package transport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// BrowserTransport delegates only registered Slack operations. The child never
// receives provider credentials, cookie headers, proxy URLs, or arbitrary hosts.
// The local request capability is per child lifetime and is unrelated to Slack.
type BrowserTransport struct{}

var slackHost = regexp.MustCompile(`^(?:[a-z0-9-]+\.)?(?:slack\.com|slack-gov\.com)$`)
var apiPath = regexp.MustCompile(`^/api/([a-zA-Z][a-zA-Z0-9.]+)$`)
var edgePath = regexp.MustCompile(`^/cache/[TE][A-Z0-9]{5,40}/([a-zA-Z]+/[a-zA-Z]+)$`)

const browserLimit = 32 * 1024 * 1024

func (*BrowserTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	endpoint, err := url.Parse(os.Getenv("LAPLACE_BROWSER_ENDPOINT"))
	if err != nil || endpoint.Scheme != "http" || endpoint.Hostname() != "127.0.0.1" || endpoint.Port() == "" || endpoint.Path != "/execute" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, fmt.Errorf("invalid local browser endpoint")
	}
	capability := os.Getenv("LAPLACE_BROWSER_CAPABILITY")
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`).MatchString(capability) {
		return nil, fmt.Errorf("browser capability unavailable")
	}
	target := request.URL
	if target.Scheme != "https" || !slackHost.MatchString(target.Hostname()) || target.User != nil || target.Port() != "" {
		return nil, fmt.Errorf("unregistered browser host")
	}
	method := ""
	arguments := map[string]any{}
	if parts := apiPath.FindStringSubmatch(target.Path); parts != nil {
		method = "api." + parts[1]
	} else if parts := edgePath.FindStringSubmatch(target.Path); parts != nil && strings.HasPrefix(target.Hostname(), "edgeapi.") {
		method = "edge." + parts[1]
	} else if strings.HasPrefix(target.Hostname(), "files.") && request.Method == http.MethodGet {
		method = "files.download"
		arguments["url"] = target.String()
	} else {
		return nil, fmt.Errorf("unregistered browser operation")
	}
	if method != "files.download" {
		if request.Method != http.MethodGet && request.Method != http.MethodPost {
			return nil, fmt.Errorf("unregistered browser verb")
		}
		params := map[string]any{}
		for key, values := range target.Query() {
			if key != "token" {
				params[key] = values[len(values)-1]
			}
		}
		if request.Body != nil {
			defer request.Body.Close()
			raw, err := io.ReadAll(io.LimitReader(request.Body, browserLimit+1))
			if err != nil || len(raw) > browserLimit {
				return nil, fmt.Errorf("browser request too large")
			}
			if strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
				if err := json.Unmarshal(raw, &params); err != nil {
					return nil, err
				}
			} else {
				form, err := url.ParseQuery(string(raw))
				if err != nil {
					return nil, err
				}
				for key, values := range form {
					if key != "token" {
						params[key] = values[len(values)-1]
					}
				}
			}
		}
		delete(params, "token")
		delete(params, "cookie")
		delete(params, "authorization")
		arguments["params"] = params
	}
	payload, err := json.Marshal(map[string]any{"method": method, "args": arguments})
	if err != nil {
		return nil, err
	}
	call, err := http.NewRequestWithContext(request.Context(), http.MethodPost, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	call.Header.Set("Authorization", "Bearer "+capability)
	call.Header.Set("Content-Type", "application/json")
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 125 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return fmt.Errorf("local redirect refused") }}
	defer client.CloseIdleConnections()
	response, err := client.Do(call)
	if err != nil {
		return nil, fmt.Errorf("SAVE_UNVERIFIED: browser operation interrupted; verify its outcome before retrying")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, browserLimit+1))
	if err != nil || len(raw) > browserLimit {
		return nil, fmt.Errorf("invalid browser response")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("SAVE_UNVERIFIED: browser operation failed; verify its outcome before retrying")
	}
	var result struct {
		Status      int             `json:"status"`
		ContentType string          `json:"contentType"`
		Body        json.RawMessage `json:"body"`
		Base64      *string         `json:"base64"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	data := []byte(result.Body)
	if result.Base64 != nil {
		data, err = base64.StdEncoding.DecodeString(*result.Base64)
		if err != nil {
			return nil, err
		}
	}
	// Do not hand retryable HTTP statuses to upstream SDK retry loops. Browser
	// dispatch is one-shot, including writes whose responses were lost.
	if result.Status != http.StatusOK {
		return nil, fmt.Errorf("Slack browser HTTP %d; operation not retried", result.Status)
	}
	return &http.Response{StatusCode: result.Status, Status: http.StatusText(result.Status), Header: http.Header{"Content-Type": []string{result.ContentType}}, Body: io.NopCloser(bytes.NewReader(data)), Request: request}, nil
}
