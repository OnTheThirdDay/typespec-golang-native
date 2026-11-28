package tsgo

import (
	"cmp"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// ValidationError is one violated constraint.
type ValidationError struct {
	Path       string // JSON Pointer of the offending value ("" for the root)
	Constraint string // e.g. "maxLength", "minimum", "enum", "required", or an application name
	Message    string
	// Limit is the constraint's parameter (bound, length, pattern, allowed values) and Value the
	// offending value (bounded), when known. Err retains a custom check or merged failure's cause.
	Limit any   `json:"-"`
	Value any   `json:"-"`
	Err   error `json:"-"`
}

func (e ValidationError) Error() string {
	if e.Path == "" {
		return e.Message
	}
	return e.Path + ": " + e.Message
}

// Unwrap exposes the cause of an individual check, including when entries are joined directly.
func (e ValidationError) Unwrap() error { return e.Err }

// ValidationErrors is the error returned by generated Validate methods.
type ValidationErrors []ValidationError

// Unwrap returns the application errors of custom checks (for errors.Is and errors.As).
func (es ValidationErrors) Unwrap() []error {
	var out []error
	for _, e := range es {
		if e.Err != nil {
			out = append(out, e.Err)
		}
	}
	return out
}

func (es ValidationErrors) Error() string {
	parts := make([]string, len(es))
	for i, e := range es {
		parts[i] = e.Error()
	}
	return "validation failed: " + strings.Join(parts, "; ")
}

// Validator collects validation errors below a path prefix.
//
// Generated types implement ValidateWith(v), which records their violations at v's position:
// Validate is ValidateWith on a NewValidator. When a value is only partially decoded
// (ValidateDecoded, ServerOptions.CollectErrors), the validator skips the positions whose values
// did not decode, and application checks (ValidationExtension) run only on values that decoded
// completely (RunExtensions).
type Validator struct {
	prefix string
	errs   *ValidationErrors
	state  *decodedState
}

// NewValidator returns an empty validator for the root path.
func NewValidator() *Validator { return &Validator{errs: &ValidationErrors{}} }

// NewConstraintValidator returns a validator checking only the declared constraints:
// application checks do not run (generated code selecting a union variant).
func NewConstraintValidator() *Validator {
	v := NewValidator()
	v.state = &decodedState{noHooks: true}
	return v
}

// At returns a validator for a child path segment (property name or array index).
func (v *Validator) At(segment any) *Validator {
	return &Validator{prefix: v.prefix + "/" + escapePointer(fmt.Sprint(segment)), errs: v.errs, state: v.state}
}

// Path returns the JSON Pointer of the validator's position.
func (v *Validator) Path() string { return v.prefix }

// RunExtensions reports whether application checks (ValidationExtension) run for the value at
// v's position: the value decoded completely and no union variant is being selected.
func (v *Validator) RunExtensions() bool {
	return v.state == nil || !v.state.noHooks && !v.state.incomplete[v.prefix] && !v.state.skips(v.prefix)
}

func (v *Validator) record(e ValidationError) {
	if v.state.skips(e.Path) {
		return // the value did not decode: its zero value is not checked
	}
	*v.errs = append(*v.errs, e)
}

// Add records a violated constraint at the current path.
func (v *Validator) Add(constraint, format string, args ...any) {
	v.record(ValidationError{Path: v.prefix, Constraint: constraint, Message: fmt.Sprintf(format, args...)})
}

// AddLimit records a violated constraint with its parameter (the bound, the pattern, the allowed
// values) and the offending value, which Details report.
func (v *Validator) AddLimit(constraint string, limit, value any, format string, args ...any) {
	v.addValue(constraint, limit, value, format, args...)
}

// addValue records a violated constraint with its parameter and the offending value.
func (v *Validator) addValue(constraint string, limit, value any, format string, args ...any) {
	v.record(ValidationError{Path: v.prefix, Constraint: constraint, Message: fmt.Sprintf(format, args...), Limit: limit, Value: boundedValue(value)})
}

// AddError records the failure of an application-defined check at the current path. It joins
// the generated checks in ValidationErrors (and Details); errors.As finds err.
func (v *Validator) AddError(constraint string, err error) {
	if err == nil {
		return
	}
	v.record(ValidationError{Path: v.prefix, Constraint: constraint, Message: err.Error(), Err: err})
}

// AddErrorValue is AddError with the offending value (bounded), which Details report.
func (v *Validator) AddErrorValue(constraint string, value any, err error) {
	if err == nil {
		return
	}
	v.record(ValidationError{Path: v.prefix, Constraint: constraint, Message: err.Error(), Err: err, Value: boundedValue(value)})
}

// Merge records the errors of a nested Validate call below the current path: every validation
// error of err, and each other problem as constraint "invalid" at its position.
func (v *Validator) Merge(err error) {
	var w errorWalk
	w.run(err, treeVisitor{problem: func(p treeProblem) bool {
		if e := p.validation; e != nil {
			c := *e
			c.Path = v.prefix + p.position()
			if c.Err == nil {
				c.Err = p.cause()
			}
			v.record(c)
		} else {
			d := problemDetail(p)
			v.record(ValidationError{Path: v.prefix + d.Path, Constraint: "invalid", Message: d.Message, Value: d.Value, Err: p.cause()})
		}
		return true
	}})
}

// Err returns the collected errors, or nil.
func (v *Validator) Err() error {
	if len(*v.errs) == 0 {
		return nil
	}
	return *v.errs
}

// ValidationExtension is implemented by applications to add checks to a generated type (option
// validation-hooks). Generated ValidateWith methods call it after their own checks, with the
// validator positioned at the value; it can only add errors. It runs on values that decoded
// completely (also when sibling values failed, with ServerOptions.CollectErrors), never on
// partially decoded values or while a union variant is being selected.
type ValidationExtension interface {
	ValidateExtension(v *Validator)
}

// Validatable is implemented by every generated type.
type Validatable interface{ Validate() error }

// ValidatableWith is implemented by every generated type: ValidateWith records the violations
// of the value's constraints (and of its application checks) at v's position.
type ValidatableWith interface{ ValidateWith(v *Validator) }

// ---------------------------------------------------------------------------------------------
// checks used by generated code

// MinLength checks the length in Unicode code points (JSON Schema semantics).
func MinLength(v *Validator, s string, n int) {
	if l := utf8.RuneCountInString(s); l < n {
		v.addValue("minLength", n, s, "length %d is less than %d", l, n)
	}
}

// MaxLength checks the length in Unicode code points.
func MaxLength(v *Validator, s string, n int) {
	if l := utf8.RuneCountInString(s); l > n {
		v.addValue("maxLength", n, s, "length %d is greater than %d", l, n)
	}
}

// CompilePattern compiles the RE2 translation of a declared (ECMAScript) pattern; violations
// report the declared pattern as the constraint's limit.
func CompilePattern(declared, re2 string) *regexp.Regexp {
	re := regexp.MustCompile(re2)
	patternSources.Store(re, declared)
	return re
}

var patternSources sync.Map // *regexp.Regexp → declared pattern

// Pattern checks a regular expression (unanchored search, as in JSON Schema).
func Pattern(v *Validator, s string, re *regexp.Regexp) {
	// Code-point matching, as ECMAScript regular expressions in Unicode mode (JSON Schema 2020-12).
	if !re.MatchString(s) {
		limit := re.String()
		if declared, ok := patternSources.Load(re); ok {
			limit = declared.(string)
		}
		v.addValue("pattern", limit, s, "%q does not match pattern %q", s, re.String())
	}
}

// MinItems checks the number of array items.
func MinItems[T any](v *Validator, xs []T, n int) {
	if len(xs) < n {
		v.addValue("minItems", n, len(xs), "%d items is fewer than %d", len(xs), n)
	}
}

// MaxItems checks the number of array items.
func MaxItems[T any](v *Validator, xs []T, n int) {
	if len(xs) > n {
		v.addValue("maxItems", n, len(xs), "%d items is more than %d", len(xs), n)
	}
}

// Minimum checks x >= bound (exclusive: x > bound) for ordered Go numbers.
func Minimum[T cmp.Ordered](v *Validator, x, bound T, exclusive bool) {
	if exclusive && !(x > bound) {
		v.addValue("exclusiveMinimum", bound, x, "%v is not greater than %v", x, bound)
	} else if !exclusive && x < bound {
		v.addValue("minimum", bound, x, "%v is less than %v", x, bound)
	}
}

// Maximum checks x <= bound (exclusive: x < bound).
func Maximum[T cmp.Ordered](v *Validator, x, bound T, exclusive bool) {
	if exclusive && !(x < bound) {
		v.addValue("exclusiveMaximum", bound, x, "%v is not less than %v", x, bound)
	} else if !exclusive && x > bound {
		v.addValue("maximum", bound, x, "%v is greater than %v", x, bound)
	}
}

// Unsatisfiable records a constraint that no value of the Go type can satisfy (for example
// @minValue(300) on an int8 property), so that such values are never accepted silently.
func Unsatisfiable(v *Validator, constraint, bound string) {
	v.Add(constraint, "no value satisfies %s %s", constraint, bound)
}

// RatBound is an exact decimal bound for Integer/Decimal checks.
func RatBound(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("tsgo: invalid bound " + s)
	}
	return r
}

