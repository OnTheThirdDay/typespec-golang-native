package tsgo

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"
	"unsafe"
)

// Codec converts between a Go value and its JSON encoding. Generated code composes codecs so
// that TypeSpec encodings (e.g. `@encode("rfc7231")`) apply at any nesting depth.
type Codec[T any] struct {
	Encode func(v T) ([]byte, error)
	Decode func(data []byte) (T, error)
}

// DecodeError is a structural decoding failure at a JSON Pointer path.
type DecodeError struct {
	Path string // JSON Pointer (RFC 6901), "" for the document root
	Err  error
	// Value is the raw JSON of the offending value when known (bounded; see Details).
	Value json.RawMessage

	// Err is a *DecodeProblem (the machine-readable kind and metadata of the failure) for the
	// failures found by the runtime and by generated code.

	partialState
}

func (e *DecodeError) Error() string {
	if e.Path == "" {
		return e.Err.Error()
	}
	return e.Path + ": " + e.Err.Error()
}

func (e *DecodeError) Unwrap() error { return e.Err }

// WithPath prefixes the path of err (which may already be a *DecodeError) with segment.
func WithPath(segment any, err error) error {
	if err == nil {
		return nil
	}
	return withPrefix("/"+escapePointer(fmt.Sprint(segment)), err)
}

// withPrefix prefixes the JSON Pointer of err. A *DecodeError or *MultiError
// is rewritten with the prefix (and its recorded failed positions); any other error, including
// wrapped and joined trees, is enclosed in a *DecodeError at prefix, keeping all of it.
func withPrefix(prefix string, err error) error {
	if err == nil || prefix == "" {
		return err
	}
	switch e := err.(type) {
	case *MultiError:
		return prefixMulti(prefix, e)
	case *DecodeError:
		return &DecodeError{Path: prefix + e.Path, Err: e.Err, Value: e.Value, partialState: e.prefixed(prefix)}
	}
	return &DecodeError{Path: prefix, Err: err}
}

// Keep native child paths available to errors.As for ordinary generated collections. A group
// too large to copy receives a lazy prefix around the original tree, including its partial value.
func prefixMulti(prefix string, root *MultiError) error {
	type pair struct{ src, dst *MultiError }
	out := &MultiError{}
	pending := []pair{{root, out}}
	var w errorWalk
	for len(pending) > 0 {
		i := len(pending) - 1
		src, dst := pending[i].src, pending[i].dst
		pending = pending[:i]
		if !w.step() || !w.charge(len(src.Errors)) {
			return &DecodeError{Path: prefix, Err: root, partialState: partialState{value: root.value, partial: root.partial}}
		}
		dst.partialState = src.prefixed(prefix)
		dst.Errors = make([]error, len(src.Errors))
		for i, child := range src.Errors {
			if group, ok := child.(*MultiError); ok {
				copy := &MultiError{}
				dst.Errors[i] = copy
				pending = append(pending, pair{group, copy})
			} else {
				dst.Errors[i] = withPrefix(prefix, child)
			}
		}
	}
	return out
}

func escapePointer(s string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(s)
}

func decodeErrorf(format string, args ...any) error {
	return &DecodeError{Err: fmt.Errorf(format, args...)}
}

// problemf returns a *DecodeError whose cause is a *DecodeProblem of the given kind.
func problemf(kind ProblemKind, format string, args ...any) *DecodeError {
	return &DecodeError{Err: &DecodeProblem{Kind: kind, Message: fmt.Sprintf(format, args...)}}
}

// typeError reports a JSON value of another type than expected.
func typeError(expected string, got JSONKind) error {
	kind := ProblemType
	if got == KindUnknown || got == KindEmpty {
		kind = ProblemSyntax
	}
	return &DecodeError{Err: &DecodeProblem{Kind: kind, Expected: expected, Got: got.String(), Message: fmt.Sprintf("expected %s, got %s", expected, got)}}
}

func isJSONNull(data []byte) bool {
	return string(bytes.TrimSpace(data)) == "null"
}

func expectKind(data []byte, kind JSONKind, what string) error {
	if k := ProbeJSONKind(data); k != kind {
		return typeError(what, k)
	}
	return nil
}

// JSONCodec uses the type's own MarshalJSON/UnmarshalJSON methods (all generated types).
func JSONCodec[T json.Marshaler, PT interface {
	*T
	json.Unmarshaler
}]() Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) { return v.MarshalJSON() },
		// On failure the result is the partial value attached by the type (WithPartial); the
		// whole value counts as failed when the type attaches none.
		Decode: func(data []byte) (T, error) {
			var v T
			err := PT(&v).UnmarshalJSON(data)
			if err != nil {
				if p, ok := Partial[T](err); ok {
					return p, err
				}
				var zero T
				return zero, wholeFailure(err)
			}
			return v, nil
		},
	}
}

