import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @format("ipv4-cidr") net: string; }
