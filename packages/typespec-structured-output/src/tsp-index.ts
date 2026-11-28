import { $defaultFactory, $schemaName, $structuredOutput } from "./decorators.js";
export { $lib } from "./lib.js";

export const $decorators = {
  StructuredOutput: {
    structuredOutput: $structuredOutput,
    schemaName: $schemaName,
    defaultFactory: $defaultFactory,
  },
};
