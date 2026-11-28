import "typespec-structured-output";
using StructuredOutput;

/** An identifier. */
@minLength(3)
scalar Id extends string;
@maxLength(10)
scalar ShortId extends Id;
@minValue(0)
scalar Percent extends float64;
@structuredOutput
model Entity {
  id: ShortId;
  /** Narrower. */
  @maxLength(5) code: ShortId;
  ratio: Percent;
  @maxValue(100) bounded: Percent;
  small: uint8;
  @minValueExclusive(0) positive: int16;
  safe: safeint;
  big: uint64;
  maybe_id: ShortId | null;
  @minItems(2) pairs: int32[][];
}
