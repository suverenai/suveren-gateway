/**
 * Guidance: the words that let an AI with only the gateway's tools lead a person
 * from an empty gateway to a working one. The builders are generic — they take
 * manifests, mandates and facts — so every case below uses several DIFFERENT
 * manifests (a files-like, an invoices-like, a sender, an unrelated one) and none
 * of the builders names any of them.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { registerProfile } from '@hap/core';
import {
  firstMandateText,
  connectorOverview,
  howToGetMandate,
  attachmentSources,
  attachmentLine,
  attachmentNotAllowedText,
  attachmentFailureStep,
  refusalNextStep,
  sourceTitle,
  manifestAreas,
  possibleAreas,
  factsLines,
  shortAnswer,
  pickerCard,
  proposalFields,
  SIGN_STEP,
  mandateEndedProposalText,
  endedFromRefusal,
  productionBlockedSteps,
  cardSteps,
  type GuideManifest,
  type GuideAuth,
  type OverviewInput,
} from '../src/lib/guidance';
import { buildMandateBrief } from '../src/lib/mandate-brief';
import { listAuthorizationsHandler } from '../src/tools/authorizations';
import { buildProxiedToolDescription, noMandateRefusal } from '../src/lib/tool-proxy';
import { invalidManifestDocumentsReason, loadManifests, getManifest } from '../src/lib/manifest-loader';
import { createMcpServer } from '../src/index';
import type { IntegrationManager, DiscoveredTool } from '../src/lib/integration-manager';
import type { SharedState, EnrichedAuthorization } from '../src/lib/shared-state';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const PROFILES_DIR = process.env.SUVEREN_PROFILES_DIR ?? join(ROOT, '..', 'hap-profiles');
const profile = (rel: string) => JSON.parse(readFileSync(join(PROFILES_DIR, rel), 'utf8'));

afterEach(() => { delete process.env.SUVEREN_SIMULATION; });

// ── Several different manifests ────────────────────────────────────────────

const FILES: GuideManifest = {
  id: 'files', name: 'Files', description: 'Files kept on this computer', profile: 'files',
  setupHint: 'Choose a folder on this computer.',
  credentials: { fields: [{ key: 'sharedFolder', label: 'Shared folder', placeholder: 'Full path of the folder your AI saves files into' }] },
  documents: { file: { title: 'Saved files', label: 'saved file {id}', savedBy: 'save_file' } },
  setupGuide: [{ title: 'Choose the shared folder', description: 'Pick one folder.' }, { title: 'Give the Files mandate' }],
  toolGating: { overrides: { save_file: { profile: 'files' } } },
};
const LEDGER: GuideManifest = {
  id: 'ledger', name: 'Ledger', description: 'Bookkeeping', profile: 'invoicing',
  setupHint: 'Paste your API key.',
  credentials: { fields: [{ key: 'apiKey', label: 'API key' }] },
  documents: { 'invoice-pdf': { label: 'issued invoice {id}' }, 'quote-pdf': { label: 'quote {id}' } },
  toolGating: { overrides: { issue: { profile: 'invoicing' }, quote: { profile: 'sales' } } },
};
const POST: GuideManifest = {
  id: 'post', name: 'Post', description: 'Send mail', profile: 'email',
  oauth: { signInGroup: { name: 'Google' } },
  credentials: { fields: [{ key: 'clientId', label: 'Client ID' }] },
  toolGating: { overrides: { send: { profile: 'email', attachmentsArg: 'attachments' } } },
};
const NOTES: GuideManifest = { id: 'notes', name: 'Notes', profile: 'memo', toolGating: { overrides: {} } };

const auth = (profileId: string, extra: Partial<GuideAuth> = {}): GuideAuth => ({ profileId, complete: true, ...extra });
const NAMES: Record<string, string> = { files: 'Files', invoicing: 'Invoicing', sales: 'Sales', email: 'Email', memo: 'Memo', delegation: 'Setup' };

function input(over: Partial<OverviewInput> & { running?: string[]; creds?: string[]; blocked?: Record<string, 'simulation' | 'production'> } = {}): OverviewInput {
  const running = new Set(over.running ?? []);
  const creds = new Set(over.creds ?? []);
  return {
    manifests: [FILES, LEDGER, POST, NOTES],
    auths: [],
    areaName: (a) => NAMES[a] ?? a,
    setup: { card: 'Setup', held: [], fields: { profile: 'allowed_profiles', mode: 'allowed_modes' } },
    toolName: (c, t) => `${c}__${t}`,
    facts: (id) => ({ running: running.has(id), hasCredentials: creds.has(id), blocked: over.blocked?.[id] }),
    ...over,
  };
}

describe('manifestAreas / sourceTitle', () => {
  it('lists the connector area first, then any area a tool names — once', () => {
    expect(manifestAreas(LEDGER)).toEqual(['invoicing', 'sales']);
    expect(manifestAreas({ ...POST, profile: 'github.com/x/hap-profiles/email@0.9' })).toEqual(['email']);
    expect(manifestAreas({ id: 'x', name: 'X' })).toEqual([]);
  });
  it('names a kind as the mandate form does: title, else label without {id}, else the kind', () => {
    expect(sourceTitle('file', FILES.documents!.file)).toBe('Saved files');
    expect(sourceTitle('invoice-pdf', LEDGER.documents!['invoice-pdf'])).toBe('Issued invoice');
    expect(sourceTitle('thing', undefined)).toBe('Thing');
  });
});

describe('1. the first mandate', () => {
  it('names the page, the buttons and the card, in order, and the follow-up call', () => {
    const t = firstMandateText({ url: 'http://localhost:3400', card: 'Setup' });
    expect(t).toContain('An AI can never create the first one');
    expect(t).toContain('http://localhost:3400');
    expect(t).toMatch(/\*\*Mandates\*\*, then \*\*\+ New mandate\*\*/);
    expect(t).toContain('card **Setup**');
    expect(t).toContain('**Give a mandate**');
    expect(t).toContain('Scope & Limits');
    expect(t).toMatch(/In Sign they give it a \*\*Title\*\* \(required\), choose how it runs and for how long, then press \*\*Sign mandate\*\*/);
    expect(t).toContain('Ask them first whether it should run automatically or ask each time.');
    expect(t).toContain('No active mandate exists');
    expect(t).not.toContain('yet');
    expect(t).toContain('list-authorizations()');
    expect(t.indexOf('1.')).toBeLessThan(t.indexOf('2.'));
    expect(t.indexOf('2.')).toBeLessThan(t.indexOf('3.'));
  });
  it('uses the card name it is given, whatever it is', () => {
    expect(firstMandateText({ url: 'u', card: 'Delegation' })).toContain('card **Delegation**');
  });
});

