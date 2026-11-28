package tsgo

import (
	"math/big"
	"strconv"
	"strings"
)

// Exact parsing of untrusted decimal numbers is bounded: math/big's decimal conversion costs grow
// superlinearly with the number of digits and with the exponent (a 9-byte token such as 1e1000000
// takes tens of milliseconds), so a request of small tokens could otherwise consume minutes of
// CPU. Numbers beyond these bounds are rejected with a decode error, never approximated.
const (
	// MaxExactDigits is the maximum number of significant digits of an exact number.
	MaxExactDigits = 10000
	// MaxExactExponent is the maximum magnitude of the decimal exponent of an exact number.
	MaxExactExponent = 10000
)

// decimalParts is the canonical form of a decimal number: value = ±0.digits × 10^exp, where
// digits has no leading or trailing zeros. Zero has empty digits, exp 0 and neg false.
type decimalParts struct {
	neg    bool
	digits string
	exp    int64
}

// parseDecimalParts reads [+-]digits[.digits][(e|E)[+-]digits] in linear time.
func parseDecimalParts(s string) (decimalParts, bool) {
	var p decimalParts
	i := 0
	if i < len(s) && (s[i] == '-' || s[i] == '+') {
		p.neg = s[i] == '-'
		i++
	}
	start := i
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	intPart := s[start:i]
	frac := ""
	if i < len(s) && s[i] == '.' {
		i++
		fs := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		frac = s[fs:i]
	}
	if intPart == "" && frac == "" {
		return p, false
	}
	var e int64
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		es := i
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		ds := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if ds == i || i-ds > 18 {
			return p, false // missing or absurdly long exponent
		}
		var err error
		if e, err = strconv.ParseInt(s[es:i], 10, 64); err != nil {
			return p, false
		}
	}
	if i != len(s) {
		return p, false
	}
	all := intPart + frac
	lead := len(all) - len(strings.TrimLeft(all, "0"))
	digits := strings.TrimRight(all[lead:], "0")
	if digits == "" {
		return decimalParts{}, true
	}
	p.digits = digits
	p.exp = int64(len(intPart)-lead) + e
	return p, true
}

// SameNumberText reports whether two decimal spellings denote the same number, exactly and in
// time linear in their length (no big-number arithmetic).
func SameNumberText(a, b string) bool {
	if a == b {
		return true
	}
	x, ok := parseDecimalParts(a)
	y, ok2 := parseDecimalParts(b)
	return ok && ok2 && x == y
}

// exactRat converts a decimal spelling to an exact rational within the documented bounds.
func exactRat(s string) (*big.Rat, bool) {
	p, ok := parseDecimalParts(s)
	if !ok || !p.withinExactBounds() {
		return nil, false
	}
	if p.digits == "" {
		return new(big.Rat), true
	}
	n, _ := new(big.Int).SetString(p.digits, 10)
	if p.neg {
		n.Neg(n)
	}
	scale := p.exp - int64(len(p.digits)) // value = n × 10^scale
	pow := func(k int64) *big.Int { return new(big.Int).Exp(big.NewInt(10), big.NewInt(k), nil) }
	if scale >= 0 {
		return new(big.Rat).SetInt(n.Mul(n, pow(scale))), true
	}
	return new(big.Rat).SetFrac(n, pow(-scale)), true
}

// exactNumberText checks the bounds of an exact number without converting it.
func exactNumberText(s string) bool {
	p, ok := parseDecimalParts(s)
	return ok && p.withinExactBounds()
}

// withinExactBounds bounds the significant digits and the scientific exponent (d.ddd × 10^e).
func (p decimalParts) withinExactBounds() bool {
	if p.digits == "" {
		return true
	}
	e := p.exp - 1
	return len(p.digits) <= MaxExactDigits && e <= MaxExactExponent && e >= -MaxExactExponent
}

// truncateNumber keeps error messages small for very long numeric tokens.
func truncateNumber(s string) string {
	if len(s) > 64 {
		return s[:32] + "…" + s[len(s)-16:]
	}
	return s
}
