// Command widgets serves the generated strict API with an in-memory store.
//
//	tsp compile .            # generates ./api (Go) and ./schemas (Structured Outputs)
//	go run . -addr :8080
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"sync"

	"example.com/widgets/api"
	"example.com/widgets/api/tsgo"
)

// store implements api.StrictServerInterface.
type store struct {
	mu      sync.Mutex
	widgets []api.Widget
}

func (s *store) WidgetsAPIList(ctx context.Context, r api.WidgetsAPIListRequestObject) (api.WidgetsAPIListResponseObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []api.Widget{}
	for _, w := range s.widgets {
		if r.Color == nil || w.Color == *r.Color {
			out = append(out, w)
		}
	}
	return api.WidgetsAPIList200JSONResponse{Body: out}, nil
}

func (s *store) WidgetsAPICreate(ctx context.Context, r api.WidgetsAPICreateRequestObject) (api.WidgetsAPICreateResponseObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w := api.Widget{ID: fmt.Sprint(len(s.widgets) + 1), Name: r.Body.Name, Color: r.Body.Color, WeightGrams: r.Body.WeightGrams, Tags: r.Body.Tags}
	s.widgets = append(s.widgets, w)
	return api.WidgetsAPICreate201JSONResponse{Location: "/widgets/" + w.ID, Body: w}, nil
}

func (s *store) WidgetsAPIRead(ctx context.Context, r api.WidgetsAPIReadRequestObject) (api.WidgetsAPIReadResponseObject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, w := range s.widgets {
		if w.ID == r.ID {
			return api.WidgetsAPIRead200JSONResponse{Body: w}, nil
		}
	}
	return api.WidgetsAPIRead404JSONResponse{Body: api.Problem{Code: "not_found", Message: "no widget " + r.ID}}, nil
}

// authenticate accepts one static token; real applications verify credentials here.
func authenticate(token string) tsgo.AuthenticateFunc {
	return func(ctx context.Context, r *http.Request, op tsgo.OperationInfo) (context.Context, error) {
		if t, ok := tsgo.BearerToken(r); ok && t == token {
			return ctx, nil
		}
		return nil, errors.New("invalid bearer token")
	}
}

// ParseSuggestion decodes and validates an LLM reply produced with schemas/WidgetSuggestion.json:
// the generated models are usable outside HTTP handlers.
func ParseSuggestion(reply []byte) (api.WidgetSuggestion, error) {
	var s api.WidgetSuggestion
	if err := json.Unmarshal(reply, &s); err != nil {
		return s, err
	}
	s.ApplyDefaults()
	return s, s.Validate()
}

func newHandler(token string) http.Handler {
	return api.NewHandler(&store{}, api.ServerOptions{Authenticate: authenticate(token), ValidateResponses: true})
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	token := flag.String("token", "secret", "accepted bearer token")
	flag.Parse()
	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, newHandler(*token)))
}
