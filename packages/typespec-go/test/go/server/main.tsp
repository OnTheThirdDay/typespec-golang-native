import "@typespec/http";
import "typespec-go";
using Http;

@service(#{ title: "Widget service" })
@useAuth(BearerAuth)
namespace WidgetService;

model Widget {
  @visibility(Lifecycle.Read) id: string;
  @minLength(1) name: string;
  @visibility(Lifecycle.Create) secret?: string;
  weight?: float64 = 1.5;
  tags?: string[];
}

@error
model ApiError {
  code: string;
  message: string;
}

model Page<T> {
  items: T[];
  next?: string;
}

@route("/widgets")
interface Widgets {
  @get list(
    @query(#{ explode: true }) tags?: string[],
    @query @minValue(1) @maxValue(100) limit?: int32 = 10,
    @query @encode(ArrayEncoding.pipeDelimited) colors?: string[],
    @header("x-request-id") requestId?: string,
  ): Page<Widget>;

  @post create(@body body: Widget, @header("x-trace") trace?: string): {
    @statusCode _: 201;
    @header("Location") location: string;
    @body body: Widget;
  } | ApiError;

  @get read(@path id: string, @cookie session?: string): {
    @statusCode _: 200;
    @header etag: string;
    @header @encode(DateTimeKnownEncoding.rfc7231) lastModified?: utcDateTime;
    @body body: Widget;
  } | {
    @statusCode _: 404;
    @body error: ApiError;
  };

  @delete remove(@path id: string): {
    @statusCode _: 204;
  } | {
    @minValue(500) @maxValue(599) @statusCode code: int32;
    @body error: ApiError;
  };

  @put @route("/{id}/label") setLabel(@path id: string, @header contentType: "text/plain", @body label: string): {
    @statusCode _: 200;
    @header contentType: "text/plain";
    @body label: string;
  };

  @put @route("/{id}/blob") upload(@path id: string, @header contentType: "application/octet-stream", @body data: bytes): {
    @statusCode _: 204;
  };

  @get @route("/{id}/blob") download(@path id: string): {
    @header contentType: "application/octet-stream";
    @body data: bytes;
  };

  @post @route("/{id}/attachments") attach(
    @path id: string,
    @header contentType: "multipart/form-data",
    @multipartBody body: {
      description: HttpPart<string>;
      file: HttpPart<File>;
      extra?: HttpPart<Widget>;
    },
  ): {
    @statusCode _: 204;
  };

  @get @route("/{ids}/batch") batch(@path ids: string[]): string[];
}

model FormData {
  name: string;
  tags?: string[];
  n?: int32 = 7;
}

@route("/misc")
interface Misc {
  @post @route("/form") form(@header contentType: "application/x-www-form-urlencoded", @body body: FormData): FormData;
  @get @route("/params") params(@cookie flavors?: string[], @query @encode(ArrayEncoding.newlineDelimited) lines?: string[]): {
    @body body: string[];
  };
  @post @route("/tuple") tuple(
    @header contentType: "multipart/form-data",
    @multipartBody body: [HttpPart<string, #{ name: "a" }>, HttpPart<File, #{ name: "f" }>],
  ): {
    @statusCode _: 204;
  };
}

@route("/public")
@useAuth(NoAuth)
op ping(@query t?: utcDateTime): {
  @statusCode _: 200;
  @body body: {
    ok: boolean;
    at?: utcDateTime;
  };
};

@route("/files/{+path}")
op getFile(@path path: string): {
  @body body: string;
};
