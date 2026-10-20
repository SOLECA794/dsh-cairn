/**
 * A stand-in for `@deepseek-ai/dsh-tools`.
 *
 * The real module lives inside the harness and cannot be imported outside a DSH
 * install, which would otherwise make `lib/index.js` unimportable on a dev
 * machine and `apply()` untestable. This stub keeps the parts cairn depends on —
 * the option shape `defineTool` accepts, and the fact that it returns the tool
 * object the registry stores — and validates enough of it to catch a typo in a
 * tool definition (a bad `type`, a missing `render`, a parameter spec that is
 * not an object).
 *
 * It deliberately does NOT validate the JSON Schema body of `output.schema`:
 * cairn's tools build that by hand, and a stub that re-implemented the harness's
 * schema compiler would be testing the stub.
 */

const PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object'])

export function defineTool(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('defineTool: options must be an object')
  }
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool: name is required')
  }
  if (typeof options.description !== 'string' || options.description.length === 0) {
    throw new TypeError(`defineTool(${options.name}): description is required`)
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError(`defineTool(${options.name}): execute must be a function`)
  }

  const parameters = options.parameters ?? {}
  for (const [key, spec] of Object.entries(parameters)) {
    if (spec === null || typeof spec !== 'object') {
      throw new TypeError(`defineTool(${options.name}): parameter "${key}" must be an object`)
    }
    if (!PARAM_TYPES.has(spec.type)) {
      throw new TypeError(`defineTool(${options.name}): parameter "${key}" has unsupported type "${spec.type}"`)
    }
    if (spec.enum !== undefined && !Array.isArray(spec.enum)) {
      throw new TypeError(`defineTool(${options.name}): parameter "${key}" enum must be an array`)
    }
  }

  const output = options.output
  if (output !== undefined) {
    if (output.schema === null || typeof output.schema !== 'object') {
      throw new TypeError(`defineTool(${options.name}): output.schema must be an object`)
    }
    if (typeof output.render !== 'function') {
      throw new TypeError(`defineTool(${options.name}): output.render must be a function`)
    }
  }

  return {
    name: options.name,
    description: options.description,
    parameters,
    output,
    execute: options.execute
  }
}

export default { defineTool }
