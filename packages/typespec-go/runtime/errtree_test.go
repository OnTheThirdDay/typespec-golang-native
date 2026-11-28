package tsgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// An independent model of error trees: every tree is built together with the
// problems, failed positions and partial-validation behaviour expected of it, derived from how it
// was composed, never from walkErrors.

type wantProblem struct {
	kind, location, parameter, path, constraint, allowed, message string
	unions                                                        []UnionChoice
	request                                                       bool // a request error applies
}

func (w wantProblem) String() string {
	var u []string
	for _, c := range w.unions {
		u = append(u, c.Path+"="+c.Variant)
	}
	return strings.Join([]string{w.kind, w.location, w.parameter, w.path, w.constraint, w.allowed, strings.Join(u, ","), w.message}, "|")
}

type modelTree struct {
	name     string
	err      error
	problems []wantProblem
	failed   []string
}

func gotProblem(d ErrorDetail) string {
	allowed := ""
	if d.Allowed != nil {
		allowed = fmt.Sprint(d.Allowed)
	}
	return wantProblem{kind: string(d.Kind), location: d.Location, parameter: d.Parameter, path: d.Path, constraint: d.Constraint, allowed: allowed, message: d.Message, unions: d.Unions}.String()
}

func baseTrees() []modelTree {
	return []modelTree{
		{name: "decode", err: WithPath("a", problemf(ProblemType, "wrong a")),
			problems: []wantProblem{{kind: "decode", path: "/a", constraint: "type", message: "wrong a"}}, failed: []string{"/a"}},
		{name: "validation", err: ValidationErrors{
			{Path: "/v", Constraint: "enum", Limit: []string{"x", "y"}, Message: "not x or y"},
			{Path: "/w", Constraint: "maxLength", Limit: 3, Message: "too long"},
		}, problems: []wantProblem{
			{kind: "validation", path: "/v", constraint: "enum", allowed: "[x y]", message: "not x or y"},
			{kind: "validation", path: "/w", constraint: "maxLength", message: "too long"},
		}, failed: []string{"/v", "/w"}},
		{name: "problem", err: &DecodeProblem{Kind: ProblemEnum, Allowed: []any{"x"}, Message: "not x"},
			problems: []wantProblem{{kind: "decode", constraint: "enum", allowed: "[x]", message: "not x"}}, failed: []string{""}},
		{name: "plain", err: errors.New("plain failure"),
			problems: []wantProblem{{kind: "decode", message: "plain failure"}}, failed: []string{""}},
		{name: "variant", err: InVariant("Cat", WithPath("n", problemf(ProblemType, "wrong n"))),
			problems: []wantProblem{{kind: "decode", path: "/n", constraint: "type", message: "wrong n", unions: []UnionChoice{{Path: "", Variant: "Cat"}}}}, failed: []string{"/n"}},
		// A truncated collection records that the whole value failed.
		{name: "recorded", err: collectionFailure([]error{WithPath(0, problemf(ProblemRange, "too big"))}, true),
			problems: []wantProblem{{kind: "decode", path: "/0", constraint: "range", message: "too big"}}, failed: []string{""}},
	}
}

func cloneProblems(ps []wantProblem) []wantProblem {
	out := slices.Clone(ps)
	for i := range out {
		out[i].unions = slices.Clone(out[i].unions)
	}
	return out
}

// wrapTree wraps t with a single fmt.Errorf wrapper, before or after its message.
func wrapTree(t modelTree, suffix bool) modelTree {
	r := modelTree{name: "wrap(" + t.name + ")", problems: cloneProblems(t.problems), failed: slices.Clone(t.failed)}
	if suffix {
		r.name, r.err = "suffix("+t.name+")", fmt.Errorf("%w (while reading)", t.err)
	} else {
		r.err = fmt.Errorf("reading: %w", t.err)
	}
	if len(t.problems) == 1 {
		r.problems[0].message = r.err.Error()
	}
	return r
}

func pathTree(t modelTree) modelTree {
	r := modelTree{name: "path(" + t.name + ")", err: WithPath("p", t.err), problems: cloneProblems(t.problems)}
	for i := range r.problems {
		r.problems[i].path = "/p" + r.problems[i].path
		for j := range r.problems[i].unions {
			r.problems[i].unions[j].Path = "/p" + r.problems[i].unions[j].Path
		}
	}
	for _, f := range t.failed {
		r.failed = append(r.failed, "/p"+f)
	}
	return r
}