describe('4. attachments, built from the manifests', () => {
  const tn = (c: string, t: string) => `${c}__${t}`;
  it('lists every document kind with the connector, and who saves it when the manifest says', () => {
    const line = attachmentLine(attachmentSources([FILES, LEDGER, POST], tn))!;
    expect(line).toContain('Saved files (files:file; save the file first with files__save_file)');
    expect(line).toContain('Issued invoice (ledger:invoice-pdf)');
    expect(line).toContain('Quote (ledger:quote-pdf)');
    expect(line).not.toContain('ledger__');           // no savedBy declared -> no save hint
    expect(line).toMatch(/Never send without an attachment the person asked for: if it is missing or refused, stop and ask the person\.$/);
  });
  it('follows the manifest: another connector with another tool name', () => {
    const DOCS: GuideManifest = { id: 'vault', name: 'Vault', documents: { upload: { title: 'Uploads', savedBy: 'put_upload' } } };
    expect(attachmentLine(attachmentSources([DOCS], tn))).toContain('Uploads (vault:upload; save the file first with vault__put_upload)');
  });
  it('is absent when no connector offers a document', () => {
    expect(attachmentLine(attachmentSources([POST, NOTES], tn))).toBeUndefined();
  });

  describe('the refusal names the mandate and the source to tick', () => {
    const emailProfile = { scopeSchema: { fields: { allowed_attachment_sources: {} } } };
    const oldProfile = { scopeSchema: { fields: {} } };
    const refs = [{ connector: 'files', kind: 'file' }];
    const base = { tool: 'post__send', area: 'Email', refs, titleOf: (c: string, k: string) => (c === 'files' && k === 'file' ? 'Saved files' : k) };
    it('current mandate without the tick', () => {
      const t = attachmentNotAllowedText({ ...base, candidates: [{ profileId: 'email@0.9', context: { allowed_attachment_sources: 'ledger:invoice-pdf' } }], profileOf: () => emailProfile });
      expect(t).toContain('Refused: no Email mandate lets post__send attach Saved files (files:file).');
      expect(t).toContain('Nothing was sent and no ticket was requested.');
      expect(t).toContain('**Mandates**, open the Email mandate, press **Edit**, tick Saved files (files:file) under **What the AI may attach**, and sign it again.');
      expect(t).toMatch(/stop and ask\.$/);
    });
    it('only the missing source is named when another is ticked', () => {
      const t = attachmentNotAllowedText({
        ...base, refs: [...refs, { connector: 'ledger', kind: 'invoice-pdf' }],
        candidates: [{ profileId: 'email@0.9', context: { allowed_attachment_sources: 'ledger:invoice-pdf' } }], profileOf: () => emailProfile,
      });
      expect(t).toContain('attach Saved files (files:file).');
      expect(t).not.toContain('invoice-pdf');
    });
    it('a mandate from a version that cannot carry attachments says to give a new one', () => {
      const t = attachmentNotAllowedText({ ...base, candidates: [{ profileId: 'email@0.8' }], profileOf: () => oldProfile });
      expect(t).toContain('is from a version that cannot carry attachments');
      expect(t).toContain('**Mandates → + New mandate → Email**');
    });
  });

  it('a failed attachment ends with the person\'s step and "stop and ask", by cause', () => {
    expect(attachmentFailureStep({ code: 'UNAVAILABLE', connector: 'files', connectorName: 'Files' })).toMatch(/Files connector is not running.*\*\*Connectors\*\*.*card \*\*Files\*\*.*stop and ask/s);
    expect(attachmentFailureStep({ code: 'NOT_FOUND', connector: 'files', savedBy: 'files__save_file' })).toMatch(/Bring it in first with files__save_file.*stop and ask/s);
    expect(attachmentFailureStep({ code: 'NOT_FOUND', connector: 'ledger' })).toMatch(/Ask the person which one they mean.*stop and ask/s);
    expect(attachmentFailureStep({ code: 'TOO_LARGE', connector: 'files' })).toMatch(/smaller file.*stop and ask/s);
    expect(attachmentFailureStep({ code: 'WHATEVER', connector: 'files' })).toMatch(/nothing was sent.*stop and ask/s);
  });
});

describe('2. what is needed for a goal — the connector overview', () => {
  it('a fresh gateway: every connector in the order to act, each with its next step', () => {
    const t = connectorOverview(input({ running: ['notes'] }));
    // Not-running connectors (a person acts first) come before the running one.
    expect(t.indexOf('- Files')).toBeLessThan(t.indexOf('- Notes'));
    expect(t.indexOf('- Ledger')).toBeLessThan(t.indexOf('- Notes'));
    // Set up or not: Ledger needs a key (no settings saved), Files has only optional settings, Post needs a sign-in.
    expect(t).toMatch(/- Ledger \(Bookkeeping\) — not set up\. A person opens \*\*Connectors\*\*, the card \*\*Ledger\*\*, enters \*\*API key\*\*, presses \*\*Save & Encrypt\*\* \(the connector then starts by itself\)/);
    expect(t).toMatch(/- Post \(Send mail\) — not set up\..*presses \*\*Save & Encrypt\*\*, then \*\*Connect Post Account\*\* and follows the steps on the card to connect Google/);
    expect(t).toMatch(/- Files \(Files kept on this computer\) — not set up\. A person opens \*\*Connectors\*\*, the card \*\*Files\*\*, enters \*\*Shared folder\*\* \(Full path of the folder your AI saves files into\), presses \*\*Save & Encrypt\*\*/);

    expect(t).toContain('- Notes — running.');
  });

  it('settings saved: set up but not running; running: no step for the connector itself', () => {
    const t = connectorOverview(input({ creds: ['ledger'], running: ['post'] }));
    expect(t).toMatch(/- Ledger \(Bookkeeping\) — set up, but not running\. A person opens \*\*Connectors\*\*, the card \*\*Ledger\*\* and presses \*\*Start Ledger Connector\*\*/);
    expect(t).toMatch(/- Post \(Send mail\) — running\./);
  });

  it('a blocked connector says so and where the setting is', () => {
    const t = connectorOverview(input({ blocked: { ledger: 'production' } }));
    expect(t).toMatch(/- Ledger.*runs for real\. A person opens \*\*Connectors\*\*, the card \*\*Ledger\*\*/s);
  });

  it('mandate per AREA: a connector serving two areas is checked for both', () => {
    const t = connectorOverview(input({ running: ['ledger'], auths: [auth('github.com/x/invoicing@0.4')] }));
    expect(t).toContain('mandate for Invoicing: yes');
    expect(t).toMatch(/mandate for Sales: none\./);
  });

  it('a review-mode mandate is marked', () => {
    const t = connectorOverview(input({ running: ['notes'], auths: [auth('memo@0.1', { deferredCommitmentDomains: ['owner'] })] }));
    expect(t).toContain('mandate for Memo: yes (review: each action needs approval)');
  });

  it('a mandate that must be signed again is not "none"', () => {
    const t = connectorOverview(input({ running: ['notes'], auths: [auth('memo@0.1', { needsReapproval: true })] }));
    expect(t).toContain('mandate for Memo: must be signed again. A person opens **Mandates** and presses **Sign again**');
    expect(t).not.toContain('mandate for Memo: none');
  });

  it('running connector with no mandate comes before one that has it', () => {
    const t = connectorOverview(input({ running: ['notes', 'ledger'], auths: [auth('memo@0.1'), auth('invoicing@0.4'), auth('sales@0.4')] , manifests: [NOTES, LEDGER, FILES]}));
    expect(t.indexOf('- Files')).toBeLessThan(t.indexOf('- Notes'));
  });

  it('shows who can bring a document in, and which sources the sending mandate still lacks', () => {
    const t = connectorOverview(input({
      running: ['files', 'ledger', 'post'],
      auths: [auth('email@0.9', { context: { allowed_attachment_sources: 'files:file' } }), auth('files@0.1'), auth('invoicing@0.4'), auth('sales@0.4')],
    }));
    expect(t).toContain('its documents (Saved files) can be attached to messages if the sending mandate ticks them under **What the AI may attach**');
    expect(t).toMatch(/may attach: Saved files \(save the file first with files__save_file\) — allowed; Issued invoice — not ticked in the mandate; Quote — not ticked in the mandate/);
    expect(t).toContain('A source that is not ticked needs the person to edit that mandate: **Mandates**, open it, **Edit**, tick it under **What the AI may attach**, sign again.');
  });

  it('with the sender not yet under a mandate, sources are listed without a verdict', () => {
    const t = connectorOverview(input({ running: ['post', 'files'] }));
    expect(t).toMatch(/may attach: Saved files \(save the file first with files__save_file\); Issued invoice; Quote/);
    expect(t).not.toContain('not ticked');
  });

  it('asked for by name, prints the connector\'s whole setup guide', () => {
    const t = connectorOverview(input({ manifests: [FILES], detail: true }));
    expect(t).toContain('1. Choose the shared folder — Pick one folder.');
    expect(t).toContain('2. Give the Files mandate');
  });

  it('a manifest with nothing special is just a line', () => {
    const t = connectorOverview(input({ manifests: [NOTES], running: ['notes'] }));
    expect(t.split('\n').filter(l => l.trim().startsWith('-'))).toHaveLength(1);
  });
});

