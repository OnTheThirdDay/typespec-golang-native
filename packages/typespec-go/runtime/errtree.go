package tsgo

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

// MaxErrorTreeWork bounds nodes (including child slots), validation entries and recorded
// positions examined in one walk. MaxErrorTreeViews bounds the opaque adapters queried in
// that same walk, across all branches and independently of the detail display limit.
const (
	MaxErrorTreeWork  = 16 * 1024
	MaxErrorTreeViews = 100
)

// ErrErrorTreeLimit means the runtime could not enumerate the whole failure within its budget.
var ErrErrorTreeLimit = errors.New("error traversal limit exceeded")

func traversalLimitEntry() ValidationError {
	return ValidationError{Constraint: string(ErrorTraversalLimit), Message: ErrErrorTreeLimit.Error(), Err: ErrErrorTreeLimit}
}

type treeContext struct {
	path      string
	request   *RequestError // innermost classification
	location  *RequestError // nearest explicit wire location
	decoded   bool          // the outer request on this branch retained a partial body
	wrapper   error         // outermost application wrapper since the last fork
	projected error         // causes reached through As, which need not be Go Unwrap edges
	unions    []UnionChoice
	value     json.RawMessage
	valuePath string
}

func (ctx *treeContext) wrap(err error) {
	if ctx.wrapper == nil {
		ctx.wrapper = err
	}
}

func (ctx *treeContext) project(err, view error) {
	ctx.wrap(err)
	if ctx.projected == nil {
		ctx.projected = ctx.wrapper
	}
	ctx.projected = errors.Join(ctx.projected, view)
}

type treeProblem struct {
	treeContext
	leaf       error
	validation *ValidationError
}

func (p treeProblem) position() string {
	if p.validation != nil {
		return p.path + p.validation.Path
	}
	return p.path
}

func (p treeProblem) source() error {
	if p.wrapper != nil {
		return p.wrapper
	}
	return p.leaf
}

func (p treeProblem) cause() error {
	if p.projected != nil {
		return p.projected
	}
	return p.source()
}

type treeVisitor struct {
	problem      func(treeProblem) bool
	recorded     func(treeContext, []string, error) bool // visit recorded positions in place of leaves
	firstRequest func(*RequestError) bool                // stop descending at the first request on each branch
}

type errorWalk struct {
	work, views int
	limited     bool
	first       *RequestError // first concrete or opaque request classification reached
}

func (w *errorWalk) step() bool { return w.charge(1) }

func (w *errorWalk) charge(n int) bool {
	if w.limited || n > MaxErrorTreeWork-w.work {
		w.limited = true
		return false
	}
	w.work += n
	return true
}

func (w *errorWalk) queryAdapter() bool {
	if w.views == MaxErrorTreeViews {
		w.limited = true
		return false
	}
	w.views++
	return true
}

func (w *errorWalk) enterRequest(ctx *treeContext, re *RequestError) {
	if w.first == nil {
		w.first = re
	}
	if ctx.request == nil {
		ctx.decoded = re.decoded
	}
	ctx.request = re
	if re.Location != "" {
		ctx.location = re
	}
}

// run reports exhaustion once at the root. Siblings on the pending stack can be at unrelated
// paths, so the last visited path is insufficient to authorize partial validation.
func (w *errorWalk) run(err error, v treeVisitor) {
	w.walk(err, v)
	if w.limited {
		entry := traversalLimitEntry()
		v.problem(treeProblem{validation: &entry})
	}
}

type treeFrame struct {
	ctx      treeContext
	children []error
}

func (ctx treeContext) group(children []error) treeFrame {
	if len(children) > 1 {
		ctx.wrapper, ctx.projected = nil, nil
	}
	return treeFrame{ctx, children}
}

// Depth-first in declared order. Frames retain slices of pending siblings without copying
// them or inspecting a later child after a visitor stops. Unary and synthetic edges iterate.
func (w *errorWalk) walk(err error, v treeVisitor) bool {
	return walkBranches(err, func(e error, ctx treeContext) (treeFrame, bool) { return w.branch(e, ctx, v) })
}

func walkBranches(err error, visit func(error, treeContext) (treeFrame, bool)) bool {
	stack := []treeFrame{{children: []error{err}}}
	for len(stack) > 0 {
		i := len(stack) - 1
		frame := &stack[i]
		ctx, child := frame.ctx, frame.children[0]
		frame.children = frame.children[1:]
		if len(frame.children) == 0 {
			stack = stack[:i]
		}
		next, more := visit(child, ctx)
		if !more {
			return false
		}
		if len(next.children) != 0 {
			stack = append(stack, next)
		}
	}
	return true
}

