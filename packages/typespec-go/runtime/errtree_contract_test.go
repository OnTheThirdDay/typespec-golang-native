package tsgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"testing"
	"time"
)

func TestForwardingAdapterPreservesActualBranches(t *testing.T) {
	a := ValidationErrors{{Path: "/a", Constraint: "minimum", Message: "too small"}}
	b := WithPath("b", RequiredError("missing b"))
	var queries int
	source := WithPath("row", forwardingWrap{errors.Join(a, b), &queries})
	d := Details(source, 5)
	if len(d) != 2 || d[0].Path != "/row/a" || d[1].Path != "/row/b" || d[0].Constraint != "minimum" || d[1].Constraint != "required" {
		t.Errorf("details %+v", d)
	}
	if paths := FailedPaths(source); !slices.Equal(paths, []string{"/row/a", "/row/b"}) {
		t.Errorf("failed paths %q", paths)
	}
	verify := func(v *Validator) {
		if v.At("row").At("a").RunExtensions() || v.At("row").At("b").RunExtensions() || !v.At("row").At("ok").RunExtensions() {
			t.Error("incorrect hook eligibility")
		}
	}
	ValidateDecoded(source, verify)
	var f RequestFailures
	f.Stop(DecodedBodyError(source), "body", true)
	f.Err(func(v *Validator) { verify(v.At("body")) })
	v := NewValidator()
	v.At("data").Merge(source)
	if got := Details(v.Err(), 5); len(got) != 2 || got[0].Path != "/data/row/a" || got[1].Path != "/data/row/b" {
		t.Errorf("merge %+v", got)
	}
	if queries != 0 {
		t.Errorf("forwarding As queried %d times for a node with actual children", queries)
	}
}

// Finite even on the old implementation. The fuse turns an excessive walk into a
// test failure before it can consume the process stack or memory.
type freshRequestView struct {
	calls *int
	fuse  int
}

func (*freshRequestView) Error() string { return "opaque adapter" }
func (a *freshRequestView) As(target any) bool {
	r, ok := target.(**RequestError)
	if !ok {
		return false
	}
	*a.calls++
	if *a.calls >= a.fuse {
		return false
	}
	*r = &RequestError{Kind: ErrBody, Location: "body", decoded: true, Err: &freshRequestView{a.calls, a.fuse}}
	return true
}

func TestTraversalExhaustionSubprocess(t *testing.T) {
	const flag = "TSGO_ERROR_WALK_CHILD"
	if os.Getenv(flag) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTraversalExhaustionSubprocess$", "-test.count=1")
		cmd.Env = append(os.Environ(), flag+"=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("child %v (%v): %s", err, ctx.Err(), out)
		}
		return
	}
	var calls int
	const fuse = 512
	fresh := func() error {
		calls = 0
		return WithPath("row", &freshRequestView{&calls, fuse})
	}
	source := fresh()
	ds := Details(source, 1)
	if calls != MaxErrorTreeViews || len(ds) != 1 || ds[0].Constraint != "traversal-limit" {
		t.Errorf("synthesis used %d calls and returned %d details", calls, len(ds))
	}
	if ps := FailedPaths(fresh()); !slices.Equal(ps, []string{""}) {
		t.Errorf("unresolved input marked %q", ps)
	}
	ValidateDecoded(fresh(), func(v *Validator) {
		if v.At("other").RunExtensions() {
			t.Error("hook on unresolved input")
		}
	})
	var f RequestFailures
	f.Stop(fresh(), "body", true)
	f.Err(func(v *Validator) {
		if v.At("body").At("other").RunExtensions() || !v.At("query:q").RunExtensions() {
			t.Error("request validation crossed exhaustion boundary")
		}
	})
	v := NewValidator()
	v.At("import").Merge(fresh())
	if ds := Details(v.Err(), 1); len(ds) != 1 || ds[0].Path != "/import" || ds[0].Constraint != "traversal-limit" {
		t.Errorf("missing root traversal-limit at merge prefix, got %d details", len(ds))
	}
	for i, handler := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(1)} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest("GET", "/", nil), fresh())
		var p Problem
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || calls != MaxErrorTreeViews ||
			p.Detail != ErrErrorTreeLimit.Error() || len(p.Errors) != 1 || p.Errors[0].Constraint != "traversal-limit" ||
			len(p.Details) != i || i == 1 && p.Details[0].Kind != ErrorTraversalLimit {
			t.Errorf("HTTP %s after %d view queries", w.Body.String(), calls)
		}
	}
}

