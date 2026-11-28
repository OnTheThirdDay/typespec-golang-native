package tsgo

import (
	"encoding"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// TextCodec converts a value to and from its textual form, used for HTTP parameters and
// headers and for JSON values that TypeSpec encodes as strings.
type TextCodec[T any] struct {
	Format func(v T) (string, error)
	Parse  func(s string) (T, error)
	// Name is the expected type or format ("int32", "date-time", "duration", "base64", ...),
	// reported as DecodeProblem.Expected when parsing fails.
	Name string
}

// parse is Parse with failures reported as a *DecodeProblem (ProblemFormat unless the parser
// already reports a problem).
func (tc TextCodec[T]) parse(s string) (T, error) {
	v, err := tc.Parse(s)
	if err == nil {
		return v, nil
	}
	// Text parsed with a JSON codec (numbers): a JSON-level failure means another text form.
	var p *DecodeProblem
	if errors.As(err, &p) && (p.Kind == ProblemSyntax || p.Kind == ProblemType) && tc.Name != "" {
		return v, &DecodeProblem{Kind: ProblemFormat, Expected: tc.Name, Message: fmt.Sprintf("invalid %s %q", tc.Name, truncate(s)), Err: err}
	}
	return v, FormatError(tc.Name, err)
}

// MarshalerText is the text codec of a type implementing encoding.TextMarshaler and
// encoding.TextUnmarshaler: enums and scalars of another generated package (option external).
func MarshalerText[T encoding.TextMarshaler, PT interface {
	*T
	encoding.TextUnmarshaler
}]() TextCodec[T] {
	return TextCodec[T]{
		Format: func(v T) (string, error) {
			b, err := v.MarshalText()
			return string(b), err
		},
		Parse: func(s string) (T, error) {
			var v T
			err := PT(&v).UnmarshalText([]byte(s))
			return v, err
		},
	}
}

// JSONString wraps a text codec into a JSON codec that uses JSON strings.
func JSONString[T any](tc TextCodec[T]) Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) {
			s, err := tc.Format(v)
			if err != nil {
				return nil, err
			}
			return StringCodec.Encode(s)
		},
		Decode: func(data []byte) (T, error) {
			s, err := StringCodec.Decode(data)
			if err != nil {
				var zero T
				return zero, err
			}
			v, err := tc.parse(s)
			if err != nil {
				return v, &DecodeError{Err: err}
			}
			return v, nil
		},
	}
}

// ParseText parses s with tc, reporting failures as a *DecodeProblem (text bodies).
func ParseText[T any](tc TextCodec[T], s string) (T, error) { return tc.parse(s) }

// ConvertText adapts a text codec to a defined type with the same representation.
func ConvertText[T any, B any](base TextCodec[B], to func(B) T, from func(T) B) TextCodec[T] {
	return TextCodec[T]{
		Name:   base.Name,
		Format: func(v T) (string, error) { return base.Format(from(v)) },
		Parse: func(s string) (T, error) {
			b, err := base.Parse(s)
			if err != nil {
				var zero T
				return zero, err
			}
			return to(b), nil
		},
	}
}

// StringText is the identity text codec.
var StringText = TextCodec[string]{
	Name:   "string",
	Format: validText,
	Parse:  validText,
}

func validText(s string) (string, error) {
	if !utf8.ValidString(s) {
		return "", errors.New("text is not valid UTF-8")
	}
	return s, nil
}

