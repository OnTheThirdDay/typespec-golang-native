import "typespec-structured-output";
using StructuredOutput;

/** A postal address. */
model Address {
  /** Street line. */
  street: string;
  city: string;
}

/** A customer record. */
@structuredOutput
model Customer {
  /** Where the customer lives. */
  home: Address;
  work: Address;
  @summary("Display Name") display_name: string;
}
