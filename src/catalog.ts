import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition {
  /** Caller-facing identity. Invalid MCP names are deterministically aliased by the catalog. */
  name: string;
  description: string;
  /** JSON Schema for the object arguments, validated before dispatch. */
  parameters: object;
}

export interface Catalog {
  readonly tools: readonly Tool[];
  readonly aliases: readonly string[];
  readonly originalToAlias: ReadonlyMap<string, string>;
  readonly aliasToOriginal: ReadonlyMap<string, string>;
  resolve(alias: string): string | undefined;
  validate(alias: string, value: unknown): asserts value is Record<string, unknown>;
}

type Schema = Record<string, unknown> | boolean;
const legalName = /^[A-Za-z0-9_-]{1,64}$/;

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite JSON number");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value !== "object") throw new Error("Value is outside the JSON domain");
  if (ancestors.has(value)) throw new Error("Cyclic JSON value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Non-JSON object");
  }
  ancestors.add(value);
  for (const item of Object.values(value)) assertJson(item, ancestors);
  ancestors.delete(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** JSON domain validation is shared by argument and result encoding. It never coerces numbers. */
export function assertJsonValue(value: unknown): void { assertJson(value); }

/** Visit schema positions only; const/default/examples and property names are instance data. */
function visitSchemas(value: unknown, visit: (schema: Record<string, unknown>) => void): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  visit(schema);
  for (const keyword of ["items", "additionalItems", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems"]) {
    const nested = schema[keyword];
    if (Array.isArray(nested)) nested.forEach(item => visitSchemas(item, visit));
    else visitSchemas(nested, visit);
  }
  for (const keyword of ["properties", "patternProperties", "definitions", "$defs", "dependencies", "dependentSchemas"]) {
    const nested = schema[keyword];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      Object.values(nested).forEach(item => visitSchemas(item, visit));
    }
  }
}