// BoolText accepts exactly "true" and "false".
var BoolText = TextCodec[bool]{
	Name:   "boolean",
	Format: func(v bool) (string, error) { return strconv.FormatBool(v), nil },
	Parse: func(s string) (bool, error) {
		switch s {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		return false, fmt.Errorf("invalid boolean %q", s)
	},
}

// IntText formats and parses sized integers in base 10.
func IntText[T intType]() TextCodec[T] {
	c := IntCodec[T]()
	var zero T
	return TextCodec[T]{
		Name:   fmt.Sprintf("%T", zero),
		Format: func(v T) (string, error) { b, err := c.Encode(v); return string(b), err },
		Parse: func(s string) (T, error) {
			if strings.TrimSpace(s) != s || s == "" {
				return 0, fmt.Errorf("invalid integer %q", s)
			}
			return c.Decode([]byte(s))
		},
	}
}

// Float64Text formats and parses float64 values.
var Float64Text = TextCodec[float64]{
	Name:   "float64",
	Format: func(v float64) (string, error) { b, err := encodeFloat(v, 64); return string(b), err },
	Parse:  func(s string) (float64, error) { return parseFloatText(s, 64) },
}

// Float32Text formats and parses float32 values.
var Float32Text = TextCodec[float32]{
	Name:   "float32",
	Format: func(v float32) (string, error) { b, err := encodeFloat(float64(v), 32); return string(b), err },
	Parse: func(s string) (float32, error) {
		f, err := parseFloatText(s, 32)
		return float32(f), err
	},
}

func parseFloatText(s string, bits int) (float64, error) {
	f, err := strconv.ParseFloat(s, bits)
	mantissa, _, _ := strings.Cut(strings.ToLower(s), "e")
	if f == 0 && strings.ContainsAny(mantissa, "123456789") {
		return 0, fmt.Errorf("nonzero number %q underflows float%d", s, bits)
	}
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || strings.ContainsAny(s, "xXpP_") {
		return 0, fmt.Errorf("invalid number %q", s)
	}
	return f, nil
}

// ---------------------------------------------------------------------------------------------
// date/time

// DateTimeRFC3339 is the default encoding of utcDateTime and offsetDateTime.
var DateTimeRFC3339 = TextCodec[time.Time]{
	Name:   "date-time",
	Format: func(v time.Time) (string, error) { return v.Format(time.RFC3339Nano), nil },
	Parse: func(s string) (time.Time, error) {
		t, err := time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid RFC 3339 date-time %q", s)
		}
		return t, nil
	},
}

// DateTimeRFC7231 is the HTTP-date (IMF-fixdate) encoding, e.g. "Sun, 06 Nov 1994 08:49:37 GMT".
var DateTimeRFC7231 = TextCodec[time.Time]{
	Name:   "http-date",
	Format: func(v time.Time) (string, error) { return v.UTC().Format(http.TimeFormat), nil },
	Parse: func(s string) (time.Time, error) {
		t, err := time.Parse(http.TimeFormat, s)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid RFC 7231 date-time %q", s)
		}
		return t, nil
	},
}

// UnixTimestampCodec encodes time as integer seconds since the Unix epoch. Sub-second precision
// cannot be represented and is rejected on encode.
func UnixTimestampCodec[T int32 | int64]() Codec[time.Time] {
	ic := IntCodec[T]()
	return Codec[time.Time]{
		Encode: func(v time.Time) ([]byte, error) {
			if v.Nanosecond() != 0 {
				return nil, fmt.Errorf("unix timestamp %v has sub-second precision", v)
			}
			s := v.Unix()
			if int64(T(s)) != s {
				return nil, fmt.Errorf("unix timestamp %d out of range", s)
			}
			return ic.Encode(T(s))
		},
		Decode: func(data []byte) (time.Time, error) {
			n, err := ic.Decode(data)
			if err != nil {
				return time.Time{}, err
			}
			return time.Unix(int64(n), 0).UTC(), nil
		},
	}
}

// UnixTimestampText is the text form of UnixTimestampCodec.
func UnixTimestampText[T int32 | int64]() TextCodec[time.Time] {
	c := UnixTimestampCodec[T]()
	return TextCodec[time.Time]{
		Name:   "unixtime",
		Format: func(v time.Time) (string, error) { b, err := c.Encode(v); return string(b), err },
		Parse:  func(s string) (time.Time, error) { return c.Decode([]byte(s)) },
	}
}

// Date is a calendar date without time zone (TypeSpec plainDate), encoded as YYYY-MM-DD.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// String returns the RFC 3339 full-date form.
func (d Date) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.Year, int(d.Month), d.Day) }

// ParseDate parses YYYY-MM-DD.
func ParseDate(s string) (Date, error) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return Date{}, fmt.Errorf("invalid date %q", s)
	}
	return Date{Year: t.Year(), Month: t.Month(), Day: t.Day()}, nil
}