describe('2. how to get a missing mandate', () => {
  const heldSetup = (profiles: string, modes: string): OverviewInput['setup'] => ({
    tool: 'setup__create_mandate', card: 'Setup', fields: { profile: 'allowed_profiles', mode: 'allowed_modes' },
    held: [auth('delegation@0.6', { context: { allowed_profiles: profiles, allowed_modes: modes } })],
  });
  const noSetup: OverviewInput['setup'] = { card: 'Setup', held: [], fields: { profile: 'allowed_profiles', mode: 'allowed_modes' } };
  const args = (setup: OverviewInput['setup'], team?: OverviewInput['team']) => ({ areaName: (a: string) => NAMES[a] ?? a, setup, team });

  it('a Setup mandate allows the area: propose it, ask automatic-or-review first, lowest limits, say what it allows', () => {
    const t = howToGetMandate('email', 'Post', args(heldSetup('email, files', 'review')));
    expect(t).toContain('Propose it with setup__create_mandate(profile: "email", ...) (modes you may propose: review).');
    expect(t).toContain('ask the person whether it should run automatically or ask them each time (review)');
    expect(t).toContain('lowest limits and the shortest duration that cover the work');
    expect(t).toContain('what the mandate really allows');
  });

  it('a Setup mandate that does not list the area: the person signs it, or widens the Setup mandate', () => {
    const t = howToGetMandate('sales', 'Ledger', args(heldSetup('email', 'review')));
    expect(t).toContain('Not yours to propose: the person\'s Setup mandate does not list Sales.');
    expect(t).toContain('**Mandates → + New mandate →** card **Ledger**');
    expect(t).toContain('add Sales to the Setup mandate');
    expect(t).not.toContain('Propose it with');
  });

  it('no Setup mandate: the person signs it on the page, with the card name', () => {
    const t = howToGetMandate('email', 'Post', args(noSetup));
    expect(t).toBe('A person signs it: **Mandates → + New mandate**, card **Post**, **Give a mandate**. Ask them first whether it should run automatically or ask each time. On the **Sign** step they give it a **Title** (required) and choose **Review Each Action** or **Automatic**, then press **Sign mandate**. (With a Setup mandate you could prepare it for them.)');
  });

  it('the team has not enabled the profile: says what an admin does, and that nothing else helps', () => {
    const t = howToGetMandate('email', 'Post', args(heldSetup('email', 'review'), new Map([['email', { teamCode: 'profile_not_enabled', teamName: 'Sales Vienna' }]])));
    expect(t).toContain('Blocked: the team "Sales Vienna" has not enabled Email');
    expect(t).toContain('ask an admin of "Sales Vienna" to open **Team → Manage this team in your Authority Server**, enable Email and name who may give its mandates');
    expect(t).toContain('Nothing else helps until then.');
    expect(t).not.toContain('Propose it with');
  });

  it('enabled, but the person is not a grantor', () => {
    const t = howToGetMandate('email', 'Post', args(noSetup, new Map([['email', { teamCode: 'not_a_grantor', teamName: 'Sales Vienna' }]])));
    expect(t).toContain('Blocked: Email is enabled in "Sales Vienna", but the person is not one of those who may give it.');
  });
});

