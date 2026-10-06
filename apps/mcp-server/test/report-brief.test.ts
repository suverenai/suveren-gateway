/**
 * The report brief (R3) must teach exactly the elements the widget verifies,
 * forbid scripts, and keep the proof rules — the brief is the AI's only guide.
 */
import { describe, it, expect } from 'vitest';
import { REPORT_BRIEF, REPORT_ELEMENTS, REPORT_BLOCKS } from '../src/lib/report-brief';

describe('report brief', () => {
  it('teaches every verifiable element, with its reference syntax', () => {
    for (const el of REPORT_ELEMENTS) expect(REPORT_BRIEF).toContain(`<${el} `);
    expect(REPORT_ELEMENTS).toHaveLength(6);
  });

  it('forbids JavaScript and external content', () => {
    expect(REPORT_BRIEF).toMatch(/no JavaScript/);
    expect(REPORT_BRIEF).toMatch(/no external files/);
  });

  it('keeps the proof rules: every case defined, metrics from the gateway, no guessed IDs', () => {
    expect(REPORT_BRIEF).toMatch(/Define every case/);
    expect(REPORT_BRIEF).toMatch(/Use sv-metric for every headline number/);
    expect(REPORT_BRIEF).toMatch(/Do not guess IDs/);
  });

  it('lists the metric kinds the gateway computes', () => {
    for (const kind of ['completed', 'median-time', 'without-approval', 'approvals', 'median-approval-wait']) {
      expect(REPORT_BRIEF).toContain(kind);
    }
  });

  it('stays vendor-neutral about the AI client and free of internal jargon for managers', () => {
    expect(REPORT_BRIEF).not.toMatch(/Claude|ChatGPT|OpenAI|Anthropic/);
  });

  it('asks for a layout that works on phones and in a narrow side panel', () => {
    expect(REPORT_BRIEF).toMatch(/on a phone, in a narrow side panel/);
    expect(REPORT_BRIEF).toMatch(/viewBox/);
  });

  it('documents case lists for metrics and that unreferenced tickets are listed', () => {
    expect(REPORT_BRIEF).toContain('cases="C1 C3"');
    expect(REPORT_BRIEF).toMatch(/lists every ticket from the window that your report does not reference/);
  });

  it('tells the AI its own content is labelled "AI analysis — not verified" and that sv- classes are removed (review SR5)', () => {
    expect(REPORT_BRIEF).toContain('"AI analysis — not verified"');
    expect(REPORT_BRIEF).toMatch(/class names starting with "sv-" are removed/);
  });

  it('teaches the two-tag format: the exact block syntax, an example, and the rules (RR6)', () => {
    for (const b of REPORT_BLOCKS) expect(REPORT_BRIEF).toContain(`<${b}`);
    expect(REPORT_BRIEF).toContain('<sv-ai>…</sv-ai>');
    expect(REPORT_BRIEF).toContain('<sv-row>…</sv-row>');
    expect(REPORT_BRIEF).toContain('<sv-glossary lang="de"><sv-term key="erp__create_quote">Angebot erstellt</sv-term></sv-glossary>');
    expect(REPORT_BRIEF).toContain('variant="compact"');
    expect(REPORT_BRIEF).toContain('variant="full"');
    expect(REPORT_BRIEF).toMatch(/Example:\n<sv-ai>/);
    expect(REPORT_BRIEF).toMatch(/Anything else is dropped/);
    expect(REPORT_BRIEF).toMatch(/Nothing verified inside sv-ai/);
    expect(REPORT_BRIEF).toMatch(/inline style="…" attributes only \(no <style> blocks/);
    expect(REPORT_BRIEF).toMatch(/Words only: never numbers, amounts, times or ids/);
  });

  it('is about regular reports for the agent\'s window, with cases only when test data is loaded (RR6)', () => {
    expect(REPORT_BRIEF).toMatch(/regular reports on what you did in your reporting window/);
    expect(REPORT_BRIEF).toMatch(/list_tickets returns it \("window"\)/);
    expect(REPORT_BRIEF).toMatch(/Cases and coverage apply only when test data is loaded/);
  });

  it('explains how a case is timed (later of email date and test load — review SR4)', () => {
    expect(REPORT_BRIEF).toMatch(/the later of the two/);
  });
});
