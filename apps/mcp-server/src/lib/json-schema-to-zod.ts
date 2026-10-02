/**
 * Connector tool input schema (JSON Schema) → Zod shape for registerTool.
 *
 * The MCP SDK's registerTool takes Zod and turns it back into JSON Schema for the
 * agent's tools/list. The previous converter kept only the top level — every
 * nested object became "any object", every array "a list of anything" — so the
 * agent never saw e.g. that create_quote's `lines` are {item_id, qty}, nor the
 * simulation package format of load_simulation (found 2026-10-02 by hap-e2e
 * simulation-setup). This converts recursively.
 *
 * Safety (the schema comes from the connector, which we do not fully trust):
 * - depth-limited (MAX_DEPTH); deeper parts fall back to z.unknown(), as before;
 * - `$ref` is never resolved (no recursion, no remote fetch) — unknown;
 * - objects pass unknown keys through, so nothing a connector accepts today is
 *   newly refused by the gateway; enforcement of bounds is unchanged (it reads the
 *   arguments, not this schema).
 */
import { z } from 'zod';

const MAX_DEPTH = 8;

type Json = Record<string, unknown>;

function convert(schema: unknown, depth: number): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return z.unknown();
  const s = schema as Json;
  if ('$ref' in s) return withDescription(z.unknown(), s);

  let t: z.ZodTypeAny;
  const type = Array.isArray(s.type) ? undefined : s.type; // union types: keep permissive
  switch (type) {
    case 'string': {
      if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === 'string')) {
        t = z.enum(s.enum as [string, ...string[]]);
        break;
      }
      let str = z.string();
      if (typeof s.minLength === 'number') str = str.min(s.minLength);
      if (typeof s.maxLength === 'number') str = str.max(s.maxLength);
      if (typeof s.pattern === 'string') {
        try { str = str.regex(new RegExp(s.pattern)); } catch { /* invalid pattern: ignore */ }
      }
      t = str;
      break;
    }
    case 'number':
    case 'integer': {
      let num = z.number();
      if (type === 'integer') num = num.int();
      if (typeof s.minimum === 'number') num = num.min(s.minimum);
      if (typeof s.maximum === 'number') num = num.max(s.maximum);
      t = num;
      break;
    }
    case 'boolean':
      t = z.boolean();
      break;
    case 'array': {
      let arr = z.array(s.items ? convert(s.items, depth + 1) : z.unknown());
      if (typeof s.minItems === 'number') arr = arr.min(s.minItems);
      if (typeof s.maxItems === 'number') arr = arr.max(s.maxItems);
      t = arr;
      break;
    }
    case 'object': {
      if (s.properties && typeof s.properties === 'object') {
        t = z.object(shapeOf(s, depth + 1)).passthrough();
      } else {
        t = z.record(z.unknown());
      }
      break;
    }
    default:
      t = z.unknown();
  }
  return withDescription(t, s);
}

function withDescription(t: z.ZodTypeAny, s: Json): z.ZodTypeAny {
  return typeof s.description === 'string' ? t.describe(s.description) : t;
}

function shapeOf(schema: Json, depth: number): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const t = convert(prop, depth);
    shape[key] = required.has(key) ? t : t.optional();
  }
  return shape;
}

/** The top-level shape registerTool expects (the tool's input object is implied). */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  return shapeOf(schema ?? {}, 1);
}
