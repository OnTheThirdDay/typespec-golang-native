# Third-party notices

This repository contains code copied or adapted from the projects below. Each copied file
names its source and commit in a header comment.

| Component | Upstream | License | Used in | How |
|---|---|---|---|---|
| Go naming rules (`naming.ts`, `mappings.ts`) | [Azure/typespec-azure](https://github.com/Azure/typespec-azure) `packages/typespec-go`, commit `6d580c6702b01dc587a9948cb03c9c3350dda89b` | MIT, © Microsoft Corporation | `packages/typespec-go/src/naming/` | Copied (`mappings.ts` unmodified, `naming.ts` without its memo cache) |
| JSON kind probe for unions | same repository, `src/codegen/core/unions.ts`, same commit | MIT, © Microsoft Corporation | `packages/typespec-go/runtime/union.go` (`ProbeJSONKind`) | Ported from generated Go helper |
| `uri` parameter encoding package and its tests | [ogen-go/ogen](https://github.com/ogen-go/ogen) `uri/`, commit `3d90c0ca96cc3a28db44d4088da22f7890875ac3` | Apache-2.0, © ogen authors (full text in `runtime/uri/LICENSE.ogen`) | `packages/typespec-go/runtime/uri/`, vendored into generated code with its license | Copied; `go-faster/errors` replaced by the standard library, internal helpers replaced by local equivalents |
| Doc comment canonicalization | [golang/go](https://github.com/golang/go) `src/go/doc/comment/parse.go`, `print.go` and `src/go/printer/comment.go`, go1.26.7 | BSD-3-Clause, © The Go Authors | `packages/typespec-go/src/doccomment.ts` | Block parsing and printing ported to TypeScript; verified against the Go implementation by differential tests |
| Strict-server generation | [oapi-codegen/oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) `pkg/codegen/templates/strict/strict-interface.tmpl`, `strict-http.tmpl`, commit `977b0d44` | Apache-2.0, © oapi-codegen contributors | `packages/typespec-go/src/server.ts` | Template structure ported to the TypeScript generator with the same names and semantics (`StrictServerInterface`, `<Op>RequestObject`, `<Op>ResponseObject`/`Visit<Op>Response`, `StrictHandlerFunc`/`StrictMiddlewareFunc`, error handlers), then extended (typed parameters, validation, defaults, auth hooks, body limits) |
| JSON Schema definition naming, remapping, deduplication, key sorting | [pydantic/pydantic](https://github.com/pydantic/pydantic) `pydantic/json_schema.py`, v2.14.4 | MIT, © 2017 to present Pydantic Services Inc. and individual contributors | `packages/typespec-structured-output/src/pydantic/`, `src/json.ts` | Ported to TypeScript |
| Strict schema transformation | [openai/openai-python](https://github.com/openai/openai-python) `src/openai/lib/_pydantic.py`, v3.59.0 | Apache-2.0, © OpenAI | `packages/typespec-structured-output/src/strict.ts` | Ported to TypeScript; test models of `tests/lib/test_pydantic.py` ported as fixtures |
| HTTP conformance specifications | [microsoft/typespec](https://github.com/microsoft/typespec) `@typespec/http-specs` 0.1.0-alpha.46 | MIT, © Microsoft Corporation | test input (npm dev dependency, not redistributed) | Compiled and replayed by `packages/typespec-go/test/http-specs/` |

Reference fixtures (`packages/typespec-structured-output/test/fixtures/*/reference.json`) are
output of Pydantic and the OpenAI SDK for models written in this repository.

## MIT License (Microsoft Corporation — typespec-azure)

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## MIT License (Pydantic)

Copyright (c) 2017 to present Pydantic Services Inc. and individual contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Apache License 2.0 (ogen, openai-python, oapi-codegen)

The full license text is included in `packages/typespec-go/runtime/uri/LICENSE.ogen` and at
<https://www.apache.org/licenses/LICENSE-2.0>. Modifications to the copied ogen files are
described in `runtime/uri/doc.go`; modifications to the ported OpenAI SDK code are described in
`packages/typespec-structured-output/src/strict.ts`.

## BSD 3-Clause License (The Go Authors — go/doc/comment, go/printer)

Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

   * Redistributions of source code must retain the above copyright notice, this list of
     conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above copyright notice, this list of
     conditions and the following disclaimer in the documentation and/or other materials provided
     with the distribution.
   * Neither the name of Google LLC nor the names of its contributors may be used to endorse or
     promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
