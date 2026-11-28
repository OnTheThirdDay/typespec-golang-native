package tsgo_test

import (
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"

	rt "typespecgo/runtime"
)

type counterError struct {
	name  string
	calls int
}

func (e *counterError) Error() string {
	e.calls++
	return e.name
}

type countingWrap struct {
	cause  error
	unwrap int
}

func (e *countingWrap) Error() string { return "wrapper" }

func (e *countingWrap) Unwrap() error {
	e.unwrap++
	return e.cause
}

func TestIndependentPlainJoinAndBounds(t *testing.T) {
	a, b := &counterError{name: "disk read"}, &counterError{name: "socket read"}
	group := errors.Join(a, b)
	multi := &rt.MultiError{Errors: []error{a, b}}
	for _, pair := range []struct {
		name string
		err  error
	}{{"standard", group}, {"MultiError", multi}} {
		d := rt.Details(pair.err, 0)
		if len(d) != 2 || d[0].Err != a || d[1].Err != b {
			t.Errorf("%s: %d details, messages %q", pair.name, len(d), messages(d))
		}
	}
	structLeaf := rt.WithPath("x", rt.RequiredError("missing x"))
	flat, nested := rt.Details(errors.Join(a, b, structLeaf), 0), rt.Details(errors.Join(group, structLeaf), 0)
	if !slices.Equal(messages(flat), messages(nested)) {
		t.Errorf("association changed errors: flat %q, nested %q", messages(flat), messages(nested))
	}
	a.calls, b.calls = 0, 0
	d := rt.Details(group, 1)
	if len(d) != 1 || a.calls != 1 || b.calls != 0 || d[0].Message != "disk read" {
		t.Errorf("max=1: reads %d/%d, details %+v", a.calls, b.calls, d)
	}
	tail := &countingWrap{cause: io.EOF}
	rt.Details(errors.Join(a, tail, structLeaf), 1)
	if tail.unwrap > 0 {
		t.Errorf("unreported branch unwrapped %d time(s)", tail.unwrap)
	}
	queries := 0
	adapter := &projectedError{view: func(any) bool {
		queries++
		return false
	}}
	rt.Details(errors.Join(a, adapter), 1)
	if queries != 0 {
		t.Errorf("unreported branch received %d As calls", queries)
	}
}

func messages(ds []rt.ErrorDetail) []string {
	var r []string
	for _, d := range ds {
		r = append(r, d.Message)
	}
	return r
}

func TestSingleProblemAndOriginalGroupContext(t *testing.T) {
	leaf := rt.EnumError("other", "open", "closed")
	single := fmt.Errorf("while importing row 17: %w", rt.WithPath("state", leaf))
	d := rt.Details(single, 1)
	if len(d) != 1 || d[0].Path != "/state" || d[0].Constraint != "enum" || d[0].Message != single.Error() {
		t.Errorf("single structured problem %q", messages(d))
	}
	plain := fmt.Errorf("disk: %w", io.ErrUnexpectedEOF)
	wrappedSingle := fmt.Errorf("input %w (line 8)", rt.BodyError(plain))
	d = rt.Details(wrappedSingle, 4)
	if len(d) != 1 || d[0].Location != "body" || d[0].Message != wrappedSingle.Error() {
		t.Errorf("single plain problem below body %q", messages(d))
	}
	batch := fmt.Errorf("whole batch [%w] (row 7)", errors.Join(rt.WithPath("read", plain), rt.WithPath("status", leaf)))
	formatted := batch.Error()
	d = rt.Details(batch, 4)
	if len(d) != 2 || strings.Contains(d[0].Message, "row 7") || strings.Contains(d[1].Message, "row 7") || d[0].Err != plain || !errors.Is(d[0].Err, io.ErrUnexpectedEOF) || !errors.Is(batch, leaf) || !errors.Is(rt.WithPath("import", batch), batch) || !strings.Contains(formatted, "row 7") {
		t.Errorf("group identity %q %v", formatted, d)
	}
	nested := &rt.MultiError{Errors: []error{errors.New("earlier"), batch}}
	if !errors.Is(nested, batch) {
		t.Error("original branch inaccessible")
	}
	if nested.Error() != "earlier" {
		t.Fatalf("first-failure message = %q", nested.Error())
	}
}

