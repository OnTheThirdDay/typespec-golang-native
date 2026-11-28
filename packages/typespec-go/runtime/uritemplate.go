package tsgo

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Decoding of RFC 6570 expansions (level 4) as used by TypeSpec routes. Generated routers
// match the escaped request path against a compiled template and pass each captured
// expansion here. The operator determines prefix, separator and naming:
//
//	op   prefix sep  named
//	""   ""     ","  no     {x}   simple
//	"+"  ""     ","  no     {+x}  reserved
//	"."  "."    "."  no     {.x}  label
//	"/"  "/"    "/"  no     {/x}  path segments
//	";"  ";"    ";"  yes    {;x}  matrix
//	"?"  "?"    "&"  yes    {?x}  form query (handled from url.Values)

type expansionOp struct {
	prefix, sep string
	named       bool
}

func opOf(op string) (expansionOp, error) {
	switch op {
	case "", "+":
		return expansionOp{"", ",", false}, nil
	case ".":
		return expansionOp{".", ".", false}, nil
	case "/":
		return expansionOp{"/", "/", false}, nil
	case ";":
		return expansionOp{";", ";", true}, nil
	}
	return expansionOp{}, fmt.Errorf("unsupported URI template operator %q", op)
}

func unescape(op, s string) (string, error) {
	return url.PathUnescape(s)
}

// ExpansionPresent reports whether a captured expansion holds a value (an undefined
// variable expands to the empty string).
func ExpansionPresent(raw string) bool { return raw != "" }

// SplitExpansion returns the percent-decoded items of a primitive (one item) or array value.
func SplitExpansion(raw, op, name string, explode bool) ([]string, error) {
	o, err := opOf(op)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(raw, o.prefix) {
		return nil, syntaxErrorf("expansion %q must start with %q", raw, o.prefix)
	}
	body := raw[len(o.prefix):]
	var parts []string
	if explode {
		parts = strings.Split(body, o.sep)
		if o.named {
			for i, p := range parts {
				v, ok := cutNamed(p, name)
				if !ok {
					return nil, syntaxErrorf("expected %q=..., got %q", name, p)
				}
				parts[i] = v
			}
		}
	} else {
		if o.named {
			v, ok := cutNamed(body, name)
			if !ok {
				return nil, syntaxErrorf("expected %q=..., got %q", name, body)
			}
			body = v
		}
		parts = strings.Split(body, ",")
	}
	for i, p := range parts {
		if parts[i], err = unescape(op, p); err != nil {
			return nil, err
		}
	}
	return parts, nil
}

func cutNamed(s, name string) (string, bool) {
	if s == name {
		return "", true // matrix ifemp: ";name"
	}
	v, ok := strings.CutPrefix(s, name+"=")
	return v, ok
}

// SplitExpansionPairs returns the key/value pairs of a record or model value.
func SplitExpansionPairs(raw, op, name string, explode bool) ([][2]string, error) {
	o, err := opOf(op)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(raw, o.prefix) {
		return nil, syntaxErrorf("expansion %q must start with %q", raw, o.prefix)
	}
	body := raw[len(o.prefix):]
	var out [][2]string
	if explode {
		for _, p := range strings.Split(body, o.sep) {
			k, v, ok := strings.Cut(p, "=")
			// Matrix expansions omit "=" after a key whose value is empty (RFC 6570 section 3.2.7).
			if !ok && !o.named {
				return nil, syntaxErrorf("expected key=value, got %q", p)
			}
			kk, err1 := unescape(op, k)
			vv, err2 := unescape(op, v)
			if err := errors.Join(err1, err2); err != nil {
				return nil, err
			}
			out = append(out, [2]string{kk, vv})
		}
		return out, nil
	}
	if o.named {
		v, ok := cutNamed(body, name)
		if !ok {
			return nil, syntaxErrorf("expected %q=..., got %q", name, body)
		}
		body = v
	}
	items := strings.Split(body, ",")
	if len(items)%2 != 0 {
		return nil, syntaxErrorf("record expansion %q has an odd number of items", body)
	}
	for i := 0; i < len(items); i += 2 {
		k, err1 := unescape(op, items[i])
		v, err2 := unescape(op, items[i+1])
		if err := errors.Join(err1, err2); err != nil {
			return nil, err
		}
		out = append(out, [2]string{k, v})
	}
	return out, nil
}

// ParseExpansionValue decodes a primitive expansion.
func ParseExpansionValue[T any](raw, op, name string, explode bool, tc TextCodec[T]) (T, error) {
	var zero T
	if op == "+" {
		s, err := url.PathUnescape(raw)
		if err != nil {
			return zero, err
		}
		return tc.parse(s)
	}
	items, err := SplitExpansion(raw, op, name, explode)
	if err != nil {
		return zero, err
	}
	if len(items) != 1 {
		return zero, syntaxErrorf("expected one value, got %d", len(items))
	}
	return tc.parse(items[0])
}

// ParseExpansionArray decodes an array expansion.
func ParseExpansionArray[T any](raw, op, name string, explode bool, tc TextCodec[T]) ([]T, error) {
	items, err := SplitExpansion(raw, op, name, explode)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(items))
	for _, it := range items {
		v, err := tc.parse(it)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// ParseExpansionRecord decodes a record expansion.
func ParseExpansionRecord[T any](raw, op, name string, explode bool, tc TextCodec[T]) (map[string]T, error) {
	pairs, err := SplitExpansionPairs(raw, op, name, explode)
	if err != nil {
		return nil, err
	}
	return pairsToMap(pairs, tc)
}

func pairsToMap[T any](pairs [][2]string, tc TextCodec[T]) (map[string]T, error) {
	out := make(map[string]T, len(pairs))
	for _, p := range pairs {
		if _, dup := out[p[0]]; dup {
			return nil, duplicateErrorf("duplicate key %q", p[0])
		}
		v, err := tc.parse(p[1])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p[0], err)
		}
		out[p[0]] = v
	}
	return out, nil
}

