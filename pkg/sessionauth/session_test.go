package sessionauth

import "testing"

func TestBrowserOnly(t *testing.T) {
	for _, token := range []string{"", "demo", "xoxp-user", "xoxb-bot", "xoxc-"} {
		if _, err := NewValueAuth(token, "xoxd-cookie"); err == nil {
			t.Fatalf("accepted non-session token")
		}
	}
	for _, cookie := range []string{"", "demo", "xoxp-cookie"} {
		if _, err := NewValueAuth("xoxc-session", cookie); err == nil {
			t.Fatalf("accepted invalid cookie")
		}
	}
	a, err := NewValueAuth("xoxc-session", "xoxd-cookie%2Fencoded")
	if err != nil {
		t.Fatal(err)
	}
	if a.Cookies()[0].Value != "xoxd-cookie%2Fencoded" {
		t.Fatal("double-escaped cookie")
	}
	a, err = NewValueAuth("xoxc-session", "xoxd-cookie/needs+escaping")
	if err != nil {
		t.Fatal(err)
	}
	if a.Cookies()[0].Value != "xoxd-cookie%2Fneeds%2Bescaping" {
		t.Fatal("cookie not escaped")
	}
}

func TestGovSlackCookieDomain(t *testing.T) {
	t.Setenv("SLACK_MCP_GOVSLACK", "true")
	a, err := NewValueAuth("xoxc-session", "xoxd-cookie")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range a.Cookies() {
		if c.Domain != ".slack-gov.com" {
			t.Fatal("wrong cookie domain")
		}
	}
}
