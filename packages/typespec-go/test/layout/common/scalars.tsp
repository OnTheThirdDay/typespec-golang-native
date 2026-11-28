namespace Shop.Common;

@pattern("^[A-Z]{3}$") scalar CurrencyCode extends string;
@pattern("^[a-z0-9-]+$") scalar Slug extends string;

model Money { amount: decimal; currency: CurrencyCode; }

enum Status { Active: "active", Retired: "retired" }
