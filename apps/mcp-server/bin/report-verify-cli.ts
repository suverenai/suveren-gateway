/**
 * `suveren-gateway verify-report <file>` — offline verification of an
 * "Export with proof" report file (work-plan R6). Built as its OWN tsup
 * entry (see package.json's `build` script) so the npm bundle and the
 * Windows installer payload can run it with no network and no gateway
 * process — `bundle/bin/suveren-gateway.js`'s `verify-report` subcommand
 * dynamically imports the compiled `dist/report-verify-cli.mjs` next to
 * `dist/http.mjs`.
 *
 * All the actual verification logic lives in `lib/report/verify-export.ts`
 * (unit-tested directly, independent of argv/stdio) — this file is argv
 * parsing, file I/O, the one optional network call (`--online`), and
 * human-readable output only.
 */
import { readFileSync } from 'node:fs';
import { verifyExportBundle, type VerifyExportResult } from '../src/lib/report/verify-export';
import { isExportBundle, type ExportBundle } from '../src/lib/report/export-types';

const PROOF_SCRIPT_RE = /<script[^>]*id="suveren-proof"[^>]*>([\s\S]*?)<\/script>/i;

/** Finds and parses the `<script id="suveren-proof">` data block an export
 *  file embeds (`export-report.ts#buildExportDocument`). Throws a message
 *  meant to be printed as-is — never a raw JSON.parse/stack trace. */