/** Supply a conventional items schema only when no permitted tail can reach it. */
function outboundParameters(parameters: Tool["inputSchema"]): Tool["inputSchema"] {
  const candidates = new Set<Record<string, unknown>>();
  let hasReferences = false;
  visitSchemas(parameters, node => {
    // Skip the whole document conservatively: cloning IDs/anchors can duplicate
    // identities, and references may depend on the original positional structure.
    for (const keyword of ["$ref", "$id", "$anchor", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor"]) {
      if (Object.hasOwn(node, keyword)) hasReferences = true;
    }
    const prefix = node.prefixItems;
    if (!Object.hasOwn(node, "items") && Array.isArray(prefix) && prefix.length > 0 &&
        typeof node.maxItems === "number" && Number.isInteger(node.maxItems) && node.maxItems <= prefix.length &&
        prefix.every(item => isDeepStrictEqual(item, prefix[0]))) {
      candidates.add(node);
    }
  });
  if (hasReferences || candidates.size === 0) return parameters;
  // Copy only for an actual rewrite. The validator keeps its untouched source
  // snapshot; the replacer selects schema identities, never schema-looking data.
  return JSON.parse(JSON.stringify(parameters, (_key, value) =>
    candidates.has(value) ? { ...value, items: value.prefixItems[0] } : value)) as Tool["inputSchema"];
}

function compileArguments(parameters: object, identity: string): (value: unknown) => void {
  const schema = parameters as Record<string, unknown>;
  if (schema.type !== "object") throw new Error(`Tool ${identity}: inputSchema must declare type object`);
  const draft07 = schema.$schema === "http://json-schema.org/draft-07/schema#" || schema.$schema === "http://json-schema.org/draft-07/schema";
  const draft2020 = schema.$schema === "https://json-schema.org/draft/2020-12/schema" || schema.$schema === "https://json-schema.org/draft/2020-12/schema#";
  if (schema.$schema !== undefined && !draft07 && !draft2020) {
    throw new Error(`Tool ${identity}: only JSON Schema draft-07 and draft-2020-12 are supported; schema was not changed`);
  }
  let hasPrefixItems = false;
  let unsupported: string | undefined;
  visitSchemas(schema, node => {
    if (Object.hasOwn(node, "prefixItems")) hasPrefixItems = true;
    // These need evaluation/dynamic-reference tracking in the safe-integer walker.
    // Reject rather than advertise validation that can miss integer-only fields.
    for (const keyword of ["$dynamicRef", "unevaluatedItems", "unevaluatedProperties"]) {
      if (Object.hasOwn(node, keyword)) unsupported = keyword;
    }
  });
  // Real MCP tuple metadata omits $schema. An explicit draft-07 remains authoritative.
  const uses2020 = draft2020 || (schema.$schema === undefined && hasPrefixItems);
  if (uses2020 && unsupported) throw new Error(`Tool ${identity}: unsupported schema keyword ${unsupported}; schema was not changed`);
  const ajv = new (uses2020 ? Ajv2020 : Ajv)({
    allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false,
    strictNumbers: true, allowUnionTypes: true, coerceTypes: false,
    useDefaults: false, removeAdditional: false, validateFormats: true,
  });
  addFormats(ajv);
  const root = `https://omp-agy.invalid/schema/${createHash("sha256").update(identity).digest("hex")}`;
  ajv.addSchema(schema, root);
  const validator = ajv.getSchema(root)!;
  // Compile all schemas through AJV before publishing anything; unsupported keywords fail closed.
  if (!validator) throw new Error(`Tool ${identity}: schema could not be compiled`);
  const cache = new Map<string, ValidateFunction>();
  const get = (ref: string): ValidateFunction => {
    let validate = cache.get(ref);
    if (!validate) {
      validate = ajv.getSchema(ref);
      if (!validate) throw new Error(`Unresolvable schema reference: ${ref}`);
      cache.set(ref, validate);
    }
    return validate;
  };
  const pointer = (part: string | number) => encodeURIComponent(String(part).replace(/~/g, "~0").replace(/\//g, "~1"));
  const child = (ref: string, ...parts: (string | number)[]) => `${ref.includes("#") ? ref : `${ref}#`}/${parts.map(pointer).join("/")}`;
  const locations = new WeakMap<object, { ref: string; base: string }>();
  function index(value: unknown, ref: string, base: string, isRoot = false): void {
    if (value === null || typeof value !== "object") return;
    const id = (value as Record<string, unknown>).$id;
    const localBase = typeof id === "string" ? (isRoot ? id : ajv.opts.uriResolver.resolve(base, id)) : base;
    locations.set(value, { ref, base: localBase });
    for (const [key, nested] of Object.entries(value)) index(nested, child(ref, key), localBase);
  }
  index(schema, root, root, true);

  function integers(ref: string, value: unknown, visited: Map<unknown, Set<string>>): void {
    // AJV can optimize a $ref-only validator to the referenced schema. Recover that
    // schema's original pointer before walking children, not the referring pointer.
    const node = get(ref).schema as Schema;
    if (typeof node === "boolean") return;
    const location = locations.get(node);
    if (!location) throw new Error("Schema reference resolved outside this activation catalog");
    ref = location.ref;
    const localBase = location.base;
    let refs = visited.get(value);
    if (refs?.has(ref)) return;
    if (!refs) visited.set(value, refs = new Set());
    refs.add(ref);
    if (typeof node.$ref === "string") {
      integers(ajv.opts.uriResolver.resolve(localBase, node.$ref), value, visited);
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("integer") && !types.includes("number") && typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error(`Unsafe integer argument at schema ${ref}`);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) branches.forEach((_, index) => {
        const branch = child(ref, keyword, index);
        if (keyword === "allOf" || get(branch)(value)) integers(branch, value, visited);
      });
    }
    if (node.if !== undefined) {
      const condition = child(ref, "if");
      const matches = get(condition)(value);
      if (matches) integers(condition, value, visited);
      const chosen = matches ? "then" : "else";
      if (node[chosen] !== undefined) integers(child(ref, chosen), value, visited);
    }
    if (Array.isArray(value)) {
      const tupleKeyword = uses2020 ? "prefixItems" : "items";
      const tuple = node[tupleKeyword];
      if (Array.isArray(tuple)) {
        const tailKeyword = uses2020 ? "items" : "additionalItems";
        value.forEach((item, index) => {
          if (index < tuple.length) integers(child(ref, tupleKeyword, index), item, visited);
          else if (typeof node[tailKeyword] === "object") integers(child(ref, tailKeyword), item, visited);
        });
      } else if (node.items !== undefined) {
        value.forEach(item => integers(child(ref, "items"), item, visited));
      }
      if (node.contains !== undefined) {
        const contains = child(ref, "contains");
        value.forEach(item => { if (get(contains)(item)) integers(contains, item, visited); });
      }
    } else if (value !== null && typeof value === "object") {
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const patterns = (node.patternProperties ?? {}) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value)) {
        let matched = false;
        if (Object.hasOwn(properties, key)) {
          matched = true;
          integers(child(ref, "properties", key), item, visited);
        }
        for (const pattern of Object.keys(patterns)) if (new RegExp(pattern, "u").test(key)) {
          matched = true;
          integers(child(ref, "patternProperties", pattern), item, visited);
        }
        if (!matched && typeof node.additionalProperties === "object") integers(child(ref, "additionalProperties"), item, visited);
      }
      for (const keyword of uses2020 ? ["dependencies", "dependentSchemas"] : ["dependencies"]) {
        const dependencies = (node[keyword] ?? {}) as Record<string, unknown>;
        for (const [key, dependency] of Object.entries(dependencies)) {
          if (Object.hasOwn(value, key) && dependency !== null && typeof dependency === "object" && !Array.isArray(dependency)) {
            integers(child(ref, keyword, key), value, visited);
          }
        }
      }
    }
  }

  return value => {
    assertJson(value);
    if (!validator(value)) throw new Error(`Invalid arguments for ${identity}: ${ajv.errorsText(validator.errors)}`);
    integers(root, value, new Map());
  };
}

