package tsgo

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// JSONKind is the kind of a JSON value, determined from its first significant byte.
type JSONKind int

// The JSON kinds. ProbeJSONKind is adapted from the Azure TypeSpec Go emitter
// (github.com/Azure/typespec-azure packages/typespec-go/src/codegen/core/unions.ts, commit
// 6d580c6702b01dc587a9948cb03c9c3350dda89b, MIT License).
const (
	KindUnknown JSONKind = iota
	KindObject
	KindArray
	KindString
	KindNumber
	KindBool
	KindNull
	KindEmpty
)

func (k JSONKind) String() string {
	switch k {
	case KindObject:
		return "object"
	case KindArray:
		return "array"
	case KindString:
		return "string"
	case KindNumber:
		return "number"
	case KindBool:
		return "boolean"
	case KindNull:
		return "null"
	case KindEmpty:
		return "empty input"
	}
	return "invalid JSON"
}

// ProbeJSONKind returns the kind of the JSON value in data without parsing it.
func ProbeJSONKind(data []byte) JSONKind {
	if len(data) == 0 {
		return KindEmpty
	}
	for _, b := range data {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return KindObject
		case '[':
			return KindArray
		case '"':
			return KindString
		case 't', 'f':
			return KindBool
		case 'n':
			return KindNull
		case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
			return KindNumber
		default:
			return KindUnknown
		}
	}
	return KindEmpty
}

// UnionVariant is one candidate of an undiscriminated union, tried in declaration order.
type UnionVariant struct {
	Name  string
	Kinds []JSONKind // JSON kinds the variant can accept (nil = any)
	// Consts are the variant's required constant (single-literal) properties. When no variant
	// decodes a value, they identify the variants the value was meant for, whose failures alone
	// are then reported; they never influence which variant is selected.
	Consts []UnionConst
	// Try decodes and validates data. It returns a function storing the decoded value (nil if
	// the data does not decode structurally), whether the variant accounts for every property
	// of a JSON object (see Covers), and the decoding or validation error. The validation checks
	// the declared constraints only (NewConstraintValidator): application checks never take part
	// in selecting a variant. A decoding error may carry the union holding the partially decoded
	// variant (WithPartial), kept when that variant is the one reported.
	Try func(data []byte) (commit func(), exact bool, err error)
}

// UnionConst is a constant property of a union variant: its JSON name and JSON value.
type UnionConst struct {
	Property string
	Value    string
}

// DecodeUnion implements the documented decoding policy for undiscriminated unions. Variants
// are tried in declaration order and the selected one is:
//
//  1. the first variant that decodes, validates and accounts for every property of an object;
//  2. otherwise the first variant that decodes and validates;
//  3. otherwise the first variant that decodes structurally (its constraint violations are then
//     reported by Validate, with the precise path, as for any other value).
//
// If no variant decodes, the error reports the failures of the variants whose constant
// properties the value matches: a single such variant's errors (all of them when several
// properties failed) are returned with their precise paths, each wrapped in a *VariantError, and
// with the partially decoded variant; several variants are reported as a *UnionError.
func DecodeUnion(data []byte, variants []UnionVariant) error {
	kind := ProbeJSONKind(data)
	var failed []VariantError
	var consts [][]UnionConst
	var valid, invalid func()
	for _, v := range variants {
		if v.Kinds != nil && !containsKind(v.Kinds, kind) {
			continue
		}
		commit, exact, err := v.Try(data)
		switch {
		case commit == nil:
			// Kept as values: formatting happens only if the error is reported.
			failed = append(failed, VariantError{Variant: v.Name, Err: err})
			consts = append(consts, v.Consts)
		case err != nil:
			if invalid == nil {
				invalid = commit
			}
		case exact:
			commit()
			return nil
		case valid == nil:
			valid = commit
		}
	}
	if valid != nil {
		valid()
		return nil
	}
	if invalid != nil {
		invalid()
		return nil
	}
	if len(failed) == 0 {
		return &DecodeError{Err: &DecodeProblem{Kind: ProblemUnion, Got: kind.String(), Message: fmt.Sprintf("no union variant accepts a JSON %s", kind)}}
	}
	return unionFailure(data, kind, failed, consts)
}

// unionFailure selects the variant failures worth reporting, using only the constant properties
// declared by the variants.
func unionFailure(data []byte, kind JSONKind, failed []VariantError, consts [][]UnionConst) error {
	candidates := failed
	if kind == KindObject {
		if r, err := NewObjectReader(data); err == nil {
			var matching []VariantError
			for i, f := range failed {
				if constsMatch(r.fields, consts[i]) {
					matching = append(matching, f)
				}
			}
			if len(matching) > 0 {
				candidates = matching
			} else if p, ok := sharedConstProperty(consts); ok {
				// Every variant declares this constant and the value matches none of them.
				var values []string
				for _, cs := range consts {
					for _, c := range cs {
						if c.Property == p {
							values = append(values, c.Value)
						}
					}
				}
				got := "missing"
				if raw, found := r.fields[p]; found {
					got = truncate(string(bytes.TrimSpace(raw)))
				}
				return WithPath(p, &UnionError{Kind: kind, Variants: failed, allowed: values, msg: fmt.Sprintf("%s identifies no union variant (expected %s)", got, joinLimited(values, " or "))})
			}
		}
	}
	if len(candidates) == 1 {
		return InVariant(candidates[0].Variant, candidates[0].Err)
	}
	return &DecodeError{Err: &UnionError{Kind: kind, Variants: candidates}}
}

// InVariant attributes the decoding failures of a union's identified variant to it: every
// failure (all of a *MultiError) keeps its path and is wrapped in a *VariantError; the failed
// positions and the partially decoded value are kept.
func InVariant(variant string, err error) error {
	return attribute(variant, err, false)
}

