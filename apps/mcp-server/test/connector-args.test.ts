/**
 * No credential in a connector's command-line arguments.
 *
 * A program's arguments can be read by other programs on the computer (`ps`;
 * on macOS and Linux by every user). Mollie's manifest put the access token
 * there: `--header "Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}"`, and the
 * gateway replaced the placeholder with the real token before spawning
 * mcp-remote. Now the placeholder stays, the token travels in the
 * environment, and mcp-remote (which expands `${VAR}` in `--header` itself —
 * manifest field `mcp.expandsEnvInArgs: { afterOption: ["--header"] }`)
 * builds the header. A manifest that
 * would still put a credential into the arguments is refused.
 *
 * Covered here (real spawns of a fixture connector that reports its own argv
 * and env; the real-mcp-remote proof is mcp-remote-token-not-in-args.test.ts):
 *   - buildSpawnArgs: placeholders kept / refused / interpolated, the value
 *     check, the in-memory resolved args the preflight reads;
 *   - IntegrationManager: the spawned process sees the placeholder in argv
 *     and the token in env; a refusing manifest is never spawned and its
 *     error names the variable, never the value;
 *   - every shipped manifest passes the rule with stand-in credentials.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnArgs, redactSecrets, CredentialInArgsError } from '../src/lib/connector-args';
import { remotePreflightTarget } from '../src/lib/remote-auth-preflight';
import { invalidExpandsEnvInArgsReason } from '../src/lib/manifest-loader';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'argv-env-mcp-server.mjs');
const SHIPPED_MANIFESTS = join(import.meta.dirname, '..', '..', '..', 'content', 'integrations');
const FAKE_TOKEN = 'access_org_FAKE_test_token_9f3c1e';

const HEADER = { afterOption: ['--header'] };
const MOLLIE_ARGS = ['https://mcp.mollie.com/mcp', '--header', 'Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}'];

function input(overrides: Partial<Parameters<typeof buildSpawnArgs>[0]> = {}): Parameters<typeof buildSpawnArgs>[0] {
  return {
    connectorId: 'mollie',
    args: MOLLIE_ARGS,
    vaultEnv: { MOLLIE_ACCESS_TOKEN: FAKE_TOKEN },
    vaultVarNames: new Set(['MOLLIE_ACCESS_TOKEN']),
    secretVarNames: new Set(['MOLLIE_ACCESS_TOKEN']),
    inherited: { HOME: '/home/someone' },
    expandsEnvInArgs: HEADER,
    ...overrides,
  };
}

describe('buildSpawnArgs', () => {
  it('a connector that expands ${VAR} itself: the placeholder stays, no token in the spawn args', () => {
    const { spawnArgs } = buildSpawnArgs(input());
    expect(spawnArgs).toEqual(MOLLIE_ARGS);
    expect(spawnArgs.join(' ')).not.toContain(FAKE_TOKEN);
  });

  it('the preflight still gets the real header — from the in-memory resolved args', () => {
    const { resolvedArgs } = buildSpawnArgs(input());
    expect(remotePreflightTarget('mcp-remote', resolvedArgs)).toEqual({
      url: 'https://mcp.mollie.com/mcp',
      authorization: `Bearer ${FAKE_TOKEN}`,
    });
  });

  it('a missing token resolves to an empty header for the preflight, exactly as before', () => {
    const { resolvedArgs } = buildSpawnArgs(input({ vaultEnv: {} }));
    expect(resolvedArgs[2]).toBe('Authorization: Bearer ');
  });

  it('without the manifest flag, a placeholder naming a vault variable is refused — naming the variable, never the value', () => {
    let caught: unknown;
    try {
      buildSpawnArgs(input({ expandsEnvInArgs: undefined }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialInArgsError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/^mollie: not started/);
    expect(msg).toContain('${MOLLIE_ACCESS_TOKEN}');
    expect(msg).toContain('mcp.expandsEnvInArgs.afterOption');
    expect(msg).not.toContain(FAKE_TOKEN);
  });

  it('refused even when the credential is not set yet (a leak must not depend on the vault being empty)', () => {
    expect(() => buildSpawnArgs(input({ expandsEnvInArgs: undefined, vaultEnv: {} }))).toThrow(CredentialInArgsError);
  });

  it('a non-secret vault setting in a placeholder is refused too — nothing from the vault goes into args', () => {
    expect(() =>
      buildSpawnArgs(input({
        args: ['--mode', '${MODE}'],
        vaultEnv: { MODE: 'live' },
        vaultVarNames: new Set(['MODE']),
        secretVarNames: new Set(),
        expandsEnvInArgs: undefined,
      })),
    ).toThrow(/credential \$\{MODE\}/);
  });

  it('a placeholder naming only an inherited (non-vault) variable is interpolated as before', () => {
    const { spawnArgs } = buildSpawnArgs(input({
      args: ['--home', '${HOME}', '--none', '${NOT_SET}'],
      expandsEnvInArgs: undefined,
    }));
    expect(spawnArgs).toEqual(['--home', '/home/someone', '--none', '']);
  });

  it('a secret VALUE in the args (e.g. a saved config with a pasted token) is refused, whatever the flag', () => {
    for (const expandsEnvInArgs of [HEADER, undefined]) {
      let caught: unknown;
      try {
        buildSpawnArgs(input({
          args: ['https://mcp.mollie.com/mcp', '--header', `Authorization: Bearer ${FAKE_TOKEN}`],
          expandsEnvInArgs,
        }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CredentialInArgsError);
      expect((caught as Error).message).toContain('MOLLIE_ACCESS_TOKEN');
      expect((caught as Error).message).not.toContain(FAKE_TOKEN);
    }
  });

  it('args without placeholders and without secrets pass unchanged', () => {
    expect(buildSpawnArgs(input({ args: [], expandsEnvInArgs: undefined })).spawnArgs).toEqual([]);
    expect(buildSpawnArgs(input({ args: ['--port', '1'], expandsEnvInArgs: undefined })).spawnArgs).toEqual(['--port', '1']);
  });
});

describe('buildSpawnArgs — only the declared positions are left to the program', () => {
  it('a vault placeholder in an argument that does NOT follow a declared option is refused', () => {
    expect(() =>
      buildSpawnArgs(input({ args: ['https://x/mcp', '--token', '${MOLLIE_ACCESS_TOKEN}'] })),
    ).toThrow(/credential \$\{MOLLIE_ACCESS_TOKEN\}/);
    // The option itself carrying it (no `--header` before it) is outside too.
    expect(() =>
      buildSpawnArgs(input({ args: ['--header=Authorization: Bearer ${MOLLIE_ACCESS_TOKEN}'] })),
    ).toThrow(CredentialInArgsError);
  });

  it('non-vault placeholders: left to the program after a declared option, filled in by the gateway elsewhere (as before)', () => {
    const { spawnArgs } = buildSpawnArgs(input({
      args: ['--header', 'X-Home: ${HOME}', '--home', '${HOME}'],
    }));
    expect(spawnArgs).toEqual(['--header', 'X-Home: ${HOME}', '--home', '/home/someone']);
  });
});

describe('the value check: refuses, and says a very short value may be a coincidence', () => {
  it('a short secret that happens to occur in the URL refuses the start, with the coincidence explained and no value or length', () => {
    let caught: unknown;
    try {
      buildSpawnArgs(input({ vaultEnv: { MOLLIE_ACCESS_TOKEN: 'mcp' } }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialInArgsError);
    const msg = (caught as Error).message;
    expect(msg).toBe(
      'mollie: not started — the value of the credential MOLLIE_ACCESS_TOKEN appears in its arguments, ' +
        'where other programs on this computer can read it. If that value is very short, this may be a ' +
        'coincidence (it happens to occur in an address or option). Either way, remove it from the arguments ' +
        '(the connector receives MOLLIE_ACCESS_TOKEN in its environment), or use a longer MOLLIE_ACCESS_TOKEN.',
    );
    expect(msg).not.toMatch(/\b3\b/); // no length
  });
});

describe('manifest loader: expandsEnvInArgs shape and placement', () => {
  const base = {
    mcp: { command: 'x', args: ['https://x/mcp', '--header', 'Authorization: Bearer ${TOKEN}'] },
    credentials: { fields: [], envMapping: { TOKEN: 'token' } },
  };
  const withFlag = (expandsEnvInArgs: unknown, args = base.mcp.args) =>
    ({ ...base, mcp: { ...base.mcp, args, expandsEnvInArgs } }) as unknown as Parameters<typeof invalidExpandsEnvInArgsReason>[0];

  it('accepts the declared shape with the credential after a listed option', () => {
    expect(invalidExpandsEnvInArgsReason(withFlag({ afterOption: ['--header'] }))).toBeNull();
  });

  it.each([
    ['true', true],
    ['false', false],
    ['an array', ['--header']],
    ['an empty list', { afterOption: [] }],
    ['an unknown key', { afterOption: ['--header'], everywhere: true }],
    ['a non-option', { afterOption: ['header'] }],
  ])('refuses %s', (_label, value) => {
    expect(invalidExpandsEnvInArgsReason(withFlag(value))).toMatch(/^mcp\.expandsEnvInArgs must be/);
  });

  it('refuses a credential placeholder outside the declared positions, or with no declaration at all', () => {
    expect(invalidExpandsEnvInArgsReason(withFlag({ afterOption: ['--header'] }, ['--token', '${TOKEN}'])))
      .toMatch(/mcp\.args\[1\] names the credential \$\{TOKEN\}/);
    expect(invalidExpandsEnvInArgsReason(withFlag(undefined)))
      .toMatch(/mcp\.args\[2\] names the credential \$\{TOKEN\}/);
  });

  it('a non-credential placeholder anywhere is fine', () => {
    expect(invalidExpandsEnvInArgsReason(withFlag(undefined, ['--home', '${HOME}']))).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence, longest value first, and ignores empty values', () => {
    expect(redactSecrets(`a ${FAKE_TOKEN} b ${FAKE_TOKEN}`, [FAKE_TOKEN, ''])).toBe('a [redacted] b [redacted]');
    expect(redactSecrets('xx-abcdef-yy', ['abc', 'abcdef'])).toBe('xx-[redacted]-yy');
    expect(redactSecrets('nothing here', [])).toBe('nothing here');
  });
});

describe('every shipped manifest keeps credentials out of the args', () => {
  const files = readdirSync(SHIPPED_MANIFESTS).filter(f => f.endsWith('.json') && f !== 'index.json');

  it.each(files)('%s', (file) => {
    const m = JSON.parse(readFileSync(join(SHIPPED_MANIFESTS, file), 'utf8')) as {
      mcp: { args: string[]; expandsEnvInArgs?: { afterOption: string[] } };
      credentials: { fields: Array<{ key: string; type: string }>; envMapping: Record<string, string> };
    };
    const types = new Map(m.credentials.fields.map(f => [f.key, f.type]));
    const vaultEnv: Record<string, string> = {};
    const secret = new Set<string>();
    for (const [envVar, key] of Object.entries(m.credentials.envMapping)) {
      vaultEnv[envVar] = `STAND_IN_VALUE_${envVar}_7c2e`;
      if (types.get(key) !== 'text') secret.add(envVar);
    }
    const { spawnArgs } = buildSpawnArgs({
      connectorId: file,
      args: m.mcp.args,
      vaultEnv,
      vaultVarNames: new Set(Object.keys(vaultEnv)),
      secretVarNames: secret,
      inherited: {},
      expandsEnvInArgs: m.mcp.expandsEnvInArgs,
    });
    for (const v of Object.values(vaultEnv)) expect(spawnArgs.join('\n')).not.toContain(v);
  });

  it('mollie.json declares that mcp-remote expands ${VAR} itself', () => {
    const m = JSON.parse(readFileSync(join(SHIPPED_MANIFESTS, 'mollie.json'), 'utf8'));
    expect(m.mcp.expandsEnvInArgs).toEqual({ afterOption: ['--header'] });
    expect(m.mcp.command).toBe('mcp-remote');
  });
});

// ─── Through the real spawn path ────────────────────────────────────────────

let workDir: string;
let manifestsDir: string;
let originalIntegrationsDir: string | undefined;
let IntegrationManager: typeof import('../src/lib/integration-manager').IntegrationManager;
let loadManifests: typeof import('../src/lib/manifest-loader').loadManifests;
let getManifest: typeof import('../src/lib/manifest-loader').getManifest;

function manifest(id: string, args: string[], expandsEnvInArgs?: unknown): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1',
    description: 'test fixture',
    icon: 'wrench',
    profile: 'test-profile',
    mcp: { command: process.execPath, args, ...(expandsEnvInArgs !== undefined ? { expandsEnvInArgs } : {}) },
    credentials: {
      fields: [
        { key: 'accessToken', label: 'Access Token', type: 'password' },
        { key: 'mode', label: 'Mode', type: 'text' },
      ],
      envMapping: { FAKE_ACCESS_TOKEN: 'accessToken', FAKE_MODE: 'mode' },
    },
    oauth: null,
    toolGating: { default: { executionMapping: {} }, overrides: {} },
  };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'hap-connector-args-test-'));
  manifestsDir = join(workDir, 'manifests');
  mkdirSync(manifestsDir, { recursive: true });
  originalIntegrationsDir = process.env.SUVEREN_INTEGRATIONS_DIR;
  process.env.SUVEREN_INTEGRATIONS_DIR = join(workDir, 'integrations');

  const entries: Record<string, Record<string, unknown>> = {
    // mollie's shape: the program expands ${VAR} itself.
    'expands-itself': manifest('expands-itself', [FIXTURE, '--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}'], HEADER),
    // The same args WITHOUT the declaration: the old leak — must be refused.
    'would-leak': manifest('would-leak', [FIXTURE, '--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}']),
    // Declared for --header, but the credential sits after another option.
    'expands-elsewhere': manifest('expands-elsewhere', [FIXTURE, '--token', '${FAKE_ACCESS_TOKEN}'], HEADER),
    // The old boolean shape: no longer valid.
    'bool-flag': manifest('bool-flag', [FIXTURE, '--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}'], true),
    // A plain connector: no placeholders at all (every other shipped one).
    'plain': manifest('plain', [FIXTURE]),
  };
  const index: Record<string, string> = {};
  for (const [id, m] of Object.entries(entries)) {
    index[id] = `${id}.json`;
    writeFileSync(join(manifestsDir, `${id}.json`), JSON.stringify(m));
  }
  writeFileSync(join(manifestsDir, 'index.json'), JSON.stringify({ integrations: index }));

  ({ IntegrationManager } = await import('../src/lib/integration-manager'));
  ({ loadManifests, getManifest } = await import('../src/lib/manifest-loader'));
  loadManifests(manifestsDir);
});

afterAll(() => {
  if (originalIntegrationsDir === undefined) delete process.env.SUVEREN_INTEGRATIONS_DIR;
  else process.env.SUVEREN_INTEGRATIONS_DIR = originalIntegrationsDir;
  rmSync(workDir, { recursive: true, force: true });
});

function configFor(id: string, args: string[]) {
  return {
    id,
    name: id,
    command: process.execPath,
    args,
    envKeys: { FAKE_ACCESS_TOKEN: `${id}.accessToken` },
    optionalEnvKeys: { FAKE_MODE: `${id}.mode` },
    profile: null,
    enabled: true,
  };
}

async function startedWith(im: InstanceType<typeof IntegrationManager>, id: string): Promise<{ argv: string[]; env: string | null }> {
  const res = await im.callTool(id, 'started_with', { envVar: 'FAKE_ACCESS_TOKEN' });
  return JSON.parse(res.content[0].text) as { argv: string[]; env: string | null };
}

describe('IntegrationManager spawns a connector without its credential in the arguments', () => {
  let im: InstanceType<typeof IntegrationManager>;
  afterEach(async () => { await im?.shutdown(); });

  it('expandsEnvInArgs: the process sees the ${VAR} placeholder in argv and the token in its environment', async () => {
    im = new IntegrationManager(new Map([['expands-itself', { accessToken: FAKE_TOKEN, mode: 'live' }]]));
    await im.startIntegration(configFor('expands-itself', [FIXTURE, '--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}']));
    const seen = await startedWith(im, 'expands-itself');
    expect(seen.argv).toEqual(['--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}']);
    expect(seen.argv.join(' ')).not.toContain(FAKE_TOKEN);
    expect(seen.env).toBe(FAKE_TOKEN);
  });

  it('without the declaration the start is refused, never spawned; the error names connector and variable, not the value', async () => {
    im = new IntegrationManager(new Map([['would-leak', { accessToken: FAKE_TOKEN }]]));
    const err = await im
      .startIntegration(configFor('would-leak', [FIXTURE, '--header', 'Authorization: Bearer ${FAKE_ACCESS_TOKEN}']))
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(CredentialInArgsError);
    expect(err!.message).toMatch(/^would-leak: not started/);
    expect(err!.message).toContain('FAKE_ACCESS_TOKEN');
    expect(err!.message).not.toContain(FAKE_TOKEN);
    expect(im.isRunning('would-leak')).toBe(false);
  });

  it('the loader refuses manifests that would put a credential into the args, and the old boolean shape', () => {
    expect(getManifest('expands-itself')).toBeDefined();
    expect(getManifest('plain')).toBeDefined();
    expect(getManifest('would-leak')).toBeUndefined();
    expect(getManifest('expands-elsewhere')).toBeUndefined();
    expect(getManifest('bool-flag')).toBeUndefined();
  });

  it('a credential after an undeclared option is refused at start too (a saved config, whatever the manifest says)', async () => {
    im = new IntegrationManager(new Map([['expands-itself', { accessToken: FAKE_TOKEN }]]));
    const err = await im
      .startIntegration(configFor('expands-itself', [FIXTURE, '--token', '${FAKE_ACCESS_TOKEN}']))
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(CredentialInArgsError);
    expect(err!.message).toMatch(/^expands-itself: not started/);
    expect(err!.message).not.toContain(FAKE_TOKEN);
    expect(im.isRunning('expands-itself')).toBe(false);
  });

  it('a saved config with the token pasted literally into its args is refused', async () => {
    im = new IntegrationManager(new Map([['plain', { accessToken: FAKE_TOKEN }]]));
    const err = await im
      .startIntegration(configFor('plain', [FIXTURE, `--token=${FAKE_TOKEN}`]))
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(CredentialInArgsError);
    expect(err!.message).not.toContain(FAKE_TOKEN);
    expect(im.isRunning('plain')).toBe(false);
  });

  it('a plain connector starts exactly as before: same argv, credential in its environment', async () => {
    im = new IntegrationManager(new Map([['plain', { accessToken: FAKE_TOKEN }]]));
    await im.startIntegration(configFor('plain', [FIXTURE]));
    const seen = await startedWith(im, 'plain');
    expect(seen.argv).toEqual([]);
    expect(seen.env).toBe(FAKE_TOKEN);
  });
});
