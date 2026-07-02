package security

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	in := "Authorization: Bearer abcdef\npassword=secret\napi_key=xyz"
	out := RedactSecrets(in)
	for _, leaked := range []string{"abcdef", "secret", "xyz"} {
		if strings.Contains(out, leaked) {
			t.Fatalf("secret %q leaked in %q", leaked, out)
		}
	}
	for _, kept := range []string{"Authorization", "password", "api_key"} {
		if !strings.Contains(out, kept) {
			t.Fatalf("key %q missing in %q", kept, out)
		}
	}
}

func TestRedactSecretsToken(t *testing.T) {
	in := "token=s3cr3t"
	out := RedactSecrets(in)
	if strings.Contains(out, "s3cr3t") {
		t.Fatalf("token value leaked in %q", out)
	}
	if !strings.Contains(out, "token") {
		t.Fatalf("token key missing in %q", out)
	}
}
