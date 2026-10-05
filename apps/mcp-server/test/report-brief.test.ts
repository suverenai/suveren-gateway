/**
 * The report brief (R3) must teach exactly the elements the widget verifies,
 * forbid scripts, and keep the proof rules — the brief is the AI's only guide.
 */
import { describe, it, expect } from 'vitest';
import { REPORT_BRIEF, REPORT_ELEMENTS } from '../src/lib/report-brief';

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
    expect(REPORT_BRIEF).toMatch(/lists every ticket from the test period that your report does not reference/);
  });
});
