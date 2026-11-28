import "typespec-structured-output";
using StructuredOutput;

model L1 { next: L2; }
model L2 { next: L3; }
model L3 { next: L4; }
model L4 { next: L5; }
model L5 { next: L6; }
model L6 { next: L7; }
model L7 { next: L8; }
model L8 { next: L9; }
model L9 { next: L10; }
model L10 { next: L11; }
model L11 { v: string; }
@structuredOutput
model Root { l: L1; }
