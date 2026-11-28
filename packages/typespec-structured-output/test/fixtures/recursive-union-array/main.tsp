import "typespec-structured-output";
using StructuredOutput;
union Tree { leaf: string, children: Tree[] }
@structuredOutput model Forest { root: Tree; maybe: Tree | null; }
