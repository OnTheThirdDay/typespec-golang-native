import "typespec-go";
import "typespec-structured-output";
using StructuredOutput;

/** Facts extracted from a text (shared by both emitters). */
namespace Extraction;

enum Sentiment { positive, negative, neutral }

model Address {
  street: string;
  city: string;
  postcode?: string;
}

model Person {
  name: string;
  @minValue(0) @maxValue(150) age?: int32;
  address: Address | null;
  tags: string[];
}

model Org {
  orgName: string;
  size: "small" | "large";
}

union Party { person: Person, org: Org }

/** Facts extracted from a text. */
@structuredOutput
model Facts {
  @minItems(1) parties: Party[];
  sentiment: Sentiment;
  score: float64;
  confidence?: float64;
  note: string | null;
  primary?: Party;
  kind: "a" | "b";
  @minValue(-9007199254740993) count: int64;
}
