// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import "strings"

// isCookieNameValid reports whether raw is a valid cookie name (an RFC 7230 token).
// Equivalent of ogen internal/httpcookie.IsCookieNameValid without golang.org/x/net.
func isCookieNameValid(raw string) bool {
	if raw == "" {
		return false
	}
	return strings.IndexFunc(raw, func(r rune) bool { return !isTokenRune(r) }) < 0
}

func isTokenRune(r rune) bool {
	if r >= 0x80 || r <= ' ' || r == 0x7f {
		return false
	}
	return !strings.ContainsRune(`()<>@,;:\\"/[]?={}`, r)
}