// ---------------------------------------------------------------------------------------------
// primitives

// encoding/json replaces malformed UTF-8 and unpaired UTF-16 escapes with U+FFFD.
// Reject those before converting a wire string into a Go value or map key.
func validJSONUnicode(data []byte) bool {
	if !utf8.Valid(data) {
		return false
	}
	for i := bytes.IndexByte(data, '\\'); i >= 0; i = bytes.IndexByte(data, '\\') {
		data = data[i+1:]
		if len(data) == 0 {
			return false
		}
		if data[0] != 'u' {
			data = data[1:]
			continue
		}
		if len(data) < 5 {
			return false
		}
		n, err := strconv.ParseUint(string(data[1:5]), 16, 16)
		if err != nil {
			return false
		}
		data = data[5:]
		if n < 0xd800 || n > 0xdfff {
			continue
		}
		if n >= 0xdc00 || len(data) < 6 || data[0] != '\\' || data[1] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(data[2:6]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		data = data[6:]
	}
	return true
}

// StringCodec encodes Go strings as JSON strings; JSON null and non-strings are rejected.
var StringCodec = Codec[string]{
	Encode: func(v string) ([]byte, error) {
		if !utf8.ValidString(v) {
			return nil, errors.New("string is not valid UTF-8")
		}
		return marshalNoEscape(v)
	},
	Decode: func(data []byte) (string, error) {
		if err := expectKind(data, KindString, "string"); err != nil {
			return "", err
		}
		if !validJSONUnicode(data) {
			return "", problemf(ProblemUnicode, "invalid Unicode in JSON string")
		}
		var s string
		if err := json.Unmarshal(data, &s); err != nil {
			return "", problemf(ProblemSyntax, "invalid string: %v", err)
		}
		return s, nil
	},
}

// BoolCodec encodes Go booleans as JSON booleans.
var BoolCodec = Codec[bool]{
	Encode: func(v bool) ([]byte, error) { return strconv.AppendBool(nil, v), nil },
	Decode: func(data []byte) (bool, error) {
		switch string(bytes.TrimSpace(data)) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		return false, typeError("boolean", ProbeJSONKind(data))
	},
}

// Integer constraints for IntCodec.
type intType interface {
	~int8 | ~int16 | ~int32 | ~int64 | ~uint8 | ~uint16 | ~uint32 | ~uint64
}

// IntCodec encodes sized integers. Decoding accepts any JSON number denoting an integer in
// range, including forms such as 1.0 or 1e2 (JSON Schema `integer` semantics).
func IntCodec[T intType]() Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) {
			if isSigned[T]() {
				return strconv.AppendInt(nil, int64(v), 10), nil
			}
			return strconv.AppendUint(nil, uint64(v), 10), nil
		},
		Decode: func(data []byte) (T, error) {
			n, err := parseJSONInteger(data)
			if err != nil {
				return 0, err
			}
			return intFromBig[T](n)
		},
	}
}

func isSigned[T intType]() bool {
	var x T
	x--
	return x < 0
}

func intFromBig[T intType](n *big.Int) (T, error) {
	var zero T
	if isSigned[T]() {
		if !n.IsInt64() {
			return zero, intRangeError[T](n)
		}
		v := T(n.Int64())
		if big.NewInt(int64(v)).Cmp(n) != 0 {
			return zero, intRangeError[T](n)
		}
		return v, nil
	}
	if !n.IsUint64() {
		return zero, intRangeError[T](n)
	}
	v := T(n.Uint64())
	if new(big.Int).SetUint64(uint64(v)).Cmp(n) != 0 {
		return zero, intRangeError[T](n)
	}
	return v, nil
}

// intRangeError reports an integer outside the range of T (Minimum and Maximum are T's bounds).
func intRangeError[T intType](n *big.Int) error {
	var zero T
	bits := uint(unsafe.Sizeof(zero) * 8)
	var lo, hi any
	if isSigned[T]() {
		lo, hi = -int64(1)<<(bits-1), int64(1)<<(bits-1)-1
	} else {
		lo, hi = uint64(0), uint64(1)<<(bits-1)<<1-1
	}
	return &DecodeError{Err: &DecodeProblem{Kind: ProblemRange, Expected: fmt.Sprintf("%T", zero), Got: "number", Minimum: lo, Maximum: hi,
		Message: fmt.Sprintf("integer %s out of range for %T", n, zero)}}
}

func jsonNumberText(data []byte) (string, error) {
	if err := expectKind(data, KindNumber, "number"); err != nil {
		return "", err
	}
	s := string(bytes.TrimSpace(data))
	if !json.Valid(data) {
		return "", problemf(ProblemSyntax, "invalid number %q", s)
	}
	return s, nil
}

