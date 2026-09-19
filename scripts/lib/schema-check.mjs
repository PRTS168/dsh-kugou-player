/**
 * Strict JSON Schema checks for tool definitions.
 *
 * DSH's own registry accepts raw JSON Schema for a tool's `parameters`, but the
 * provider validates it too — and a provider rejection fails the ENTIRE model
 * request, which drops the harness into safe mode rather than failing one tool
 * call. A single malformed keyword is therefore an outage, not a blemish.
 *
 * The specific mistake this guards against is mixing up the two schema dialects
 * that exist in this codebase:
 *
 *   defineTool DSL :  { mode: { type: 'string', required: true } }
 *   raw JSON Schema:  { properties: { mode: {...} }, required: ['mode'] }
 *
 * Copying the DSL form into a raw schema leaves `required: true` inside a
 * property, where JSON Schema demands an array — and the provider answers
 * "invalid schema for function 'x': true is not of type 'array'".
 *
 * @module scripts/lib/schema-check
 */

/** Types JSON Schema permits in `type`. */
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** Keywords whose value must itself be a schema object. */
const SCHEMA_VALUED = ['items', 'additionalProperties', 'propertyNames', 'not', 'contains'];

/** Keywords whose value must be an array of schemas. */
const SCHEMA_ARRAY_VALUED = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];

/**
 * Walk a schema and collect every problem that would make a provider reject it.
 *
 * @param node  schema (or subschema) to check
 * @param path  dotted path used to make messages actionable
 * @param problems accumulator; created when omitted
 * @returns the array of problem strings
 */
export function validateSchema(node, path = 'schema', problems = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${path}: schema node must be an object`);
    return problems;
  }

  // The exact bug that once broke a live turn.
  if ('required' in node && !Array.isArray(node.required)) {
    problems.push(`${path}.required must be an array, got ${JSON.stringify(node.required)}`);
  }
  if (Array.isArray(node.required) && node.required.some((key) => typeof key !== 'string')) {
    problems.push(`${path}.required must contain only strings`);
  }

  if ('type' in node) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    for (const type of types) {
      if (!VALID_TYPES.has(type)) problems.push(`${path}.type has invalid value ${JSON.stringify(type)}`);
    }
  }

  if ('enum' in node && !Array.isArray(node.enum)) {
    problems.push(`${path}.enum must be an array`);
  }

  if ('properties' in node) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      problems.push(`${path}.properties must be an object`);
    } else {
      for (const [key, sub] of Object.entries(node.properties)) {
        validateSchema(sub, `${path}.properties.${key}`, problems);
      }
    }
  }

  // `required` may only name properties that exist, or the provider errors.
  if (Array.isArray(node.required) && node.properties && typeof node.properties === 'object') {
    for (const key of node.required) {
      if (!(key in node.properties)) problems.push(`${path}.required names undeclared property "${key}"`);
    }
  }

  for (const keyword of SCHEMA_VALUED) {
    if (!(keyword in node)) continue;
    // `additionalProperties: false` is a boolean, legitimately.
    if (keyword === 'additionalProperties' && typeof node[keyword] === 'boolean') continue;
    validateSchema(node[keyword], `${path}.${keyword}`, problems);
  }

  for (const keyword of SCHEMA_ARRAY_VALUED) {
    if (!(keyword in node)) continue;
    if (!Array.isArray(node[keyword])) {
      problems.push(`${path}.${keyword} must be an array`);
      continue;
    }
    node[keyword].forEach((sub, index) => validateSchema(sub, `${path}.${keyword}[${index}]`, problems));
  }

  return problems;
}

/** True when the schema is clean. */
export function isSchemaValid(node) {
  return validateSchema(node).length === 0;
}

/**
 * Reject a parameters spec that accidentally uses defineTool DSL phrasing.
 *
 * Cheap textual backstop for the structural walk above: the DSL marks a
 * parameter required with a boolean, which is never valid in raw JSON Schema.
 */
export function findDslContamination(spec) {
  return /"required":(true|false)/.test(JSON.stringify(spec ?? {}));
}
