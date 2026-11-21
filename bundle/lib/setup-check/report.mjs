/**
 * Setup check output: the plain-text report and `--json`. Both are built
 * only from the engine's findings, which never hold a secret value.
 */

import { GROUPS, formatDate } from './engine.mjs';

const RESULT_WIDTH = 13; // "cannot tell" + two spaces

function lineText(f) {
  return f.subject ? `${f.subject}: ${f.detail}` : f.detail;
}

export function renderText(report) {
  const out = [];
  out.push(`Suveren Setup check — ${formatDate(report.date)}`);
  out.push(`AI apps found: ${report.aiAppsFound.length ? report.aiAppsFound.map((a) => a.name).join(', ') : 'none recognised'}`);
  const sim = report.gateway.simulation === true ? 'on' : report.gateway.simulation === false ? 'off' : 'unknown';
  out.push(`Gateway: version ${report.gateway.version || 'unknown'}, simulation ${sim}, MCP port ${report.gateway.mcpPort}`);
  for (const group of GROUPS) {
    const lines = report.findings.filter((f) => f.group === group.id);
    if (!lines.length) continue;
    out.push('');
    out.push(group.title);
    for (const f of lines) out.push(`  ${f.result.padEnd(RESULT_WIDTH)}${lineText(f)}`);
  }
  out.push('');
  out.push('Confirm by hand');
  for (const item of report.confirmByHand) out.push(`  - ${item}`);
  if (report.notes.length) {
    out.push('');
    for (const n of report.notes) out.push(n);
  }
  out.push('');
  out.push(`Result: ${report.summary.open} open, ${report.summary.cannotTell} to confirm by hand`);
  return out.join('\n') + '\n';
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function renderJson(report) {
  const titles = Object.fromEntries(GROUPS.map((g) => [g.id, g.title]));
  return JSON.stringify({
    check: 'suveren-setup-check',
    formatVersion: 1,
    date: isoDate(report.date),
    gateway: report.gateway,
    aiAppsFound: report.aiAppsFound,
    locations: report.locations,
    findings: report.findings.map((f) => ({
      group: titles[f.group],
      result: f.result,
      subject: f.subject,
      detail: f.detail,
      source: f.source,
    })),
    confirmByHand: report.confirmByHand,
    notes: report.notes,
    summary: report.summary,
    exitCode: report.exitCode,
  }, null, 2) + '\n';
}
