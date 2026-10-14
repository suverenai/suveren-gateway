/**
 * AU10 — `_source` is offered on every non-read connector tool's discovered
 * input schema, and ONLY those (doc §1: "Not offered on read tools.").
 * Exercises the real integration point (IntegrationManager.startIntegration),
 * not just the pure `withSourceLink` helper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { IntegrationManager } from '../src/lib/integration-manager';
import type { IntegrationConfig } from '../src/lib/integration-registry';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'test-mcp-server.ts');

function config(): IntegrationConfig {
  return {
    id: 'au10fixture',
    name: 'AU10 fixture',
    command: 'npx',
    args: ['tsx', FIXTURE],
    env: {},
    envKeys: {},
    profile: 'au10-profile',
    toolGating: {
      default: { executionMapping: {} },
      overrides: {
        // write tool — should get _source
        add: { executionMapping: {}, staticExecution: { action_type: 'write' } },
        // read tool — must NOT get _source
        echo: { category: 'read', boundField: 'read_access', requiredValue: 'unlimited' },
      },
    } as IntegrationConfig['toolGating'],
    enabled: true,
  };
}

describe('_source injection at tool discovery', () => {
  let im: IntegrationManager;
  afterEach(async () => { await im?.shutdown(); });

  it('a non-read tool gets an optional _source property; a read tool does not', async () => {
    im = new IntegrationManager(new Map());
    await im.startIntegration(config());
    const tools = im.getAllTools();

    const add = tools.find((t) => t.originalName === 'add');
    const echo = tools.find((t) => t.originalName === 'echo');
    expect(add).toBeDefined();
    expect(echo).toBeDefined();

    const addProps = (add!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const echoProps = (echo!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect('_source' in addProps).toBe(true);
    expect('_source' in echoProps).toBe(false);
    // The original arguments must still be present, unmodified.
    expect(addProps.a).toBeDefined();
    expect(addProps.b).toBeDefined();
  });
});
