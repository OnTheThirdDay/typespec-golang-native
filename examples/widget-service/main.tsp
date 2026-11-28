import "@typespec/http";
import "typespec-go";
import "typespec-structured-output";

using Http;
using StructuredOutput;

/** A small widget catalogue: a strict Go HTTP server and an LLM extraction schema from one spec. */
@service(#{ title: "Widgets" })
@useAuth(BearerAuth)
namespace Widgets;

enum Color {
  red,
  green,
  blue,
}

model Widget {
  @visibility(Lifecycle.Read) id: string;

  /** Display name. */
  @minLength(1) @maxLength(80) name: string;

  color: Color;
  @minValue(0) weightGrams?: int32 = 100;
  tags?: string[];
}

/** What an LLM extracts from a free-text widget description. */
@structuredOutput
model WidgetSuggestion {
  /** Proposed display name. */
  name: string;

  color: Color;

  /** Estimated weight in grams, if stated. */
  weight_grams: int32 | null;

  confidence: float64;
}

@error
model Problem {
  code: string;
  message: string;
}

@route("/widgets")
interface WidgetsApi {
  @get list(@query color?: Color): Widget[];
  @post create(@body widget: Widget): {
    @statusCode _: 201;
    @header location: string;
    @body widget: Widget;
  } | Problem;
  @get read(@path id: string): Widget | {
    @statusCode _: 404;
    @body problem: Problem;
  };
}
