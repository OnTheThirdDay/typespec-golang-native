import "typespec-structured-output";
using StructuredOutput;

// `...Record<never>` is TypeSpec's closed object: no property beyond the declared ones. It is
// Pydantic's ConfigDict(extra="forbid").

/** A closed model. */
model Closed { name: string; ...Record<never>; }

model Base { id: string; ...Record<never>; }
/** Inherits the closure of its base, as Pydantic subclasses inherit model_config. */
model DerivedFromClosed extends Base {}

model Open { name: string; }
model ClosedFromOpen extends Open { extra: int32; ...Record<never>; }

/** A spread copies the properties and the indexer, so the copy is closed too. */
model SpreadOfClosed { ...Closed; more: string; }

model Gen<T> { value: T; ...Record<never>; }

@structuredOutput
model Tree { label: string; kids: Tree[]; ...Record<never>; }

model Empty { ...Record<never>; }

@structuredOutput
model Root {
  closed: Closed;
  derived: DerivedFromClosed;
  closedFromOpen: ClosedFromOpen;
  spread: SpreadOfClosed;
  gen: Gen<string>;
  genClosed: Gen<Closed>;
  tree: Tree;
  empty: Empty;
  open: Open;
  maybe: Closed | null;
  many: Closed[];
  ...Record<never>;
}