// DecodeQueryList reads a non-exploded RFC 6570 list. Literal commas delimit entries;
// a percent-encoded comma belongs to its entry. url.Values alone loses that distinction.
func DecodeQueryList[T any](rawQuery, name string, tc TextCodec[T]) ([]T, bool, error) {
	var result []T
	present := false
	for field := range strings.SplitSeq(rawQuery, "&") {
		rawKey, rawValue, _ := strings.Cut(field, "=")
		key, err := url.QueryUnescape(rawKey)
		if err != nil {
			return nil, false, err
		}
		if key != name {
			continue
		}
		if present {
			return nil, true, syntaxErrorf("repeated query parameter %q", name)
		}
		present = true
		for item := range strings.SplitSeq(rawValue, ",") {
			s, err := url.QueryUnescape(item)
			if err != nil {
				return nil, true, err
			}
			v, err := tc.parse(s)
			if err != nil {
				return nil, true, err
			}
			result = append(result, v)
		}
	}
	return result, present, nil
}

func DecodeQueryRecord[T any](rawQuery, name string, tc TextCodec[T]) (map[string]T, bool, error) {
	fields, present, err := DecodeQueryList(rawQuery, name, StringText)
	if err != nil || !present {
		return nil, present, err
	}
	if len(fields)%2 != 0 {
		return nil, true, syntaxErrorf("record parameter %q has an odd number of items", name)
	}
	pairs := make([][2]string, 0, len(fields)/2)
	for i := 0; i < len(fields); i += 2 {
		pairs = append(pairs, [2]string{fields[i], fields[i+1]})
	}
	v, err := pairsToMap(pairs, tc)
	return v, true, err
}

// QueryPairs returns the key/value pairs of a record or model query parameter: non-exploded
// as `name=k1,v1,k2,v2`, exploded as separate parameters `k1=v1&k2=v2` (every query parameter
// whose name is not in exclude, i.e. not declared by another parameter).
func QueryPairs(q url.Values, name string, explode bool, exclude []string) ([][2]string, bool, error) {
	if !explode {
		vals, ok := q[name]
		if !ok {
			return nil, false, nil
		}
		if len(vals) != 1 {
			return nil, true, syntaxErrorf("expected one value, got %d", len(vals))
		}
		items := strings.Split(vals[0], ",")
		if len(items)%2 != 0 {
			return nil, true, syntaxErrorf("record value %q has an odd number of items", vals[0])
		}
		var out [][2]string
		for i := 0; i < len(items); i += 2 {
			out = append(out, [2]string{items[i], items[i+1]})
		}
		return out, true, nil
	}
	var out [][2]string
	for _, k := range sortedKeys(q) {
		skip := false
		for _, e := range exclude {
			if e == k {
				skip = true
			}
		}
		if skip {
			continue
		}
		vals := q[k]
		if len(vals) != 1 {
			return nil, true, syntaxErrorf("%s: expected one value, got %d", k, len(vals))
		}
		out = append(out, [2]string{k, vals[0]})
	}
	return out, len(out) > 0, nil
}

// QueryRecord decodes a record query parameter.
func QueryRecord[T any](q url.Values, name string, explode bool, exclude []string, tc TextCodec[T]) (map[string]T, bool, error) {
	pairs, present, err := QueryPairs(q, name, explode, exclude)
	if err != nil || !present {
		return nil, present, err
	}
	m, err := pairsToMap(pairs, tc)
	return m, true, err
}

// QueryObject returns the fields of a flat object. Every key must occur exactly once.
func QueryObject(rawQuery string, q url.Values, name string, explode bool, exclude []string) (url.Values, bool, error) {
	var m map[string]string
	var present bool
	var err error
	if explode {
		m, present, err = QueryRecord(q, name, true, exclude, StringText)
	} else {
		m, present, err = DecodeQueryRecord(rawQuery, name, StringText)
	}
	if err != nil || !present {
		return nil, present, err
	}
	return objectFields(m), true, nil
}

// ParseExpansionObject keeps decoded property values separate for per-field typed binding.
func ParseExpansionObject(raw, op, name string, explode bool) (url.Values, error) {
	m, err := ParseExpansionRecord(raw, op, name, explode, StringText)
	if err != nil {
		return nil, err
	}
	return objectFields(m), nil
}

func objectFields(m map[string]string) url.Values {
	fields := make(url.Values, len(m))
	for key, value := range m {
		fields.Set(key, value)
	}
	return fields
}

// PairValue finds a key in decoded pairs (model parameters).
func PairValue(pairs [][2]string, key string) (string, bool) {
	for _, p := range pairs {
		if p[0] == key {
			return p[1], true
		}
	}
	return "", false
}

// RequireLiteralQuery checks literal query parameters written in a route (`/x?fixed=true{&p}`).
func RequireLiteralQuery(q url.Values, name, value string) bool {
	for _, v := range q[name] {
		if v == value {
			return true
		}
	}
	return false
}