func parseJSONInteger(data []byte) (*big.Int, error) {
	s, err := jsonNumberText(data)
	if err != nil {
		return nil, err
	}
	r, ok := exactRat(s)
	if !ok {
		return nil, problemf(ProblemPrecision, "number %s exceeds the exact range (%d significant digits, exponent ±%d)", truncateNumber(s), MaxExactDigits, MaxExactExponent)
	}
	if !r.IsInt() {
		return nil, &DecodeError{Err: &DecodeProblem{Kind: ProblemType, Expected: "integer", Got: "number", Message: fmt.Sprintf("expected integer, got %s", truncateNumber(s))}}
	}
	return r.Num(), nil
}

// Float64Codec encodes float64 values; NaN and infinities have no JSON representation.
var Float64Codec = Codec[float64]{
	Encode: func(v float64) ([]byte, error) { return encodeFloat(v, 64) },
	Decode: func(data []byte) (float64, error) {
		s, err := jsonNumberText(data)
		if err != nil {
			return 0, err
		}
		f, err := parseFloatText(s, 64)
		if err != nil {
			return 0, floatRangeError(s, 64)
		}
		return f, nil
	},
}

// Float32Codec encodes float32 values. Decoding rounds to the nearest float32 and rejects values
// outside its range.
var Float32Codec = Codec[float32]{
	Encode: func(v float32) ([]byte, error) { return encodeFloat(float64(v), 32) },
	Decode: func(data []byte) (float32, error) {
		s, err := jsonNumberText(data)
		if err != nil {
			return 0, err
		}
		f, err := parseFloatText(s, 32)
		if err != nil {
			return 0, floatRangeError(s, 32)
		}
		return float32(f), nil
	},
}

func floatRangeError(s string, bits int) error {
	lo, hi := any(-math.MaxFloat64), any(math.MaxFloat64)
	if bits == 32 {
		lo, hi = float32(-math.MaxFloat32), float32(math.MaxFloat32)
	}
	return &DecodeError{Err: &DecodeProblem{Kind: ProblemRange, Expected: fmt.Sprintf("float%d", bits), Got: "number", Minimum: lo, Maximum: hi,
		Message: fmt.Sprintf("number %s out of range for float%d", s, bits)}}
}

func encodeFloat(v float64, bits int) ([]byte, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil, fmt.Errorf("unsupported value: %v has no JSON representation", v)
	}
	return strconv.AppendFloat(nil, v, 'g', -1, bits), nil
}

// RawCodec passes JSON through unchanged (TypeSpec `unknown`). Decoding only checks that the
// input is well-formed JSON; any JSON value, including null, is accepted.
var RawCodec = Codec[json.RawMessage]{
	Encode: func(v json.RawMessage) ([]byte, error) {
		if v == nil {
			return []byte("null"), nil
		}
		if !json.Valid(v) || !validJSONUnicode(v) {
			return nil, errors.New("invalid JSON in unknown value")
		}
		return v, nil
	},
	Decode: func(data []byte) (json.RawMessage, error) {
		if !json.Valid(data) || !validJSONUnicode(data) {
			return nil, problemf(ProblemSyntax, "invalid JSON")
		}
		return append(json.RawMessage(nil), bytes.TrimSpace(data)...), nil
	},
}

// NullType is the Go representation of the TypeSpec `null` type used on its own.
type NullType struct{}

// NullCodec only accepts JSON null.
var NullCodec = Codec[NullType]{
	Encode: func(NullType) ([]byte, error) { return []byte("null"), nil },
	Decode: func(data []byte) (NullType, error) {
		if !isJSONNull(data) {
			return NullType{}, typeError("null", ProbeJSONKind(data))
		}
		return NullType{}, nil
	},
}

// ---------------------------------------------------------------------------------------------
// composites

