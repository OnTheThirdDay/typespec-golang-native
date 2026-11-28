import "../dist/src/tsp-index.js";

using TypeSpec.Reflection;

namespace StructuredOutput;

/**
 * Marks a model as a Structured Output root. One schema file is emitted per root.
 *
 * @param name Name of the schema (`json_schema.name` / `text.format.name`). Defaults to the
 *             Pydantic class name of the model. OpenAI requires `^[a-zA-Z0-9_-]{1,64}$`.
 */
extern dec structuredOutput(target: Model, name?: valueof string);

/**
 * Sets the Pydantic class name of a model or enum in Structured Output schemas, independently of
 * the TypeSpec declaration name and of other emitters: it is the schema's `title`, its `$defs`
 * key and `$ref` target, and the default root name, and it takes part in Pydantic's definition
 * name collision handling. On a template declaration it names the generic class (`Name[Arg]`).
 *
 * @param name A Python identifier.
 */
extern dec schemaName(target: Model | Enum, name: valueof string);

/**
 * Declares that the property's default comes from a Pydantic `default_factory`: the schema has
 * no `default` keyword, while the property stays optional and target profile restrictions on
 * defaults still apply.
 */
extern dec defaultFactory(target: ModelProperty);