// DateText is the text codec of plainDate.
var DateText = TextCodec[Date]{
	Name: "date",
	Format: func(v Date) (string, error) {
		if _, err := ParseDate(v.String()); err != nil {
			return "", err
		}
		return v.String(), nil
	},
	Parse: ParseDate,
}

// TimeOfDay is a wall-clock time without date or time zone (TypeSpec plainTime), encoded as
// HH:MM:SS with optional fractional seconds.
type TimeOfDay struct {
	Hour, Minute, Second, Nanosecond int
}

func (t TimeOfDay) String() string {
	s := fmt.Sprintf("%02d:%02d:%02d", t.Hour, t.Minute, t.Second)
	if t.Nanosecond != 0 {
		s += strings.TrimRight(fmt.Sprintf(".%09d", t.Nanosecond), "0")
	}
	return s
}

// ParseTimeOfDay parses HH:MM:SS[.fraction].
func ParseTimeOfDay(s string) (TimeOfDay, error) {
	t, err := time.Parse("15:04:05.999999999", s)
	if err != nil {
		return TimeOfDay{}, fmt.Errorf("invalid time %q", s)
	}
	return TimeOfDay{Hour: t.Hour(), Minute: t.Minute(), Second: t.Second(), Nanosecond: t.Nanosecond()}, nil
}

// TimeOfDayText is the text codec of plainTime.
var TimeOfDayText = TextCodec[TimeOfDay]{
	Name: "time",
	Format: func(v TimeOfDay) (string, error) {
		if v.Hour < 0 || v.Hour > 23 || v.Minute < 0 || v.Minute > 59 || v.Second < 0 || v.Second > 59 || v.Nanosecond < 0 || v.Nanosecond > 999999999 {
			return "", fmt.Errorf("invalid time of day %+v", v)
		}
		return v.String(), nil
	},
	Parse: ParseTimeOfDay,
}

// ---------------------------------------------------------------------------------------------
// duration

// Duration is an ISO 8601 duration (TypeSpec duration). Calendar components (years, months,
// weeks, days) are kept separately because their length is not fixed.
type Duration struct {
	Negative                   bool
	Years, Months, Weeks, Days int64
	Hours, Minutes, Seconds    int64
	Nanoseconds                int64 // fractional seconds, 0 ≤ Nanoseconds < 1e9
}

// DurationOf converts a time.Duration.
func DurationOf(d time.Duration) Duration {
	var out Duration
	if d < 0 {
		out.Negative = true
		d = -d
	}
	out.Hours = int64(d / time.Hour)
	d -= time.Duration(out.Hours) * time.Hour
	out.Minutes = int64(d / time.Minute)
	d -= time.Duration(out.Minutes) * time.Minute
	out.Seconds = int64(d / time.Second)
	out.Nanoseconds = int64(d - time.Duration(out.Seconds)*time.Second)
	return out
}

// ErrCalendarDuration reports a duration with calendar components where a fixed length is needed.
var ErrCalendarDuration = errors.New("duration has calendar components (years, months, weeks or days) of variable length")

// Std converts to time.Duration; it fails for calendar components and on overflow.
func (d Duration) Std() (time.Duration, error) {
	if d.Years != 0 || d.Months != 0 || d.Weeks != 0 || d.Days != 0 {
		return 0, ErrCalendarDuration
	}
	total := new(big.Int).Mul(big.NewInt(d.Hours), big.NewInt(int64(time.Hour)))
	total.Add(total, new(big.Int).Mul(big.NewInt(d.Minutes), big.NewInt(int64(time.Minute))))
	total.Add(total, new(big.Int).Mul(big.NewInt(d.Seconds), big.NewInt(int64(time.Second))))
	total.Add(total, big.NewInt(d.Nanoseconds))
	if d.Negative {
		total.Neg(total)
	}
	if !total.IsInt64() {
		return 0, errors.New("duration overflows time.Duration")
	}
	return time.Duration(total.Int64()), nil
}