// requestTree encloses t in a body or query-parameter request error; the innermost applies.
func requestTree(t modelTree, param bool) modelTree {
	r := modelTree{name: "body(" + t.name + ")", problems: cloneProblems(t.problems), failed: slices.Clone(t.failed)}
	if param {
		r.name, r.err = "param("+t.name+")", ParamError("query", "q", t.err)
	} else {
		r.err = BodyError(t.err)
	}
	for i := range r.problems {
		p := &r.problems[i]
		if p.request {
			continue
		}
		p.request = true
		if param {
			p.location, p.parameter, p.kind = "query", "q", "parameter"
		} else {
			p.location = "body"
		}
	}
	return r
}

// joinTree combines a and b with errors.Join, fmt.Errorf with two %w, or a *MultiError.
func joinTree(a, b modelTree, how int) modelTree {
	r := modelTree{}
	switch how {
	case 0:
		r.name, r.err = "join("+a.name+","+b.name+")", errors.Join(a.err, b.err)
	case 1:
		r.name, r.err = "both("+a.name+","+b.name+")", fmt.Errorf("first %w, then %w", a.err, b.err)
	default:
		r.name, r.err = "multi("+a.name+","+b.name+")", &MultiError{Errors: []error{a.err, b.err}}
	}
	r.problems = append(cloneProblems(a.problems), cloneProblems(b.problems)...)
	r.failed = append(slices.Clone(a.failed), b.failed...)
	return r
}

// randomTree composes up to depth levels of wrappers, paths, request errors and joins.
func randomTree(rng *rand.Rand, depth int) modelTree {
	bases := baseTrees()
	if depth == 0 || rng.IntN(4) == 0 {
		return bases[rng.IntN(len(bases))]
	}
	switch rng.IntN(7) {
	case 0:
		return wrapTree(randomTree(rng, depth-1), false)
	case 1:
		return wrapTree(randomTree(rng, depth-1), true)
	case 2:
		return pathTree(randomTree(rng, depth-1))
	case 3:
		return requestTree(randomTree(rng, depth-1), rng.IntN(2) == 0)
	}
	return joinTree(randomTree(rng, depth-1), randomTree(rng, depth-1), rng.IntN(3))
}

// forwardingWrap contributes no structure of its own. Its As is exactly the
// ordinary first-match Go search of its child, which may be a group.
type forwardingWrap struct {
	child   error
	queries *int
}

func (w forwardingWrap) Error() string { return "forwarded" }
func (w forwardingWrap) Unwrap() error { return w.child }
func (w forwardingWrap) As(target any) bool {
	if w.queries != nil {
		*w.queries++
	}
	return errors.As(w.child, target)
}

func forwardingTree(t modelTree) modelTree {
	r := modelTree{name: "forward(" + t.name + ")", err: forwardingWrap{child: t.err}, problems: cloneProblems(t.problems), failed: slices.Clone(t.failed)}
	if len(r.problems) == 1 {
		r.problems[0].message = "forwarded"
	}
	return r
}

type modelRequestView struct{ child error }

func (e modelRequestView) Error() string { return "opaque request" }
func (e modelRequestView) As(target any) bool {
	if re, ok := target.(**RequestError); ok {
		*re = &RequestError{Kind: ErrBody, Location: "body", Err: e.child, decoded: true}
		return true
	}
	return false
}

// Start with the independently modeled body, including its wire location and failed
// positions. The adapter changes only the single-branch display message.
func synthesizedTree(t modelTree) modelTree {
	r := requestTree(t, false)
	r.name = "view(" + t.name + ")"
	r.err = modelRequestView{t.err}
	if len(r.problems) == 1 {
		r.problems[0].message = "opaque request"
	}
	return r
}

