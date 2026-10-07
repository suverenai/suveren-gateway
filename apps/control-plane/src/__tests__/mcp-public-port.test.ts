/**
 * The MCP port the UI tells AI assistants to connect to. It used to be
 * guessed from the UI's own port, which was wrong for a custom port and dev.
 */
import { describe, it, expect } from 'vitest';
import { mcpPublicPort } from '../lib/mcp-public-port';

describe('mcpPublicPort', () => {
  it('npm / Windows install: the port server.js gives the MCP server (incl. a custom one)', () => {
    expect(mcpPublicPort({ SUVEREN_MCP_PORT: '3430' })).toBe(3430);
    expect(mcpPublicPort({ SUVEREN_MCP_PORT: '15530' }, 'http://127.0.0.1:15530')).toBe(15530);
  });

  it('Docker: the host port wins over the port bound inside the container', () => {
    expect(mcpPublicPort({ SUVEREN_MCP_PUBLIC_PORT: '7430', SUVEREN_MCP_PORT: '3030' })).toBe(7430);
  });

  it('dev: only the internal URL is set', () => {
    expect(mcpPublicPort({}, 'http://127.0.0.1:3431')).toBe(3431);
  });

  it('nothing usable → null (the UI then shows no snippet rather than a guess)', () => {
    expect(mcpPublicPort({}, 'not a url')).toBeNull();
    expect(mcpPublicPort({ SUVEREN_MCP_PORT: 'abc' }, '')).toBeNull();
  });
});