// ArrayCodec encodes slices; a nil slice encodes as []. JSON null is rejected.
func ArrayCodec[T any](elem Codec[T]) Codec[[]T] {
	return Codec[[]T]{
		Encode: func(v []T) ([]byte, error) {
			buf := []byte{'['}
			for i, e := range v {
				if i > 0 {
					buf = append(buf, ',')
				}
				b, err := elem.Encode(e)
				if err != nil {
					return nil, fmt.Errorf("[%d]: %w", i, err)
				}
				buf = append(buf, b...)
			}
			return append(buf, ']'), nil
		},
		// On failure the result holds the items that decoded (and the partial values of the others).
		Decode: func(data []byte) ([]T, error) {
			if err := expectKind(data, KindArray, "array"); err != nil {
				return nil, err
			}
			var raw []json.RawMessage
			if err := json.Unmarshal(data, &raw); err != nil {
				return nil, problemf(ProblemSyntax, "invalid array: %v", err)
			}
			out := make([]T, len(raw))
			var errs []error
			for i, r := range raw {
				v, err := elem.Decode(r)
				out[i] = v
				if err != nil {
					// Every failing item is kept (bounded); the first one is the error.
					if errs = append(errs, WithPath(i, withValue(err, r))); len(errs) >= MaxCollectedErrors {
						return out, collectionFailure(errs, i < len(raw)-1)
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

// MapCodec encodes TypeSpec records; a nil map encodes as {}. Keys are written in sorted order.
func MapCodec[T any](elem Codec[T]) Codec[map[string]T] {
	return Codec[map[string]T]{
		Encode: func(v map[string]T) ([]byte, error) {
			w := NewObjectWriter()
			for _, k := range sortedKeys(v) {
				if err := WriteField(w, k, v[k], elem); err != nil {
					return nil, err
				}
			}
			return w.Finish()
		},
		// On failure the result holds the entries that decoded (and the partial values of the others).
		Decode: func(data []byte) (map[string]T, error) {
			r, err := NewObjectReader(data)
			if err != nil {
				return nil, wholeFailure(err)
			}
			out := make(map[string]T, len(r.fields))
			var errs []error
			for i, k := range r.order {
				v, err := elem.Decode(r.fields[k])
				out[k] = v
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

// NullableCodec encodes Nullable[T] as null or the inner encoding.
func NullableCodec[T any](inner Codec[T]) Codec[Nullable[T]] {
	return Codec[Nullable[T]]{
		Encode: func(v Nullable[T]) ([]byte, error) {
			if x, ok := v.Get(); ok {
				return inner.Encode(x)
			}
			return []byte("null"), nil
		},
		Decode: func(data []byte) (Nullable[T], error) {
			if isJSONNull(data) {
				return Null[T](), nil
			}
			v, err := inner.Decode(data)
			if err != nil {
				return Value(v), err // the partial value
			}
			return Value(v), nil
		},
	}
}

// ConvertCodec adapts a codec for a base type to a defined type with the same underlying
// representation (generated custom scalars, e.g. `type Uuid string`).
func ConvertCodec[T any, B any](base Codec[B], to func(B) T, from func(T) B) Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) { return base.Encode(from(v)) },
		Decode: func(data []byte) (T, error) {
			b, err := base.Decode(data)
			if err != nil {
				return to(b), err // the partial value
			}
			return to(b), nil
		},
	}
}

// LiteralCodec accepts exactly one JSON value (TypeSpec literal types such as `kind: "cat"`).
func LiteralCodec[T comparable](base Codec[T], want T) Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) {
			if v != want {
				return nil, fmt.Errorf("value %v does not equal literal %v", v, want)
			}
			return base.Encode(v)
		},
		Decode: func(data []byte) (T, error) {
			v, err := base.Decode(data)
			if err != nil {
				return v, err
			}
			if v != want || !literalNumberMatches(want, string(data)) {
				var zero T
				return zero, &DecodeError{Err: &DecodeProblem{Kind: ProblemLiteral, Allowed: []any{want}, Message: fmt.Sprintf("expected literal %v, got %v", jsonish(want), jsonish(v))}}
			}
			return v, nil
		},
	}
}

// Decimal spellings near a floating literal can round to the same Go value. Membership is
// tested in the wire domain before returning that rounded value.
func literalNumberMatches(v any, token string) bool {
	switch v.(type) {
	case float32, float64:
		return SameNumberText(strings.TrimSpace(token), jsonish(v))
	}
	return true
}

func jsonish(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// MarshalWith encodes v with codec c; MustDecode is used for defaults known to be valid.
func MarshalWith[T any](c Codec[T], v T) ([]byte, error) { return c.Encode(v) }

// UnmarshalWith decodes data with codec c.
func UnmarshalWith[T any](c Codec[T], data []byte) (T, error) { return c.Decode(data) }

// MustDecode decodes a compile-time constant (default values); it panics on failure, which
// indicates a generator bug.
func MustDecode[T any](c Codec[T], data string) T {
	v, err := c.Decode([]byte(data))
	if err != nil {
		panic(fmt.Sprintf("tsgo: invalid generated constant %s: %v", data, err))
	}
	return v
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// syntaxErrorf reports text that does not have the expected structure (parameters).
func syntaxErrorf(format string, args ...any) error {
	return &DecodeProblem{Kind: ProblemSyntax, Message: fmt.Sprintf(format, args...)}
}

func duplicateErrorf(format string, args ...any) error {
	return &DecodeProblem{Kind: ProblemDuplicateProperty, Message: fmt.Sprintf(format, args...)}
}
