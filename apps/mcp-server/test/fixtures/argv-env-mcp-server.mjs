/**
 * Minimal MCP server (stdio) that reports how it was started: its own
 * command-line arguments and the value of one environment variable. Used by
 * connector-args.test.ts to see, from inside the spawned process, what the
 * gateway really handed over — arguments versus environment.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'argv-env-fixture', version: '0.0.1' }, {});

server.registerTool(
  'started_with',
  {
    description: 'Returns this process\'s arguments and one environment variable',
    inputSchema: { envVar: z.string() },
  },
  async ({ envVar }) => ({
    content: [{
      type: 'text',
      text: JSON.stringify({ argv: process.argv.slice(2), env: process.env[envVar] ?? null }),
    }],
  }),
);

await server.connect(new StdioServerTransport());