func TestMergePreservesApplicationCause(t *testing.T) {
	origin := rt.NewValidator()
	business := errors.New("bad sku")
	origin.At("sku").AddErrorValue("customer-rule", "sku-x", business)
	ioCause := fmt.Errorf("reading notes: %w", io.ErrUnexpectedEOF)
	batch := fmt.Errorf("batch A: %w", errors.Join(origin.Err(), rt.WithPath("notes", ioCause)))
	v := rt.NewValidator()
	v.At("order").Merge(batch)
	merged := v.Err()
	md := rt.Details(merged, 0)
	if len(md) != 2 || md[0].Path != "/order/sku" || md[1].Path != "/order/notes" || md[0].Err != business || !errors.Is(merged, business) || md[0].Value != "sku-x" || md[1].Constraint != "invalid" {
		t.Fatalf("merge data %+v", md)
	}
	if !errors.Is(merged, io.ErrUnexpectedEOF) || md[1].Err != ioCause {
		t.Errorf("merged I/O cause reachable=%v, detail.Err=%v, merged text %q", errors.Is(merged, io.ErrUnexpectedEOF), md[1].Err, merged.Error())
	}
}

func TestDecodedRequestJoinedOnEitherSideOfBodyWrapper(t *testing.T) {
	a, b := rt.WithPath("first", rt.RequiredError("absent first")), rt.WithPath("second", rt.RequiredError("absent second"))
	for _, f := range []struct {
		name string
		err  error
	}{
		{"body_of_join", rt.DecodedBodyError(errors.Join(a, b))}, {"join_of_bodies", fmt.Errorf("two fields: %w", errors.Join(rt.DecodedBodyError(a), rt.DecodedBodyError(b)))},
	} {
		if got := rt.FailedPaths(f.err); !slices.Equal(got, []string{"/first", "/second"}) {
			t.Fatalf("%s failed paths %v", f.name, got)
		}
		var fs rt.RequestFailures
		fs.Stop(f.err, "body", true)
		out := fs.Err(func(v *rt.Validator) {
			for _, x := range []string{"first", "second", "good"} {
				child := v.At("body").At(x)
				if child.RunExtensions() != (x == "good") {
					t.Errorf("%s: hook eligible at %s = %t", f.name, child.Path(), child.RunExtensions())
				}
				child.Add("probe", "checking")
			}
		})
		if ds := rt.Details(out, 9); len(ds) != 3 || ds[len(ds)-1].Path != "/body/good" {
			t.Errorf("%s details %v", f.name, ds)
		}
	}
}

func TestWalkVisitsEachWrapperOnce(t *testing.T) {
	for _, depth := range []int{1, 8, 128} {
		var wraps []*countingWrap
		var e error = rt.WithPath("field", rt.RequiredError("missing"))
		for i := 0; i < depth; i++ {
			w := &countingWrap{cause: e}
			wraps = append(wraps, w)
			e = w
		}
		ds := rt.Details(e, 1)
		if len(ds) != 1 || ds[0].Path != "/field" {
			t.Fatal(ds)
		}
		for i, w := range wraps {
			if w.unwrap != 1 {
				t.Errorf("depth %d, wrapper %d: called Unwrap %d times", depth, i, w.unwrap)
			}
		}
	}
}

