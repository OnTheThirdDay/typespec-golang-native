import "typespec-structured-output";
using StructuredOutput;

// Port of openai-python tests/lib/test_pydantic.py::test_enums
enum Color { RED: "red", BLUE: "blue", GREEN: "green" }
@structuredOutput
model ColorDetection {
  /** The detected color */
  color: Color;
  /** The hex color code of the detected color */
  hex_color_code: string;
}