// A competing application view is deliberately unrelated to the actual children.
type competingGroup struct {
	children                     []error
	statusQueries, detailQueries int
}

func (*competingGroup) Error() string     { return "group context" }
func (g *competingGroup) Unwrap() []error { return g.children }
func (g *competingGroup) As(target any) bool {
	switch t := target.(type) {
	case **RequestError:
		g.statusQueries++
		*t = &RequestError{Kind: ErrContentType, Location: "header", Name: "Content-Type"}
		return true
	case *ValidationErrors:
		g.detailQueries++
		*t = ValidationErrors{{Path: "/invented", Message: "invented"}}
		return true
	default:
		g.detailQueries++
		return false
	}
}

func TestWrapperStatusPreservesActualProblems(t *testing.T) {
	business := errors.New("business rule")
	g := &competingGroup{children: []error{
		ParamError("query", "q", ValidationErrors{{Path: "/one", Constraint: "rule", Message: "first", Err: business}}),
		BodyError(WithPath("two", FormatError("number", io.ErrUnexpectedEOF))),
	}}
	for i, handler := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(2)} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest("GET", "/", nil), g)
		var p Problem
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || w.Code != 415 || p.Status != 415 || p.Detail != "group context" || len(p.Errors) != 1 || p.Errors[0].Path != "/one" || p.Errors[0].Message != "first" {
			t.Fatalf("HTTP %d %s", w.Code, w.Body.String())
		}
		if len(p.Details) != 2*i || i == 1 && (p.Details[0].Location != "query" || p.Details[1].Location != "body" || p.Details[1].Path != "/two") {
			t.Fatalf("details %+v", p.Details)
		}
	}
	if paths := FailedPaths(g); !slices.Equal(paths, []string{"/one", "/two"}) {
		t.Fatalf("failed positions %q", paths)
	}
	v := NewValidator()
	v.At("batch").Merge(g)
	es := v.Err().(ValidationErrors)
	if len(es) != 2 || es[0].Path != "/batch/one" || es[0].Constraint != "rule" || es[1].Path != "/batch/two" || !errors.Is(es, business) || !errors.Is(es, io.ErrUnexpectedEOF) {
		t.Fatalf("merged %+v", es)
	}
	if g.statusQueries != 2 || g.detailQueries != 0 {
		t.Fatalf("wrapper asked for %d statuses and %d validation views", g.statusQueries, g.detailQueries)
	}
}

type statusProbe struct {
	child error
	calls *int
	kind  RequestErrorKind // zero declines the status query
}

func (*statusProbe) Error() string   { return "status probe" }
func (e *statusProbe) Unwrap() error { return e.child }
func (e *statusProbe) As(target any) bool {
	if re, ok := target.(**RequestError); ok {
		*e.calls++
		if e.kind != 0 {
			*re = &RequestError{Kind: e.kind}
			return true
		}
	}
	return false
}

func TestHTTPStatusViewBudgetPreservesDiagnostics(t *testing.T) {
	for _, match := range []int{MaxErrorTreeViews - 1, MaxErrorTreeViews} {
		calls := 0
		var children []error
		for i := 0; i <= MaxErrorTreeViews; i++ {
			probe := &statusProbe{child: ValidationError{Path: fmt.Sprintf("/%d", i), Message: "bad"}, calls: &calls}
			if i == match {
				probe.kind = ErrBodyTooLarge
			}
			children = append(children, probe)
		}
		children = append(children, Unauthenticated(errors.New("denied")))
		err := errors.Join(children...)
		for _, handler := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(1)} {
			calls = 0
			rec := httptest.NewRecorder()
			handler(rec, httptest.NewRequest("GET", "/", nil), err)
			var p Problem
			want := 401 // concrete classification if the status-only probe is beyond budget
			if match < MaxErrorTreeViews {
				want = 413
			}
			if e := json.Unmarshal(rec.Body.Bytes(), &p); e != nil || rec.Code != want || p.Status != want ||
				calls != MaxErrorTreeViews || len(p.Errors) != MaxErrorTreeViews+1 || p.Errors[match].Path != fmt.Sprintf("/%d", match) {
				t.Fatalf("match %d: HTTP %d, %d probes, %d validation entries", match, rec.Code, calls, len(p.Errors))
			}
		}
	}
}

