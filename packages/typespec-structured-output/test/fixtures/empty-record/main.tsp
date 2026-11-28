import "typespec-structured-output";
using StructuredOutput;
model Box<T> { value: T; }
@structuredOutput model M { nothing: Record<never>; items: Record<never>[]; boxed: Box<Record<never>>; }