func TestLimitsPreservePrefixOnStructuredJoins(t *testing.T) {
	var list []error
	for i := 0; i < rt.MaxCollectedErrors+2; i++ {
		list = append(list, rt.WithPath(i, rt.RequiredError("absent")))
	}
	e := errors.Join(list...)
	for _, max := range []int{-1, 0, 1, 3, rt.MaxCollectedErrors + 5} {
		ds := rt.Details(e, max)
		want := max
		if want <= 0 {
			want = rt.MaxCollectedErrors
		}
		if want > len(list) {
			want = len(list)
		}
		if len(ds) != want {
			t.Fatalf("limit %d got %d", max, len(ds))
		}
		for i, d := range ds {
			if d.Path != "/"+fmt.Sprint(i) || d.Constraint != "required" {
				t.Fatalf("wrong detail at %d: %+v", i, d)
			}
		}
	}
	if ps := rt.FailedPaths(e); len(ps) != 1 || ps[0] != "" {
		t.Fatalf("over-limit failed paths %v", ps)
	}
	exact := rt.FailedPaths(errors.Join(list[:rt.MaxCollectedErrors]...))
	if len(exact) != rt.MaxCollectedErrors || exact[len(exact)-1] != fmt.Sprintf("/%d", rt.MaxCollectedErrors-1) {
		t.Fatalf("failed positions at the limit: %q", exact)
	}
	tail := &countingWrap{cause: io.EOF}
	list[len(list)-1] = tail
	group := errors.Join(list...)
	body := rt.DecodedBodyError(group)
	tail.unwrap = 0 // constructing a body error classifies HTTP size failures
	rt.FailedPaths(group)
	var f rt.RequestFailures
	f.Stop(body, "body", true)
	if tail.unwrap != 0 {
		t.Fatalf("overflow visited a later failure %d times", tail.unwrap)
	}
	f.Err(func(v *rt.Validator) {
		if v.At("body").At("later").RunExtensions() {
			t.Error("overflow authorized validation of an unvisited body field")
		}
	})
}

// The same adapter type can be opaque or expose concrete children. Only the opaque form publishes a view.
type projectedError struct {
	view   func(any) bool
	causes []error
}

func (e *projectedError) Error() string      { return "domain failure" }
func (e *projectedError) As(target any) bool { return e.view(target) }
func (e *projectedError) Unwrap() []error    { return e.causes }

func TestAsViewsPreserveSiblingOrderAndActualCauses(t *testing.T) {
	app := errors.New("blocked")
	entry := rt.ValidationError{Path: "/sku", Constraint: "policy", Message: "reserved SKU", Err: app}
	es := rt.ValidationErrors{entry}
	for _, shape := range []string{"list", "list pointer", "entry", "entry pointer"} {
		t.Run(shape, func(t *testing.T) {
			err := &projectedError{view: func(target any) bool {
				switch p := target.(type) {
				case *rt.ValidationErrors:
					if shape == "list" {
						*p = es
						return true
					}
				case **rt.ValidationErrors:
					if shape == "list pointer" {
						*p = &es
						return true
					}
				case *rt.ValidationError:
					if shape == "entry" {
						*p = entry
						return true
					}
				case **rt.ValidationError:
					if shape == "entry pointer" {
						*p = &entry
						return true
					}
				}
				return false
			}}
			source := rt.WithPath("row", errors.Join(rt.WithPath("before", io.EOF), err, rt.WithPath("after", io.ErrShortWrite)))
			ds := rt.Details(source, 0)
			if len(ds) != 3 || ds[0].Path != "/row/before" || ds[1].Path != "/row/sku" || ds[2].Path != "/row/after" ||
				ds[1].Constraint != "policy" || ds[1].Message != "domain failure" || ds[1].Err != app {
				t.Fatalf("details %+v", ds)
			}
			if got := rt.FailedPaths(source); !slices.Equal(got, []string{"/row/before", "/row/sku", "/row/after"}) {
				t.Fatalf("failed paths %q", got)
			}
			v := rt.NewValidator()
			v.At("order").Merge(source)
			got := v.Err().(rt.ValidationErrors)
			if len(got) != 3 || got[1].Path != "/order/row/sku" || got[1].Message != entry.Message || got[1].Err != app ||
				!errors.Is(got, app) || !errors.Is(got, io.EOF) || !errors.Is(got, io.ErrShortWrite) || !errors.Is(entry, app) {
				t.Fatalf("merged violations %+v", got)
			}
		})
	}
}

