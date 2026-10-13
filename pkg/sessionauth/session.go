// Package sessionauth accepts only Slack browser-session credentials.
package sessionauth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/korotovsky/slack-mcp-server/pkg/transport"
	"github.com/slack-go/slack"
	"go.uber.org/zap"
)

const DefaultUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"

type Provider interface {
	SlackToken() string
	Cookies() []*http.Cookie
	HTTPClient() (*http.Client, error)
	Test(context.Context) (*slack.AuthTestResponse, error)
}

type ValueAuth struct {
	token   string
	cookies []*http.Cookie
}

func NewValueAuth(token, cookie string) (ValueAuth, error) {
	if !strings.HasPrefix(cookie, "xoxd-") {
		return ValueAuth{}, errors.New("a browser session cookie is required")
	}
	domain := ".slack.com"
	if os.Getenv("SLACK_MCP_GOVSLACK") == "true" {
		domain = ".slack-gov.com"
	}
	return NewValueCookiesAuth(token, []*http.Cookie{
		{Name: "d", Value: escapeCookie(cookie), Domain: domain, Path: "/", Secure: true, HttpOnly: true},
		{Name: "d-s", Value: strconv.FormatInt(time.Now().Unix()-10, 10), Domain: domain, Path: "/", Secure: true},
	})
}

func NewValueCookiesAuth(token string, cookies []*http.Cookie) (ValueAuth, error) {
	if !strings.HasPrefix(token, "xoxc-") || len(token) <= 5 {
		return ValueAuth{}, errors.New("only browser session tokens are supported")
	}
	for _, c := range cookies {
		if c != nil && c.Name == "d" && strings.HasPrefix(c.Value, "xoxd-") {
			return ValueAuth{token: token, cookies: cookies}, nil
		}
	}
	return ValueAuth{}, errors.New("a browser session cookie is required")
}

func UserAgent() string {
	if value := os.Getenv("SLACK_MCP_USER_AGENT"); value != "" {
		return value
	}
	return DefaultUserAgent
}

func (v ValueAuth) SlackToken() string      { return v.token }
func (v ValueAuth) Cookies() []*http.Cookie { return v.cookies }
func (v ValueAuth) HTTPClient() (*http.Client, error) {
	return transport.ProvideHTTPClient(v.cookies, zap.NewNop()), nil
}
func (v ValueAuth) Test(ctx context.Context) (*slack.AuthTestResponse, error) {
	cl, err := v.HTTPClient()
	if err != nil {
		return nil, err
	}
	opts := []slack.Option{slack.OptionHTTPClient(cl)}
	if os.Getenv("SLACK_MCP_GOVSLACK") == "true" {
		opts = append(opts, slack.OptionAPIURL("https://slack-gov.com/api/"))
	}
	return slack.New(v.token, opts...).AuthTestContext(ctx)
}

func escapeCookie(value string) string {
	if regexp.MustCompile(`^[-._~%a-zA-Z0-9]+$`).MatchString(value) {
		return value
	}
	return url.QueryEscape(value)
}
