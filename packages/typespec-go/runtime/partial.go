package tsgo

import (
	"slices"
	"strings"
)

// Partial decoding. When a value fails to decode, its decoder keeps what did decode: the
// properties, items and record entries that decoded, and (for a union) the variant the value was
// identified as. The decoding error records, exactly, the positions whose values did not decode
// (failed, prefixed like the error's paths as it moves up) and, at a generated type's boundary
// (json.Unmarshaler), the partially decoded value. Collected-error reporting validates the parts
// that decoded and skips the failed positions, so zero values, missing properties and failed
// union candidates never produce validation errors (ValidateDecoded, RequestFailures).

// partialState is carried by *DecodeError and *MultiError.
type partialState struct {
	// failed lists the positions (JSON Pointers relative to the error's paths) whose values did not
	// decode. nil: the failing values are the error paths themselves (computed by FailedPaths).
	failed []string
	// value is the partially decoded value of a generated type (WithPartial).
	value   any
	partial bool
}

func (s partialState) prefixed(prefix string) partialState {
	if s.failed != nil {
		out := make([]string, len(s.failed))
		for i, f := range s.failed {
			out[i] = prefix + f
		}
		s.failed = out
	}
	return s
}

// withState returns a copy of err (a *DecodeError or *MultiError; another error is wrapped in a
// *DecodeError with the same message) carrying s.
func withState(err error, s partialState) error {
	switch e := err.(type) {
	case *DecodeError:
		c := *e
		c.partialState = s
		return &c
	case *MultiError:
		c := *e
		c.partialState = s
		return &c
	}
	return &DecodeError{Err: err, partialState: s}
}

// WithPartial attaches the partially decoded value of a generated type to its decoding failure
// (generated UnmarshalJSON methods). JSONCodec returns it with the error, so that the decoding
// of an enclosing value keeps it, and Partial retrieves it.
func WithPartial(err error, value any) error {
	if err == nil {
		return nil
	}
	return withState(err, partialState{failed: FailedPaths(err), value: value, partial: true})
}

// wholeFailure marks err as the failure of the whole value: none of its parts decoded.
func wholeFailure(err error) error {
	if err == nil {
		return nil
	}
	return withState(err, partialState{failed: []string{""}})
}

// collectionFailure is the failure of a collection whose other elements decoded; truncated: the
// collection stopped at MaxCollectedErrors, so the later elements were not decoded.
func collectionFailure(errs []error, truncated bool) error {
	err := joinErrors(errs)
	if truncated {
		return withState(err, partialState{failed: []string{""}})
	}
	return withState(err, partialState{failed: FailedPaths(err)})
}

// Partial returns the partially decoded value carried by the decoding failure of a value of a
// generated type T (for example the error of json.Unmarshal into a generated model).
func Partial[T any](err error) (T, bool) {
	var s partialState
	switch e := err.(type) {
	case *DecodeError:
		s = e.partialState
	case *MultiError:
		s = e.partialState
	}
	v, ok := s.value.(T)
	return v, ok && s.partial
}

// FailedPaths returns the JSON Pointers of the values that did not decode (each failing value,
// not its enclosing objects and arrays), bounded by MaxCollectedErrors.
func FailedPaths(err error) []string {
	return failedPositions(err, false)
}

// ValidateDecoded returns err with the violations that validate (the ValidateWith method of the
// partially decoded value) finds in the parts that decoded; the failed positions are skipped and
// application checks run only on values that decoded completely. The message and errors.As
// target remain err's first failure.
func ValidateDecoded(err error, validate func(v *Validator)) error {
	if err == nil || validate == nil {
		return err
	}
	v := newDecodedValidator(FailedPaths(err), "")
	validate(v)
	if verr := v.Err(); verr != nil {
		return &MultiError{Errors: []error{err, verr}}
	}
	return err
}

// decodedState is the validation state of a partially decoded value.
type decodedState struct {
	failed     map[string]bool // positions that did not decode
	incomplete map[string]bool // positions at or above a failed position
	noHooks    bool            // union variant selection: only declared constraints
}

func newDecodedValidator(failed []string, prefix string) *Validator {
	s := &decodedState{failed: map[string]bool{}, incomplete: map[string]bool{}}
	for _, f := range failed {
		f = prefix + f
		s.failed[f] = true
		for p := f; ; p = parentPointer(p) {
			s.incomplete[p] = true
			if p == "" {
				break
			}
		}
	}
	v := NewValidator()
	v.state = s
	return v
}

func parentPointer(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return ""
}

// skips reports whether p is at or below a position that did not decode.
func (s *decodedState) skips(p string) bool {
	if s == nil || len(s.failed) == 0 {
		return false
	}
	for q := p; ; q = parentPointer(q) {
		if s.failed[q] {
			return true
		}
		if q == "" {
			return false
		}
	}
}

// RequestFailures collects the failures of one request when ServerOptions.CollectErrors is set
// (generated handlers): every parameter and the body are decoded, then the parts that decoded
// are validated.
type RequestFailures struct {
	errs   []error
	failed []string
}

// Skip excludes a request position from validation when its containing transport input failed.
func (f *RequestFailures) Skip(segment string) {
	f.failed = append(f.failed, "/"+escapePointer(segment))
}

// Stop records the failure of the request value at segment ("query:limit", "body") and reports
// whether the handler stops (fail-fast reporting). The value is then not validated, except the
// parts of a body that decoded (DecodedBodyError).
func (f *RequestFailures) Stop(err error, segment string, collect bool) bool {
	if err == nil {
		return false
	}
	if !collect {
		return true
	}
	if len(f.errs) < MaxCollectedErrors {
		f.errs = append(f.errs, err)
	}
	prefix := "/" + escapePointer(segment)
	for _, p := range failedPositions(err, true) {
		f.failed = append(f.failed, prefix+p)
	}
	return false
}

// DecodedBodyError is BodyError for a body whose decoding kept the part that decoded (the
// request's Body): collected-error reporting validates that part.
func DecodedBodyError(err error) error {
	return wrapBodyError(err, true)
}

// Failed reports whether a failure was recorded.
func (f *RequestFailures) Failed() bool { return len(f.errs) > 0 }

// Err returns the recorded failures followed by the validation errors (a ValidationRequestError)
// that validate (the request's ValidateWith) finds in the values that decoded.
func (f *RequestFailures) Err(validate func(v *Validator)) error {
	errs := slices.Clone(f.errs)
	if validate != nil {
		v := newDecodedValidator(f.failed, "")
		validate(v)
		if verr := v.Err(); verr != nil {
			errs = append(errs, ValidationRequestError(verr))
		}
	}
	return joinErrors(errs)
}