func TestIncompleteHTTPWalkSkipsWrappingAs(t *testing.T) {
	var calls, visits, formats int
	source := &statusProbe{child: countChain(MaxErrorTreeWork, errors.New("bad"), &visits, &formats), calls: &calls, kind: ErrBodyTooLarge}
	for _, err := range []error{source, errors.Join(Unauthenticated(errors.New("denied")), source)} {
		rec := httptest.NewRecorder()
		DefaultRequestErrorHandler(rec, httptest.NewRequest("GET", "/", nil), err)
		var p Problem
		want := 401
		if err == source {
			want = 400
		}
		if e := json.Unmarshal(rec.Body.Bytes(), &p); e != nil || rec.Code != want || p.Detail != ErrErrorTreeLimit.Error() ||
			len(p.Errors) != 1 || p.Errors[0].Constraint != "traversal-limit" || calls != 0 || formats != 0 {
			t.Fatalf("HTTP %d, %d status probes, problem %s", rec.Code, calls, rec.Body.String())
		}
	}
}

func TestHTTPStatusBoundsDelegatedSearch(t *testing.T) {
	// Each adapter delegates to errors.As. On a miss the standard library then
	// unwraps again. Twelve small wrappers are enough to exceed the view budget.
	calls := 0
	var err error = ValidationError{Path: "/token", Constraint: "invalid", Message: "malformed"}
	for range 12 {
		err = forwardingWrap{child: err, queries: &calls}
	}
	for _, source := range []error{err, errors.Join(err, Unauthenticated(errors.New("denied")))} {
		calls = 0
		rec := httptest.NewRecorder()
		DetailedRequestErrorHandler(1)(rec, httptest.NewRequest("GET", "/", nil), source)
		want := 400
		if _, group := source.(interface{ Unwrap() []error }); group {
			want = 401
		}
		var p Problem
		if e := json.Unmarshal(rec.Body.Bytes(), &p); e != nil || rec.Code != want || calls > MaxErrorTreeViews ||
			len(p.Errors) != 1 || p.Errors[0].Path != "/token" || len(p.Details) != 1 || p.Details[0].Constraint != "invalid" {
			t.Fatalf("%d delegated queries, HTTP %d: %s", calls, rec.Code, rec.Body.String())
		}
	}
}

type emptyValidationView struct{}

func (emptyValidationView) Error() string { return "failed" }
func (emptyValidationView) As(target any) bool {
	if es, ok := target.(*ValidationErrors); ok {
		*es = nil
		return true
	}
	return false
}

func TestEmptyViewStillReportsOpaqueFailure(t *testing.T) {
	source := WithPath("item", emptyValidationView{})
	d := Details(source, 0)
	if len(d) != 1 || d[0].Path != "/item" || d[0].Message != "failed" || d[0].Kind != ErrorDecode {
		t.Fatalf("details %+v", d)
	}
	v := NewValidator()
	v.Merge(source)
	if v.Err() == nil {
		t.Fatal("empty As view erased failure")
	}
}

// countUnwrap returns its child without interrogating it. Its formatter is deliberately
// constant so a test can observe whether the HTTP handler attempted an incomplete summary.
type countUnwrap struct {
	child           error
	visits, formats *int
}

func (w *countUnwrap) Unwrap() error { *w.visits++; return w.child }
func (w *countUnwrap) Error() string { *w.formats++; return "wrapped" }
func countChain(n int, leaf error, visits, formats *int) error {
	for range n {
		leaf = &countUnwrap{leaf, visits, formats}
	}
	return leaf
}

