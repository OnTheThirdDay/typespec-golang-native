package tsgo

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// JSON serialization policies selected by generated code (options float-format and
// string-escaping). They reproduce pydantic-core's model_dump_json, or Python's json.dumps,
// byte for byte; decoding is unchanged.

// PydanticFloat64Codec writes float64 values as pydantic-core does: shortest round-trip digits,
// decimal notation for decimal exponents -5 ≤ e < 16 with ".0" for integral values (1.0, -0.0,
// 0.00001, 1000000000000000.0), exponent notation otherwise (1e+16, 1.5e-7, 5e-324).
var PydanticFloat64Codec = Codec[float64]{
	Encode: func(v float64) ([]byte, error) { return pydanticFloat(v, 64) },
	Decode: Float64Codec.Decode,
}

// PydanticFloat32Codec writes float32 values like PydanticFloat64Codec, from the shortest
// digits that round-trip the float32 value.
var PydanticFloat32Codec = Codec[float32]{
	Encode: func(v float32) ([]byte, error) { return pydanticFloat(float64(v), 32) },
	Decode: Float32Codec.Decode,
}

// PythonReprFloat64Codec writes float64 values as Python's json.dumps does (float.__repr__):
// shortest round-trip digits, decimal notation for decimal exponents -4 ≤ e < 16 with ".0" for
// integral values (1.0, -0.0, 0.0001, 1000000000000000.0), exponent notation otherwise with a
// sign and at least two exponent digits (1e-05, 1.5e-07, 1e+16, 5e-324).
var PythonReprFloat64Codec = Codec[float64]{
	Encode: func(v float64) ([]byte, error) { return shortestFloat(v, 64, -4, 2) },
	Decode: Float64Codec.Decode,
}

// PythonReprFloat32Codec writes float32 values like PythonReprFloat64Codec, from the shortest
// digits that round-trip the float32 value: the text json.dumps writes for the Python float of
// that decimal.
var PythonReprFloat32Codec = Codec[float32]{
	Encode: func(v float32) ([]byte, error) { return shortestFloat(float64(v), 32, -4, 2) },
	Decode: Float32Codec.Decode,
}

func pydanticFloat(v float64, bits int) ([]byte, error) { return shortestFloat(v, bits, -5, 1) }

// shortestFloat writes the shortest round-trip digits of v (a float of the given bit size) in
// decimal notation for decimal exponents minExp ≤ e < 16 (".0" for integral values), and in
// exponent notation otherwise, with at least expDigits exponent digits.
func shortestFloat(v float64, bits, minExp, expDigits int) ([]byte, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil, errors.New("unsupported value: NaN and infinities have no JSON representation")
	}
	s := strconv.FormatFloat(v, 'e', -1, bits) // d.ddde±XX
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	mant, expText, _ := strings.Cut(s, "e")
	exp, _ := strconv.Atoi(expText)
	digits := strings.Replace(mant, ".", "", 1)
	var out string
	if exp >= minExp && exp < 16 {
		if exp < 0 {
			out = "0." + strings.Repeat("0", -exp-1) + digits
		} else if len(digits) <= exp+1 {
			out = digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
		} else {
			out = digits[:exp+1] + "." + digits[exp+1:]
		}
	} else {
		out = digits[:1]
		if len(digits) > 1 {
			out += "." + digits[1:]
		}
		sign := "+"
		if exp < 0 {
			sign, exp = "-", -exp
		}
		e := strconv.Itoa(exp)
		out += "e" + sign + strings.Repeat("0", max(0, expDigits-len(e))) + e
	}
	if neg {
		out = "-" + out
	}
	return []byte(out), nil
}

// Escaping selects how strings (values and object keys) are escaped in JSON.
type Escaping int

const (
	// EscapeDefault is encoding/json without HTML escaping (U+2028 and U+2029 are escaped).
	EscapeDefault Escaping = iota
	// EscapeMinimal escapes only what JSON requires (`"`, `\`, U+0000–U+001F, with \b \t \n \f
	// \r short forms), as pydantic-core and serde_json do.
	EscapeMinimal
)

func (e Escaping) encode(s string) ([]byte, error) {
	if e == EscapeMinimal {
		return minimalString(s)
	}
	return StringCodec.Encode(s)
}

// MinimalStringCodec is StringCodec with EscapeMinimal.
var MinimalStringCodec = Codec[string]{
	Encode: minimalString,
	Decode: StringCodec.Decode,
}

func minimalString(s string) ([]byte, error) {
	if !utf8.ValidString(s) {
		return nil, errors.New("string is not valid UTF-8")
	}
	const hex = "0123456789abcdef"
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b = append(b, '\\', c)
		case c == '\b':
			b = append(b, '\\', 'b')
		case c == '\t':
			b = append(b, '\\', 't')
		case c == '\n':
			b = append(b, '\\', 'n')
		case c == '\f':
			b = append(b, '\\', 'f')
		case c == '\r':
			b = append(b, '\\', 'r')
		case c < 0x20:
			b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xf])
		default:
			b = append(b, c)
		}
	}
	return append(b, '"'), nil
}

// NewObjectWriterEscaping starts a JSON object whose keys are escaped with e.
func NewObjectWriterEscaping(e Escaping) *ObjectWriter {
	w := NewObjectWriter()
	w.escaping = e
	return w
}

// MapCodecEscaping is MapCodec with keys escaped with e.
func MapCodecEscaping[T any](elem Codec[T], e Escaping) Codec[map[string]T] {
	c := MapCodec(elem)
	c.Encode = func(v map[string]T) ([]byte, error) {
		w := NewObjectWriterEscaping(e)
		for _, k := range sortedKeys(v) {
			if err := WriteField(w, k, v[k], elem); err != nil {
				return nil, err
			}
		}
		return w.Finish()
	}
	return c
}

// InjectPropertyEscaping is InjectProperty with the name and value escaped with e.
func InjectPropertyEscaping(object []byte, name, value string, e Escaping) ([]byte, error) {
	return injectProperty(object, name, value, e)
}
