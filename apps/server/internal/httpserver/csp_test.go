package httpserver

import (
	"strings"
	"testing"
)

// The web client shows a vault's PDFs in an iframe served by this same
// server, and the PDF response carries the policy too. `frame-ancestors
// 'none'` therefore forbade the app's own same-origin frame and every PDF
// embed rendered as a blocked frame (#121). Same-origin framing must stay
// allowed; framing by other sites stays blocked.
func TestContentSecurityPolicyAllowsSameOriginFraming(t *testing.T) {
	csp := contentSecurityPolicy()
	if !strings.Contains(csp, "frame-ancestors 'self'") {
		t.Fatalf("CSP must allow same-origin framing for PDF embeds, got: %s", csp)
	}
	if strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("CSP still forbids same-origin framing: %s", csp)
	}
}
