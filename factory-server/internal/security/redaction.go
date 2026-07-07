// Package security provides credential-value redaction for text that may
// transit audit/log/input paths. It replaces secret VALUES with a fixed
// [REDACTED] token while preserving the surrounding key/token kind so the
// diagnostic structure remains readable.
//
// This is a DEFENSE-IN-DEPTH layer, not the primary boundary. The controlled
// credential input boundary (server.credentialSecrets) keeps plaintext values
// solely in an in-memory registry behind opaque handles; redaction is applied
// on operational artifacts (audit copies of input.json/prompt/output, command
// logs) so that even if a handle's value leaked into free text, it would be
// masked before persistence.
package security

import "regexp"

// secretPatterns matches credential-bearing key/value or header forms an agent
// or command might emit. Each pattern captures the key/header prefix in group 1
// and the trailing secret value; RedactSecrets replaces only the value with
// [REDACTED], keeping the key visible.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(authorization\s*:\s*bearer\s+)[^\s]+`),
	regexp.MustCompile(`(?i)(api[_-]?key\s*[:=]\s*)[^\s]+`),
	regexp.MustCompile(`(?i)(password\s*[:=]\s*)[^\s]+`),
	regexp.MustCompile(`(?i)(token\s*[:=]\s*)[^\s]+`),
}

// RedactSecrets replaces the VALUE portion of every recognized credential
// pattern in value with [REDACTED], leaving the key/header intact. It is
// idempotent and never returns an error: an unparseable or empty input is
// returned verbatim.
func RedactSecrets(value string) string {
	out := value
	for _, re := range secretPatterns {
		out = re.ReplaceAllString(out, `${1}[REDACTED]`)
	}
	return out
}
