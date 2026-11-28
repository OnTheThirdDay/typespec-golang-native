import "typespec-structured-output";
using StructuredOutput;
@structuredOutput model Wire {
  padded: bytes;
  @encode(BytesKnownEncoding.base64url) url: bytes;
  @encode(string) flag: boolean;
  @minValue(0) amount: decimal;
}