func (w *errorWalk) validation(es ValidationErrors, ctx treeContext, v treeVisitor) bool {
	if len(es) > 1 {
		ctx.wrapper, ctx.projected = nil, nil
	}
	for i := range es {
		if !w.step() || !v.problem(treeProblem{treeContext: ctx, validation: &es[i]}) {
			return false
		}
	}
	return true
}

// Only an opaque application error is eligible for As. A validation collection or entry
// is a terminal representation; an empty collection supplies no representation of a failure.
func validationView(a interface{ As(any) bool }) ValidationErrors {
	var es ValidationErrors
	if a.As(&es) && len(es) > 0 {
		return es
	}
	var list *ValidationErrors
	if a.As(&list) && list != nil && len(*list) > 0 {
		return *list
	}
	var entry ValidationError
	if a.As(&entry) {
		return ValidationErrors{entry}
	}
	var ptr *ValidationError
	if a.As(&ptr) && ptr != nil {
		return ValidationErrors{*ptr}
	}
	return nil
}

// branch follows a single chain until it yields a sibling group, a terminal problem or
// the visitor's stop signal. Known semantic leaves keep their parser/check causes as metadata.
func (w *errorWalk) branch(err error, ctx treeContext, v treeVisitor) (treeFrame, bool) {
	var done treeFrame
	for w.step() {
		switch e := err.(type) {
		case nil:
			return done, true
		case *RequestError:
			w.enterRequest(&ctx, e)
			if v.firstRequest != nil {
				return done, v.firstRequest(e)
			}
			if e.Err != nil {
				err = e.Err
				continue
			}
		case *MultiError:
			if v.recorded != nil && e.failed != nil {
				return done, v.recorded(ctx, e.failed, e)
			}
			return ctx.group(e.Errors), true
		case *DecodeError:
			if v.recorded != nil && e.failed != nil {
				return done, v.recorded(ctx, e.failed, e)
			}
			ctx.path += e.Path
			if e.Value != nil {
				ctx.value, ctx.valuePath = e.Value, ctx.path
			}
			if e.Err != nil {
				err = e.Err
				continue
			}
		case *VariantError:
			ctx.unions = append(ctx.unions, UnionChoice{Path: strings.TrimSuffix(ctx.path, e.at), Variant: e.Variant})
			if e.Err != nil {
				err = e.Err
				continue
			}
		case ValidationErrors:
			return done, w.validation(e, ctx, v)
		case *ValidationErrors:
			return done, e == nil || w.validation(*e, ctx, v)
		case ValidationError:
			return done, v.problem(treeProblem{treeContext: ctx, validation: &e})
		case *ValidationError:
			return done, e == nil || v.problem(treeProblem{treeContext: ctx, validation: e})
		case *DecodeProblem, *UnionError:
			// One failure. Its underlying technical causes are not independent inputs.
		default:
			switch u := err.(type) {
			case interface{ Unwrap() []error }:
				if children := u.Unwrap(); len(children) > 0 {
					ctx.wrap(err)
					return ctx.group(children), true
				}
			case interface{ Unwrap() error }:
				if child := u.Unwrap(); child != nil {
					ctx.wrap(err)
					err = child
					continue
				}
			}
			if a, ok := err.(interface{ As(any) bool }); ok {
				if !w.queryAdapter() {
					return done, false
				}
				var re *RequestError
				if a.As(&re) && re != nil {
					w.enterRequest(&ctx, re)
					if v.firstRequest != nil {
						return done, v.firstRequest(re)
					}
					if re.Err != nil {
						ctx.project(err, re)
						err = re.Err
						continue
					}
				}
				if es := validationView(a); len(es) > 0 {
					ctx.wrap(err)
					return done, w.validation(es, ctx, v)
				}
				var problem *DecodeProblem
				if a.As(&problem) && problem != nil {
					ctx.project(err, problem)
					return done, v.problem(treeProblem{treeContext: ctx, leaf: problem})
				}
			}
		}
		return done, v.problem(treeProblem{treeContext: ctx, leaf: err})
	}
	return done, false
}

