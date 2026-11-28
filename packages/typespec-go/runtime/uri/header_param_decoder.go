// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"net/http"
	"strings"
)

type headerParamDecoder struct {
	paramName string
	explode   bool
	header    http.Header
}

func (d *headerParamDecoder) DecodeValue() (string, error) {
	if len(d.header.Values(d.paramName)) == 0 {
		return "", fmt.Errorf("header parameter %q not set", d.paramName)
	}

	return d.header.Get(d.paramName), nil
}

func (d *headerParamDecoder) DecodeArray(f func(Decoder) error) error {
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

func (d *headerParamDecoder) DecodeFields(f func(field string, d Decoder) error) error {
	val, err := d.DecodeValue()
	if err != nil {
		return err
	}

	pushField := func(field, value string) error { return f(field, constval{value}) }
	var kvSep, fieldSep byte = ',', ','
	if d.explode {
		kvSep = '='
	}
	return decodeObject(
		(&cursor{src: val}),
		kvSep, fieldSep, pushField,
	)
}
