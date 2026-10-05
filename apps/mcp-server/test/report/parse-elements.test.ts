import { describe, it, expect } from 'vitest';
import { parseElements } from '../../src/lib/report/parse-elements';

describe('parseElements', () => {
  it('finds all six brief elements, in document order, with their attributes', () => {
    const html = `
      <h1>Report</h1>
      <sv-ticket ref="t1"></sv-ticket>
      <sv-approval ticket="t1"></sv-approval>
      <sv-mandate ticket="t1"></sv-mandate>
      <sv-record system="erp" ref="q1"></sv-record>
      <sv-case start="email:m1" goal="ticket:t1" steps="t2 t3"></sv-case>
      <sv-metric kind="completed" cases="all"></sv-metric>
    `;
    const found = parseElements(html);
    expect(found.map(f => f.kind)).toEqual([
      'sv-ticket', 'sv-approval', 'sv-mandate', 'sv-record', 'sv-case', 'sv-metric',
    ]);
    expect(found[0]).toMatchObject({ id: 'sv-ticket-0', attrs: { ref: 't1' } });
    expect(found[4].attrs).toEqual({ start: 'email:m1', goal: 'ticket:t1', steps: 't2 t3' });
  });

  it('ignores ordinary HTML and only matches sv-* tags', () => {
    const found = parseElements('<div class="sv-looking-but-not">x</div><p>sv-ticket in text, not a tag</p>');
    expect(found).toEqual([]);
  });

  it('finds an unrecognised sv-* element too — classification is the caller\'s job', () => {
    const found = parseElements('<sv-totally-made-up foo="1"></sv-totally-made-up>');
    expect(found).toEqual([{ id: 'sv-totally-made-up-0', kind: 'sv-totally-made-up', attrs: { foo: '1' } }]);
  });

  it('numbers repeated elements of the same kind in order', () => {
    const found = parseElements('<sv-ticket ref="a"></sv-ticket><sv-ticket ref="b"></sv-ticket>');
    expect(found.map(f => f.id)).toEqual(['sv-ticket-0', 'sv-ticket-1']);
  });

  it('handles a self-closing-style element', () => {
    const found = parseElements('<sv-ticket ref="a" />');
    expect(found).toEqual([{ id: 'sv-ticket-0', kind: 'sv-ticket', attrs: { ref: 'a' } }]);
  });
});