func TestAsViewsOfParserAndRequestErrors(t *testing.T) {
	parser := rt.FormatError("decimal", io.ErrUnexpectedEOF)
	err := &projectedError{view: func(target any) bool {
		p, ok := target.(**rt.DecodeProblem)
		if ok {
			*p = parser.(*rt.DecodeProblem)
		}
		return ok
	}}
	partial := rt.DecodedBodyError(rt.WithPath("amount", err)).(*rt.RequestError)
	body := &projectedError{view: func(target any) bool {
		p, ok := target.(**rt.RequestError)
		if ok {
			*p = partial
		}
		return ok
	}}
	source := rt.WithPath("order", body)
	ds := rt.Details(source, 0)
	if len(ds) != 1 || ds[0].Path != "/order/amount" || ds[0].Location != "body" || ds[0].Expected != "decimal" ||
		ds[0].Constraint != "format" || !errors.Is(ds[0].Err, io.ErrUnexpectedEOF) {
		t.Fatalf("details %+v", ds)
	}
	merged := rt.NewValidator()
	merged.Merge(source)
	if !errors.Is(merged.Err(), body) || !errors.Is(merged.Err(), io.ErrUnexpectedEOF) {
		t.Fatal("merge lost the adapter or its projected parser cause")
	}
	var fs rt.RequestFailures
	fs.Stop(source, "body", true)
	fs.Err(func(v *rt.Validator) {
		order := v.At("body").At("order")
		if order.At("amount").RunExtensions() || !order.At("total").RunExtensions() {
			t.Error("lost projected body failures")
		}
	})
	// Here the adapter also has a real child. The concrete I/O failure is authoritative.
	self := &projectedError{causes: []error{io.EOF}}
	self.view = func(target any) bool {
		p, ok := target.(**rt.RequestError)
		if ok {
			*p = &rt.RequestError{Kind: rt.ErrParameter, Location: "query", Name: "q", Err: self}
		}
		return ok
	}
	d := rt.Details(self, 1)
	if len(d) != 1 || d[0].Parameter != "" || d[0].Kind != rt.ErrorDecode || !errors.Is(d[0].Err, io.EOF) {
		t.Fatalf("self-classifying adapter %+v", d)
	}
}

func TestMixedRequestFailureExcludesEntireSegment(t *testing.T) {
	partial := rt.DecodedBodyError(rt.WithPath("bad", io.EOF))
	transport := rt.BodyError(io.ErrUnexpectedEOF)
	for _, source := range []error{errors.Join(partial, transport), errors.Join(transport, partial), errors.Join(partial, io.ErrShortWrite)} {
		var fs rt.RequestFailures
		fs.Stop(source, "body", true)
		fs.Err(func(v *rt.Validator) {
			if v.At("body").At("other").RunExtensions() || !v.At("query:q").RunExtensions() {
				t.Fatal("validation ran on an unread body or skipped an independent parameter")
			}
			v.At("body").At("other").Add("probe", "unread")
			if v.Err() != nil {
				t.Fatal(v.Err())
			}
		})
	}
	var fs rt.RequestFailures
	if fs.Stop(nil, "body", true) || fs.Stop(nil, "body", false) || fs.Failed() || len(rt.FailedPaths(nil)) != 0 {
		t.Fatal("nil failure was recorded")
	}
}

