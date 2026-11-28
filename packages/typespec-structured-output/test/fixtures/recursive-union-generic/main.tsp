import "typespec-structured-output";
using StructuredOutput;

model Box<T> { v: T; }
union Tree { leaf: string, children: Tree[] }

@structuredOutput
model Holder { b: Box<Tree>; plain: Box<string | int32>; }
