/**
 * Minimal MCP server (stdio) that reports back the value of an environment
 * variable it was started with. Exists so a test can assert WHICH value an
 * env var had inside the spawned child — e.g. that simulation mode forced a
 * connector's mode var to "simulation" — without inventing a fake transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'env-report-fixture', version: '0.0.1' }, {});

server.registerTool(
  'get_env',
  {
    description: 'Reports the value of an environment variable this process was started with',
    inputSchema: { name: z.string().describe('Environment variable name') },
  },
  async (args) => ({
    content: [{ type: 'text', text: process.env[args.name] ?? '' }],
  }),
);

await server.connect(new StdioServerTransport());
