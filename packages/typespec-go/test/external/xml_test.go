package consumer

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"example.com/shared"
)

type payer struct{}

func (payer) Transfer(_ context.Context, r TransferRequestObject) (TransferResponseObject, error) {
	var p shared.Money = r.Body
	p.Currency = "AUD"
	return Transfer200XMLResponse{Body: p}, nil
}

func TestImportedXMLWire(t *testing.T) {
	h := NewHandler(payer{}, ServerOptions{ValidateResponses: true})
	r := httptest.NewRequest("POST", "/xml", strings.NewReader("<Money><amount>42</amount><currency>EUR</currency></Money>"))
	w := httptest.NewRecorder()
	r.Header.Set("Content-Type", "application/xml")
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "<Money><amount>42</amount><currency>AUD</currency></Money>") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
