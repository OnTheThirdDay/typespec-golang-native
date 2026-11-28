// Long generated identifiers: every generated construct must be gofmt-clean as emitted,
// whatever the identifier lengths (gofmt keeps a function literal on one line only while its
// header and body stay short).
import "@typespec/http";
using Http;

@service
namespace LongNames;

@encode("rfc7231") scalar ExtraordinarilyLongCustomTimestampScalarNameForFormatting extends utcDateTime;
@encode(string) scalar ExtraordinarilyLongCustomIntegerScalarNameForFormattingTests extends int64;

model AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesAlpha { kind: "alpha"; value: string; }
model AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesBeta { kind: "beta"; count: int32; }

union AnExtraordinarilyLongUndiscriminatedUnionNameForGofmtLineLengthRegressionTests {
  AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesAlpha,
  AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesBeta,
  string,
}

model AnExtraordinarilyLongContainerModelNameHoldingEveryLengthDependentConstruct {
  either: AnExtraordinarilyLongUndiscriminatedUnionNameForGofmtLineLengthRegressionTests;
  @encode(DateTimeKnownEncoding.rfc3339) stamp?: ExtraordinarilyLongCustomTimestampScalarNameForFormatting;
  @encode(string) counter?: ExtraordinarilyLongCustomIntegerScalarNameForFormattingTests;
  anonymousUnionWithAnExtraordinarilyLongPropertyName?: { a: string } | { b: int32 } | int64[];
}

enum AnExtraordinarilyLongEnumerationNameForGofmtLineLengthRegressionTestsXYZ { AnExtraordinarilyLongEnumerationMemberNameForGofmtLineLengthRegressionTests: "x", Other: "y" }

@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union AnExtraordinarilyLongDiscriminatedUnionNameForGofmtLineLengthRegressionTests {
  alpha: AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesAlpha,
  beta: AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesBeta,
}

model AnExtraordinarilyLongSecondContainerModelNameWithCollectionsRecordsAndTuplesXYZ {
  tagged: AnExtraordinarilyLongDiscriminatedUnionNameForGofmtLineLengthRegressionTests;
  level?: AnExtraordinarilyLongEnumerationNameForGofmtLineLengthRegressionTestsXYZ;
  byName?: Record<AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesAlpha>;
  pair?: [AnExtraordinarilyLongModelNameUsedToProduceVeryLongGeneratedConstructorNamesBeta, ExtraordinarilyLongCustomIntegerScalarNameForFormattingTests];
  nested?: { inner: { a: string } | { b: ExtraordinarilyLongCustomTimestampScalarNameForFormatting } };
}

@route("/second") @get op anExtraordinarilyLongSecondOperationNameForGofmtRegressionTestsXYZ(
  @query anExtraordinarilyLongQueryParameterNameForGofmtRegressionTests?: AnExtraordinarilyLongEnumerationNameForGofmtLineLengthRegressionTestsXYZ,
): AnExtraordinarilyLongSecondContainerModelNameWithCollectionsRecordsAndTuplesXYZ;

@route("/things/{anExtraordinarilyLongPathParameterNameForTesting}")
@post
op anExtraordinarilyLongOperationNameForGofmtRegressionTests(
  @path anExtraordinarilyLongPathParameterNameForTesting: ExtraordinarilyLongCustomIntegerScalarNameForFormattingTests,
  @header("x-extraordinarily-long-header") @encode(DateTimeKnownEncoding.rfc3339) stamp?: ExtraordinarilyLongCustomTimestampScalarNameForFormatting,
  @body body: AnExtraordinarilyLongContainerModelNameHoldingEveryLengthDependentConstruct,
): AnExtraordinarilyLongContainerModelNameHoldingEveryLengthDependentConstruct;