// String returns the ISO 8601 form, e.g. "P1DT2H30M" or "PT0.5S".
func (d Duration) String() string {
	var b strings.Builder
	if d.Negative {
		b.WriteByte('-')
	}
	b.WriteByte('P')
	for _, c := range []struct {
		v int64
		u byte
	}{{d.Years, 'Y'}, {d.Months, 'M'}, {d.Weeks, 'W'}, {d.Days, 'D'}} {
		if c.v != 0 {
			b.WriteString(strconv.FormatInt(c.v, 10))
			b.WriteByte(c.u)
		}
	}
	if d.Hours != 0 || d.Minutes != 0 || d.Seconds != 0 || d.Nanoseconds != 0 {
		b.WriteByte('T')
		if d.Hours != 0 {
			b.WriteString(strconv.FormatInt(d.Hours, 10) + "H")
		}
		if d.Minutes != 0 {
			b.WriteString(strconv.FormatInt(d.Minutes, 10) + "M")
		}
		if d.Seconds != 0 || d.Nanoseconds != 0 {
			b.WriteString(strconv.FormatInt(d.Seconds, 10))
			if d.Nanoseconds != 0 {
				b.WriteString(strings.TrimRight(fmt.Sprintf(".%09d", d.Nanoseconds), "0"))
			}
			b.WriteByte('S')
		}
	}
	if b.Len() == 1 || (d.Negative && b.Len() == 2) {
		b.WriteString("T0S")
	}
	return b.String()
}

// ParseDuration parses an ISO 8601 duration (PnYnMnWnDTnHnMnS). Only the seconds component may
// have a fraction, with at most nanosecond precision.
func ParseDuration(s string) (Duration, error) {
	bad := func() (Duration, error) { return Duration{}, fmt.Errorf("invalid ISO 8601 duration %q", s) }
	var d Duration
	rest := s
	if strings.HasPrefix(rest, "-") {
		d.Negative = true
		rest = rest[1:]
	} else if strings.HasPrefix(rest, "+") {
		rest = rest[1:]
	}
	if !strings.HasPrefix(rest, "P") {
		return bad()
	}
	rest = rest[1:]
	inTime := false
	seen := false
	order := "YMWDTHMS"
	last := -1
	for rest != "" {
		if rest[0] == 'T' {
			if inTime {
				return bad()
			}
			inTime = true
			rest = rest[1:]
			if rest == "" {
				return bad()
			}
			last = strings.IndexByte(order, 'T')
			continue
		}
		i := 0
		for i < len(rest) && (rest[i] >= '0' && rest[i] <= '9' || rest[i] == '.' || rest[i] == ',') {
			i++
		}
		if i == 0 || i == len(rest) {
			return bad()
		}
		num, unit := strings.ReplaceAll(rest[:i], ",", "."), rest[i]
		rest = rest[i+1:]
		pos := -1
		if inTime {
			pos = strings.IndexByte("HMS", unit)
			if pos >= 0 {
				pos += 5
			}
		} else {
			pos = strings.IndexByte("YMWD", unit)
		}
		if pos < 0 || pos <= last {
			return bad()
		}
		last = pos
		seen = true
		if strings.Contains(num, ".") {
			if pos != 7 || rest != "" {
				return bad() // only the final seconds component may be fractional
			}
			whole, frac, _ := strings.Cut(num, ".")
			if whole == "" || frac == "" || len(frac) > 9 {
				return bad()
			}
			sec, err := strconv.ParseInt(whole, 10, 64)
			if err != nil {
				return bad()
			}
			ns, _ := strconv.ParseInt((frac + "000000000")[:9], 10, 64)
			d.Seconds, d.Nanoseconds = sec, ns
			continue
		}
		v, err := strconv.ParseInt(num, 10, 64)
		if err != nil {
			return bad()
		}
		switch pos {
		case 0:
			d.Years = v
		case 1:
			d.Months = v
		case 2:
			d.Weeks = v
		case 3:
			d.Days = v
		case 5:
			d.Hours = v
		case 6:
			d.Minutes = v
		case 7:
			d.Seconds = v
		}
	}
	if !seen {
		return bad()
	}
	return d, nil
}

// DurationISO8601Text is the default encoding of duration.
var DurationISO8601Text = TextCodec[Duration]{
	Name:   "duration",
	Format: func(v Duration) (string, error) { return v.String(), nil },
	Parse:  ParseDuration,
}

