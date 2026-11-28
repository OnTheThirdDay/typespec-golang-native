import "typespec-structured-output";
using StructuredOutput;

@structuredOutput
model M { @encode(DateTimeKnownEncoding.unixTimestamp, int64) at: utcDateTime; }
