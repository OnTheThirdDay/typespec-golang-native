// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"net/url"
	"strings"
)

// Clone clones u and returns cloned url that you can modify.
func Clone(u *url.URL) *url.URL {
	target := new(url.URL)

	target.Path = u.Path
	target.RawFragment = u.RawFragment
	target.RawPath = u.RawPath
	target.Scheme = u.Scheme
	target.Host = u.Host
	target.ForceQuery = u.ForceQuery
	target.User = u.User

	return target
}

// AddPathParts adds escaped path parts to the given URL.
func AddPathParts(u *url.URL, parts ...string) {
	var (
		path    strings.Builder
		rawPath strings.Builder

		writeRaw = u.RawPath != ""
	)
	path.WriteString(u.Path)
	if writeRaw {
		rawPath.WriteString(u.RawPath)
	}

	for _, part := range parts {
		if !strings.ContainsRune(part, '%') {
			path.WriteString(part)
			if writeRaw {
				rawPath.WriteString(part)
			}
			continue
		}

		if !writeRaw {
			rawPath.WriteString(path.String())
		}
		writeRaw = true
		rawPath.WriteString(part)
		unescaped, _ := url.PathUnescape(part)
		path.WriteString(unescaped)
	}

	u.Path = path.String()
	if rawPath.Len() > 0 {
		u.RawPath = rawPath.String()
	}
}