// DurationSecondsCodec encodes a fixed-length duration as a number of seconds, as an integer
// (int32/int64) or a float (float32/float64) number depending on the TypeSpec encoding.
func DurationSecondsCodec(numberType string) Codec[Duration] {
	return durationUnitCodec(numberType, time.Second)
}

// DurationMillisecondsCodec encodes a fixed-length duration as a number of milliseconds.
func DurationMillisecondsCodec(numberType string) Codec[Duration] {
	return durationUnitCodec(numberType, time.Millisecond)
}

func durationUnitCodec(numberType string, unit time.Duration) Codec[Duration] {
	isInt := numberType == "int32" || numberType == "int64"
	return Codec[Duration]{
		Encode: func(v Duration) ([]byte, error) {
			std, err := v.Std()
			if err != nil {
				return nil, err
			}
			if isInt {
				if std%unit != 0 {
					return nil, fmt.Errorf("duration %v is not a whole number of %v", std, unit)
				}
				n := int64(std / unit)
				if numberType == "int32" && (n < math.MinInt32 || n > math.MaxInt32) {
					return nil, fmt.Errorf("duration %v out of range for int32", std)
				}
				return strconv.AppendInt(nil, n, 10), nil
			}
			bits := 64
			if numberType == "float32" {
				bits = 32
			}
			return encodeFloat(float64(std)/float64(unit), bits)
		},
		Decode: func(data []byte) (Duration, error) {
			if isInt {
				var n int64
				var err error
				if numberType == "int32" {
					var x int32
					x, err = IntCodec[int32]().Decode(data)
					n = int64(x)
				} else {
					n, err = IntCodec[int64]().Decode(data)
				}
				if err != nil {
					return Duration{}, err
				}
				if n > math.MaxInt64/int64(unit) || n < math.MinInt64/int64(unit) {
					return Duration{}, problemf(ProblemRange, "duration overflows")
				}
				return DurationOf(time.Duration(n) * unit), nil
			}
			s, err := jsonNumberText(data)
			if err != nil {
				return Duration{}, err
			}
			r, ok := exactRat(s)
			if !ok {
				return Duration{}, problemf(ProblemPrecision, "number %s exceeds the exact range", truncateNumber(s))
			}
			ns := new(big.Rat).Mul(r, new(big.Rat).SetInt64(int64(unit)))
			if !ns.IsInt() {
				return Duration{}, problemf(ProblemPrecision, "duration %s has sub-nanosecond precision", s)
			}
			if !ns.Num().IsInt64() {
				return Duration{}, problemf(ProblemRange, "duration %s overflows", s)
			}
			return DurationOf(time.Duration(ns.Num().Int64())), nil
		},
	}
}

// DurationNumberText is the text form of a numeric duration encoding.
func DurationNumberText(c Codec[Duration]) TextCodec[Duration] {
	return TextCodec[Duration]{
		Name:   "duration",
		Format: func(v Duration) (string, error) { b, err := c.Encode(v); return string(b), err },
		Parse:  func(s string) (Duration, error) { return c.Decode([]byte(s)) },
	}
}

// ---------------------------------------------------------------------------------------------
// bytes

// Base64Text is the default bytes encoding (RFC 4648 §4, padded).
var Base64Text = TextCodec[[]byte]{
	Name:   "base64",
	Format: func(v []byte) (string, error) { return base64.StdEncoding.EncodeToString(v), nil },
	Parse: func(s string) ([]byte, error) {
		if strings.ContainsAny(s, "\r\n") {
			return nil, fmt.Errorf("line break in base64")
		}
		b, err := base64.StdEncoding.Strict().DecodeString(s)
		if err != nil {
			return nil, fmt.Errorf("invalid base64: %v", err)
		}
		return b, nil
	},
}

// Base64URLText is the base64url encoding (RFC 4648 §5). It is written without padding;
// both padded and unpadded input is accepted.
var Base64URLText = TextCodec[[]byte]{
	Name:   "base64url",
	Format: func(v []byte) (string, error) { return base64.RawURLEncoding.EncodeToString(v), nil },
	Parse: func(s string) ([]byte, error) {
		if strings.ContainsAny(s, "\r\n") {
			return nil, fmt.Errorf("line break in base64url")
		}
		encoding := base64.RawURLEncoding.Strict()
		if strings.Contains(s, "=") {
			encoding = base64.URLEncoding.Strict()
		}
		b, err := encoding.DecodeString(s)
		if err != nil {
			return nil, fmt.Errorf("invalid base64url: %v", err)
		}
		return b, nil
	},
}