export function extractProofBundle(html: string): ExportBundle {
  const match = PROOF_SCRIPT_RE.exec(html);
  if (!match) {
    throw new Error(
      'No embedded proof bundle found (missing <script id="suveren-proof"> block) — ' +
      'is this a Suveren "Export with proof" file?',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Could not parse the embedded proof bundle: ${err instanceof Error ? err.message : String(err)}`);
  }
  const o = parsed as { format?: unknown; version?: unknown } | null;
  if (o && o.format === 'suveren-report-export' && o.version === 1) {
    throw new Error(
      'This file was exported by an older gateway (format version 1): it does not carry what the checker needs to ' +
      'compare the values the page SHOWS with the signed data. Export the report again with a current gateway.',
    );
  }
  if (!isExportBundle(parsed)) {
    throw new Error('The embedded proof bundle is not in the expected "suveren-report-export" format.');
  }
  return parsed;
}

interface ParsedArgs {
  file?: string;
  key?: string;
  online: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let file: string | undefined;
  let key: string | undefined;
  let online = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') {
      key = argv[++i];
    } else if (a === '--online') {
      online = true;
    } else if (a === '--help' || a === '-h') {
      help = true;
    } else if (!a.startsWith('-') && file === undefined) {
      file = a;
    }
  }
  return { file, key, online, help };
}

export const HELP_TEXT = `Usage: suveren-gateway verify-report <file> [--key <hex>] [--online]

Verifies an "Export with proof" report file OFFLINE: every ticket signature,
every mandate attestation signature, every reference the report makes to a
ticket, approval, mandate, or case — and every VALUE the page shows.

  --key <hex>   Require the embedded Authority Server key to match this exact
                value — a fingerprint you already trust (e.g. read aloud over
                the phone by the Authority Server's operator).
  --online      Fetch the Authority Server's CURRENT public key
                (<asUrl>/api/as/pubkey) and require it to match.

A key embedded in the file proves nothing by itself — a forger can embed
their own key and self-sign everything to match it. Pass --key or --online to
confirm the embedded key against something you trust independently of this
file; with neither, the file's internal consistency is checked but the key
itself is not.

What the page shows is checked in two steps:
  1. The visible page must be exactly what the embedded proof data draws —
     the checker re-draws the whole file and compares it byte for byte. Any
     edit to the page (a number, a time, a style, an added box) fails. Keep
     the file as downloaded: re-saving it from a browser changes it. A file
     drawn by a different gateway version may not re-draw identically; check
     it with that version.
  2. Every value in every green box is checked against its source:
       checked against signature   ticket fields (action, time, profile,
                                   execution context), mandate limits (via
                                   the recomputed bounds hash), commitment
                                   mode, owners, intent (via its hash)
       recomputed                  wait_s, a case's duration_s, metrics —
                                   recomputed from the file's own values
       not checkable offline       approval times and approver (local
                                   archive), records and a case's start email
                                   (connector database), the refusals metric
     Values that cannot be checked offline are listed per box under "Not
     checkable offline" and do NOT fail the check — but they are never
     reported as signed.

References the report itself shows as "not verifiable" (e.g. the AI named a
ticket that does not exist) are listed under "Not verifiable (as shown in the
report)" and do NOT fail the check — the file is honest about them. Every
reference the file shows as VERIFIED must be backed by a validly signed
ticket (and mandate) in the file, or the check fails.

Exit codes:
  0  every signature is valid, every reference shown as verified is backed,
     every value checked against a signature or recomputed matches, AND the
     embedded key was confirmed
  1  something is invalid — a bad signature, a reference shown as verified
     with no valid ticket behind it, a value on the page that differs from
     the signed data or does not recompute, an edited page, or a key that
     does not match --key/--online
  2  everything else is valid, but the embedded key was NOT checked (no --key
     or --online given) — confirm it yourself before trusting this file
`;

export async function runVerifyReportCli(argv: string[]): Promise<number> {
  const { file, key, online, help } = parseArgs(argv);
  if (help || !file) {
    process.stdout.write(HELP_TEXT);
    return help ? 0 : 1;
  }

  let html: string;
  try {
    html = readFileSync(file, 'utf-8');
  } catch (err) {
    console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let bundle: ExportBundle;
  try {
    bundle = extractProofBundle(html);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let onlineKeyHex: string | undefined;
  if (online) {
    try {
      const url = `${bundle.authorityServer.url.replace(/\/+$/, '')}/api/as/pubkey`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { publicKey?: unknown };
      if (typeof data.publicKey !== 'string') throw new Error('Response had no publicKey field.');
      onlineKeyHex = data.publicKey;
    } catch (err) {
      console.error(`--online: could not fetch the Authority Server's current key: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  const result = await verifyExportBundle(bundle, { expectedKeyHex: key, onlineKeyHex, documentHtml: html });
  printSummary(bundle, result);

  if (!result.allValid || result.keyConfirmation.state === 'mismatch') return 1;
  if (result.keyConfirmation.state === 'unconfirmed') return 2;
  return 0;
}

function printSummary(bundle: ExportBundle, result: VerifyExportResult): void {
  const bundled = result.tickets.filter(t => t.present);
  const invalidTickets = bundled.filter(t => !t.signatureValid);
  const referenced = result.tickets.filter(t => t.referenced);

  console.log(`Suveren report export — ${bundle.tickets.length} ticket(s) in the bundle, ${referenced.length} referenced by the report.`);

  if (invalidTickets.length === 0) {
    console.log(`  Signatures: all ${bundled.length} valid.`);
  } else {
    console.log(`  Signatures: ${bundled.length - invalidTickets.length}/${bundled.length} valid — INVALID:`);
    for (const t of invalidTickets) console.log(`    - ${t.ticketId}: ${t.error ?? 'invalid'}`);
  }

  const shownVerified = result.elements.filter(e => e.presented === 'verified');
  const unbacked = shownVerified.filter(e => !e.backed);
  const flagged = result.elements.filter(e => e.presented === 'not-verifiable');
  console.log(`  References: ${shownVerified.length} verified · ${flagged.length} not verifiable (as shown in the report).`);
  if (unbacked.length > 0) {
    console.log(`  INVALID — ${unbacked.length} reference(s) shown as verified with no valid backing in the file:`);
    for (const e of unbacked) console.log(`    - ${e.elementId}${e.ticketIds.length ? ` (${e.ticketIds.join(', ')})` : ''}: ${e.error ?? 'not backed'}`);
  }
  if (flagged.length > 0) {
    console.log(`  Not verifiable (as shown in the report):`);
    for (const e of flagged) {
      const missing = e.ticketIds.filter(id => !bundle.tickets.some(t => (t as Record<string, unknown>).id === id));
      const note = missing.length > 0 ? ` — not in the file: ${missing.join(', ')}` : '';
      console.log(`    - ${e.elementId}${e.ticketIds.length ? ` (${e.ticketIds.join(', ')})` : ''}${note}`);
    }
  }

  printBoxes(result);

  const invalidAuth = result.authorizations.filter(a => !a.attestationValid || a.boundsHashMatches === false || a.boundsValuesProven === false);
  if (invalidAuth.length > 0) {
    console.log(`  Mandates: ${result.authorizations.length - invalidAuth.length}/${result.authorizations.length} valid — INVALID:`);
    for (const a of invalidAuth) console.log(`    - ${a.authorizationId}: ${a.error ?? 'invalid'}`);
  } else {
    console.log(`  Mandates: all ${result.authorizations.length} valid.`);
  }

  console.log(`  Authority Server key fingerprint: ${result.keyFingerprint} (${bundle.authorityServer.url})`);
  if (result.keyConfirmation.state === 'confirmed') {
    console.log(`  Key confirmed against ${result.keyConfirmation.source === 'online' ? 'the live Authority Server' : '--key'}.`);
  } else if (result.keyConfirmation.state === 'mismatch') {
    console.log(`  Key MISMATCH — expected fingerprint ${result.keyConfirmation.expectedFingerprint}, the file has ${result.keyFingerprint}.`);
  } else {
    console.log(`  Key not confirmed — compare this fingerprint with ${bundle.authorityServer.url}/api/as/pubkey or pass --online.`);
  }
}

function printBoxes(result: VerifyExportResult): void {
  if (result.document.state === 'match') console.log('  Page: exactly what the signed data draws.');
  else if (result.document.state === 'mismatch') console.log(`  INVALID — page: ${result.document.error}`);
  for (const e of result.drawnErrors) console.log(`  INVALID — ${e}`);

  const bad = result.boxes.filter(b => b.mismatches.length > 0);
  const ok = result.boxes.filter(b => b.mismatches.length === 0);
  const fully = ok.filter(b => b.notCheckable.length === 0);
  console.log(`  Boxes: ${fully.length} fully checked · ${ok.length - fully.length} partly not checkable offline · ${bad.length} MISMATCH.`);
  for (const b of ok) {
    const parts: string[] = [];
    if (b.signed.length > 0) parts.push(`checked against signature: ${[...new Set(b.signed)].join(', ')}`);
    if (b.recomputed.length > 0) parts.push(`recomputed: ${b.recomputed.map(r => `${r.field} (from ${r.inputs.join(' + ')})`).join(', ')}`);
    if (parts.length > 0) console.log(`    - ${b.elementId}: ${parts.join(' · ')}`);
  }
  if (bad.length > 0) {
    console.log(`  INVALID — ${bad.length} box(es) show a value that differs from its source:`);
    for (const b of bad) for (const m of b.mismatches) console.log(`    - ${b.elementId}: ${m}`);
  }
  const unbackable = result.boxes.filter(b => b.notCheckable.length > 0);
  if (unbackable.length > 0) {
    console.log('  Not checkable offline (shown in the report, not backed by a signature — does not fail the check):');
    for (const b of unbackable) {
      console.log(`    - ${b.elementId}: ${b.notCheckable.map(n => `${n.field} (${n.source})`).join(', ')}`);
    }
  }
  console.log('  Coverage panel: from the connector database — not checkable offline.');
}

// Allow running this file's COMPILED output directly
// (`node report-verify-cli.mjs <file>`) in addition to the bundled CLI
// subcommand, which imports `runVerifyReportCli` instead (it already parsed
// `verify-report` off argv itself).
if (import.meta.url === `file://${process.argv[1]}`) {
  runVerifyReportCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