describe('7 more cases from the real-AI test', () => {
  const MAIL: GuideManifest = {
    id: 'mail', name: 'Email', description: 'Read and send email', profile: 'email',
    simulation: { field: 'mode', default: 'simulation' },
    modeLabels: { simulation: 'Test mailbox', live: { gmail: 'Gmail' } },
    modeOptions: { live: { gmail: { label: 'Gmail', fields: ['clientId', 'clientSecret'] } } },
    credentials: { fields: [
      { key: 'mode', label: 'Mode (optional)', optional: true },
      { key: 'clientId', label: 'Client ID', placeholder: 'From Google Cloud Console', optional: true },
      { key: 'clientSecret', label: 'Client Secret', optional: true },
    ] },
    oauth: { signInGroup: { name: 'Google' }, forOption: { mode: 'live' } },
    setupGuide: [{ title: 'Ready to use', description: 'A simulated inbox.', simulationOnly: true }, { title: 'Use Gmail', description: 'Create an OAuth client.' }],
    toolGating: { overrides: { send: { profile: 'email', attachmentsArg: 'attachments' } } },
  };
  const ERP: GuideManifest = { id: 'erp', name: 'ERP', profile: 'sales', toolGating: { overrides: { issue: { profile: 'invoicing' } } } };

  it('the data choice comes from the manifest: Gmail is named, with its fields, button and sign-in', () => {
    const t = connectorOverview(input({ manifests: [MAIL], blocked: { mail: 'production' } }));
    expect(t).toContain('chooses **Gmail** under *Where does Email get its data?*, enters **Client ID** (From Google Cloud Console) and **Client Secret**, presses **Save & Encrypt**, then **Connect Email Account** and follows the steps on the card to connect Google');
  });
  it('in test mode the choice is the practice data and nothing is asked for', () => {
    const t = connectorOverview(input({ manifests: [MAIL], simulation: true }));
    expect(t).toContain('presses **Activate Email**');
    expect(t).not.toContain('Gmail');
  });
  it('a connector already paused on a production gateway: the Edit settings path, not a button that is not there', () => {
    const t = connectorOverview(input({ manifests: [MAIL], blocked: { mail: 'production' }, facts: () => ({ running: false, hasCredentials: true, blocked: 'production', registered: true }) }));
    expect(t).toContain('presses **Edit settings**, chooses **Gmail** under *Where does Email get its data?*, enters **Client ID** (From Google Cloud Console) and **Client Secret**, presses **Save**, then **Connect Email** and follows the steps on the card to connect Google');
    expect(t).not.toContain('Activate');
    expect(t).not.toContain('Save & Encrypt');
  });
  it('settings saved but never started on a production gateway: Update Credentials first', () => {
    const t = connectorOverview(input({ manifests: [MAIL], blocked: { mail: 'production' }, facts: () => ({ running: false, hasCredentials: true, blocked: 'production', registered: false }) }));
    expect(t).toContain('presses **Update Credentials**, chooses **Gmail**');
  });
  it('a sign-in that is missing is named, not "Start"', () => {
    const CAL: GuideManifest = { id: 'cal', name: 'Calendar', profile: 'calendar', credentials: { fields: [{ key: 'clientId', label: 'Client ID' }] }, oauth: { tokenStorage: 'refreshToken', signInGroup: { name: 'Google' } } };
    const t = connectorOverview(input({ manifests: [CAL], facts: () => ({ running: false, hasCredentials: true, signedIn: false }) }));
    expect(t).toContain('settings saved, but not signed in. A person opens **Connectors**, the card **Calendar**, presses **Connect Calendar Account** and follows the steps on the card to connect Google');
  });
  it('registered and stopped says Start; never activated says Start <name> Connector', () => {
    const cfg = (registered: boolean) => connectorOverview(input({ manifests: [NOTES], facts: () => ({ running: false, hasCredentials: true, registered }) }));
    expect(cfg(true)).toContain('presses **Start**');
    expect(cfg(false)).toContain('presses **Start Notes Connector**');
  });
  it('no real option: the only thing left is Disable', () => {
    const ONLY: GuideManifest = { id: 'practice', name: 'Practice', profile: 'memo', simulation: { field: 'mode', default: 'simulation' }, modeLabels: { simulation: 'Practice data' } };
    expect(productionBlockedSteps(ONLY, { registered: true, hasCredentials: false })).toBe('presses **Disable**: it has no real option, so it cannot run on this gateway');
  });
  it('the simulated-inbox guide step shows only in test mode', () => {
    expect(connectorOverview(input({ manifests: [MAIL], detail: true, simulation: false }))).not.toContain('A simulated inbox');
    expect(connectorOverview(input({ manifests: [MAIL], detail: true, simulation: true }))).toContain('A simulated inbox');
  });
  it('the card name is the one the picker shows: "Name — Area" for a connector with several areas', () => {
    const t = connectorOverview(input({ manifests: [ERP], running: ['erp'] }));
    expect(t).toContain('card **ERP — Sales**');
    expect(t).toContain('card **ERP — Invoicing**');
    expect(t).not.toContain('card **ERP**,');
    expect(pickerCard(NOTES, 'memo', (a) => a)).toBe('Notes');
  });
  it('an area that had a mandate before says so; otherwise nothing is claimed', () => {
    const had = connectorOverview(input({ manifests: [NOTES], running: ['notes'], hadMandate: (a) => a === 'memo' }));
    expect(had).toContain('mandate for Memo: none. An earlier one has ended (revoked or expired).');
    const never = connectorOverview(input({ manifests: [NOTES], running: ['notes'] }));
    expect(never).not.toContain('earlier one');
  });
  it('the signing person is asked the automatic-or-review question first', () => {
    expect(SIGN_STEP).toMatch(/^Ask them first whether it should run automatically or ask each time\./);
    expect(SIGN_STEP).toContain('**Title** (required)');
  });

  describe('the field list for proposing, from the profile schema', () => {
    const profile = {
      boundsSchema: { fields: {
        profile: { required: true },
        read_access: { required: true, displayName: 'Read', boundType: { kind: 'enum', values: ['unlimited', 'none'] } },
        send_daily_max: { required: true, unit: 'count', default: 5, boundType: { kind: 'cumulative_count' } },
        spend_max: { unit: 'currency:EUR', maximum: 1000, boundType: { kind: 'max' } },
      } },
      scopeSchema: { fields: {
        allowed_attachment_sources: { format: 'connector:kind' },
        allowed_profiles: { required: true, valuesFrom: 'profiles' },
        kind: { enum: ['a', 'b'] },
      } },
      ttl: { default: 86400, max: 2592000 },
    };
    it('lists limits and scope with required marks, allowed values, units and sources', () => {
      const t = proposalFields('setup__create_mandate', 'github.com/x/email@0.9', profile, ['review', 'automatic']);
      expect(t).toContain('Fields for setup__create_mandate(profile: "email", ...), * = required; any other field name is refused:');
      expect(t).toContain('read_access* (Read) = unlimited|none');
      expect(t).toContain('send_daily_max* = number [default 5]');
      expect(t).toContain('spend_max = number [EUR, at most 1000]'.replace('EUR,', 'currency:EUR,'));
      expect(t).not.toContain('profile* ');
      expect(t).toContain('allowed_attachment_sources = comma-separated connector:kind sources, for example files:file');
      expect(t).toContain('allowed_profiles* = comma-separated names from the profiles available');
      expect(t).toContain('kind = a|b');
      expect(t).toContain('mode = review|automatic (ask the person)');
      expect(t).toContain('duration_hours = number, at most 720, default 24');
    });
    it('a profile that allows only review says only review', () => {
      expect(proposalFields('t', 'x', profile, ['review'])).toContain('mode = review (ask the person)');
    });
    it('the overview points at the field list; the connector detail carries it', () => {
      const setup = { tool: 'setup__create_mandate', card: 'Setup', fields: { profile: 'allowed_profiles', mode: 'allowed_modes' }, held: [auth('delegation@0.6', { context: { allowed_profiles: 'memo', allowed_modes: 'review' } })] };
      const profileOf = () => ({ profile, modes: ['review'] as const });
      const short = connectorOverview(input({ manifests: [NOTES], running: ['notes'], setup, profileOf }));
      expect(short).toContain('Its fields: list-authorizations(domain: "memo").');
      expect(short).not.toContain('Fields for');
      const long = connectorOverview(input({ manifests: [NOTES], running: ['notes'], setup, profileOf, detail: true }));
      expect(long).toContain('Fields for setup__create_mandate(profile: "memo", ...)');
    });
  });
});

describe('5. refusal endings', () => {
  it('"no mandate covers" ends with where the person goes, the card, and a way to find out more', () => {
    expect(noMandateRefusal('post__send', 'email', undefined, 'Post')).toBe(
      'Refused: no mandate covers post__send (email). Nothing was done. Tell the person to grant a email mandate in the gateway: ' +
      '**Mandates → + New mandate →** card **Post** → **Give a mandate**. list-authorizations(domain: "email") gives the exact steps and says whether you can propose it for them. ' +
      'Then try again. No ticket was requested.',
    );
    // A built-in's own signed-off text still wins.
    expect(noMandateRefusal('setup__x', 'delegation', 'Not done: ...', 'Setup')).toBe('Refused: Not done: ... No ticket was requested.');
  });

  it.each([
    ['MANDATE_REVOKED', /no longer valid.*Sign again/s],
    ['MANDATE_EXPIRED', /no longer valid/],
    ['BOUND_EXCEEDED', /limit stopped it.*\*\*Edit\*\*/s],
    ['CUMULATIVE_LIMIT_EXCEEDED', /wait until the period ends/],
    ['PROFILE_NOT_ENABLED_FOR_GROUP', /team admin opens \*\*Team → Manage this team/],
    ['RATE_LIMITED', /Wait a minute/],
    ['SOMETHING_NEW', /Tell the person what is written above/],
    [undefined, /Do not retry/],
  ])('%s ends with a step for the person', (code, re) => {
    const t = refusalNextStep(code, 'Post');
    expect(t).toMatch(re);
    expect(t.startsWith('Nothing ran.')).toBe(true);
  });
  it('names the connector\'s card when it is known', () => {
    expect(refusalNextStep('MANDATE_EXPIRED', 'Post')).toContain('card **Post**');
  });
});

// ── Through the real wiring ────────────────────────────────────────────────

