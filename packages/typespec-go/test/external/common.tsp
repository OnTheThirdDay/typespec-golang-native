// Declarations shared by independently compiled specifications (see external.test.ts).
namespace Shop.Common;

@pattern("^[A-Z]{3}$") scalar Currency extends string;

scalar LongRunningTransactionSequenceNumber extends int64;

model Money { amount: decimal; currency: Currency; }

enum Status { Active: "active", Retired: "retired" }

alias Shape = { circle: float64 } | { square: float64 };

/** A widget. */
model Widget {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  status?: Status = Status.Active;
  price: Money;
  note?: string | null;
  shape?: Shape;
  kind: "a" | "b";
}

model Closed { a: string; ...Record<never>; }

@discriminator("kind") model Pet { kind: string; name: string; }
model Dog extends Pet { kind: "dog"; bark: boolean; }

model Page<T> { items: T[]; total: int64; }

model Catalog { widgets: Page<Widget>; }

union Id { string, int64 }

/** A named array: a named Go slice type of the shared package. */
@maxItems(2)
model Labels is Currency[];

/** Structurally identical anonymous members keep distinct identities across packages. */
model Twins { left: { v: string }; right: { v: string }; deep: { inner: { v: string } }; }

/** `plain` is unchanged under Create visibility; `stamped` has a Create projection. */
model Audited { @visibility(Lifecycle.Read) id: string; plain: { v: string }; stamped: { v: string; @visibility(Lifecycle.Read) at: string }; }

model Parcel<T> { value: T; inner: { value: T }; }
model Deliveries {
  first: Parcel<{ code: string }>;
  second: Parcel<{ code: string }>;
}
