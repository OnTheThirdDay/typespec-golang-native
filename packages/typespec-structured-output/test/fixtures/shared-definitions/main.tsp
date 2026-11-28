import "typespec-structured-output";
using StructuredOutput;

model Money { amount: float64; currency: string; }
model Line { price: Money; total: Money; }
@structuredOutput
model Invoice {
  lines: Line[];
  subtotal: Money;
  /** Grand total. */
  total: Money;
}
