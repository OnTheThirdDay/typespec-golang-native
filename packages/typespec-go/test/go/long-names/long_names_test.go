package gen

import (
	"encoding/json"
	"testing"
	"time"
)

func TestLongNamesBehave(t *testing.T) {
	var c AnExtraordinarilyLongContainerModelNameHoldingEveryLengthDependentConstruct
	in := `{"either":{"kind":"beta","count":2},"stamp":"2024-01-02T03:04:05Z","counter":"42","anonymousUnionWithAnExtraordinarilyLongPropertyName":[1,2]}`
	if err := json.Unmarshal([]byte(in), &c); err != nil {
		t.Fatal(err)
	}
	if b, ok := c.Either.AsAnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesBeta(); !ok || b.Count != 2 {
		t.Fatalf("%+v", c.Either)
	}
	if time.Time(*c.Stamp).Year() != 2024 || *c.Counter != 42 {
		t.Fatalf("%+v", c)
	}
	out, err := json.Marshal(c)
	if err != nil || string(out) != `{"either":{"kind":"beta","count":2},"stamp":"2024-01-02T03:04:05Z","counter":"42","anonymousUnionWithAnExtraordinarilyLongPropertyName":[1,2]}` {
		t.Fatalf("%s %v", out, err)
	}
	var s AnExtraordinarilyLongSecondContainerModelNameWithCollectionsRecordsAndTuplesXYZ
	if err := json.Unmarshal([]byte(`{"tagged":{"kind":"alpha","value":"v"},"pair":[{"kind":"beta","count":1},"7"]}`), &s); err != nil || s.Pair.Item1 != 7 {
		t.Fatalf("%+v %v", s, err)
	}
}
