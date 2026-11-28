// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"net/http"
)

type HeaderDecoder struct {
	header http.Header
}

func NewHeaderDecoder(header http.Header) *HeaderDecoder {
	return &HeaderDecoder{
		header: header,
	}
}

type HeaderParameterDecodingConfig struct {
	Name    string
	Explode bool
}

func (d *HeaderDecoder) HasParam(cfg HeaderParameterDecodingConfig) error {
	if len(d.header.Values(cfg.Name)) == 0 {
		return &FieldRequiredError{Name: cfg.Name}
	}
	return nil
}

func (d *HeaderDecoder) DecodeParam(cfg HeaderParameterDecodingConfig, f func(Decoder) error) error {
	p := &headerParamDecoder{
		paramName: cfg.Name,
		explode:   cfg.Explode,
		header:    d.header,
	}

	return f(p)
}
