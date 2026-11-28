// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"net/http"
)

type CookieEncoder struct {
	req *http.Request
}

func NewCookieEncoder(req *http.Request) *CookieEncoder {
	return &CookieEncoder{
		req: req,
	}
}

type CookieParameterEncodingConfig struct {
	Name    string
	Explode bool
}

func (e *CookieEncoder) EncodeParam(cfg CookieParameterEncodingConfig, f func(Encoder) error) error {
	if name := cfg.Name; !isCookieNameValid(name) {
		return fmt.Errorf("invalid cookie name %q", name)
	}
	p := &cookieParamEncoder{
		receiver:  newReceiver(),
		paramName: cfg.Name,
		explode:   cfg.Explode,
		req:       e.req,
	}

	if err := f(p); err != nil {
		return err
	}

	return p.serialize()
}
