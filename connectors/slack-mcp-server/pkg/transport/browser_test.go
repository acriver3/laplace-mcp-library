package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBrowserTransportCredentialsAndBinary(t *testing.T) {
	calls := 0
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 43) {
			t.Error("missing per-child capability")
		}
		raw, _ := io.ReadAll(r.Body)
		if bytes.Contains(raw, []byte("sensitive-token")) {
			t.Error("provider credential crossed the bridge")
		}
		var payload struct {
			Method string         `json:"method"`
			Args   map[string]any `json:"args"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Method != "api.chat.postMessage" {
			t.Error(payload.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"status":200,"contentType":"application/json","body":{"ok":true,"ts":"1.2"}}`)
	}))
	defer bridge.Close()
	t.Setenv("LAPLACE_BROWSER_ENDPOINT", bridge.URL+"/execute")
	t.Setenv("LAPLACE_BROWSER_CAPABILITY", strings.Repeat("a", 43))
	request, _ := http.NewRequest("POST", "https://fixture.slack.com/api/chat.postMessage", strings.NewReader("token=sensitive-token&channel=C123&text=fixture"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Cookie", "d=sensitive-token")
	result, err := (&BrowserTransport{}).RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer result.Body.Close()
	data, _ := io.ReadAll(result.Body)
	if string(data) != `{"ok":true,"ts":"1.2"}` {
		t.Error(string(data))
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestBrowserTransportNeverRetriesOrRedirects(t *testing.T) {
	calls := 0
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(502) }))
	defer bridge.Close()
	t.Setenv("LAPLACE_BROWSER_ENDPOINT", bridge.URL+"/execute")
	t.Setenv("LAPLACE_BROWSER_CAPABILITY", strings.Repeat("a", 43))
	request, _ := http.NewRequestWithContext(context.Background(), "POST", "https://slack.com/api/chat.postMessage", strings.NewReader("text=fixture"))
	_, err := (&BrowserTransport{}).RoundTrip(request)
	if err == nil || !strings.Contains(err.Error(), "SAVE_UNVERIFIED") {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
	for _, target := range []string{"https://evil.test/api/chat.postMessage", "http://slack.com/api/users.list", "https://slack.com:123/api/users.list", "https://slack.com/unregistered"} {
		req, _ := http.NewRequest("GET", target, nil)
		if _, err := (&BrowserTransport{}).RoundTrip(req); err == nil {
			t.Fatal(target)
		}
	}
	if calls != 1 {
		t.Fatal("unregistered request reached bridge")
	}
}