// MinimumRat checks an exact bound for Integer and Decimal values.
func MinimumRat(v *Validator, x *big.Rat, bound *big.Rat, exclusive bool) {
	if x == nil {
		v.Add("number", "expected a finite number")
		return
	}
	c := x.Cmp(bound)
	if exclusive && c <= 0 {
		v.addValue("exclusiveMinimum", bound.RatString(), x.RatString(), "%s is not greater than %s", x.RatString(), bound.RatString())
	} else if !exclusive && c < 0 {
		v.addValue("minimum", bound.RatString(), x.RatString(), "%s is less than %s", x.RatString(), bound.RatString())
	}
}

// MaximumRat checks an exact bound for Integer and Decimal values.
func MaximumRat(v *Validator, x *big.Rat, bound *big.Rat, exclusive bool) {
	if x == nil {
		v.Add("number", "expected a finite number")
		return
	}
	c := x.Cmp(bound)
	if exclusive && c >= 0 {
		v.addValue("exclusiveMaximum", bound.RatString(), x.RatString(), "%s is not less than %s", x.RatString(), bound.RatString())
	} else if !exclusive && c > 0 {
		v.addValue("maximum", bound.RatString(), x.RatString(), "%s is greater than %s", x.RatString(), bound.RatString())
	}
}

