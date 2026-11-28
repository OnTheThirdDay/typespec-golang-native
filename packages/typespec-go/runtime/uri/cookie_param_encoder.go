// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"net/http"
	"strings"
)

type cookieParamEncoder struct {
	*receiver
	paramName string
	explode   bool
	req       *http.Request
}

func (e *cookieParamEncoder) setCookie(val string) {
	//#nosec G124
	e.req.AddCookie(&http.Cookie{
		Name:  e.paramName,
		Value: escapeCookie(val),
	})
}

func (e *cookieParamEncoder) serialize() error {
	switch e.typ {
	case typeNotSet:
		return nil
	case typeValue:
		e.setCookie(e.val)
		return nil
	case typeArray:
		if e.explode {
			panic("cookie with explode: true not supported")
		}

		const sep = ","
		for _, val := range e.items {
			if err := checkNotContains(val, sep); err != nil {
				return err
			}
		}
		e.setCookie(strings.Join(e.items, sep))
		return nil
	case typeObject:
		if e.explode {
			panic("cookie with explode: true not supported")
		}

		const kvSep, fieldSep = ',', ','
		for _, f := range e.fields {
			if err := checkNotContains(f.Name, string(kvSep)); err != nil {
				return err
			}
			if err := checkNotContains(f.Value, string(fieldSep)); err != nil {
				return err
			}
		}
		e.setCookie(encodeObject(kvSep, fieldSep, e.fields))
		return nil
	default:
		panic("unreachable")
	}
}