func TestWorkBudgetIsIndependentOfProblemCount(t *testing.T) {
	var visits, formats int
	leaf := errors.New("leaf")
	atLimit := countChain(MaxErrorTreeWork-1, leaf, &visits, &formats)
	if ds := Details(atLimit, 1); len(ds) != 1 || ds[0].Message != "wrapped" || visits != MaxErrorTreeWork-1 {
		t.Fatalf("exact budget: %d unwraps, %+v", visits, ds)
	}
	source := &countUnwrap{child: errors.Join(WithPath("seen", leaf), atLimit, WithPath("unseen", leaf)), visits: &visits, formats: &formats}
	for _, h := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(1)} {
		visits, formats = 0, 0
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("POST", "/", nil), source)
		var p Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || p.Detail != ErrErrorTreeLimit.Error() || len(p.Errors) != 1 || p.Errors[0].Constraint != "traversal-limit" || visits > MaxErrorTreeWork || formats != 0 {
			t.Fatalf("partial HTTP summary %s, %d visits, %d format calls", rec.Body.String(), visits, formats)
		}
	}
	ds := Details(source, 8)
	if len(ds) != 2 || ds[0].Path != "/seen" || ds[1].Kind != ErrorTraversalLimit || ds[1].Path != "" || !errors.Is(ds[1].Err, ErrErrorTreeLimit) {
		t.Fatalf("prefix and limit %+v", ds)
	}
	if ps := FailedPaths(source); !slices.Equal(ps, []string{""}) {
		t.Fatalf("partial list authorized unknown siblings: %q", ps)
	}
	v := NewValidator()
	v.Merge(source)
	if !errors.Is(v.Err(), ErrErrorTreeLimit) {
		t.Fatal("merge lost exhaustion cause")
	}
	// Many groups can produce zero details while consuming the entire work budget.
	empty := make([]error, MaxErrorTreeWork+1)
	for i := range empty {
		empty[i] = ValidationErrors{}
	}
	if d := Details(errors.Join(empty...), 1); len(d) != 1 || d[0].Kind != ErrorTraversalLimit {
		t.Fatalf("empty branches %+v", d)
	}
}

func TestWorkBudgetSharedByRecordedSubtrees(t *testing.T) {
	var visits, formats int
	const branches = 64
	parts := make([]error, branches)
	for i := range parts {
		partial := &RequestError{Kind: ErrBody, Location: "body", decoded: true, Err: WithPath(i, RequiredError("bad"))}
		parts[i] = WithPartial(countChain(MaxErrorTreeWork/branches, partial, &visits, &formats), i)
	}
	visits = 0
	var f RequestFailures
	f.Stop(errors.Join(parts...), "body", true)
	f.Err(func(v *Validator) {
		if v.At("body").At("other").RunExtensions() || !v.At("query:q").RunExtensions() {
			t.Error("retention proofs did not fail closed for this segment")
		}
	})
	if visits > MaxErrorTreeWork || formats != 0 {
		t.Fatalf("proofs took %d visits, %d formats", visits, formats)
	}
}

func TestViewBudgetIsSharedAcrossSiblings(t *testing.T) {
	calls := 0
	children := make([]error, MaxErrorTreeViews+1)
	for i := range children {
		children[i] = opaqueMultiView{&RequestError{Kind: ErrBody, Err: RequiredError("absent")}, &calls}
	}
	source := errors.Join(children...)
	ds := Details(source, 2*MaxErrorTreeViews)
	if calls != MaxErrorTreeViews || len(ds) != MaxErrorTreeViews+1 || ds[len(ds)-1].Kind != ErrorTraversalLimit {
		t.Fatalf("visited %d adapters, reported %d problems", calls, len(ds))
	}
}

func TestBudgetedPrefixAndFirstError(t *testing.T) {
	var e error = RequiredError("bad")
	for range MaxErrorTreeWork + 1 {
		e = &MultiError{Errors: []error{e}}
	}
	source := WithPath("row", WithPartial(e, "partial"))
	if partial, ok := Partial[string](source); !ok || partial != "partial" {
		t.Fatal("lost native partial value")
	}
	if d := Details(source, 1); len(d) != 1 || d[0].Kind != ErrorTraversalLimit {
		t.Fatal("missing traversal limit")
	}
	if v := FirstErrors(source); !errors.Is(v, ErrErrorTreeLimit) {
		t.Fatal("unbounded fail-fast normalization")
	}
	var visits, formats int
	long := countChain(MaxErrorTreeWork, &http.MaxBytesError{Limit: 5}, &visits, &formats)
	if re := DecodedBodyError(long).(*RequestError); re.decoded || visits > MaxErrorTreeWork || formats != 0 {
		t.Fatal("unproven partial body or unbounded transport lookup")
	}
	if re := DecodedBodyError(fmt.Errorf("read: %w", &http.MaxBytesError{Limit: 5})).(*RequestError); re.StatusCode() != 413 || re.decoded {
		t.Fatal("lost ordinary size-limit classification")
	}
}

