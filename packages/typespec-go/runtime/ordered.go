package tsgo

import (
	"encoding/json"
	"fmt"
	"iter"
	"reflect"
	"slices"
)

// OrderedMap is a TypeSpec record that keeps insertion order (option ordered-records):
// decoding keeps the order of the JSON object, Set appends new keys and replaces existing ones in
// place, Delete removes, and encoding writes the keys in that order. The zero value is empty and
// ready to use. Copies of an initialized map share their entries, as Go maps do.
type OrderedMap[T any] struct {
	state *orderedEntries[T]
}

// Keys and values share one allocation so a Go value copy retains map semantics.
type orderedEntries[T any] struct {
	keys   []string
	values map[string]T
}

// OrderedMapOf builds a map from key/value pairs in order (a repeated key keeps its first
// position and its last value).
func OrderedMapOf[T any](pairs ...KeyValue[T]) OrderedMap[T] {
	var m OrderedMap[T]
	for _, p := range pairs {
		m.Set(p.Key, p.Value)
	}
	return m
}

// KeyValue is one entry of an OrderedMap.
type KeyValue[T any] struct {
	Key   string
	Value T
}

// Len returns the number of entries.
func (m OrderedMap[T]) Len() int {
	if m.state == nil {
		return 0
	}
	return len(m.state.keys)
}

// Get returns the value of key k.
func (m OrderedMap[T]) Get(k string) (T, bool) {
	if m.state == nil {
		var zero T
		return zero, false
	}
	v, ok := m.state.values[k]
	return v, ok
}

// Set adds k at the end, or replaces its value in place when it is present.
func (m *OrderedMap[T]) Set(k string, v T) {
	if m.state == nil {
		m.state = &orderedEntries[T]{values: map[string]T{}}
	}
	if _, ok := m.state.values[k]; !ok {
		m.state.keys = append(m.state.keys, k)
	}
	m.state.values[k] = v
}

// Delete removes k (no effect when absent).
func (m *OrderedMap[T]) Delete(k string) {
	if _, ok := m.Get(k); !ok {
		return
	}
	delete(m.state.values, k)
	m.state.keys = slices.DeleteFunc(m.state.keys, func(x string) bool { return x == k })
}

// Keys returns the keys in order (a copy).
func (m OrderedMap[T]) Keys() []string {
	if m.state == nil {
		return nil
	}
	return slices.Clone(m.state.keys)
}

// All iterates over the entries in order. Replacing values with Set while iterating is allowed.
func (m OrderedMap[T]) All() iter.Seq2[string, T] {
	return func(yield func(string, T) bool) {
		for i := 0; i < m.Len(); i++ {
			k := m.state.keys[i]
			if !yield(k, m.state.values[k]) {
				return
			}
		}
	}
}

// MarshalJSON implements json.Marshaler with the runtime's default policies, those of generated
// code without serialization options: keys in order, escaped with EscapeDefault, and values
// encoded by DefaultCodec (the runtime codecs of Go primitives, a value's own MarshalJSON).
// Generated code encodes records with the program's policies (float-format, string-escaping)
// through OrderedMapCodec; use OrderedMapCodec too to encode a standalone map with other policies.
//
// encoding/json transforms what MarshalJSON returns: json.Marshal and an Encoder without
// SetEscapeHTML(false) escape <, > and & (in keys and string values), and both escape U+2028
// and U+2029 written raw by EscapeMinimal. Call MarshalJSON (or a codec) directly, or use an
// Encoder with SetEscapeHTML(false) for the HTML characters, to keep the runtime's bytes.
func (m OrderedMap[T]) MarshalJSON() ([]byte, error) {
	return OrderedMapCodec(DefaultCodec[T](), EscapeDefault).Encode(m)
}

// UnmarshalJSON implements json.Unmarshaler: keys in document order, values decoded by
// DefaultCodec, so that strings, numbers and generated types are checked as in generated code.
func (m *OrderedMap[T]) UnmarshalJSON(data []byte) error {
	v, err := OrderedMapCodec(DefaultCodec[T](), EscapeDefault).Decode(data)
	if err != nil {
		return WithPartial(err, v)
	}
	*m = v
	return nil
}

