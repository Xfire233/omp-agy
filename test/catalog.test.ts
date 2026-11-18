import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildCatalog, type Catalog, type ToolDefinition } from "../src/catalog.js";

const tool = (name: string, parameters: object = { type: "object", properties: {} }): ToolDefinition => ({ name, description: `Description for ${name}`, parameters });

describe("immutable tool catalog", () => {
  test("keeps legal names, deterministically aliases others, and reserves all legal originals", () => {
    const original = "tool.with spaces";
    const colliding = `tool_with_spaces_${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
    const names = [original, colliding, "read", "x".repeat(160), "工具"];
    const first = buildCatalog(names.map(name => tool(name)));
    const second = buildCatalog([...names].reverse().map(name => tool(name)));
    expect(new Set(first.aliases).size).toBe(names.length);
    for (const name of names) {
      const alias = first.originalToAlias.get(name)!;
      expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(second.originalToAlias.get(name)).toBe(alias);
      expect(first.resolve(alias)).toBe(name);
      expect(first.aliasToOriginal.get(alias)).toBe(name);
    }
    expect(first.originalToAlias.get(colliding)).toBe(colliding);
    expect(first.originalToAlias.get(original)).not.toBe(colliding);
    expect(first.resolve("missing")).toBeUndefined();
  });

  test("freezes schema snapshot, exposes no mutable internal lookup maps, and preserves empty catalog", () => {
    const parameters = { type: "object" as const, properties: { n: { type: "integer", minimum: 1 } }, required: ["n"], additionalProperties: false };
    const catalog = buildCatalog([tool("read", parameters)]);
    expect(catalog.tools[0]!.inputSchema).toEqual(parameters);
    parameters.properties.n.minimum = 9;
    expect(catalog.tools[0]!.inputSchema.properties).toEqual({ n: { type: "integer", minimum: 1 } });
    (catalog.aliasToOriginal as Map<string, string>).set("read", "other");
    expect(catalog.resolve("read")).toBe("read");
    expect(Object.isFrozen(catalog.tools[0]!.inputSchema.properties)).toBe(true);
    expect(buildCatalog([]).tools).toEqual([]);
    expect(() => buildCatalog([tool("a"), tool("a")])).toThrow("Duplicate");
  });

  test("does not strip unknown schema semantics or silently accept unsupported drafts", () => {
    expect(() => buildCatalog([tool("x", { type: "object", inventedConstraint: true })])).toThrow();
    expect(() => buildCatalog([tool("x", { type: "object", $schema: "https://json-schema.org/draft/2019-09/schema" })])).toThrow("supported");
    expect(() => buildCatalog([tool("x", { type: "array", items: { type: "string" } })])).toThrow("type object");
    expect(() => buildCatalog([tool("x", { type: "object", properties: { x: { $ref: "https://outside.invalid/schema" } } })])).toThrow();
  });
});

describe("MCP prefixItems tuples", () => {
  test("validates the installed swipe_points schema and numeric boundaries", () => {
    // Cached mcp_tools:uiautomator2 metadata: no $schema, fixed-size integer pairs.
    const parameters = {
      additionalProperties: false,
      properties: {
        serial: { type: "string", description: "Android device serialno" },
        points: {
          items: { maxItems: 2, minItems: 2, prefixItems: [{ type: "integer" }, { type: "integer" }], type: "array" },
          type: "array", description: "List of (x, y) coordinates to swipe through",
        },
        duration: { default: 0.5, type: "number", description: "Duration of swipe in seconds, default is 0.5" },
      },
      required: ["serial", "points"], type: "object",
    };
    const name = "mcp__uiautomator2_swipe_points";
    const catalog: Catalog = buildCatalog([tool(name, parameters)]);
    const valid = { serial: "device", points: [[0, 1], [-1, Number.MAX_SAFE_INTEGER], [Number.MIN_SAFE_INTEGER, 2]] };
    expect(() => catalog.validate(name, valid)).not.toThrow();
    expect(valid).not.toHaveProperty("duration");
    expect(() => catalog.validate(name, { serial: "device", points: [], duration: 0.25 })).not.toThrow();
    for (const points of [null, {}, [0, 1], [[]], [[1]], [[1, 2, 3]], [["1", 2]], [[1, "2"]], [[1.5, 2]], [[1, 2.5]], [[true, 2]], [[1, null]]]) {
      expect(() => catalog.validate(name, { serial: "device", points })).toThrow("Invalid arguments");
    }
    for (const point of [[9_007_199_254_740_992, 0], [0, -9_007_199_254_740_992]]) {
      expect(() => catalog.validate(name, { serial: "device", points: [point] })).toThrow("Unsafe integer");
    }
    for (const number of [NaN, Infinity, -Infinity]) {
      expect(() => catalog.validate(name, { serial: "device", points: [[number, 0]] })).toThrow("Non-finite");
      expect(() => catalog.validate(name, { serial: "device", points: [], duration: number })).toThrow("Non-finite");
    }
    expect(() => catalog.validate(name, { points: [[0, 1]] })).toThrow("Invalid arguments");
    expect(() => catalog.validate(name, { serial: "device", points: [], duration: "0.5" })).toThrow("Invalid arguments");
    expect(() => catalog.validate(name, { serial: "device", points: [], extra: true })).toThrow("Invalid arguments");
  });

  test("honors 2020-12 prefix and tail schemas, refs, and explicit tuple bounds", () => {
    for (const $schema of [undefined, "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"]) {
      const catalog: Catalog = buildCatalog([tool("tuples", {
        ...($schema ? { $schema } : {}), type: "object",
        $defs: { integer: { type: "integer" } },
        properties: {
          open: { type: "array", prefixItems: [{ $ref: "#/$defs/integer" }] },
          closed: { type: "array", prefixItems: [{ type: "integer" }, { type: "number" }], items: false },
          tail: { type: "array", prefixItems: [{ type: "number" }], items: { $ref: "#/$defs/integer" } },
        },
      })]);
      // prefixItems alone neither requires positions nor restricts the remaining items.
      expect(() => catalog.validate("tuples", { open: [], closed: [] })).not.toThrow();
      expect(() => catalog.validate("tuples", { open: [1, "tail"], closed: [1, 0.25], tail: [0.5, 2, 3] })).not.toThrow();
      expect(() => catalog.validate("tuples", { open: [1, 9_007_199_254_740_992] })).not.toThrow();
      expect(() => catalog.validate("tuples", { closed: [1, 2, 3] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("tuples", { open: ["1"] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("tuples", { tail: [0.5, "2"] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("tuples", { tail: [0.5, 2.5] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("tuples", { open: [9_007_199_254_740_992] })).toThrow("Unsafe integer");
      expect(() => catalog.validate("tuples", { tail: [0.5, 9_007_199_254_740_992] })).toThrow("Unsafe integer");
      expect(() => catalog.validate("tuples", { closed: [1, 9_007_199_254_740_992] })).not.toThrow();
    }
  });

  test("preserves bounded homogeneous tuple constraints in the advertised schema and source validator", () => {
    // Frozen caller metadata also makes any in-place compatibility rewrite fail.
    const integer = Object.freeze({ minimum: -3, type: "integer" });
    const parameters = Object.freeze({
      type: "object", additionalProperties: false,
      properties: Object.freeze({ tuple: Object.freeze({
        type: "array", minItems: 2, maxItems: 2,
        prefixItems: Object.freeze([integer, Object.freeze({ type: "integer", minimum: -3 })]),
      }) }),
      required: Object.freeze(["tuple"]),
    });
    const source: Catalog = buildCatalog([tool("source", parameters)]);
    const advertised: Catalog = buildCatalog([tool("advertised", source.tools[0]!.inputSchema)]);
    for (const [catalog, name] of [[source, "source"], [advertised, "advertised"]] as const) {
      for (const tuple of [[0, 1], [-3, Number.MAX_SAFE_INTEGER]]) {
        expect(() => catalog.validate(name, { tuple })).not.toThrow();
      }
      for (const tuple of [[], [1], [1, 2, 3], ["1", 2], [1, 0.5], [-4, 0]]) {
        expect(() => catalog.validate(name, { tuple })).toThrow("Invalid arguments");
      }
      expect(() => catalog.validate(name, { tuple: [0, 9_007_199_254_740_992] })).toThrow("Unsafe integer");
    }
  });

  test("does not tighten unbounded, partially bounded, mixed, or existing-tail tuples", () => {
    const source: Catalog = buildCatalog([tool("source", {
      type: "object", properties: {
        open: { type: "array", prefixItems: [{ type: "integer" }, { type: "integer" }] },
        longer: { type: "array", maxItems: 3, prefixItems: [{ type: "integer" }, { type: "integer" }] },
        shorter: { type: "array", maxItems: 1, prefixItems: [{ type: "integer" }, { type: "integer" }] },
        empty: { type: "array", maxItems: 0, prefixItems: [{ type: "integer" }] },
        mixed: { type: "array", maxItems: 2, prefixItems: [{ type: "integer" }, { type: "number" }] },
        existing: { type: "array", prefixItems: [{ type: "integer" }], items: { type: "string" } },
        permissive: { type: "array", prefixItems: [{ type: "integer" }], items: true },
        closed: { type: "array", prefixItems: [{ type: "integer" }], items: false },
      },
    })]);
    const advertised: Catalog = buildCatalog([tool("advertised", source.tools[0]!.inputSchema)]);
    for (const [catalog, name] of [[source, "source"], [advertised, "advertised"]] as const) {
      expect(() => catalog.validate(name, {
        open: [1, 2, "tail"], longer: [1, 2, "tail"], shorter: [1], empty: [],
        mixed: [1, 0.25], existing: [1, "tail"], permissive: [1, null], closed: [1],
      })).not.toThrow();
      expect(() => catalog.validate(name, { open: [1, 2, 9_007_199_254_740_992] })).not.toThrow();
      for (const value of [{ shorter: [1, 2] }, { empty: [1] }, { mixed: [1, "2"] }, { existing: [1, 2] }, { closed: [1, 2] }]) {
        expect(() => catalog.validate(name, value)).toThrow("Invalid arguments");
      }
    }
  });

  test("transforms schema positions without interpreting const, default, or examples as schemas", () => {
    const data = { type: "array", maxItems: 2, prefixItems: [{ type: "integer" }, { type: "integer" }] };
    const source: Catalog = buildCatalog([tool("source", {
      type: "object", properties: {
        data: { const: data, default: data, examples: [data] },
        nested: { allOf: [{ type: "array", maxItems: 2, prefixItems: [{ type: "integer" }, { type: "integer" }] }] },
      },
    })]);
    const advertised: Catalog = buildCatalog([tool("advertised", source.tools[0]!.inputSchema)]);
    for (const [catalog, name] of [[source, "source"], [advertised, "advertised"]] as const) {
      expect(() => catalog.validate(name, { data, nested: [1, 2] })).not.toThrow();
      expect(() => catalog.validate(name, { data: { ...data, items: { type: "integer" } } })).toThrow("Invalid arguments");
      expect(() => catalog.validate(name, { nested: [1, 2, 3] })).toThrow("Invalid arguments");
      expect(() => catalog.validate(name, { nested: [1, "2"] })).toThrow("Invalid arguments");
    }
  });

  test("keeps reference scopes valid and rejects unsupported anchors", () => {
    for (const element of [
      { $ref: "#/$defs/integer" },
      { $id: "coordinate.json", type: "integer" },
    ]) {
      const source: Catalog = buildCatalog([tool("source", {
        type: "object", $defs: { integer: { type: "integer" } },
        properties: { tuple: { type: "array", maxItems: 1, prefixItems: [element] } },
      })]);
      const advertised: Catalog = buildCatalog([tool("advertised", source.tools[0]!.inputSchema)]);
      for (const [catalog, name] of [[source, "source"], [advertised, "advertised"]] as const) {
        expect(() => catalog.validate(name, { tuple: [Number.MAX_SAFE_INTEGER] })).not.toThrow();
        expect(() => catalog.validate(name, { tuple: ["1"] })).toThrow("Invalid arguments");
        expect(() => catalog.validate(name, { tuple: [1, 2] })).toThrow("Invalid arguments");
        expect(() => catalog.validate(name, { tuple: [9_007_199_254_740_992] })).toThrow("Unsafe integer");
      }
    }
    expect(() => buildCatalog([tool("unsupportedAnchor", {
      type: "object", properties: {
        tuple: { type: "array", maxItems: 1, prefixItems: [{ $anchor: "coordinate", type: "integer" }] },
      },
    })])).toThrow("$anchor");
  });

  test("retains draft-07 semantics and does not infer dialects from instance data", () => {
    for (const $schema of [undefined, "http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-07/schema"]) {
      const catalog: Catalog = buildCatalog([tool("legacy", {
        ...($schema ? { $schema } : {}), type: "object",
        properties: {
          tuple: { type: "array", items: [{ type: "integer" }, { type: "number" }], additionalItems: false },
          data: { const: { prefixItems: [{ type: "integer" }] }, default: { prefixItems: [] }, examples: [{ prefixItems: [] }] },
          prefixItems: { type: "string" },
        },
      })]);
      expect(() => catalog.validate("legacy", { tuple: [1, 0.5], data: { prefixItems: [{ type: "integer" }] }, prefixItems: "data" })).not.toThrow();
      expect(() => catalog.validate("legacy", { tuple: [1, 0.5, 3] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("legacy", { tuple: ["1", 0.5] })).toThrow("Invalid arguments");
      expect(() => catalog.validate("legacy", { tuple: [9_007_199_254_740_992] })).toThrow("Unsafe integer");
    }
    expect(() => buildCatalog([tool("explicitLegacy", {
      $schema: "http://json-schema.org/draft-07/schema#", type: "object",
      properties: { tuple: { type: "array", prefixItems: [{ type: "integer" }] } },
    })])).toThrow("prefixItems");
  });

  test("fails closed on malformed tuples and unsupported schema semantics", () => {
    for (const tuple of [
      { prefixItems: { type: "integer" } },
      { prefixItems: [{ type: "integer" }], items: [{ type: "integer" }] },
      { prefixItems: [{ type: "integer" }], additionalItems: false },
      { prefixItems: [{ type: "integer", inventedConstraint: true }] },
    ]) {
      expect(() => buildCatalog([tool("invalid", { type: "object", properties: { tuple: { type: "array", ...tuple } } })])).toThrow();
    }
    for (const keyword of ["$dynamicRef", "unevaluatedItems", "unevaluatedProperties"]) {
      expect(() => buildCatalog([tool("unsupported", {
        $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
        properties: { value: { [keyword]: keyword === "$dynamicRef" ? "#" : { type: "integer" } } },
      })])).toThrow(keyword);
    }
  });

  test("checks applicable 2020-12 dependent schemas and keeps number-only schemas", () => {
    const catalog: Catalog = buildCatalog([tool("dependent", {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: { trigger: { type: "boolean" }, n: { type: "number" } },
      dependentSchemas: { trigger: { properties: { n: { type: "integer" } } } },
    })]);
    expect(() => catalog.validate("dependent", { n: 9_007_199_254_740_992 })).not.toThrow();
    expect(() => catalog.validate("dependent", { trigger: false, n: Number.MAX_SAFE_INTEGER })).not.toThrow();
    expect(() => catalog.validate("dependent", { trigger: false, n: 9_007_199_254_740_992 })).toThrow("Unsafe integer");
    expect(() => catalog.validate("dependent", { trigger: true, n: 0.5 })).toThrow("Invalid arguments");
  });

  test("finds tuple semantics inside schema definitions and applicator branches", () => {
    const catalog: Catalog = buildCatalog([tool("nested", {
      type: "object",
      $defs: { coordinates: { allOf: [{ type: "array", prefixItems: [{ type: "integer" }], items: false }] } },
      properties: { coordinates: { $ref: "#/$defs/coordinates" } },
    })]);
    expect(() => catalog.validate("nested", { coordinates: [Number.MAX_SAFE_INTEGER] })).not.toThrow();
    expect(() => catalog.validate("nested", { coordinates: ["1"] })).toThrow("Invalid arguments");
    expect(() => catalog.validate("nested", { coordinates: [1, 2] })).toThrow("Invalid arguments");
    expect(() => catalog.validate("nested", { coordinates: [9_007_199_254_740_992] })).toThrow("Unsafe integer");
  });
});

describe("schema-directed Number domain", () => {
  test("validates nested integer refs, array tuples, maps and conditional branches", () => {
    const catalog: Catalog = buildCatalog([tool("numeric", {
      type: "object", additionalProperties: false,
      definitions: { id: { type: "integer" } },
      properties: {
        kind: { enum: ["integer", "float"] },
        payload: {},
        nested: { type: "object", properties: { ids: { type: "array", items: { $ref: "#/definitions/id" } } } },
        tuple: { type: "array", items: [{ type: "integer" }, { type: "number" }], additionalItems: { type: "integer" } },
        map: { type: "object", additionalProperties: { type: "integer" } },
        patterns: { type: "object", patternProperties: { "^id": { type: "integer" } } },
      },
      if: { properties: { kind: { const: "integer" } }, required: ["kind"] },
      then: { properties: { payload: { type: "integer" } } },
      else: { properties: { payload: { type: "number" } } },
    })]);
    const unsafe = 9_007_199_254_740_992;
    expect(() => catalog.validate("numeric", { nested: { ids: [unsafe] } })).toThrow("Unsafe integer");
    expect(() => catalog.validate("numeric", { tuple: [0, 0.2, unsafe] })).toThrow("Unsafe integer");
    expect(() => catalog.validate("numeric", { map: { key: unsafe } })).toThrow("Unsafe integer");
    expect(() => catalog.validate("numeric", { patterns: { id1: unsafe } })).toThrow("Unsafe integer");
    expect(() => catalog.validate("numeric", { kind: "integer", payload: unsafe })).toThrow("Unsafe integer");
    expect(() => catalog.validate("numeric", { kind: "float", payload: unsafe })).not.toThrow();
    expect(() => catalog.validate("numeric", { nested: { ids: [Number.MAX_SAFE_INTEGER] }, tuple: [1, 0.25] })).not.toThrow();
    expect(() => catalog.validate("numeric", { nested: { ids: ["12"] } })).toThrow("Invalid arguments");
    expect(() => catalog.validate("numeric", { unexpected: true })).toThrow("Invalid arguments");
  });

  test("only walks matching union branches and keeps ordinary floats/string identifiers", () => {
    const catalog: Catalog = buildCatalog([tool("union", {
      type: "object", properties: {
        value: { oneOf: [
          { type: "object", properties: { kind: { const: "integer" }, n: { type: "integer" } }, required: ["kind", "n"] },
          { type: "object", properties: { kind: { const: "float" }, n: { type: "number" } }, required: ["kind", "n"] },
        ] },
        id: { type: "string" },
        number: { type: "number" },
      },
    })]);
    const value = { value: { kind: "float", n: 9_007_199_254_740_992 }, id: "9007199254740993123", number: 0.1 };
    expect(() => catalog.validate("union", value)).not.toThrow();
    expect(value.id).toBe("9007199254740993123");
    expect(() => catalog.validate("union", { value: { kind: "integer", n: 9_007_199_254_740_992 } })).toThrow("Unsafe integer");
    for (const number of [Infinity, -Infinity, NaN]) expect(() => catalog.validate("union", { number })).toThrow("Non-finite");
    expect(() => catalog.validate("union", { number: undefined })).toThrow("JSON domain");
  });

  test("documents normal JSON decoding rather than claiming raw numeric lexeme recovery", () => {
    const catalog: Catalog = buildCatalog([tool("integer", { type: "object", properties: { n: { type: "integer" } } })]);
    const decoded = JSON.parse('{"n":9007199254740990.9}') as { n: number };
    expect(decoded.n).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => catalog.validate("integer", decoded)).not.toThrow();
  });
});

describe("reference scope and applicability", () => {
  test("walks referenced objects, recursive objects, relative IDs and escaped property pointers", () => {
    const catalog: Catalog = buildCatalog([tool("recursive", {
      $id: "relative/catalog.json", type: "object",
      definitions: {
        row: { type: "object", properties: { "id/# value": { type: "integer" } } },
      },
      properties: {
        row: { $ref: "#/definitions/row" },
        children: { type: "array", items: { $ref: "#" } },
      },
    })]);
    expect(() => catalog.validate("recursive", { row: { "id/# value": 3 }, children: [{ row: { "id/# value": 4 } }] })).not.toThrow();
    expect(() => catalog.validate("recursive", { children: [{ row: { "id/# value": 9_007_199_254_740_992 } }] })).toThrow("Unsafe integer");
  });

  test("checks integer constraints reached through allOf, dependencies and contains", () => {
    const catalog: Catalog = buildCatalog([tool("applicable", {
      type: "object", properties: { trigger: { type: "boolean" }, n: {}, array: { type: "array", contains: { type: "integer" } } },
      allOf: [{ properties: { requiredInteger: { type: "integer" } } }],
      dependencies: { trigger: { properties: { n: { type: "integer" } } } },
    })]);
    const unsafe = 9_007_199_254_740_992;
    expect(() => catalog.validate("applicable", { n: unsafe })).not.toThrow();
    expect(() => catalog.validate("applicable", { trigger: false, n: unsafe })).toThrow("Unsafe integer");
    expect(() => catalog.validate("applicable", { requiredInteger: unsafe })).toThrow("Unsafe integer");
    expect(() => catalog.validate("applicable", { array: ["not numeric", unsafe] })).toThrow("Unsafe integer");
  });
});

test("nested integer/number type unions retain Number semantics without relaxing integer-only fields", () => {
  const catalog: Catalog = buildCatalog([tool("numberUnion", {
    type: "object", properties: {
      nested: { type: "object", properties: {
        value: { type: ["integer", "number"] },
        values: { type: "array", items: { type: ["number", "integer"] } },
        integerOrString: { type: ["integer", "string"] },
        integerOnly: { type: "integer" },
      } },
    },
  })]);
  const unsafeInteger = 9_007_199_254_740_992;
  expect(() => catalog.validate("numberUnion", { nested: { value: 0.5, values: [0.25, unsafeInteger] } })).not.toThrow();
  expect(() => catalog.validate("numberUnion", { nested: { value: unsafeInteger } })).not.toThrow();
  expect(() => catalog.validate("numberUnion", { nested: { integerOrString: "9007199254740993123", integerOnly: Number.MAX_SAFE_INTEGER } })).not.toThrow();
  expect(() => catalog.validate("numberUnion", { nested: { integerOrString: unsafeInteger } })).toThrow("Unsafe integer");
  expect(() => catalog.validate("numberUnion", { nested: { integerOnly: unsafeInteger } })).toThrow("Unsafe integer");
  expect(() => catalog.validate("numberUnion", { nested: { integerOnly: 0.5 } })).toThrow("Invalid arguments");
  expect(() => catalog.validate("numberUnion", { nested: { value: Infinity } })).toThrow("Non-finite");
});
