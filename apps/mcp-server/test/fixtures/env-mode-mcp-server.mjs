/**
 * Minimal MCP server (stdio) that reports the FIXTURE_MODE it was started
 * with — lets a test see which env a (re)started child actually received.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'env-mode-fixture', version: '0.0.1' }, {});

server.registerTool(
  'mode',
  { description: 'Returns FIXTURE_MODE from the environment', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: process.env.FIXTURE_MODE ?? 'unset' }] }),
);

await server.connect(new StdioServerTransport());