export function buildCatalog(definitions: readonly ToolDefinition[]): Catalog {
  const names = new Set<string>();
  for (const tool of definitions) {
    if (!tool.name || names.has(tool.name)) throw new Error(`Duplicate or empty tool name: ${tool.name}`);
    names.add(tool.name);
  }
  const originalToAlias = new Map<string, string>();
  const aliasToOriginal = new Map<string, string>();
  // Reserve every legal original before generating aliases, including originals later in the input.
  for (const name of [...names].sort()) if (legalName.test(name)) {
    originalToAlias.set(name, name);
    aliasToOriginal.set(name, name);
  }
  for (const name of [...names].sort()) if (!originalToAlias.has(name)) {
    const stem = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 38) || "tool";
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
    let suffix = 0;
    let alias: string;
    do {
      const tail = `_${digest}${suffix ? `_${suffix}` : ""}`;
      alias = `${stem.slice(0, 64 - tail.length)}${tail}`;
      suffix++;
    } while (aliasToOriginal.has(alias));
    originalToAlias.set(name, alias);
    aliasToOriginal.set(alias, name);
  }
  const validators = new Map<string, (value: unknown) => void>();
  const tools = definitions.map(tool => {
    // JSON snapshot prevents an executor's later schema mutation from changing this activation.
    // TypeBox schemas can carry symbol metadata, which is not part of their JSON Schema representation.
    assertJson(tool.parameters);
    const parameters = JSON.parse(JSON.stringify(tool.parameters)) as Tool["inputSchema"];
    const alias = originalToAlias.get(tool.name)!;
    validators.set(alias, compileArguments(parameters, tool.name));
    return freeze({ name: alias, description: tool.description, inputSchema: outboundParameters(parameters) });
  });
  return Object.freeze({
    tools: Object.freeze(tools), aliases: Object.freeze(tools.map(tool => tool.name)),
    get originalToAlias() { return new Map(originalToAlias); },
    get aliasToOriginal() { return new Map(aliasToOriginal); },
    resolve: (alias: string) => aliasToOriginal.get(alias),
    validate(alias: string, value: unknown): asserts value is Record<string, unknown> {
      const validate = validators.get(alias);
      if (!validate) throw new Error(`Unknown bridge tool: ${alias}`);
      validate(value);
    },
  });
}
