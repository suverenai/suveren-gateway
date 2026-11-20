/**
 * UI review (DEC-88, mockup phone-d3-live.html v6): the shared pieces the gateway page and the phone both draw. Static markup:
 * a piece is its props.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalPanelHead } from './ApprovalPanelHead';
import { ResultFoot, StampNext, UnknownTop, RESULT_TEXT } from './ApprovalResult';
import { DeviceRows, deviceDetail } from './DeviceRows';
import { giveSummaryLine } from '../mandate-screens/give-view';
import { SP } from '../lib/pairing-texts';

const noop = () => {};
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the panel head: Previous and Next carry the same weight', () => {
  const head = (compact: boolean) => renderToStaticMarkup(
    <ApprovalPanelHead compact={compact} position={{ index: 2 }} total={3} prevId="a" nextId="c" onMove={noop} onLater={noop} autoOpen onToggleAuto={noop} />,
  );
  for (const compact of [true, false]) {
    it(compact ? 'compact (phone, gateway below 1100px)' : 'wide (gateway)', () => {
      const h = head(compact);
      expect(h).toMatch(/class="av3-btn apr-o[^"]*"[^>]*data-testid="approval-prev"/);
      expect(h).toMatch(/class="av3-btn apr-o[^"]*"[^>]*data-testid="approval-next"/);
      // Only the card's decision button is primary: nothing in the head's arrows.
      expect(h.slice(h.indexOf('<nav'), h.indexOf('</nav>'))).not.toContain('av3-btn-primary');
    });
  }
  it('the title reads "Waiting for you"; only " for you" can be hidden on a narrow screen', () => {
    const h = head(true);
    expect(text(h.slice(h.indexOf('<h2'), h.indexOf('</h2>')))).toBe('Waiting for you');
    expect(h).toContain('<span class="t-rest"> for you</span>');
  });
});

describe('a result that stays on the card: on top, one pinned full-width button', () => {
  it('refused: the host\'s Next / Close is the one primary button, full width', () => {
    const h = renderToStaticMarkup(<ResultFoot dismiss={{ label: 'Next', onDismiss: noop }} />);
    expect(h).toContain('class="av3-foot"');
    expect(h).toContain('class="av3-btns-stack"');
    expect(h).toMatch(/<button[^>]*class="av3-btn av3-btn-primary"[^>]*data-testid="result-dismiss"[^>]*>Next</);
    expect(h.match(/<button/g)).toHaveLength(1);
  });
  it('without a host button there is no footer', () => {
    expect(renderToStaticMarkup(<ResultFoot />)).toBe('');
  });
  it('not known: "Check again" is primary, Next / Close secondary; while it reads, "Checking…" and both are off; then what it found', () => {
    const idle = renderToStaticMarkup(<ResultFoot check={{ busy: false, checkedOnce: false, onCheck: noop }} dismiss={{ label: 'Close', onDismiss: noop }} />);
    expect(idle).toMatch(/class="av3-btn av3-btn-primary"[^>]*data-testid="result-check"[^>]*>Check again</);
    expect(idle).toMatch(/class="av3-btn"[^>]*data-testid="result-dismiss"[^>]*>Close</);
    expect(idle.indexOf('result-check')).toBeLessThan(idle.indexOf('result-dismiss'));
    const busy = renderToStaticMarkup(<ResultFoot check={{ busy: true, checkedOnce: false, onCheck: noop }} dismiss={{ label: 'Close', onDismiss: noop }} />);
    expect(text(busy)).toContain(RESULT_TEXT.checking);
    expect(busy).toContain('av3-spin');
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    const after = renderToStaticMarkup(<ResultFoot check={{ busy: false, checkedOnce: true, onCheck: noop }} />);
    expect(after).toContain('data-testid="check-result"');
    expect(text(after)).toContain(RESULT_TEXT.checkedStillUnknown);
  });
  it('not known: the problem first, with the warning sign, not a check mark', () => {
    const h = renderToStaticMarkup(<UnknownTop word="Approved" line="It is not known whether this ran." />);
    expect(h).toContain('data-testid="decision-unknown"');
    expect(h).toContain('class="res-top"');
    expect(h).not.toContain('av3-check');
    expect(text(h)).toBe('Approved It is not known whether this ran.');
  });
  it('the stamp of a result that times away names what opens next', () => {
    expect(text(renderToStaticMarkup(<StampNext>Send email</StampNext>))).toBe('Next: Send email');
  });
});

describe('the device rows (gateway page and phone, one implementation)', () => {
  const NOW = 1_800_000_000;
  const rows = [
    { keyId: 'k1', label: 'Office Mac', kind: 'gateway' as const, thisDevice: false, addedAt: NOW - 40 * 86400, recent: false },
    { keyId: 'k2', label: 'Home Mac', kind: 'gateway' as const, thisDevice: false, addedAt: NOW - 3600, recent: true },
    { keyId: 'k3', label: 'My iPhone', kind: 'approve-app' as const, thisDevice: true, addedAt: NOW - 3600, recent: true },
  ];
  it('two lines: the name with its tag, then kind and when added', () => {
    const h = renderToStaticMarkup(<DeviceRows rows={rows} nowSeconds={NOW} thisDeviceTag="This phone" />);
    expect(text(h)).toContain('H Home Mac new Computer · added today');
    expect(text(h)).toContain('M My iPhone This phone Phone · added today');
    expect(h).not.toContain(SP.devCanConfirm);
    expect(h).not.toContain(SP.devRecent);
    expect(deviceDetail(rows[0], NOW)).toMatch(/^Computer · added /);
  });
  it('where a device can be removed: Remove on each row, and the warning only on the row of a device added recently that is not this one', () => {
    const h = renderToStaticMarkup(<DeviceRows rows={rows} nowSeconds={NOW} thisDeviceTag="This phone" onRemove={noop} />);
    expect(h.match(/data-testid="device-remove"/g)).toHaveLength(3);
    expect(h.match(/data-testid="row-warn"/g)).toHaveLength(1);
    expect(h).toMatch(/Home Mac[^]*data-testid="row-warn">Added today\. If this was not you, remove it\.</);
  });
  it('a device being added has neither Remove nor a warning', () => {
    const h = renderToStaticMarkup(<DeviceRows rows={[{ ...rows[1], adding: true }]} nowSeconds={NOW} thisDeviceTag="This phone" onRemove={noop} />);
    expect(h).not.toContain('device-remove');
    expect(h).not.toContain('row-warn');
    expect(text(h)).toBe('H Home Mac new Computer');
  });
});

describe('the summary line under a mandate\'s title', () => {
  const schema = { fields: { offer_value: { displayName: 'Value of one offer', unit: 'currency:EUR' }, per_day: { displayName: 'Offers per day', unit: 'count' } } };
  it('every shown limit with its unit, the scope values, then how long; schema-driven', () => {
    expect(giveSummaryLine({ limits: { offer_value: 2000, per_day: 10 }, scope: { region: ['Austria', 'Germany'] }, durationSeconds: 14 * 86400, boundsSchema: schema }))
      .toBe('2000 EUR · 10 · Austria, Germany · 14 days');
  });
  it('a hidden limit, profile and path stay out; nothing at all gives no line', () => {
    expect(giveSummaryLine({ limits: { offer_value: 2000, per_day: 10, profile: 'x' }, scope: { path: '/x' }, boundsSchema: schema, hidden: new Set(['per_day']) })).toBe('2000 EUR');
    expect(giveSummaryLine({})).toBe('');
  });
});