// ---------------------------------------------------------------------------------------------
// arbitrary precision numbers

// Integer is an arbitrary-precision integer (TypeSpec integer). The zero value is 0.
type Integer struct {
	v *big.Int
}

// NewInteger returns an Integer holding x.
func NewInteger(x int64) Integer { return Integer{v: big.NewInt(x)} }

// IntegerFromBig copies x.
func IntegerFromBig(x *big.Int) Integer { return Integer{v: new(big.Int).Set(x)} }

// Big returns a copy of the value.
func (i Integer) Big() *big.Int {
	if i.v == nil {
		return new(big.Int)
	}
	return new(big.Int).Set(i.v)
}

func (i Integer) String() string { return i.Big().String() }

// Cmp compares two integers.
func (i Integer) Cmp(o Integer) int { return i.Big().Cmp(o.Big()) }

// IntegerCodec encodes Integer as a JSON number.
var IntegerCodec = Codec[Integer]{
	Encode: func(v Integer) ([]byte, error) { return []byte(v.String()), nil },
	Decode: func(data []byte) (Integer, error) {
		n, err := parseJSONInteger(data)
		if err != nil {
			return Integer{}, err
		}
		return Integer{v: n}, nil
	},
}

// IntegerText is the text form of IntegerCodec.
var IntegerText = TextCodec[Integer]{
	Name:   "integer",
	Format: func(v Integer) (string, error) { return v.String(), nil },
	Parse:  func(s string) (Integer, error) { return IntegerCodec.Decode([]byte(s)) },
}

// Decimal is an exact base-10 number (TypeSpec numeric, decimal, decimal128). It keeps the
// textual form so values round-trip without precision loss.
type Decimal struct {
	text string
}

// ParseDecimal parses a JSON-number-formatted decimal.
func ParseDecimal(s string) (Decimal, error) {
	if !isJSONNumberText(s) {
		return Decimal{}, fmt.Errorf("invalid decimal %q", truncateNumber(s))
	}
	if !exactNumberText(s) {
		return Decimal{}, fmt.Errorf("decimal %s exceeds the exact range (%d significant digits, exponent ±%d)", truncateNumber(s), MaxExactDigits, MaxExactExponent)
	}
	return Decimal{text: s}, nil
}

// MustDecimal parses s and panics on error.
func MustDecimal(s string) Decimal {
	d, err := ParseDecimal(s)
	if err != nil {
		panic(err)
	}
	return d
}

func (d Decimal) String() string {
	if d.text == "" {
		return "0"
	}
	return d.text
}

// Rat returns the exact value (decimals are bounded when parsed, see MaxExactDigits).
func (d Decimal) Rat() *big.Rat {
	if r, ok := exactRat(d.String()); ok {
		return r
	}
	r, _ := new(big.Rat).SetString(d.String())
	return r
}

// Cmp compares two decimals numerically.
func (d Decimal) Cmp(o Decimal) int { return d.Rat().Cmp(o.Rat()) }

// SignificantDigits returns the number of significant decimal digits (for decimal128 checks).
func (d Decimal) SignificantDigits() int {
	p, _ := parseDecimalParts(d.String())
	return max(1, len(p.digits))
}

// DecimalCodec encodes Decimal as a JSON number.
var DecimalCodec = Codec[Decimal]{
	Encode: func(v Decimal) ([]byte, error) { return []byte(v.String()), nil },
	Decode: func(data []byte) (Decimal, error) {
		s, err := jsonNumberText(data)
		if err != nil {
			return Decimal{}, err
		}
		if !exactNumberText(s) {
			return Decimal{}, problemf(ProblemPrecision, "decimal %s exceeds the exact range (%d significant digits, exponent ±%d)", truncateNumber(s), MaxExactDigits, MaxExactExponent)
		}
		return Decimal{text: s}, nil
	},
}