// allTrees returns every tree of one combinator over two base trees, and random deeper ones.
func allTrees() []modelTree {
	var out []modelTree
	bases := baseTrees()
	for _, a := range bases {
		out = append(out, a, wrapTree(a, false), wrapTree(a, true), pathTree(a), requestTree(a, false), requestTree(a, true),
			wrapTree(pathTree(a), false), pathTree(wrapTree(a, true)), requestTree(requestTree(a, true), false), pathTree(requestTree(a, false)))
		for _, b := range bases {
			for how := range 3 {
				j := joinTree(a, b, how)
				out = append(out, j, wrapTree(j, false), pathTree(j), requestTree(j, true), pathTree(wrapTree(j, true)),
					pathTree(joinTree(requestTree(a, false), requestTree(b, true), how)))
			}
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 3000 {
		out = append(out, randomTree(rng, 5))
	}
	// Retain the original corpus. Exercise both adapter contracts above and below real forks,
	// including combinations with prefixes, request metadata, recorded paths and lazy views.
	original := out
	for i, tr := range original {
		forwarded, view := forwardingTree(tr), synthesizedTree(tr)
		other := bases[i%len(bases)]
		out = append(out, forwarded, view,
			pathTree(forwardingTree(joinTree(view, other, i%3))),
			synthesizedTree(joinTree(other, forwarded, (i+1)%3)))
	}
	return out
}

// failures reports at most a few failing trees, then how many failed.
type failures struct {
	t      *testing.T
	n      int // trees with any mismatch
	bad    bool
	checks int
	trees  int
}

func (f *failures) fail(format string, args ...any) {
	f.t.Helper()
	if !f.bad {
		f.n++
		f.bad = true
	}
	f.checks++
	if f.checks <= 3 {
		f.t.Errorf(format, args...)
	}
}

func (f *failures) done() {
	if f.n > 0 {
		f.t.Errorf("%d of %d trees fail (%d mismatches)", f.n, f.trees, f.checks)
	}
}

func TestErrorTreesKeepEveryProblem(t *testing.T) {
	trees := allTrees()
	f := &failures{t: t, trees: len(trees)}
	defer f.done()
	for _, tr := range trees {
		f.bad = false
		var want, got []string
		for _, p := range tr.problems {
			want = append(want, p.String())
		}
		details := Details(tr.err, 1000)
		for _, d := range details {
			got = append(got, gotProblem(d))
		}
		if !slices.Equal(got, want) {
			f.fail("%s: details\n got %q\nwant %q", tr.name, got, want)
			continue
		}
		// The bound is a prefix of the same order.
		for k := 1; k < len(details); k++ {
			b := Details(tr.err, k)
			if len(b) != k {
				f.fail("%s: Details(err, %d) = %d details", tr.name, k, len(b))
				continue
			}
			for i, d := range b {
				if gotProblem(d) != want[i] {
					f.fail("%s: Details(err, %d)[%d] = %q, want %q", tr.name, k, i, gotProblem(d), want[i])
				}
			}
		}
		if got := FailedPaths(tr.err); !slices.Equal(got, tr.failed) {
			f.fail("%s: failed paths\n got %q\nwant %q", tr.name, got, tr.failed)
		}
	}
}

// modelSkips and modelIncomplete are the partial-validation rules: positions at or below a failed
// position are not validated; application checks run only on values with no failed position at
// or below them.
func modelSkips(failed []string, p string) bool {
	return slices.ContainsFunc(failed, func(f string) bool { return f == "" || p == f || strings.HasPrefix(p, f+"/") })
}

func modelIncomplete(failed []string, p string) bool {
	return slices.ContainsFunc(failed, func(f string) bool { return p == "" || p == f || strings.HasPrefix(f, p+"/") })
}

// probes are positions around the failed ones: each, its ancestors, a child and siblings.
func probes(failed []string, problems []wantProblem) []string {
	set := map[string]bool{"": true, "/zz": true, "/p/zz": true, "/body/zz": true}
	add := func(p string) {
		for q := p; ; q = parentPointer(q) {
			set[q] = true
			if q == "" {
				break
			}
		}
		set[p+"/c"] = true
	}
	for _, f := range failed {
		add(f)
	}
	for _, p := range problems {
		add(p.path)
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

func validatorAt(v *Validator, pointer string) *Validator {
	if pointer == "" {
		return v
	}
	for _, s := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		v = v.At(s)
	}
	return v
}

// partialRun validates every probe below prefix with v and reports those whose constraints were
// checked and those whose application checks ran.
func partialRun(v *Validator, prefix string, ps []string) (checked, hooks []string) {
	for _, p := range ps {
		w := validatorAt(v, prefix+p)
		if w.RunExtensions() {
			hooks = append(hooks, p)
		}
		w.Add("probe", "%s", p)
	}
	var ves ValidationErrors
	if errors.As(v.Err(), &ves) {
		for _, e := range ves {
			checked = append(checked, strings.TrimPrefix(e.Path, prefix))
		}
	}
	return checked, hooks
}

func TestErrorTreesPartialValidation(t *testing.T) {
	trees := allTrees()
	fs := &failures{t: t, trees: len(trees)}
	defer fs.done()
	for _, tr := range trees {
		fs.bad = false
		ps := probes(tr.failed, tr.problems)
		var wantChecked, wantHooks []string
		for _, p := range ps {
			if !modelSkips(tr.failed, p) {
				wantChecked = append(wantChecked, p)
				if !modelIncomplete(tr.failed, p) {
					wantHooks = append(wantHooks, p)
				}
			}
		}
		// A value's own failures (ValidateDecoded).
		checked, hooks := partialRun(newDecodedValidator(FailedPaths(tr.err), ""), "", ps)
		if !slices.Equal(checked, wantChecked) || !slices.Equal(hooks, wantHooks) {
			fs.fail("%s (failed %q):\nchecked %q\n   want %q\nhooks %q\n want %q", tr.name, tr.failed, checked, wantChecked, hooks, wantHooks)
		}
		// The same retained body, once as a concrete request and once synthesized by As.
		for _, body := range []error{DecodedBodyError(tr.err), modelRequestView{tr.err}} {
			var f RequestFailures
			f.Stop(body, "body", true)
			v := newDecodedValidator(f.failed, "")
			if checked, hooks := partialRun(v, "/body", ps); !slices.Equal(checked, wantChecked) || !slices.Equal(hooks, wantHooks) {
				fs.fail("%s in %T: checked %q, want %q; hooks %q, want %q", tr.name, body, checked, wantChecked, hooks, wantHooks)
			}
		}
	}
}

// formatted counts how often its message is formatted.
type formatted struct{ n *int }

func (e formatted) Error() string { *e.n++; return "counted" }

func TestErrorTreeBoundsStopFormatting(t *testing.T) {
	var n int
	err := fmt.Errorf("x: %w", errors.Join(WithPath("a", problemf(ProblemType, "wrong a")), formatted{&n}, BodyError(formatted{&n})))
	n = 0 // fmt.Errorf formats its operands once
	if d := Details(err, 1); len(d) != 1 || d[0].Path != "/a" || n != 0 {
		t.Fatalf("%+v, formatted %d times", d, n)
	}
	if d := Details(err, 2); len(d) != 2 || n != 1 {
		t.Fatalf("%+v, formatted %d times", d, n)
	}
	n = 0
	FailedPaths(err)
	if n != 0 {
		t.Fatalf("failed positions formatted messages %d times", n)
	}
	// Failed positions beyond the bound: the whole value counts as failed, and the walk stops.
	var many []error
	for i := range MaxCollectedErrors * 3 {
		many = append(many, WithPath(i, problemf(ProblemType, "wrong")))
	}
	if f := FailedPaths(fmt.Errorf("x: %w", errors.Join(many...))); !slices.Equal(f, []string{""}) {
		t.Fatalf("%d failed paths", len(f))
	}
}

func TestMergeKeepsEveryValidationError(t *testing.T) {
	inner := func(p string) error { return ValidationErrors{{Path: p, Constraint: "minimum", Message: "small"}} }
	v := NewValidator()
	v.At("child").Merge(fmt.Errorf("nested: %w", errors.Join(inner("/a"), inner("/b"), errors.New("broken"))))
	var ves ValidationErrors
	if !errors.As(v.Err(), &ves) || len(ves) != 3 || ves[0].Path != "/child/a" || ves[1].Path != "/child/b" || ves[2].Constraint != "invalid" || ves[2].Message != "broken" {
		t.Fatalf("%v", v.Err())
	}
}

func TestProblemResponsesListEveryValidationError(t *testing.T) {
	v := func(p string) error { return ValidationErrors{{Path: p, Constraint: "minimum", Message: "small"}} }
	err := errors.Join(ParamError("query", "q", v("")), ValidationRequestError(fmt.Errorf("checks: %w", errors.Join(v("/body/a"), v("/body/b")))))
	for _, handler := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(0)} {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("GET", "/", nil), err)
		var problem Problem
		if json.Unmarshal(rec.Body.Bytes(), &problem) != nil || len(problem.Errors) != 3 || problem.Errors[1].Path != "/body/a" || problem.Errors[2].Path != "/body/b" {
			t.Fatalf("%s", rec.Body.String())
		}
	}
}
