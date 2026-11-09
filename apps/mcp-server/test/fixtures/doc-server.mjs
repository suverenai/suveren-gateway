// A real MCP server over stdio that answers `get_document` like a document
// connector: { filename, contentType, contentBase64, sha256?, warnings? }.
// Id "<n>mb" gives n MiB of bytes; "<n>b" gives exactly n bytes; "warn" gives a small file with warnings.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'doc-fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'get_document', description: 'x', inputSchema: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const id = String(req.params.arguments?.id ?? '');
  let bytes;
  let extra = {};
  const mb = /^(\d+)mb$/.exec(id);
  const exact = /^(\d+)b$/.exec(id);
  if (mb) bytes = Buffer.alloc(Number(mb[1]) * 1024 * 1024, 7);
  else if (exact) bytes = Buffer.alloc(Number(exact[1]), 7);
  else {
    bytes = Buffer.from('%PDF-1.4 small');
    extra = { warnings: ['The PDF has form fields.', 'ev‮il\nline', 42, 'x'.repeat(1000)] };
  }
  const out = { filename: `${id}.pdf`, contentType: 'application/pdf', contentBase64: bytes.toString('base64'), ...extra };
  // Structured content only, plus a short text: the reply holds the bytes once.
  return { content: [{ type: 'text', text: 'document' }], structuredContent: out };
});
await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: 256 * 1024 * 1024 }));
