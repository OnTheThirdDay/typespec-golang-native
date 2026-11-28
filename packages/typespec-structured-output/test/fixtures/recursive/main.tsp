import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model TreeNode {
  label: string;
  children: TreeNode[];
}