describe('through the gateway\'s own entry points', () => {
  const FILES_PROFILE = profile('files/0.1.profile.json');
  const EMAIL_PROFILE = profile('email/0.9.profile.json');
  const SETUP_PROFILE = profile('delegation/0.6.profile.json');
  beforeAll(() => {
    for (const p of [FILES_PROFILE, EMAIL_PROFILE, SETUP_PROFILE]) registerProfile(p.id, p);
    loadManifests(join(ROOT, 'content', 'integrations'));
  });

  const sendTool: DiscoveredTool = {
    originalName: 'send_email', namespacedName: 'mail__send_email', integrationId: 'mail', description: 'Send an email',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, attachments: { type: 'array' } } },
    gating: { profile: 'email', executionMapping: {}, staticExecution: { action_type: 'send' }, attachmentsArg: 'attachments' } as DiscoveredTool['gating'],
  };
  const saveTool: DiscoveredTool = {
    originalName: 'save_file', namespacedName: 'files__save_file', integrationId: 'files', description: 'Save a file',
    inputSchema: { type: 'object', properties: { file: { type: 'string' } } },
    gating: { profile: 'files', executionMapping: {}, staticExecution: { action_type: 'save' } } as DiscoveredTool['gating'],
  };
  const createTool: DiscoveredTool = {
    originalName: 'create_mandate', namespacedName: 'setup__create_mandate', integrationId: 'setup', description: 'Propose a mandate',
    inputSchema: {}, gating: { profile: 'delegation', executionMapping: { profile: 'allowed_profiles', mode: 'allowed_modes' }, staticExecution: { action_type: 'mandate' } } as DiscoveredTool['gating'],
  };

  function im(over: { running: string[]; tools?: DiscoveredTool[] }): IntegrationManager {
    return {
      getAllTools: () => over.tools ?? [sendTool, saveTool, createTool],
      isBuiltin: (id: string) => id === 'setup',
      isRunning: (id: string) => over.running.includes(id),
      modeBlock: () => undefined,
      getServiceCredentials: () => undefined,
      getBuiltins: () => [{ id: 'setup', name: 'Setup', description: '', profile: 'delegation', available: true }],
    } as unknown as IntegrationManager;
  }
  function state(auths: EnrichedAuthorization[]): SharedState {
    return {
      getEnrichedAuthorizations: () => auths,
      executionLog: { record: () => {}, sumByWindow: () => 0, getAll: () => [], size: 0 },
      spClient: { isUnlocked: () => true, getAuthorizationSummary: async () => null },
    } as unknown as SharedState;
  }
  const mandate = (profileId: string, context?: Record<string, string>): EnrichedAuthorization => ({
    authorizationId: `authz_${profileId.replace(/\W/g, '')}`, profileId, path: 'p', frame: { profile: profileId },
    attestations: [{ domain: 'owner', blob: 'b', expiresAt: Math.floor(Date.now() / 1000) + 3600 }],
    requiredDomains: ['owner'], attestedDomains: ['owner'], complete: true, gateContent: null, ...(context ? { context } : {}),
  }) as unknown as EnrichedAuthorization;

  it('the Files manifest declares savedBy, and the loader accepts it', () => {
    expect(getManifest('files')!.documents!.file).toMatchObject({ savedBy: 'save_file' });
  });

  it('the loader refuses a savedBy that names no tool, an internal tool, or nothing', () => {
    const doc = (savedBy: unknown, overrides: object) => ({
      toolGating: { overrides: { get_file: { internal: true }, ...overrides } },
      documents: { file: { tool: 'get_file', args: {}, savedBy } },
    }) as never;
    expect(invalidManifestDocumentsReason(doc('save_file', { save_file: { summary: 's' } }))).toBeNull();
    expect(invalidManifestDocumentsReason(doc('nope', {}))).toMatch(/savedBy "nope" is not a tool described/);
    expect(invalidManifestDocumentsReason(doc('get_file', {}))).toMatch(/must be a tool the AI can call/);
    expect(invalidManifestDocumentsReason(doc('', {}))).toMatch(/savedBy must be a non-empty string/);
    expect(invalidManifestDocumentsReason(doc(7, {}))).toMatch(/savedBy must be a non-empty string/);
  });

  it('1. a fresh gateway: the session instructions carry the first step, then the rules with the golden rule first', () => {
    const brief = buildMandateBrief({ authorizations: [], integrationManager: im({ running: [] }) });
    expect(brief).toContain('=== FIRST STEP ===');
    expect(brief).toContain('An AI can never create the first one');
    expect(brief).toContain('card **Setup**');
    expect(brief.indexOf('=== FIRST STEP ===')).toBeLessThan(brief.indexOf('=== RULES ==='));
    const rules = brief.slice(brief.indexOf('=== RULES ==='));
    expect(rules.indexOf('never write as if you were that person')).toBeLessThan(rules.indexOf('Never open or operate'));
    expect(rules).toContain('call list-authorizations(domain) with the area of the task');
  });

  it('a gateway that has a mandate does not repeat the first step', () => {
    const brief = buildMandateBrief({ authorizations: [mandate(EMAIL_PROFILE.id)] as never });
    expect(brief).not.toContain('=== FIRST STEP ===');
    expect(brief).toContain('call list-authorizations(domain) with the area of the task');
  });

  it('no mandate reads the same in test mode: the first step, no block of its own', () => {
    const live = buildMandateBrief({ authorizations: [], integrationManager: im({ running: [] }) });
    process.env.SUVEREN_SIMULATION = '1';
    const test = buildMandateBrief({ authorizations: [], integrationManager: im({ running: [] }) });
    expect(test).toContain('=== FIRST STEP ===');
    expect(test).not.toContain('=== GETTING STARTED ===');
    expect(test).toBe(live);
  });

  it('test mode with a mandate keeps its neutral block and has no first step', () => {
    process.env.SUVEREN_SIMULATION = '1';
    const brief = buildMandateBrief({ authorizations: [mandate(EMAIL_PROFILE.id)] as never, integrationManager: im({ running: ['mail'] }) });
    expect(brief).not.toContain('=== FIRST STEP ===');
    expect(brief).toContain('=== GETTING STARTED ===');
  });

  it('1. list-authorizations(domain) on a fresh gateway: the first step, then that area\'s exact steps', async () => {
    const text = (await listAuthorizationsHandler(state([]), im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
    expect(text).toContain('No active authorizations — no tool is usable yet.');
    expect(text).toContain('An AI can never create the first one');
    expect(text).toContain('Connectors, in the order to act');
    expect(text).toMatch(/- Files .* — running\./);
    expect(text).toMatch(/mandate for Files: none\. A person signs it: \*\*Mandates → \+ New mandate\*\*, card \*\*Files\*\*/);
    // Only that area: no other connector's steps.
    expect(text).not.toContain('- Email');
  });

  it('2. with a Setup mandate that lists the area, the overview says to propose it, with the tool and the questions', async () => {
    const setup = mandate(SETUP_PROFILE.id, { allowed_profiles: 'files,email', allowed_modes: 'review' });
    const text = (await listAuthorizationsHandler(state([setup]), im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
    expect(text).toContain('Propose it with setup__create_mandate(profile: "files", ...)');
    expect(text).toContain('whether it should run automatically or ask them each time');
  });

  it('2. asked for one connector, the whole setup guide comes with its mandate state', async () => {
    const text = (await listAuthorizationsHandler(state([mandate(EMAIL_PROFILE.id)]), im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
    expect(text).toContain('No authorizations found for domain "files"');
    expect(text).toContain('Its setup guide');
    expect(text).toContain('Give the Files mandate');
    expect(text).toContain('In a team: an admin switches Files and Email on first');
  });

  it('2. in a team that has not enabled the area: the overview says so, from the control plane\'s own check', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'secret';
    const calls: Array<{ dryRun: boolean; request: Record<string, unknown> }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      calls.push(body);
      return new Response(JSON.stringify({ error: 'mandate_refused', code: 'profile_not_enabled', message: 'Files 0.1 is not enabled in "Sales Vienna". Ask an admin of "Sales Vienna" to enable Files 0.1 and name who may give its mandates.' }), { status: 422 });
    });
    try {
      const st = state([]);
      (st.spClient as unknown as { getActiveTeamGroupId: () => Promise<string> }).getActiveTeamGroupId = async () => 'g_team';
      const text = (await listAuthorizationsHandler(st, im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
      expect(text).toContain('Blocked: the team "Sales Vienna" has not enabled Files');
      expect(text).toContain('Team → Manage this team in your Authority Server');
      // Only the rights are asked for, for the active team, and only for a connector that runs.
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(c => c.dryRun === true && c.request.rightsOnly === true && c.request.team === 'g_team')).toBe(true);
      expect(calls.map(c => c.request.profile)).toEqual(['files']);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUVEREN_INTERNAL_SECRET;
    }
  });

  it('2. a control plane that cannot be reached leaves the team line out and the rest intact', async () => {
    process.env.SUVEREN_INTERNAL_SECRET = 'secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    try {
      const st = state([]);
      (st.spClient as unknown as { getActiveTeamGroupId: () => Promise<string> }).getActiveTeamGroupId = async () => 'g_team';
      const text = (await listAuthorizationsHandler(st, im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
      expect(text).not.toContain('Blocked: the team');
      expect(text).toContain('mandate for Files: none. A person signs it');
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SUVEREN_INTERNAL_SECRET;
    }
  });

  it('setup__get_guide is not offered outside simulation mode, and not named in the capability map', async () => {
    const guide: DiscoveredTool = {
      originalName: 'get_guide', namespacedName: 'setup__get_guide', integrationId: 'setup', description: 'Guides', inputSchema: {}, simulationOnly: true,
      gating: { profile: 'delegation', category: 'read', boundField: 'read_access', requiredValue: 'unlimited' } as DiscoveredTool['gating'],
    };
    const tools = [createTool, guide];
    const setupMandate = mandate(SETUP_PROFILE.id, { allowed_profiles: 'files', allowed_modes: 'review' });
    (setupMandate as unknown as { frame: Record<string, unknown> }).frame = { profile: SETUP_PROFILE.id, read_access: 'unlimited', mandate_daily_max: 5 };
    const reg = (auths: EnrichedAuthorization[]) => {
      const { server, refreshTools } = createMcpServer(state(auths), im({ running: [], tools }));
      refreshTools();
      return (server as unknown as { _registeredTools: Record<string, { enabled: boolean }> })._registeredTools;
    };
    expect(reg([setupMandate]).setup__get_guide.enabled).toBe(false);
    const cap = (await listAuthorizationsHandler(state([setupMandate]), im({ running: [], tools }))({ domain: 'delegation' })).content[0].text;
    expect(cap).not.toContain('get_guide');
    process.env.SUVEREN_SIMULATION = '1';
    expect(reg([setupMandate]).setup__get_guide.enabled).toBe(true);
    expect((await listAuthorizationsHandler(state([setupMandate]), im({ running: [], tools }))({ domain: 'delegation' })).content[0].text).toContain('get_guide');
  });

  it('the Files card asks for the folder: the field is required, so the card says what to enter and which button', () => {
    const f = getManifest('files')!;
    expect(f.credentials.fields.find(x => x.key === 'sharedFolder')!.optional).toBeFalsy();
    const t = connectorOverview({ ...input({ manifests: [f as never] }) });
    expect(t).toContain('enters **Shared folder**');
    expect(t).toContain('presses **Save & Encrypt** (the connector then starts by itself)');
  });

  it('the Email manifest hides its simulated-inbox step outside test mode', () => {
    const m = getManifest('mail')! as unknown as GuideManifest;
    expect(m.setupGuide![0].simulationOnly).toBe(true);
    expect(connectorOverview(input({ manifests: [m], detail: true }))).not.toContain('simulated inbox');
  });

  it('4. the sender\'s description gets the attachment line from the manifests; a connector that starts later updates it', () => {
    const running: string[] = ['mail'];
    const manager = im({ running });
    const { server, registerProxiedTools } = createMcpServer(state([]), manager);
    registerProxiedTools();
    const reg = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    expect(reg.mail__send_email.description).not.toContain('May attach');
    running.push('files');
    registerProxiedTools();
    expect(reg.mail__send_email.description).toContain('May attach: Saved files (files:file; save the file first with files__save_file)');
    expect(reg.mail__send_email.description).toContain('stop and ask the person');
    // A tool that takes no attachments gets no such line.
    expect(reg.files__save_file.description).not.toContain('May attach');
  });

  // ── The role, the facts and the short answer (Andreas, 2026-11-10) ──────

  const sectionOf = (brief: string, heading: string) => {
    const at = brief.indexOf(`=== ${heading} ===`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const next = brief.indexOf('\n=== ', at + heading.length);
    return brief.slice(at, next < 0 ? undefined : next);
  };
  const MODE_WORDS = /simulat|\btest|practice|\bdemo\b/i;

  describe('the role and the facts in the session instructions', () => {
    const everyMode = (auths: EnrichedAuthorization[]) => {
      const live = buildMandateBrief({ authorizations: auths as never, integrationManager: im({ running: [] }) });
      process.env.SUVEREN_SIMULATION = '1';
      const test = buildMandateBrief({ authorizations: auths as never, integrationManager: im({ running: [] }) });
      delete process.env.SUVEREN_SIMULATION;
      return { live, test };
    };

    it.each([['no mandate', () => [] as EnrichedAuthorization[]], ['a mandate', () => [mandate(EMAIL_PROFILE.id)]]])('%s: the role is sent, word for word the same in every mode, and says nothing about the mode', (_label, auths) => {
      const { live, test } = everyMode(auths());
      for (const heading of ['YOUR ROLE', 'FACTS YOU CAN DRAW ON']) {
        const inLive = sectionOf(live, heading);
        expect(sectionOf(test, heading)).toBe(inLive);
        expect(inLive, heading).not.toMatch(MODE_WORDS);
      }
      expect(sectionOf(live, 'YOUR ROLE')).toContain('They are the final authority, not Suveren and not you.');
    });

    it('the golden rule stays first of all rules, ahead of the role', () => {
      const brief = buildMandateBrief({ authorizations: [], integrationManager: im({ running: [] }) });
      const rules = brief.indexOf('=== RULES ===');
      expect(rules).toBeLessThan(brief.indexOf('=== YOUR ROLE ==='));
      expect(brief.indexOf('never write as if you were that person')).toBeLessThan(brief.indexOf('They are the final authority'));
    });

    it('the facts say what a mandate and the Setup mandate are, in plain words', () => {
      const { live } = everyMode([]);
      const facts = sectionOf(live, 'FACTS YOU CAN DRAW ON');
      expect(facts).toContain('signed permission for one area of work');
      expect(facts).toContain('They can change or revoke it at any time.');
      expect(facts).toContain('The Setup mandate allows no work.');
      expect(facts).toContain('none of those exists until the person approves it');
      expect(facts).toContain('An AI can never create the first mandate');
    });

    it('no line depends on how the person opens', () => {
      const { live, test } = everyMode([]);
      const { live: liveHeld, test: testHeld } = everyMode([mandate(EMAIL_PROFILE.id)]);
      for (const t of [live, test, liveHeld, testHeld, firstMandateText({ url: 'u', card: 'Setup' })]) {
        expect(t).not.toMatch(/asks how to (start|begin|get started)/i);
      }
      expect(live).toContain('whatever the person opens with');
      expect(test).toContain('whatever the person opens with');
    });

    it('the areas come from the manifests, not from a list in the code', () => {
      expect(possibleAreas([NOTES, LEDGER], a => a.toUpperCase())).toEqual(['MEMO', 'INVOICING', 'SALES']);
      expect(possibleAreas([{ id: 'x', name: 'X', profile: 'github.com/y/zebra@1.0' }], a => a)).toEqual(['zebra']);
      expect(factsLines({ card: 'Setup', areas: possibleAreas([NOTES], () => 'Zebra pens') }).join('\n')).toContain('Possible on this gateway: Zebra pens.');
      expect(factsLines({ card: 'Setup', areas: [] }).join('\n')).not.toContain('Possible on this gateway');
    });

    it('the real manifests give the line in the instructions, one short line', () => {
      const facts = sectionOf(buildMandateBrief({ authorizations: [], integrationManager: im({ running: [] }) }), 'FACTS YOU CAN DRAW ON');
      const line = facts.split('\n').find(l => l.includes('Possible on this gateway:'))!;
      expect(line).toContain('Email');
      expect(line).toContain('Files');
      expect(line.length).toBeLessThan(300);
    });

    it('with a card name from the built-in, not a word in the code', () => {
      expect(factsLines({ card: 'Vollmacht', areas: [] }).join('\n')).toContain('The Vollmacht mandate allows no work.');
      expect(factsLines({ card: 'Setup', areas: [] }).join('\n')).toContain('The Setup mandate');
    });
  });

  /**
   * The limit: 1600 characters, about a quarter of a page (some 300 words). That fits what the
   * answer must say — where things stand, one line of areas, the one step with its buttons, what
   * the AI can do — and stops the old answer coming back (ten connectors with every step ran to
   * several thousand characters, and ChatGPT summarised it instead of leading the person).
   */
  const SHORT_ANSWER_LIMIT = 1600;

  describe('list-authorizations() with no argument is the short answer', () => {
    it('on an empty gateway: short, with the one next step, the card, and no connector steps', async () => {
      const text = (await listAuthorizationsHandler(state([]), im({ running: [] }))()).content[0].text;
      console.log(`EMPTY GATEWAY ANSWER (${text.length} chars)\n${text}`);
      expect(text.length).toBeLessThanOrEqual(SHORT_ANSWER_LIMIT);
      expect(text.match(/The one next step:/g)).toHaveLength(1);
      expect(text).toContain('**Setup**');
      expect(text).toContain('**+ New mandate**');
      expect(text).toContain('**Give a mandate**');
      expect(text).toContain('You can do yourself:');
      expect(text).toContain('list-authorizations(domain: "<area>")');
      expect(text).toContain('Email');
      expect(text).not.toContain('Connectors, in the order');
      expect(text).not.toContain('**Connectors**');
      expect(text).not.toContain('Save & Encrypt');
    });

    it('stays under the limit however many connectors exist', () => {
      const many = Array.from({ length: 40 }, (_, i): GuideManifest => ({
        id: `c${i}`, name: `Connector ${i}`, profile: `area${i}`,
        credentials: { fields: [{ key: 'k', label: 'K' }] },
      }));
      const text = shortAnswer({ ...input({ manifests: many }), url: 'http://localhost:3400', setup: { card: 'Setup', held: [], fields: {}, area: 'delegation' } });
      expect(text.length).toBeLessThanOrEqual(SHORT_ANSWER_LIMIT);
      expect(text).toContain('and 20 more');
    });

    it('reads the same in test mode on an empty gateway (the words never say which mode)', async () => {
      const live = (await listAuthorizationsHandler(state([]), im({ running: [] }))()).content[0].text;
      process.env.SUVEREN_SIMULATION = '1';
      const test = (await listAuthorizationsHandler(state([]), im({ running: [] }))()).content[0].text;
      expect(test).toBe(live);
      expect(live).not.toMatch(MODE_WORDS);
    });

    it('with mandates: the mandates, one line of areas, the one next step, no connector steps', async () => {
      const setup = mandate(SETUP_PROFILE.id, { allowed_profiles: 'files', allowed_modes: 'review' });
      const text = (await listAuthorizationsHandler(state([setup]), im({ running: ['files'] }))()).content[0].text;
      expect(text).toContain('Active authorizations (usable now):');
      expect(text.match(/The one next step:/g)).toHaveLength(1);
      expect(text).toContain('Ask what the person wants done, then propose the mandate for that area with setup__create_mandate');
      expect(text).toContain('propose new mandates with setup__create_mandate');
      expect(text).toContain('Possible here:');
      expect(text).not.toContain('Connectors, in the order');
      expect(text).not.toContain('**Connectors**');
    });

    it('with a work mandate: asks and does, and says what to call when no mandate covers it', () => {
      const t = shortAnswer({ ...input({ manifests: [NOTES], running: ['notes'], auths: [auth('memo@0.1')] }), url: 'u' });
      expect(t).toContain('With a mandate: Memo.');
      expect(t).toContain('The one next step: Ask what the person wants done and do it within the active mandates.');
      expect(t).toContain('do the work the active mandates allow');
      expect(t).not.toContain('Only a person can sign');
    });

    it('a mandate whose connector is not running: that is the one next step, and the per-area call has the buttons', () => {
      const t = shortAnswer({ ...input({ manifests: [NOTES], auths: [auth('memo@0.1')] }), url: 'u' });
      expect(t).toContain('The one next step: The Notes connector is not running, so its mandate does nothing yet. The steps: list-authorizations(domain: "memo").');
    });

    it('a mandate that must be signed again comes first', () => {
      const t = shortAnswer({ ...input({ manifests: [NOTES], running: ['notes'], auths: [auth('memo@0.1', { needsReapproval: true })] }), url: 'u' });
      expect(t).toContain('The one next step: A person signs these again: Memo. They open **Mandates** and press **Sign again**.');
    });

    it('a team that blocks the first mandate is the one next step, with "nothing else helps"', () => {
      const t = shortAnswer({
        ...input({ manifests: [NOTES] }), url: 'u',
        setup: { card: 'Setup', held: [], fields: {}, area: 'delegation' },
        team: new Map([['delegation', { teamCode: 'profile_not_enabled', teamName: 'Sales Vienna' }]]),
      });
      expect(t).toContain('The one next step: Blocked: the team "Sales Vienna" has not enabled');
      expect(t).toContain('Nothing else helps until then.');
      expect(t).not.toContain('+ New mandate');
    });

    it('through the real wiring: a team check is made for the first mandate only, and reaches the AI', async () => {
      process.env.SUVEREN_INTERNAL_SECRET = 'secret';
      const calls: Array<{ request: Record<string, unknown> }> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        calls.push(JSON.parse(String((init as RequestInit).body)));
        return new Response(JSON.stringify({ error: 'mandate_refused', code: 'not_a_grantor', message: 'Setup is enabled in "Sales Vienna"' }), { status: 422 });
      });
      try {
        const st = state([]);
        (st.spClient as unknown as { getActiveTeamGroupId: () => Promise<string> }).getActiveTeamGroupId = async () => 'g_team';
        const text = (await listAuthorizationsHandler(st, im({ running: ['files', 'mail'] }))()).content[0].text;
        expect(calls.map(c => c.request.profile)).toEqual(['delegation']);
        expect(text).toContain('The one next step: Blocked: Setup is enabled in "Sales Vienna"');
      } finally {
        fetchSpy.mockRestore();
        delete process.env.SUVEREN_INTERNAL_SECRET;
      }
    });
  });

  describe('list-authorizations(domain) keeps the exact steps of one area', () => {
    it('a connector that is not set up: the button, exactly as the card has it', async () => {
      const text = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: 'files' })).content[0].text;
      expect(text).toContain('enters **Shared folder**');
      expect(text).toContain('presses **Save & Encrypt** (the connector then starts by itself)');
      expect(text).toContain('Scope & Limits');
    });

    it('accepts the name the person sees, not only the short id', async () => {
      // A name that differs from the area's id ("customers"), so the name really has to be resolved.
      const p = profile('customers/0.6.profile.json');
      registerProfile(p.id, { ...p, name: 'Kunden und Kontakte' });
      const byName = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: 'kunden und kontakte' })).content[0].text;
      const byId = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: 'customers' })).content[0].text;
      expect(byName).toBe(byId);
      expect(byName).toContain('mandate for Kunden und Kontakte: none');
    });

    it('the first mandate itself can be asked for, by its card name too: the form step by step, not "no such area"', async () => {
      for (const asked of ['Setup', 'delegation']) {
        const text = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: asked })).content[0].text;
        expect(text).toContain('Scope & Limits');
        expect(text).not.toContain('No area or connector called');
      }
    });

    it('an area that does not exist says what does, so the AI can ask again', async () => {
      const text = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: 'nosuch' })).content[0].text;
      expect(text).toContain('No area or connector called "nosuch". Possible here:');
      expect(text).toContain('Email');
    });

    it('a team block still reaches the AI for that area, with "nothing else helps"', async () => {
      process.env.SUVEREN_INTERNAL_SECRET = 'secret';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'mandate_refused', code: 'profile_not_enabled', message: 'Files is not enabled in "Sales Vienna".' }), { status: 422 }));
      try {
        const st = state([mandate(EMAIL_PROFILE.id)]);
        (st.spClient as unknown as { getActiveTeamGroupId: () => Promise<string> }).getActiveTeamGroupId = async () => 'g_team';
        const text = (await listAuthorizationsHandler(st, im({ running: ['files'] }))({ domain: 'files' })).content[0].text;
        expect(text).toContain('Blocked: the team "Sales Vienna" has not enabled Files');
        expect(text).toContain('Nothing else helps until then.');
      } finally {
        fetchSpy.mockRestore();
        delete process.env.SUVEREN_INTERNAL_SECRET;
      }
    });

    it('the tools listed but not usable are per area now', async () => {
      const text = (await listAuthorizationsHandler(state([]), im({ running: [] }))({ domain: 'files' })).content[0].text;
      expect(text).toContain('files: files__save_file');
      expect(text).not.toContain('email:');
    });
  });

  it('buildProxiedToolDescription appends exactly what it is given', () => {
    expect(buildProxiedToolDescription(sendTool, 'EXTRA LINE')).toMatch(/Send an email\n\nEXTRA LINE$/);
    expect(buildProxiedToolDescription(sendTool)).toMatch(/Send an email$/);
  });
});

