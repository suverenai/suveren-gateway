import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
const c = new Client({ name: 'deploy-driver', version: '1' }, { capabilities: {} });
await c.connect(new SSEClientTransport(new URL('http://localhost:3431/sse')));
const tools = (await c.listTools()).tools.map(t => t.name).filter(n => n.startsWith('deploy'));
console.log('deploy tools visible:', tools.join(', ') || '(none — check authorization)');
const [, , tool, argsJson] = process.argv;
if (tool) {
  const r = await c.callTool({ name: tool, arguments: JSON.parse(argsJson || '{}') });
  console.log('isError:', r.isError ?? false);
  console.log(r.content.map(x => x.text).join('\n').slice(0, 900));
}
await c.close();
