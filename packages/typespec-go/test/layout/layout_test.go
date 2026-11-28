package gen

// Runs unchanged against every file layout: the layout moves declarations between files but
// must not change names, behaviour or validation.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"example.com/gen/tsgo"
)

func TestClosedModelUnionVariantsAreNamedAfterTheModels(t *testing.T) {
	var v Variants
	if err := json.Unmarshal([]byte(`{"items":[{"kind":"size","size":"M"},{"kind":"color","color":"red"}]}`), &v); err != nil {
		t.Fatal(err)
	}
	size, ok := v.Items[0].AsSizeVariant()
	if !ok || size.Size != SizeVariantSizeM {
		t.Fatalf("items[0] = %+v", v.Items[0])
	}
	color, ok := v.Items[1].AsColorVariant()
	if !ok || color.Color != "red" {
		t.Fatalf("items[1] = %+v", v.Items[1])
	}
	if v.Items[1].Kind() != VariantsItemsItemKindColorVariant {
		t.Fatal("kind")
	}
	// Closed variants reject undeclared properties, so no variant accepts this item.
	err := json.Unmarshal([]byte(`{"items":[{"kind":"color","color":"red","extra":1}]}`), &v)
	var de *tsgo.DecodeError
	if !errors.As(err, &de) || !strings.HasPrefix(de.Path, "/items/0") {
		t.Fatalf("err = %v", err)
	}
	out, err := json.Marshal(Variants{Items: []VariantsItemsItem{NewVariantsItemsItemColorVariant(ColorVariant{Color: "blue"})}})
	if err != nil || string(out) != `{"items":[{"kind":"color","color":"blue"}]}` {
		t.Fatalf("%s %v", out, err)
	}
}

func TestDeclarationsFromSeveralFilesWorkTogether(t *testing.T) {
	var p Product
	err := json.Unmarshal([]byte(`{"id":"1","slug":"Not A Slug","price":{"amount":1.5,"currency":"EUR"},"status":"active","kind":"digital","label":"x","dimensions":[1,2]}`), &p)
	if err != nil {
		t.Fatal(err)
	}
	// The pattern variables live in the shared file, the scalars in another file.
	var ve tsgo.ValidationErrors
	if err := p.Validate(); !errors.As(err, &ve) || len(ve) != 1 || ve[0].Path != "/slug" || ve[0].Constraint != "pattern" {
		t.Fatalf("validate = %v", err)
	}
	p.Slug = "a-slug"
	p.Price.Currency = "eu"
	if err := p.Validate(); !errors.As(err, &ve) || ve[0].Path != "/price/currency" {
		t.Fatalf("validate = %v", err)
	}
	if p.Kind != ProductKindDigital || p.Dimensions == nil || p.Dimensions.Item1 != 2 {
		t.Fatalf("%+v", p)
	}

	var page ProductPage
	if err := json.Unmarshal([]byte(`{"items":[],"meta":{"total":3}}`), &page); err != nil || page.Meta.Total != 3 {
		t.Fatalf("%+v %v", page, err)
	}

	var offer Offer
	if err := json.Unmarshal([]byte(`{"shipping":{"pickup":true},"edits":{"slug":"s","price":{"amount":1,"currency":"USD"},"status":"retired","kind":"physical"}}`), &offer); err != nil {
		t.Fatal(err)
	}
	if _, ok := offer.Shipping.AsObject1(); !ok || offer.Edits == nil || offer.Edits.Status != StatusRetired {
		t.Fatalf("%+v", offer)
	}

	var problem Problem
	if err := json.Unmarshal([]byte(`{"code":"bad","message":"m","more":1}`), &problem); err == nil {
		t.Fatal("closed model accepted an undeclared property")
	}

	var s GlobalSetting
	if err := json.Unmarshal([]byte(`{"key":"k"}`), &s); err != nil {
		t.Fatal(err)
	}
	s.ApplyDefaults()
	if s.Value == nil || *s.Value != 7 {
		t.Fatalf("%+v", s)
	}
}

func TestQualifiedNamesAndVariantsAcrossNamespaces(t *testing.T) {
	var archived ShopOrdersArchiveOrder
	if err := json.Unmarshal([]byte(`{"id":"o","archivedAt":"2024-01-02T03:04:05Z"}`), &archived); err != nil {
		t.Fatal(err)
	}
	var order ShopOrdersOrder
	if err := json.Unmarshal([]byte(`{"id":"o","lines":[{"product":"p","quantity":2}],"status":"shipped"}`), &order); err != nil || order.Status != "shipped" {
		t.Fatalf("%+v %v", order, err)
	}
	// Visibility and merge-patch variants live next to their model.
	var create ProductCreate
	if err := json.Unmarshal([]byte(`{"slug":"s","price":{"amount":1,"currency":"USD"},"status":"active","kind":"digital"}`), &create); err != nil {
		t.Fatal(err)
	}
	var patch ProductUpdateMergePatch
	if err := json.Unmarshal([]byte(`{"tags":null,"slug":"s","price":{"amount":2,"currency":"CHF"},"status":"active","kind":"digital"}`), &patch); err != nil {
		t.Fatal(err)
	}
	if patch.Tags == nil || !patch.Tags.IsNull() {
		t.Fatalf("%+v", patch)
	}
	// Declarations of namespaces whose names look like build constraints or tests are compiled.
	_ = []any{A{}, B{}, C{}, D{}, E{}, Device{}, Probe{}, Build{OS: BuildOSLinux}}
}
