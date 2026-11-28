package tsgo

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
)

// ObjectWriter builds a JSON object in field order.
type ObjectWriter struct {
	buf      bytes.Buffer
	count    int
	err      error
	escaping Escaping // of keys
}

// NewObjectWriter starts a JSON object.
func NewObjectWriter() *ObjectWriter {
	w := &ObjectWriter{}
	w.buf.WriteByte('{')
	return w
}

func (w *ObjectWriter) raw(name string, value []byte) {
	if w.count > 0 {
		w.buf.WriteByte(',')
	}
	w.count++
	key, err := w.escaping.encode(name)
	if err != nil {
		w.err = err
		return
	}
	w.buf.Write(key)
	w.buf.WriteByte(':')
	w.buf.Write(value)
}

// Finish closes the object and returns its encoding or the first error.
func (w *ObjectWriter) Finish() ([]byte, error) {
	if w.err != nil {
		return nil, w.err
	}
	w.buf.WriteByte('}')
	return w.buf.Bytes(), nil
}

// WriteField writes a property with codec c.
func WriteField[T any](w *ObjectWriter, name string, v T, c Codec[T]) error {
	if w.err != nil {
		return w.err
	}
	b, err := c.Encode(v)
	if err != nil {
		w.err = fmt.Errorf("%s: %w", name, err)
		return w.err
	}
	w.raw(name, b)
	return nil
}

// WriteOptionalField writes an optional property; a nil pointer means "absent".
func WriteOptionalField[T any](w *ObjectWriter, name string, v *T, c Codec[T]) error {
	if v == nil {
		return w.err
	}
	return WriteField(w, name, *v, c)
}

// WriteOptionalOrNull writes an optional nullable property of a response encoded with
// `response-unset-nullable: null`: a nil pointer (absent) is written as null.
func WriteOptionalOrNull[T any](w *ObjectWriter, name string, v *Nullable[T], c Codec[Nullable[T]]) error {
	if v == nil {
		if w.err == nil {
			w.raw(name, []byte("null"))
		}
		return w.err
	}
	return WriteField(w, name, *v, c)
}

// WithEncoder returns c with another encoding function (response encodings of generated types).
func WithEncoder[T any](c Codec[T], encode func(T) ([]byte, error)) Codec[T] {
	c.Encode = encode
	return c
}

// UnknownPolicy controls JSON object properties that are not declared by the model.
type UnknownPolicy int

const (
	// IgnoreUnknown drops undeclared properties (JSON Schema / OpenAPI open-object semantics).
	IgnoreUnknown UnknownPolicy = iota
	// RejectUnknown fails decoding when an undeclared property is present.
	RejectUnknown
)

// ObjectReader gives keyed access to the properties of one JSON object.
//
// Duplicate property names are rejected: their meaning is ambiguous (RFC 8259 §4) and
// last-one-wins decoding could make validation and business logic observe different values.
type ObjectReader struct {
	fields   map[string]json.RawMessage
	order    []string
	consumed map[string]bool
	err      error   // first failure
	errs     []error // every failure (bounded), err first
	// truncated: failures beyond MaxCollectedErrors were dropped, so their positions are unknown.
	truncated bool
}

