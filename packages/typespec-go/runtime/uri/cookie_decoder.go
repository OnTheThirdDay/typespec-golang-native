// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"net/http"

	"errors"
)

type CookieDecoder struct {
	req *http.Request
}

func NewCookieDecoder(req *http.Request) *CookieDecoder {
	return &CookieDecoder{
		req: req,
	}
}

type CookieParameterDecodingConfig struct {
	Name    string
	Explode bool
}

func (d *CookieDecoder) HasParam(cfg CookieParameterDecodingConfig) error {
	_, err := d.req.Cookie(cfg.Name)
	if errors.Is(err, http.ErrNoCookie) {
		return &FieldRequiredError{Name: cfg.Name}
	}
	return err
}

func (d *CookieDecoder) DecodeParam(cfg CookieParameterDecodingConfig, f func(Decoder) error) error {
	p := &cookieParamDecoder{
		paramName: cfg.Name,
		explode:   cfg.Explode,
		req:       d.req,
	}

	return f(p)
}
