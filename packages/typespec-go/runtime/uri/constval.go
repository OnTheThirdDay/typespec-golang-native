// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

type constval struct {
	v string
}

func (d constval) DecodeValue() (string, error) {
	return d.v, nil
}

func (d constval) DecodeArray(f func(Decoder) error) error {
	panic("its a value, not an array")
}

func (d constval) DecodeFields(f func(string, Decoder) error) error {
	panic("its a value, not an object")
}