// Recorded positions can enclose several request wrappers. The proof that those branches
// retained the body draws on the same budget as the failed-position walk.
func (w *errorWalk) retainedRequests(err error) bool {
	found := false
	return w.walk(err, treeVisitor{
		firstRequest: func(re *RequestError) bool { found = true; return re.decoded },
		problem:      func(treeProblem) bool { return false },
	}) && found
}

func failedPositions(err error, request bool) []string {
	var w errorWalk
	var out []string
	add := func(ctx treeContext, path string) bool {
		if request && !ctx.decoded || len(out) == MaxCollectedErrors {
			out = []string{""}
			return false
		}
		out = append(out, path)
		return true
	}
	w.walk(err, treeVisitor{
		problem: func(p treeProblem) bool { return add(p.treeContext, p.position()) },
		recorded: func(ctx treeContext, failed []string, owner error) bool {
			if request && ctx.request == nil {
				ctx.decoded = w.retainedRequests(owner)
			}
			for _, f := range failed {
				if !w.step() || !add(ctx, ctx.path+f) {
					return false
				}
			}
			return true
		},
	})
	if w.limited || err != nil && out == nil {
		return []string{""}
	}
	return out
}

// Details lists the problems of err in order, up to max (MaxCollectedErrors when max <= 0).
func Details(err error, max int) []ErrorDetail {
	if max <= 0 {
		max = MaxCollectedErrors
	}
	var w errorWalk
	var out []ErrorDetail
	w.run(err, treeVisitor{problem: func(p treeProblem) bool {
		out = append(out, problemDetail(p))
		return len(out) < max
	}})
	return out
}

// problemDetail describes one problem.
func problemDetail(p treeProblem) ErrorDetail {
	var d ErrorDetail
	if re := p.request; re != nil {
		d.Kind = requestKind(re.Kind)
	}
	if loc := p.location; loc != nil {
		d.Location, d.Parameter = loc.Location, loc.Name
	}
	// The kind of the request error, unless it is the generic decoding or validation kind.
	kind := func(k ErrorKind) ErrorKind {
		if d.Kind != "" && d.Kind != ErrorDecode && d.Kind != ErrorValidation {
			return d.Kind
		}
		return k
	}
	if len(p.unions) > 0 {
		// Later siblings may reuse the backing array beyond their common prefix.
		d.Unions = slices.Clone(p.unions)
		d.Variant = p.unions[len(p.unions)-1].Variant
	}
	if v := p.validation; v != nil {
		d.Kind, d.Path, d.Constraint, d.Limit, d.Value, d.Message, d.Err = kind(ErrorValidation), p.path+v.Path, v.Constraint, v.Limit, v.Value, v.Message, v.Err
		if p.wrapper != nil {
			d.Message = p.wrapper.Error()
			if d.Err == nil {
				d.Err = p.cause()
			}
		}
		if v.Constraint == string(ErrorTraversalLimit) && v.Err == ErrErrorTreeLimit {
			d.Kind = ErrorTraversalLimit
		}
		if v.Constraint == "enum" {
			d.Allowed = anySlice(v.Limit)
		}
		if d.Kind == ErrorValidation {
			d = validationLocation(d)
		}
		return d
	}
	d.Kind, d.Path = kind(ErrorDecode), p.path
	if p.value != nil && p.valuePath == p.path {
		d.Value = p.value
	}
	switch c := p.leaf.(type) {
	case *DecodeProblem:
		d.Constraint, d.Expected, d.Got, d.Allowed, d.Minimum, d.Maximum = string(c.Kind), c.Expected, c.Got, c.Allowed, c.Minimum, c.Maximum
		d.Err = c.Err
	case *UnionError:
		d.Constraint = string(ProblemUnion)
		for _, v := range c.Variants {
			d.Variants = append(d.Variants, v.Variant)
		}
		if c.allowed != nil {
			d.Constraint = string(ProblemDiscriminator)
			for _, a := range c.allowed {
				var v any
				decoder := json.NewDecoder(strings.NewReader(a))
				decoder.UseNumber()
				if decoder.Decode(&v) == nil {
					d.Allowed = append(d.Allowed, v)
				}
			}
		}
	case *RequestError, *DecodeError, *VariantError:
		// An empty runtime wrapper has no underlying message.
		if p.wrapper == nil {
			return d
		}
	default:
		d.Err = p.cause()
	}
	d.Message = p.source().Error()
	return d
}
