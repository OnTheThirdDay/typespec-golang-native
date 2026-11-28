import "typespec-structured-output";
using StructuredOutput;

// Interactions of `...Record<never>` (extra="forbid") with record indexers (extra="allow" with
// typed extras). The nearest indexer in the inheritance chain decides, as with Pydantic's
// inherited model_config.

model Base { id: string; ...Record<never>; }
/** Reopens a closed base with typed extras. */
model Reopened extends Base { ...Record<string>; }

model OpenExtras { a: string; ...Record<string>; }
/** Closes a base that allows typed extras. */
model ClosedExtras extends OpenExtras { b: string; ...Record<never>; }
model InheritsExtras extends OpenExtras { c: string; }

model SpreadExtras { ...Base; ...Record<string>; }
alias MaybeName = (string | null) | never;

model Box<T> { item: T; ...Record<never>; }

@structuredOutput
model Root {
  reopened: Reopened;
  spread: SpreadExtras;
  nested: MaybeName | int32;
  closedExtras: ClosedExtras;
  inheritsExtras: InheritsExtras;
  counts: Record<int32>;
  closedMap: Record<Base>;
  boxedMap: Box<Record<string>>;
  boxedOpen: Box<OpenExtras>;
  ...Record<never>;
}