// NewObjectReader parses data, which must be a JSON object.
func NewObjectReader(data []byte) (*ObjectReader, error) {
	if err := expectKind(data, KindObject, "object"); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if _, err := dec.Token(); err != nil { // '{'
		return nil, problemf(ProblemSyntax, "invalid object: %v", err)
	}
	r := &ObjectReader{fields: map[string]json.RawMessage{}, consumed: map[string]bool{}}
	for dec.More() {
		start := dec.InputOffset()
		tok, err := dec.Token()
		if err != nil {
			return nil, problemf(ProblemSyntax, "invalid object: %v", err)
		}
		key, ok := tok.(string)
		if !ok {
			return nil, problemf(ProblemSyntax, "invalid object key %v", tok)
		}
		if !validJSONUnicode(data[start:dec.InputOffset()]) {
			return nil, problemf(ProblemUnicode, "invalid Unicode in object key")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, WithPath(key, problemf(ProblemSyntax, "invalid value: %v", err))
		}
		if _, dup := r.fields[key]; dup {
			return nil, WithPath(key, problemf(ProblemDuplicateProperty, "duplicate property"))
		}
		r.fields[key] = raw
		r.order = append(r.order, key)
	}
	if _, err := dec.Token(); err != nil { // '}'
		return nil, problemf(ProblemSyntax, "invalid object: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, problemf(ProblemSyntax, "unexpected data after object")
	}
	return r, nil
}

// Has reports whether the property is present.
func (r *ObjectReader) Has(name string) bool {
	_, ok := r.fields[name]
	return ok
}

// Raw returns the raw property value and marks it consumed.
func (r *ObjectReader) Raw(name string) (json.RawMessage, bool) {
	v, ok := r.fields[name]
	if ok {
		r.consumed[name] = true
	}
	return v, ok
}

// Ignore marks properties as consumed without decoding them: known properties that the
// generated type deliberately does not hold (excluded by visibility).
func (r *ObjectReader) Ignore(names ...string) {
	for _, n := range names {
		if _, ok := r.fields[n]; ok {
			r.consumed[n] = true
		}
	}
}

func (r *ObjectReader) fail(err error) {
	if r.err == nil {
		r.err = err
	}
	if len(r.errs) < MaxCollectedErrors {
		r.errs = append(r.errs, err)
	} else {
		r.truncated = true
	}
}

// missing is the failure of an absent required property.
func missing(name string) error {
	return WithPath(name, problemf(ProblemRequired, "required property is missing"))
}

// ReadRequired decodes a required property; absence is an error. On failure dst holds the
// partially decoded value (reported only through WithPartial by generated code).
func ReadRequired[T any](r *ObjectReader, name string, dst *T, c Codec[T]) {
	raw, ok := r.Raw(name)
	if !ok {
		r.fail(missing(name))
		return
	}
	v, err := c.Decode(raw)
	*dst = v
	if err != nil {
		r.fail(WithPath(name, withValue(err, raw)))
	}
}

// ReadOptional decodes an optional property into a pointer (nil when absent).
func ReadOptional[T any](r *ObjectReader, name string, dst **T, c Codec[T]) {
	raw, ok := r.Raw(name)
	if !ok {
		*dst = nil
		return
	}
	v, err := c.Decode(raw)
	*dst = &v
	if err != nil {
		r.fail(WithPath(name, withValue(err, raw)))
	}
}

// ReadAdditional decodes every property not consumed so far into dst using c.
func ReadAdditional[T any](r *ObjectReader, dst *map[string]T, c Codec[T]) {
	var out map[string]T
	for _, k := range r.order {
		if r.consumed[k] {
			continue
		}
		r.consumed[k] = true
		v, err := c.Decode(r.fields[k])
		if out == nil {
			out = map[string]T{}
		}
		out[k] = v
		if err != nil {
			r.fail(WithPath(k, withValue(err, r.fields[k])))
		}
	}
	*dst = out
}

// Finish applies the unknown-property policy and returns the decoding failures: the first one,
// or a MultiError whose first error (message, errors.As) is that same failure.
func (r *ObjectReader) Finish(policy UnknownPolicy) error {
	if policy == RejectUnknown {
		for _, k := range r.order {
			if !r.consumed[k] {
				r.fail(WithPath(k, problemf(ProblemUnknownProperty, "unknown property")))
			}
		}
	}
	return r.Err()
}

// WriteAdditional writes additional properties in sorted key order. Keys equal to a declared
// property name are rejected (they would produce duplicate JSON properties).
func WriteAdditional[T any](w *ObjectWriter, m map[string]T, c Codec[T], declared ...string) error {
	for _, k := range sortedKeys(m) {
		for _, d := range declared {
			if k == d {
				w.err = fmt.Errorf("additional property %q collides with a declared property", k)
				return w.err
			}
		}
		if err := WriteField(w, k, m[k], c); err != nil {
			return err
		}
	}
	return w.err
}

func sortedKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// WriteRaw writes an already-encoded property value.
func (w *ObjectWriter) WriteRaw(name string, value []byte) {
	if w.err == nil {
		w.raw(name, value)
	}
}

// ReadLiteral checks a required literal-typed property that has no Go field.
func ReadLiteral[T any](r *ObjectReader, name string, c Codec[T]) {
	var v T
	ReadRequired(r, name, &v, c)
}

// ReadRawRequired returns the raw value of a required property.
func ReadRawRequired(r *ObjectReader, name string) json.RawMessage {
	raw, ok := r.Raw(name)
	if !ok {
		r.fail(missing(name))
	}
	return raw
}

// Fail records a decoding error found by generated code.
func (r *ObjectReader) Fail(err error) { r.fail(err) }

// Err returns the recorded errors (the first one, or a MultiError starting with it).
func (r *ObjectReader) Err() error {
	if r.errs == nil {
		return nil
	}
	return collectionFailure(r.errs, r.truncated)
}

// UnionValue stores the variant of a generated union type.
type UnionValue struct {
	Kind  int
	Value any
}

// InjectProperty adds a string property in front of the properties of an encoded JSON object
// (discriminator of `@discriminated(#{envelope: "none"})` unions).
func InjectProperty(object []byte, name, value string) ([]byte, error) {
	return injectProperty(object, name, value, EscapeDefault)
}

func injectProperty(object []byte, name, value string, e Escaping) ([]byte, error) {
	object = bytes.TrimSpace(object)
	if len(object) < 2 || object[0] != '{' {
		return nil, fmt.Errorf("discriminated union variant must encode as a JSON object")
	}
	key, err := e.encode(name)
	if err != nil {
		return nil, err
	}
	val, err := e.encode(value)
	if err != nil {
		return nil, err
	}
	out := append([]byte{'{'}, key...)
	out = append(out, ':')
	out = append(out, val...)
	rest := bytes.TrimSpace(object[1:])
	if len(rest) > 0 && rest[0] != '}' {
		out = append(out, ',')
	}
	return append(out, rest...), nil
}

// StripProperty removes a property from a JSON object, preserving the order of the others.
func StripProperty(object []byte, name string) ([]byte, error) {
	r, err := NewObjectReader(object)
	if err != nil {
		return nil, err
	}
	w := NewObjectWriter()
	for _, k := range r.order {
		if k != name {
			w.raw(k, r.fields[k])
		}
	}
	return w.Finish()
}

// DecodeTuple splits a JSON array of exactly n elements.
func DecodeTuple(data []byte, n int) ([]json.RawMessage, error) {
	if err := expectKind(data, KindArray, "array"); err != nil {
		return nil, err
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, problemf(ProblemSyntax, "invalid array: %v", err)
	}
	if len(raw) != n {
		return nil, &DecodeError{Err: &DecodeProblem{Kind: ProblemItems, Minimum: n, Maximum: n, Message: fmt.Sprintf("expected %d elements, got %d", n, len(raw))}}
	}
	return raw, nil
}

// EncodeTuple joins encoded tuple elements.
func EncodeTuple(items ...[]byte) []byte {
	return append(append([]byte{'['}, bytes.Join(items, []byte{','})...), ']')
}

// ReadNever fails if a property of type `never` is present.
func ReadNever(r *ObjectReader, name string) {
	if _, ok := r.Raw(name); ok {
		r.fail(WithPath(name, problemf(ProblemNever, "property of type never must be absent")))
	}
}

// SortedKeys returns the keys of m in sorted order (deterministic XML/record output).
func SortedKeys[T any](m map[string]T) []string { return sortedKeys(m) }

// DecodeItem decodes element i of a tuple into dst (the partial value on failure) and records
// its failure in errs.
func DecodeItem[T any](raw []json.RawMessage, i int, dst *T, c Codec[T], errs *[]error) {
	v, err := c.Decode(raw[i])
	*dst = v
	if err != nil {
		*errs = append(*errs, WithPath(i, withValue(err, raw[i])))
	}
}

// ItemsError returns the failures of DecodeItem: nil, the first one, or a MultiError.
func ItemsError(errs []error) error {
	if errs == nil {
		return nil
	}
	return collectionFailure(errs, false)
}