// DefaultCodec is the codec generated code uses for T without serialization options: StringCodec,
// BoolCodec, IntCodec, Float64Codec, Float32Codec and RawCodec for those Go types, the value's
// MarshalJSON and UnmarshalJSON methods (generated types, runtime types) otherwise, and
// encoding/json, without HTML escaping, for other types.
func DefaultCodec[T any]() Codec[T] {
	var zero T
	var c any
	switch any(zero).(type) {
	case string:
		c = StringCodec
	case bool:
		c = BoolCodec
	case int8:
		c = IntCodec[int8]()
	case int16:
		c = IntCodec[int16]()
	case int32:
		c = IntCodec[int32]()
	case int64:
		c = IntCodec[int64]()
	case uint8:
		c = IntCodec[uint8]()
	case uint16:
		c = IntCodec[uint16]()
	case uint32:
		c = IntCodec[uint32]()
	case uint64:
		c = IntCodec[uint64]()
	case float64:
		c = Float64Codec
	case float32:
		c = Float32Codec
	case json.RawMessage:
		c = RawCodec
	}
	if c != nil {
		return c.(Codec[T])
	}
	return Codec[T]{
		Encode: func(v T) ([]byte, error) {
			if m, ok := any(v).(json.Marshaler); ok {
				if ptr := reflect.ValueOf(m); ptr.Kind() == reflect.Pointer && ptr.IsNil() {
					return []byte("null"), nil
				}
				b, err := m.MarshalJSON()
				if err != nil {
					return nil, err
				}
				if !json.Valid(b) {
					return nil, fmt.Errorf("%T.MarshalJSON returned invalid JSON", v)
				}
				return b, nil
			}
			return marshalNoEscape(v)
		},
		Decode: func(data []byte) (T, error) {
			var v T
			if u, ok := any(&v).(json.Unmarshaler); ok {
				if err := u.UnmarshalJSON(data); err != nil {
					if p, ok := Partial[T](err); ok {
						return p, err
					}
					var zero T
					return zero, wholeFailure(err)
				}
				return v, nil
			}
			if err := json.Unmarshal(data, &v); err != nil {
				return v, &DecodeError{Err: &DecodeProblem{Kind: ProblemType, Expected: fmt.Sprintf("%T", v), Got: ProbeJSONKind(data).String(), Message: err.Error(), Err: err}}
			}
			return v, nil
		},
	}
}

// OrderedMapCodec encodes records in insertion order with keys escaped with e; decoding keeps
// the order of the JSON object and collects failures as MapCodec does.
func OrderedMapCodec[T any](elem Codec[T], e Escaping) Codec[OrderedMap[T]] {
	return Codec[OrderedMap[T]]{
		Encode: func(v OrderedMap[T]) ([]byte, error) {
			w := NewObjectWriterEscaping(e)
			for k, x := range v.All() {
				if err := WriteField(w, k, x, elem); err != nil {
					return nil, err
				}
			}
			return w.Finish()
		},
		Decode: func(data []byte) (OrderedMap[T], error) {
			r, err := NewObjectReader(data)
			if err != nil {
				return OrderedMap[T]{}, wholeFailure(err)
			}
			var out OrderedMap[T]
			var errs []error
			for i, k := range r.order {
				v, err := elem.Decode(r.fields[k])
				out.Set(k, v)
				if err != nil {
					if errs = append(errs, WithPath(k, withValue(err, r.fields[k]))); len(errs) >= MaxCollectedErrors {
						return out, collectionFailure(errs, i < len(r.order)-1)
					}
				}
			}
			if errs != nil {
				return out, collectionFailure(errs, false)
			}
			return out, nil
		},
	}
}

// ReadAdditionalOrdered decodes the properties not consumed so far, in document order.
func ReadAdditionalOrdered[T any](r *ObjectReader, dst *OrderedMap[T], c Codec[T]) {
	var out OrderedMap[T]
	for _, k := range r.order {
		if r.consumed[k] {
			continue
		}
		r.consumed[k] = true
		v, err := c.Decode(r.fields[k])
		out.Set(k, v)
		if err != nil {
			r.fail(WithPath(k, withValue(err, r.fields[k])))
		}
	}
	*dst = out
}

// WriteAdditionalOrdered writes additional properties in insertion order. Keys equal to a
// declared property name are rejected (they would produce duplicate JSON properties).
func WriteAdditionalOrdered[T any](w *ObjectWriter, m OrderedMap[T], c Codec[T], declared ...string) error {
	for k, v := range m.All() {
		if slices.Contains(declared, k) {
			w.err = fmt.Errorf("additional property %q collides with a declared property", k)
			return w.err
		}
		if err := WriteField(w, k, v, c); err != nil {
			return err
		}
	}
	return w.err
}