func TestRecordedFailuresOutsideRequestWrappers(t *testing.T) {
	first := rt.DecodedBodyError(rt.WithPath("first", io.EOF))
	second := rt.DecodedBodyError(rt.WithPath("second", io.ErrShortWrite))
	for _, tc := range []struct {
		name           string
		group          error
		siblingDecoded bool
	}{
		{"two retained", errors.Join(first, second), true},
		{"transport last", errors.Join(first, rt.BodyError(io.ErrUnexpectedEOF)), false},
		{"transport first", errors.Join(rt.BodyError(io.ErrUnexpectedEOF), second), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := rt.WithPath("row", rt.WithPartial(tc.group, struct{}{}))
			var f rt.RequestFailures
			f.Stop(err, "body", true)
			f.Err(func(v *rt.Validator) {
				row := v.At("body").At("row")
				if row.At("first").RunExtensions() || row.At("second").RunExtensions() ||
					row.At("sibling").RunExtensions() != tc.siblingDecoded || !v.At("query:q").RunExtensions() {
					t.Fatal("partial validation disagrees with the recorded positions or transport state")
				}
			})
		})
	}
}

// A slice-valued adapter has no comparable Go identity. Each normal view has a real
// successor. An empty view instead manufactures another copy of itself.
type requestView []error

func (e requestView) Error() string { return "request view" }

func (e requestView) As(target any) bool {
	r, ok := target.(**rt.RequestError)
	if ok {
		var cause error = requestView{}
		if len(e) != 0 {
			cause = e[0]
		}
		*r = rt.DecodedBodyError(cause).(*rt.RequestError)
	}
	return ok
}

func TestNestedAndSelfClassifyingRequestViews(t *testing.T) {
	leaf := rt.WithPath("bad", rt.RequiredError("missing"))
	pair := requestView{requestView{leaf}}
	for i, err := range []error{pair, errors.Join(pair, pair)} {
		ds := rt.Details(err, 0)
		if len(ds) != i+1 {
			t.Fatalf("got %d details, want %d", len(ds), i+1)
		}
		for _, d := range ds {
			if d.Path != "/bad" || d.Constraint != "required" || d.Location != "body" {
				t.Fatalf("nested view lost its actual failure: %+v", d)
			}
		}
	}
	// The same adapter may appear on independent branches.
	if paths := rt.FailedPaths(errors.Join(pair, pair)); !slices.Equal(paths, []string{"/bad", "/bad"}) {
		t.Fatalf("failed paths %q", paths)
	}
	var f rt.RequestFailures
	f.Stop(rt.WithPath("row", requestView{}), "body", true)
	f.Err(func(v *rt.Validator) {
		if v.At("body").At("other").RunExtensions() {
			t.Error("a nonterminating synthesized request view authorized partial validation")
		}
	})
}

// Application projections cannot reinterpret even a group containing exclusively plain I/O causes.
func TestAdapterWithPlainChildrenKeepsThem(t *testing.T) {
	calls := 0
	g := &projectedError{causes: []error{io.EOF, io.ErrShortWrite}, view: func(target any) bool {
		calls++
		if e, ok := target.(*rt.ValidationErrors); ok {
			*e = rt.ValidationErrors{{Path: "/invented", Constraint: "rule", Message: "view"}}
			return true
		}
		return false
	}}
	source := rt.WithPath("row", g)
	ds := rt.Details(source, 0)
	if len(ds) != 2 || ds[0].Err != io.EOF || ds[1].Err != io.ErrShortWrite || ds[0].Message != "EOF" || ds[1].Path != "/row" {
		t.Fatalf("details %+v", ds)
	}
	v := rt.NewValidator()
	v.Merge(source)
	if es := v.Err().(rt.ValidationErrors); len(es) != 2 || es[0].Constraint != "invalid" || es[1].Path != "/row" || !errors.Is(es, io.EOF) || !errors.Is(es, io.ErrShortWrite) {
		t.Fatalf("merge %+v", es)
	}
	if calls != 0 {
		t.Fatalf("consulted an adapter with real children %d times", calls)
	}
}
