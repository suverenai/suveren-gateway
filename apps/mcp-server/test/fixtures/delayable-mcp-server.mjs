/**
 * Minimal MCP server (stdio) whose STARTUP can be delayed via START_DELAY_MS.
 *
 * Exists to make start/start and start/stop races reproducible: a test spawns
 * one instance with a slow handshake and one without, and asserts the
 * IntegrationManager serializes them deterministically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const delay = Number(process.env.START_DELAY_MS ?? '0');
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const server = new McpServer({ name: 'delayable-fixture', version: '0.0.1' }, {});

server.registerTool(
  'echo',
  {
    description: 'Echoes back the input message',
    inputSchema: { message: z.string().describe('The message to echo') },
  },
  async (args) => ({
    content: [{ type: 'text', text: `Echo: ${args.message}` }],
  }),
);

await server.connect(new StdioServerTransport());