describe('a proposal whose mandate is dead', () => {
  it('says plainly it can no longer be approved and not to ask the person again', () => {
    const t = mandateEndedProposalText('abc123', 'revoked');
    expect(t).toBe('Proposal abc123 can no longer be approved: the mandate was revoked after this proposal, so it will never run. Nothing ran. A new mandate is needed; tell the person so, and do not ask them to approve this proposal again.');
    expect(mandateEndedProposalText('abc123', 'expired')).toContain('the mandate expired after this proposal');
  });
  it('reads the reason only from a dead-mandate code', () => {
    expect(endedFromRefusal('MANDATE_REVOKED')).toBe('revoked');
    expect(endedFromRefusal('MANDATE_EXPIRED')).toBe('expired');
    expect(endedFromRefusal('CUMULATIVE_LIMIT_EXCEEDED')).toBeUndefined();
    expect(endedFromRefusal(undefined)).toBeUndefined();
  });
});

// Every shipped manifest: each step the AI names must be a button the card really has.
// The card's button labels are read from its own source, so renaming one breaks this test.
describe('the steps name only buttons that exist on the connector card', () => {
  const cardSource = readFileSync(join(ROOT, 'apps', 'ui', 'src', 'components', 'IntegrationCard.tsx'), 'utf8');
  const dir = join(ROOT, 'content', 'integrations');
  const shipped = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').map(f => JSON.parse(readFileSync(join(dir, f), 'utf8'))) as Array<GuideManifest & { oauth?: { tokenStorage?: string } | null }>;
  // Each state the card can really be in, with the facts that make it so. Production-only states exist only
  // for a connector that declares simulation; a sign-in state only for one with a sign-in.
  const stated = (m: GuideManifest): Array<[string, string]> => {
    const line = (facts: Parameters<typeof input>[0], sim = false) =>
      connectorOverview(input({ manifests: [m], simulation: sim, ...facts })).split('\n')[1];
    const prod = m.simulation ? ({ blocked: 'production' } as const) : ({} as const);
    const out: Array<[string, string]> = [
      ['production, not set up', line({ facts: () => ({ running: false, hasCredentials: false, ...prod, registered: false }) })],
      ['simulation, not set up', line({ facts: () => ({ running: false, hasCredentials: false }) }, true)],
      ['saved settings, never started', line({ facts: () => ({ running: false, hasCredentials: true, registered: false, signedIn: true }) })],
      ['stopped or crashed', line({ facts: () => ({ running: false, hasCredentials: true, registered: true, signedIn: true }) })],
    ];
    if (m.simulation) {
      out.push(['production, paused (listed, set to test data)', line({ facts: () => ({ running: false, hasCredentials: true, blocked: 'production', registered: true }) })]);
      out.push(['production, test data saved, never started', line({ facts: () => ({ running: false, hasCredentials: true, blocked: 'production', registered: false }) })]);
    }
    if (m.oauth) out.push(['saved settings, no sign-in', line({ facts: () => ({ running: false, hasCredentials: true, registered: true, signedIn: false }) })]);
    return out;
  };
  // A bold name is a button, or the label of a radio option or field (which come from the manifest).
  const notButton = (m: GuideManifest): Set<string> => {
    const words = new Set<string>();
    for (const o of Object.values(m.modeOptions ?? {})) for (const e of Object.values(o as Record<string, { label?: string }>)) { if (e && typeof e === 'object' && (e as { label?: string }).label) words.add((e as { label: string }).label); }
    for (const e of Object.values(m.modeLabels ?? {})) { if (typeof e === 'string') words.add(e); else for (const l of Object.values(e)) words.add(l); }
    for (const f of m.credentials?.fields ?? []) words.add((f.label ?? f.key).replace(/\s*\(optional\)\s*$/i, ''));
    return words;
  };
  for (const m of shipped) {
    for (const [label, steps] of stated(m)) {
      it(`${m.id}: ${label}`, () => {
        const labels = notButton(m);
        for (const [, name] of steps.matchAll(/\*\*([^*]+)\*\*/g)) {
          if (labels.has(name) || name === 'Connectors' || name === m.name) continue;
          // Named with the connector's own name in the source: `Activate ${manifest.name}`, or {manifest.name} in JSX.
          const asTemplate = name.replace(m.name, '${manifest.name}');
          const asJsx = name.replace(m.name, '{manifest.name}');
          const found = [name, asTemplate, asJsx].some(n => cardSource.includes(n));
          expect(found, `${m.id} / ${label}: "${name}" is not on the card`).toBe(true);
        }
      });
    }
  }
  it('prints the matrix (read by the report)', () => {
    for (const m of shipped) {
      for (const [label, steps] of stated(m)) console.log(`MATRIX | ${m.name} | ${label} | ${steps}`);
    }
    expect(shipped.length).toBeGreaterThan(7);
  });
});
