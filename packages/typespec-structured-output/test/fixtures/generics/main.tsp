import "typespec-structured-output";
using StructuredOutput;

model Item { name: string; }
model Page<T> {
  items: T[];
  next_link: string | null;
}

@structuredOutput
model Catalog {
  first: Page<Item>;
  nested: Page<Page<Item>>;
  words: Page<string>;
}
