import "typespec-structured-output";
using StructuredOutput;

/** An item as it is read back. */
model Item {
  @visibility(Lifecycle.Read) id: string;
  name: string;
  @visibility(Lifecycle.Create) secret: string;
}

@structuredOutput
model Page {
  items: Item[];
  @visibility(Lifecycle.Read) total: int32;
}
