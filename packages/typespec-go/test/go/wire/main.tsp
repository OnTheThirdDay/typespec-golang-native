import "@typespec/http";
import "typespec-go";
using Http;
@service namespace Wire;
model Form { @encodedName("application/x-www-form-urlencoded","x-y") name: string; ids: int32[]; }
@route("/forms") @get op forms(): { @header contentType: "application/x-www-form-urlencoded"; @body body: Form; };
@route("/parts") @get op parts(): { @header contentType: "multipart/form-data"; @multipartBody body: { title: HttpPart<string>; count: HttpPart<int32>; files: HttpPart<File>[]; }; };
@route("/lookup/{a,b}") @get op lookup(@path a: string,@path b: string): string;
@maxLength(3) scalar Short extends string;
@route("/prefix/{s:3}") @get op prefix(@path s: Short): string;

@route("/matrix{;a,b}") @get op matrix(@path a?: string, @path b?: string[]): string;
@route("/reserved/{+x}/suffix") @get op reserved(@path x: string): string;