// DecimalText is the text form of DecimalCodec.
var DecimalText = TextCodec[Decimal]{
	Name:   "decimal",
	Format: func(v Decimal) (string, error) { return v.String(), nil },
	Parse:  ParseDecimal,
}

func isJSONNumberText(s string) bool {
	i := 0
	if i < len(s) && s[i] == '-' {
		i++
	}
	if i >= len(s) {
		return false
	}
	if s[i] == '0' {
		i++
	} else if s[i] >= '1' && s[i] <= '9' {
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	} else {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		j := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == j {
			return false
		}
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		j := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == j {
			return false
		}
	}
	return i == len(s)
}

// TextAsJSONNumber wraps a text codec whose text is a JSON number (used for `@encode` of
// numbers as strings and vice versa).
func TextAsJSONNumber[T any](tc TextCodec[T]) Codec[T] {
	return Codec[T]{
		Encode: func(v T) ([]byte, error) {
			s, err := tc.Format(v)
			if err != nil {
				return nil, err
			}
			return []byte(s), nil
		},
		Decode: func(data []byte) (T, error) {
			s, err := jsonNumberText(data)
			if err != nil {
				var zero T
				return zero, err
			}
			v, err := tc.parse(s)
			if err != nil {
				return v, &DecodeError{Err: err}
			}
			return v, nil
		},
	}
}

// DelimitedArrayCodec encodes an array as one JSON string whose elements are joined by sep
// (TypeSpec ArrayEncoding.commaDelimited/spaceDelimited/pipeDelimited/newlineDelimited).
// Elements containing sep cannot be represented and fail to encode. An empty string decodes
// to an empty array.
func DelimitedArrayCodec[T any](elem TextCodec[T], sep string) Codec[[]T] {
	return JSONString(TextCodec[[]T]{
		Name: "delimited " + elem.Name,
		Format: func(v []T) (string, error) {
			parts := make([]string, len(v))
			for i, e := range v {
				s, err := elem.Format(e)
				if err != nil {
					return "", fmt.Errorf("[%d]: %w", i, err)
				}
				if strings.Contains(s, sep) {
					return "", fmt.Errorf("[%d]: element %q contains the delimiter %q", i, s, sep)
				}
				parts[i] = s
			}
			return strings.Join(parts, sep), nil
		},
		Parse: func(s string) ([]T, error) {
			out := []T{}
			if s == "" {
				return out, nil
			}
			for i, p := range strings.Split(s, sep) {
				v, err := elem.parse(p)
				if err != nil {
					return nil, fmt.Errorf("[%d]: %w", i, err)
				}
				out = append(out, v)
			}
			return out, nil
		},
	})
}

// NumberAsString encodes a numeric text codec as a JSON string (TypeSpec `@encode(string)`).
func NumberAsString[T any](tc TextCodec[T]) Codec[T] { return JSONString(tc) }

// LiteralText accepts exactly one textual value (literal-typed parameters).
func LiteralText[T comparable](base TextCodec[T], want T) TextCodec[T] {
	return TextCodec[T]{
		Name: base.Name,
		Format: func(v T) (string, error) {
			if v != want {
				return "", fmt.Errorf("value %v does not equal literal %v", v, want)
			}
			return base.Format(v)
		},
		Parse: func(s string) (T, error) {
			v, err := base.parse(s)
			if err == nil && (v != want || !literalNumberMatches(want, s)) {
				var zero T
				return zero, &DecodeProblem{Kind: ProblemLiteral, Allowed: []any{want}, Message: fmt.Sprintf("expected %v, got %v", want, v)}
			}
			return v, err
		},
	}
}

// BoolStringText is the `@encode(string)` encoding of boolean: "true"/"false" are written,
// and any letter case is accepted when reading ("TRUE", "FaLsE"), as in the TypeSpec HTTP specs.
var BoolStringText = TextCodec[bool]{
	Name:   "boolean",
	Format: func(v bool) (string, error) { return strconv.FormatBool(v), nil },
	Parse: func(s string) (bool, error) {
		switch strings.ToLower(s) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		return false, fmt.Errorf("invalid boolean %q", s)
	},
}
