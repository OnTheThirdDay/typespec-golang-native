import "typespec-structured-output";
using StructuredOutput;

@maxItems(3) model Branches is Branches[];
model Tree is Record<Tree>;
@schemaName("Packet") model Box<T> { value: T; }

@structuredOutput model Forest {
  roots: Branches;
  @maxItems(1) short: Branches;
  named: Tree;
  packet: Box<Branches>;
}
