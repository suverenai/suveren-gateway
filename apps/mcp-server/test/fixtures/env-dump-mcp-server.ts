#!/usr/bin/env npx tsx
/**
 * Minimal MCP server (stdio) that records which environment variables it was
 * started with — the names and values, to the JSON file given as argv[2] —
 * then serves one tool so the gateway sees a healthy connector.
 */

import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

writeFileSync(process.argv[2], JSON.stringify(process.env));

const server = new McpServer({ name: 'env-dump', version: '0.1.0' }, {});
server.registerTool('noop', { description: 'Does nothing' }, async () => ({
  content: [{ type: 'text' as const, text: 'ok' }],
}));

void server.connect(new StdioServerTransport());