// IntegerRat converts an Integer for MinimumRat/MaximumRat.
func IntegerRat(i Integer) *big.Rat { return new(big.Rat).SetInt(i.Big()) }

// DecimalRat converts a Decimal for MinimumRat/MaximumRat.
func DecimalRat(d Decimal) *big.Rat { return d.Rat() }

// Decimal128 checks that d fits IEEE 754 decimal128 (34 significant digits, exponent range).
func Decimal128(v *Validator, d Decimal) {
	p, _ := parseDecimalParts(d.String())
	if len(p.digits) > 34 {
		v.Add("decimal128", "%s has more than 34 significant digits", truncateNumber(d.String()))
	} else if len(p.digits) != 0 && (p.exp-1 > 6144 || p.exp-int64(len(p.digits)) < -6176) {
		// The smallest quantum is 10^-6176. Subnormal numbers are valid when their
		// coefficient is integral at that scale. The largest adjusted exponent is 6144.
		v.Add("decimal128", "%s is outside the decimal128 exponent range", truncateNumber(d.String()))
	}
}

// SafeInt checks the IEEE 754 safe integer range (TypeSpec safeint).
func SafeInt(v *Validator, x int64) {
	const max int64 = 1<<53 - 1
	if x > max || x < -max {
		v.addValue("safeint", max, x, "%d is outside the safe integer range", x)
	}
}

// URL checks that s is an absolute URL (TypeSpec url).
func URL(v *Validator, s string) {
	if err := checkURL(s); err != nil {
		v.addValue("url", nil, s, "%v", err)
	}
}

// OneOf checks enum membership for closed enums.
func OneOf[T comparable](v *Validator, x T, allowed ...T) {
	for _, a := range allowed {
		if x == a {
			return
		}
	}
	v.addValue("enum", allowed, x, "%v is not one of %v", x, allowed)
}

// Finite enforces the JSON number domain for Go values constructed by applications.
func Finite(v *Validator, x float64) {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		v.Add("number", "expected a finite number")
	}
}
