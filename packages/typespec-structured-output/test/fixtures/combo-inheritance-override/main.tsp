import "typespec-structured-output";
using StructuredOutput;

enum Tier { free, pro }
@minLength(1)
scalar Name extends string;
model Account {
  id: string;
  tier: Tier;
  name: Name;
}
/** A premium account. */
@structuredOutput
model Premium extends Account {
  tier: Tier.pro;
  @maxLength(10) nickname?: Name | null;
  since?: plainDate | null;
  level?: Tier = Tier.pro;
}
