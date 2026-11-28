package gen

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

func TestIntegerIsInt64(t *testing.T) {
	// Compile-time: every integer position has a native int64 representation.
	var x Totals
	var _ int64 = x.Plain
	var _ *int64 = x.Bounded
	var _ Count = Count(int64(1))
	var _ []int64 = *(&[]int64{})
	var _ *map[string]int64 = x.Map
	var _ *tsgo.Nullable[int64] = x.Nullable
	var _ int64 = int64(TotalsLevelN1)

	in := `{"plain":9223372036854775807,"id":"-9223372036854775808","text":"12","list":[1],"map":{"a":-1},"nullable":null,"either":5,"level":7,"nested":{"n":1}}`
	if err := json.Unmarshal([]byte(in), &x); err != nil {
		t.Fatal(err)
	}
	if x.Plain != 9223372036854775807 || *x.ID != -9223372036854775808 || *x.Text != 12 || (*x.Map)["a"] != -1 || *x.Level != 7 {
		t.Fatalf("%+v", x)
	}
	if v, ok := x.Either.AsInteger(); !ok || v != 5 {
		t.Fatalf("%+v", x.Either)
	}
	out, err := json.Marshal(x)
	if err != nil || !strings.Contains(string(out), `"id":"-9223372036854775808"`) || !strings.Contains(string(out), `"plain":9223372036854775807`) {
		t.Fatalf("%s %v", out, err)
	}
}

func TestOutOfRangeIntegersAreRejected(t *testing.T) {
	for _, in := range []string{
		`{"plain":9223372036854775808}`,
		`{"plain":-9223372036854775809}`,
		`{"plain":1e19}`,
		`{"plain":1.5}`,
		`{"plain":0,"id":"9223372036854775808"}`,
		`{"plain":0,"list":[18446744073709551616]}`,
		`{"plain":0,"either":99999999999999999999}`,
	} {
		var x Totals
		err := json.Unmarshal([]byte(in), &x)
		var de *tsgo.DecodeError
		if !errors.As(err, &de) {
			t.Fatalf("%s: %v", in, err)
		}
	}
	// Integral spellings accepted by the arbitrary-precision mapping are accepted in range.
	var x Totals
	if err := json.Unmarshal([]byte(`{"plain":1.0e2}`), &x); err != nil || x.Plain != 100 {
		t.Fatalf("%v %+v", err, x)
	}
}

func TestDefaultsAndConstraints(t *testing.T) {
	var x Totals
	x.ApplyDefaults()
	if *x.Limited != 9223372036854775807 || *x.Count != 3 || (*x.List)[1] != -9223372036854775808 || x.Nested.N != 2 {
		t.Fatalf("%+v", x)
	}
	x.Bounded = tsgo.Ptr[int64](-6)
	c := Count(-1)
	x.Count = &c
	var ves tsgo.ValidationErrors
	if err := x.Validate(); !errors.As(err, &ves) || len(ves) != 2 || ves[0].Path != "/bounded" || ves[1].Path != "/count" {
		t.Fatalf("%v", err)
	}
}

type srv struct{}

func (srv) Put(ctx context.Context, r PutRequestObject) (PutResponseObject, error) {
	return Put200JSONResponse{Total: r.ID + *r.Limit, Body: Totals{Plain: r.ID}}, nil
}

func TestParameters(t *testing.T) {
	h := NewHandler(srv{}, ServerOptions{})
	do := func(path, limit string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", path, strings.NewReader(`{"plain":1}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-limit", limit)
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := do("/totals/9223372036854775806?page=2", "1")
	if rec.Code != http.StatusOK || rec.Header().Get("x-total") != "9223372036854775807" {
		t.Fatalf("%d %s %v", rec.Code, rec.Body, rec.Header())
	}
	for _, c := range [][2]string{{"/totals/9223372036854775808", "1"}, {"/totals/1", "-9223372036854775809"}, {"/totals/1?page=-1", "1"}, {"/totals/1.5", "1"}} {
		if rec := do(c[0], c[1]); rec.Code != http.StatusBadRequest {
			t.Fatalf("%v: %d", c, rec.Code)
		}
	}
}
