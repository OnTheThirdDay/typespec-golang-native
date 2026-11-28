import "typespec-structured-output";
using StructuredOutput;

enum Priority { low: 1, mid: 2, high: 3 }
enum Mode { auto, manual }
@structuredOutput
model Task {
  priority: Priority;
  mode: Mode;
  fixed: Mode.auto;
  either: Mode.auto | Mode.manual;
  modes: Mode[];
  /** Overridden mode. */
  override_mode: Mode | null;
}