func TestValidationMessagesAcrossConsumers(t *testing.T) {
	es := ValidationErrors{{Path: "/sku", Constraint: "rule", Message: "reserved"}}
	source := fmt.Errorf("order: %w", BodyError(WithPath("row", es)))
	const display = "order: body: /row: validation failed: /sku: reserved"
	// The attributable application wrapper and HTTP summary keep their complete display text.
	// The original constraint message and separately prefixed path are the legacy validation API.
	d := Details(source, 1)
	if len(d) != 1 || d[0].Path != "/row/sku" || d[0].Message != display {
		t.Fatalf("details %+v", d)
	}
	v := NewValidator()
	v.At("import").Merge(source)
	got := v.Err().(ValidationErrors)
	if len(got) != 1 || got[0].Message != "reserved" || got[0].Path != "/import/row/sku" {
		t.Fatalf("merged %+v", got)
	}
	for _, h := range []func(http.ResponseWriter, *http.Request, error){DefaultRequestErrorHandler, DetailedRequestErrorHandler(1)} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/", nil), source)
		var p Problem
		if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Detail != display || len(p.Errors) != 1 || p.Errors[0].Message != "reserved" || p.Errors[0].Path != "/row/sku" {
			t.Fatalf("HTTP %s", w.Body.String())
		}
	}
}

type opaqueMultiView struct {
	source  *RequestError
	queries *int
}

func (m opaqueMultiView) Error() string { return "opaque" }
func (m opaqueMultiView) As(target any) bool {
	*m.queries++
	return errors.As(m.source, target)
}

func TestOpaqueRequestViewVisitsItsActualGroupOnce(t *testing.T) {
	one := ValidationErrors{{Path: "/one", Constraint: "minimum", Message: "low"}}
	two := WithPath("two", RequiredError("missing"))
	queries := 0
	view := opaqueMultiView{&RequestError{Kind: ErrBody, Location: "body", Err: errors.Join(one, two), decoded: true}, &queries}
	d := Details(view, 3)
	if queries != 1 || len(d) != 2 || d[0].Constraint != "minimum" || d[1].Constraint != "required" || d[0].Location != "body" || d[1].Location != "body" {
		t.Fatalf("%d view queries, details %+v", queries, d)
	}
	if ps := FailedPaths(view); !slices.Equal(ps, []string{"/one", "/two"}) {
		t.Errorf("failed paths %q", ps)
	}
	var f RequestFailures
	f.Stop(view, "body", true)
	f.Err(func(v *Validator) {
		body := v.At("body")
		if body.At("one").RunExtensions() || body.At("two").RunExtensions() || !body.At("other").RunExtensions() {
			t.Error("lost the request view's concrete branches")
		}
	})
}

func TestForwardingRetainedAndUnreadRequestBranches(t *testing.T) {
	left := DecodedBodyError(WithPath("left", RequiredError("missing left")))
	right := DecodedBodyError(WithPath("right", RequiredError("missing right")))
	for _, tc := range []struct {
		last          error
		otherEligible bool
	}{{right, true}, {BodyError(io.ErrUnexpectedEOF), false}} {
		queries := 0
		source := forwardingWrap{errors.Join(left, tc.last), &queries}
		var f RequestFailures
		f.Stop(source, "body", true)
		f.Err(func(v *Validator) {
			b := v.At("body")
			if b.At("left").RunExtensions() || b.At("right").RunExtensions() || b.At("other").RunExtensions() != tc.otherEligible || !v.At("query:q").RunExtensions() {
				t.Error("incorrect retained body positions")
			}
		})
		if queries != 0 {
			t.Fatal("forwarding branch was consulted for request metadata")
		}
	}
}
