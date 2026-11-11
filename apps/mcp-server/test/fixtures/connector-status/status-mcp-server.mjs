/**
 * Minimal MCP server (stdio) with a status check, for connector-status.test.ts.
 *
 * `check_status` answers `structuredContent.problem` with the text of the file
 * named by STATUS_FILE (no file or empty file = no problem). STATUS_MODE=error
 * makes the check answer with an error; STATUS_MODE=hang never answers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'status-fixture', version: '0.0.1' }, {});

server.registerTool(
  'echo',
  { description: 'Echoes back the input message', inputSchema: { message: z.string() } },
  async (args) => ({ content: [{ type: 'text', text: `Echo: ${args.message}` }] }),
);

server.registerTool(
  'check_status',
  { description: 'Can this connector work right now?', inputSchema: {}, outputSchema: { problem: z.string().optional() } },
  async () => {
    if (process.env.STATUS_MODE === 'error') throw new Error('status check broke');
    if (process.env.STATUS_MODE === 'hang') await new Promise(() => {});
    const file = process.env.STATUS_FILE;
    const problem = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
    const structured = problem ? { problem } : {};
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
  },
);

await server.connect(new StdioServerTransport());
