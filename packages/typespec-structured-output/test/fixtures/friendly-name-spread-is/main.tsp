import "typespec-structured-output";
using StructuredOutput;

model Audit { created_by: string; }
@friendlyName("NamedBox")
model Box<T> { value: T; }
model Copy is Audit;
@structuredOutput
model Record1 {
  ...Audit;
  box: Box<string>;
  copy: Copy;
}