// InTaggedVariant is InVariant for the variant selected by a discriminator: messages are left
// unchanged (the discriminator names the variant).
func InTaggedVariant(variant string, err error) error {
	return attribute(variant, err, true)
}

func attribute(variant string, err error, quiet bool) error {
	switch e := err.(type) {
	case nil:
		return nil
	case *MultiError:
		out := make([]error, len(e.Errors))
		for i, x := range e.Errors {
			out[i] = attribute(variant, x, quiet)
		}
		return &MultiError{Errors: out, partialState: e.partialState}
	case *DecodeError:
		return &DecodeError{Path: e.Path, Err: &VariantError{Variant: variant, Err: e.Err, at: e.Path, quiet: quiet}, Value: e.Value, partialState: e.partialState}
	}
	return &DecodeError{Err: &VariantError{Variant: variant, Err: err, quiet: quiet}}
}

func constsMatch(fields map[string]json.RawMessage, cs []UnionConst) bool {
	for _, c := range cs {
		raw, ok := fields[c.Property]
		if !ok || !EquivalentJSON(raw, []byte(c.Value)) {
			return false
		}
	}
	return true
}

// sharedConstProperty returns the first constant property declared by every variant.
func sharedConstProperty(consts [][]UnionConst) (string, bool) {
	if len(consts) == 0 {
		return "", false
	}
	for _, c := range consts[0] {
		shared := true
		for _, cs := range consts[1:] {
			found := false
			for _, x := range cs {
				found = found || x.Property == c.Property
			}
			shared = shared && found
		}
		if shared {
			return c.Property, true
		}
	}
	return "", false
}

// VariantError is the decoding failure of one variant of an undiscriminated union.
type VariantError struct {
	Variant string
	// Err is the variant's decoding error. In a UnionError, its *DecodeError path is relative to
	// the union value; when a single variant is reported, the enclosing *DecodeError has the path.
	Err error

	at    string // path of the failure relative to the union value (Details)
	quiet bool   // the message is Err's (discriminated unions)
}

func (e *VariantError) Error() string {
	if e.quiet {
		return e.Err.Error()
	}
	return fmt.Sprintf("%v (union variant %s)", e.Err, e.Variant)
}

func (e *VariantError) Unwrap() error { return e.Err }

// UnionError reports that no variant of an undiscriminated union decodes a value. Variants holds
// the failures of the candidate variants (those consistent with the value's constant properties,
// or all variants tried when none is), in declaration order.
type UnionError struct {
	Kind     JSONKind // JSON kind of the value
	Variants []VariantError
	msg      string
	allowed  []string // constant values of the shared constant property (JSON), when it identifies none
}

// Bounds of UnionError messages: listed variants and length of each variant's message.
const (
	unionErrorVariants = 3
	unionErrorLength   = 200
)

func (e *UnionError) Error() string {
	if e.msg != "" {
		return e.msg
	}
	parts := make([]string, 0, unionErrorVariants)
	for i, v := range e.Variants {
		if i == unionErrorVariants {
			break
		}
		parts = append(parts, v.Variant+": "+truncate(fmt.Sprint(v.Err)))
	}
	s := "value matches no union variant (" + strings.Join(parts, "; ")
	if n := len(e.Variants) - unionErrorVariants; n > 0 {
		s += fmt.Sprintf("; and %d more", n)
	}
	return s + ")"
}

func truncate(s string) string {
	if len(s) <= unionErrorLength {
		return s
	}
	cut := unionErrorLength
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func joinLimited(values []string, sep string) string {
	if len(values) > 2*unionErrorVariants {
		return strings.Join(values[:2*unionErrorVariants], sep) + fmt.Sprintf("%s… (%d values)", sep, len(values))
	}
	return strings.Join(values, sep)
}

// EquivalentJSON compares complete JSON values, including nested objects and exact numbers.
func EquivalentJSON(a, b []byte) bool {
	if !json.Valid(a) || !json.Valid(b) {
		return false
	}
	if bytes.Equal(a, b) {
		return true
	}
	decode := func(data []byte) (any, error) {
		d := json.NewDecoder(bytes.NewReader(data))
		d.UseNumber()
		var v any
		err := d.Decode(&v)
		return v, err
	}
	x, err := decode(a)
	y, err2 := decode(b)
	return err == nil && err2 == nil && equalValues(x, y)
}

func equalValues(a, b any) bool {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, item := range x {
			v, found := y[k]
			if !found || !equalValues(item, v) {
				return false
			}
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !equalValues(x[i], y[i]) {
				return false
			}
		}
	case json.Number:
		y, ok := b.(json.Number)
		if !ok || x == y {
			return ok
		}
		return SameNumberText(string(x), string(y))
	default:
		return a == b
	}
	return true
}

func containsKind(ks []JSONKind, k JSONKind) bool {
	for _, x := range ks {
		if x == k {
			return true
		}
	}
	return false
}

// ErrUnsetUnion is returned when encoding or validating a union value that holds no variant.
var ErrUnsetUnion = errors.New("union value has no variant set")

// ReadDiscriminator returns the string value of the discriminator property of a JSON object.
func ReadDiscriminator(data []byte, property string) (string, error) {
	r, err := NewObjectReader(data)
	if err != nil {
		return "", err
	}
	raw, ok := r.fields[property]
	if !ok {
		return "", WithPath(property, problemf(ProblemRequired, "discriminator property is missing"))
	}
	s, err := StringCodec.Decode(raw)
	if err != nil {
		return "", WithPath(property, err)
	}
	return s, nil
}
