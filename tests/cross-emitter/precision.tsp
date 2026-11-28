import "typespec-go";
import "typespec-structured-output";
using StructuredOutput;
enum State { high: 9007199254740993, normal: 0 }
model Counters extends Record<integer> {
  value?: uint64 = 18446744073709551615;
}
@structuredOutput model Precision { state: State; counts: Counters; }
