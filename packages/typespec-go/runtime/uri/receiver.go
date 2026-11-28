// Code in this package is copied from github.com/ogen-go/ogen/uri at commit
// 3d90c0ca96cc3a28db44d4088da22f7890875ac3 (Apache-2.0, see LICENSE.ogen) and adapted:
// github.com/go-faster/errors was replaced by the standard library and ogen-internal
// packages (validate, httpcookie) by local equivalents.

package uri

import (
	"fmt"
	"strings"

	"errors"
)

func checkNotContains(s, chars string) error {
	if idx := strings.IndexAny(s, chars); idx >= 0 {
		return fmt.Errorf("invalid value %q: contains %q", s, s[idx])
	}
	return nil
}

type valueType string

func (v valueType) String() string { return string(v) }

const (
	typeNotSet valueType = "notSet"
	typeValue  valueType = "value"
	typeArray  valueType = "array"
	typeObject valueType = "object"
)

var _ Encoder = (*receiver)(nil)

// receiver is used to receive data from code generated types.
type receiver struct {
	typ    valueType
	val    string   // value type
	items  []string // array type
	fields []Field  // object type
}

func newReceiver() *receiver {
	return &receiver{
		typ: typeNotSet,
	}
}

func (s *receiver) EncodeValue(v string) error {
	if s.typ == typeValue {
		return errors.New("multiple Value calls")
	}
	if s.typ != typeNotSet && s.typ != typeValue {
		return fmt.Errorf("encode value: already encoded as %s", s.typ)
	}

	s.typ = typeValue
	s.val = v
	return nil
}

func (s *receiver) EncodeArray(f func(Encoder) error) error {
	if s.typ != typeNotSet && s.typ != typeArray {
		return fmt.Errorf("encode array: already encoded as %s", s.typ)
	}

	s.typ = typeArray
	arr := &arrayReceiver{}
	if err := f(arr); err != nil {
		return err
	}

	s.items = arr.items
	return nil
}

func (s *receiver) EncodeField(field string, f func(Encoder) error) error {
	if s.typ != typeNotSet && s.typ != typeObject {
		return fmt.Errorf("encode object: already encoded as %s", s.typ)
	}

	s.typ = typeObject
	vs := &valueReceiver{}
	if err := f(vs); err != nil {
		return err
	}

	if !vs.set {
		return nil
	}

	s.fields = append(s.fields, Field{
		Name:  field,
		Value: vs.value,
	})
	return nil
}

type arrayReceiver struct {
	set   bool
	items []string
}

func (e *arrayReceiver) EncodeValue(v string) error {
	e.set = true
	e.items = append(e.items, v)
	return nil
}

func (e *arrayReceiver) EncodeArray(_ func(Encoder) error) error {
	panic("nested arrays not allowed in path parameters")
}

func (e *arrayReceiver) EncodeField(_ string, _ func(Encoder) error) error {
	panic("nested objects not allowed in path parameters")
}

type valueReceiver struct {
	set   bool
	value string
}

func (e *valueReceiver) EncodeValue(v string) error {
	if e.set {
		panic("value already set")
	}
	e.value = v
	e.set = true
	return nil
}

func (e *valueReceiver) EncodeArray(_ func(Encoder) error) error {
	panic("nested arrays not allowed")
}

func (e *valueReceiver) EncodeField(_ string, _ func(Encoder) error) error {
	panic("nested objects not allowed")
}
