// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"net/http"
	"strings"

	"errors"
)

type cookieParamDecoder struct {
	paramName string
	explode   bool
	req       *http.Request
}

func (d *cookieParamDecoder) DecodeValue() (string, error) {
	c, err := d.req.Cookie(d.paramName)
	switch {
	case err == nil: // if NO error
	case errors.Is(err, http.ErrNoCookie):
		return "", fmt.Errorf("cookie parameter %q not set", d.paramName)
	default:
		return "", fmt.Errorf("get cookie %q: %w", d.paramName, err)
	}

	val, ok := unescapeCookie(c.Value)
	if !ok {
		return "", fmt.Errorf("invalid cookie escaping %q", c.Value)
	}
	return val, nil
}

func (d *cookieParamDecoder) DecodeArray(f func(Decoder) error) error {
	val, err := d.DecodeValue()
	if err != nil {
		return err
	}

	for v := range strings.SplitSeq(val, ",") {
		if err := f(constval{v}); err != nil {
			return err
		}
	}
	return nil
}

func (d *cookieParamDecoder) DecodeFields(f func(field string, d Decoder) error) error {
	val, err := d.DecodeValue()
	if err != nil {
		return err
	}

	pushField := func(field, value string) error { return f(field, constval{value}) }
	const kvSep, fieldSep = ',', ','
	return decodeObject(
		(&cursor{src: val}),
		kvSep, fieldSep, pushField,
	)
}
