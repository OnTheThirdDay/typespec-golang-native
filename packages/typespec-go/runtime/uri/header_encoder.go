// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import "net/http"

type HeaderEncoder struct {
	header http.Header
}

func NewHeaderEncoder(header http.Header) *HeaderEncoder {
	return &HeaderEncoder{
		header: header,
	}
}

type HeaderParameterEncodingConfig struct {
	Name    string
	Explode bool
}

func (e *HeaderEncoder) EncodeParam(cfg HeaderParameterEncodingConfig, f func(Encoder) error) error {
	p := &headerParamEncoder{
		receiver:  newReceiver(),
		paramName: cfg.Name,
		explode:   cfg.Explode,
		header:    e.header,
	}

	if err := f(p); err != nil {
		return err
	}

	// FIXME(tdakkota): probable we should return the error during encoding
	return p.serialize()
}

func (e *HeaderEncoder) Header() http.Header {
	return e.header
}
