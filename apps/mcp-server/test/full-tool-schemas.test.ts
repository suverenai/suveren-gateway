/**
 * The agent must see a connector tool's full input schema through the gateway —
 * nested objects with their fields and required markers, array item shapes,
 * enums and number limits. The old converter flattened everything below the top
 * level to "any object" / "list of anything" (found 2026-10-02 by hap-e2e
 * simulation-setup: load_simulation's package format and create_quote's
 * {item_id, qty} lines never reached the agent).
 *
 * Exercises the real path: our converter → the MCP SDK's registerTool → a real
 * MCP client's tools/list over an in-memory transport.
 */
import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { jsonSchemaToZodShape } from '../src/lib/json-schema-to-zod';

/** The shape of erp-mcp's create_quote (as published), trimmed to the nested parts. */
const CREATE_QUOTE = {
  type: 'object',
  properties: {
    customer_id: { type: 'string', description: 'Customer ID' },
    lines: {
      type: 'array',
      description: 'Quote lines',
      items: {
        type: 'object',
        properties: { item_id: { type: 'string', description: 'Item ID' }, qty: { type: 'number', description: 'Quantity' } },
        required: ['item_id', 'qty'],
      },
    },
    discount_pct: { type: 'number', minimum: 0, maximum: 100 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    package: {
      type: 'object',
      required: ['products'],
      properties: {
        products: {
          type: 'array', minItems: 1,
          items: { type: 'object', required: ['sku', 'stock'], properties: { sku: { type: 'string' }, stock: { type: 'integer', minimum: 0 } } },
        },
        contacts: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['customer', 'lead'] } } } },
      },
    },
  },
  required: ['customer_id', 'lines'],
};

async function listedSchema(inputSchema: Record<string, unknown>) {
  const server = new McpServer({ name: 't', version: '0' });
  server.registerTool('t', { description: 't', inputSchema: jsonSchemaToZodShape(inputSchema) }, async () => ({ content: [] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools[0].inputSchema as any;
}

describe('connector tool schemas reach the agent in full', () => {
  it('array items keep their object shape and required fields (create_quote lines)', async () => {
    const s = await listedSchema(CREATE_QUOTE);
    expect(s.required).toEqual(expect.arrayContaining(['customer_id', 'lines']));
    expect(s.properties.lines.items.properties).toHaveProperty('item_id');
    expect(s.properties.lines.items.required).toEqual(expect.arrayContaining(['item_id', 'qty']));
    expect(s.properties.lines.items.properties.qty.description).toBe('Quantity');
  });

  it('nested objects keep fields, required markers, enums and number limits (package)', async () => {
    const s = await listedSchema(CREATE_QUOTE);
    const pkg = s.properties.package;
    expect(pkg.required).toEqual(['products']);
    expect(pkg.properties.products.items.required).toEqual(expect.arrayContaining(['sku', 'stock']));
    expect(pkg.properties.products.items.properties.stock.type).toBe('integer');
    expect(pkg.properties.contacts.items.properties.type.enum).toEqual(['customer', 'lead']);
    expect(s.properties.discount_pct.maximum).toBe(100);
  });

  it('unknown extra fields are still accepted — nothing that works today is newly refused', () => {
    const shape = z.object(jsonSchemaToZodShape(CREATE_QUOTE));
    const ok = shape.safeParse({ customer_id: 'c', lines: [{ item_id: 'i', qty: 1, note: 'extra' }], extra_top: true });
    expect(ok.success).toBe(true);
  });

  it('wrongly shaped input is refused before it reaches the connector', () => {
    const shape = z.object(jsonSchemaToZodShape(CREATE_QUOTE));
    expect(shape.safeParse({ customer_id: 'c', lines: [{ item_id: 'i' }] }).success).toBe(false);
  });

  it('a hostile schema cannot make the gateway recurse: deep nesting and $ref fall back to "any value"', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 200; i++) deep = { type: 'object', properties: { x: deep } };
    const shape = jsonSchemaToZodShape({ type: 'object', properties: { d: deep, r: { $ref: '#' } } });
    // Within the depth limit the structure is still enforced; beyond it, any value.
    let value: unknown = 42; // a number where the 200-deep schema says "object"
    for (let i = 0; i < 12; i++) value = { x: value };
    expect(z.object(shape).safeParse({ d: value, r: { whatever: 1 } }).success).toBe(true);
    expect(z.object(shape).safeParse({ d: { x: 'not an object' } }).success).toBe(false);
  });
});
