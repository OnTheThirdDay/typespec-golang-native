import "typespec-structured-output";
using StructuredOutput;

// Port of openai-python tests/lib/test_pydantic.py::test_nested_inline_ref_expansion
model Star {
  /** The name of the star. */
  name: string;
}
model Galaxy {
  /** The name of the galaxy. */
  name: string;
  /** The largest star in the galaxy. */
  largest_star: Star;
}
@structuredOutput
model Universe {
  /** The name of the universe. */
  name: string;
  /** A galaxy in the universe. */
  galaxy: Galaxy;
}
