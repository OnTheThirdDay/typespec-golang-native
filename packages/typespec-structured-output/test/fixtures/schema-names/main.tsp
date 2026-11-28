import "typespec-structured-output";
using StructuredOutput;

// @schemaName sets the Pydantic class name independently of the TypeSpec declaration name.
namespace Billing { @schemaName("PostalAddress") model Address { line: string; } }
namespace Shipping { @schemaName("PostalAddress") model Address { street: string; } }

@schemaName("Tier") enum Level { gold, silver }

@schemaName("Envelope") model Wrapper<T> { item: T; }
model Item { name: string; }

@schemaName("Renamed") model Original { a: string; }
/** `is` copies decorators, but the name belongs to the declaration that writes it. */
model CopyOfOriginal is Original;
@friendlyName("FriendlyOnly") model Friendly { b: string; }
@schemaName("Wins") @friendlyName("Loses") model Both { c: string; }

@structuredOutput
model Order {
  bill: Billing.Address;
  ship: Shipping.Address;
  level: Level;
  wrapped: Wrapper<Item>;
  original: Original;
  duplicate: CopyOfOriginal;
  friendly: Friendly;
  both: Both;
}

@structuredOutput @schemaName("RenamedRoot") model Root2 { x: string; }
