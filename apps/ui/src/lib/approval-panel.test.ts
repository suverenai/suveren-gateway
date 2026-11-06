import { describe, it, expect } from 'vitest';
import {
  INITIAL_PANEL, reconcilePanel, panelChrome, isFormInProgress, isTypingTarget, isWizardRoute,
  resolveCurrent, positionOf, neighbour, afterDecision, loadAutoOpen, saveAutoOpen, stripAutoLabel,
  type PanelInput, type PanelState, type SettingsClient,
} from './approval-panel';

const base: PanelInput = { ids: [], loaded: true, autoOpen: true, typing: false, onApprovalsPage: false, hold: false };
const run = (prev: PanelState, over: Partial<PanelInput>) => reconcilePanel(prev, { ...base, ...over });

describe('which approvals open the panel', () => {
  it('does nothing before the queue and the setting have answered', () => {
    expect(run(INITIAL_PANEL, { loaded: false, ids: ['a'] })).toEqual(INITIAL_PANEL);
  });
  it('opens when an approval is waiting and the setting is on (also at start-up)', () => {
    expect(run(INITIAL_PANEL, { ids: ['a'] })).toEqual({ open: true, knownIds: ['a'], owed: false });
  });
  it('does not open by itself when the setting is off or unknown — only the strip shows', () => {
    expect(run(INITIAL_PANEL, { ids: ['a'], autoOpen: false }).open).toBe(false);
    expect(run(INITIAL_PANEL, { ids: ['a'], autoOpen: null }).open).toBe(false);
  });
  it('after "Later" the same approvals do not open it again; a new arrival does', () => {
    const later: PanelState = { open: false, knownIds: ['a'], owed: false };
    expect(run(later, { ids: ['a'] }).open).toBe(false);
    expect(run(later, { ids: ['a', 'b'] }).open).toBe(true);
  });
  it('slides out completely when nothing is left', () => {
    expect(run({ open: true, knownIds: ['a'], owed: false }, { ids: [] })).toEqual({ open: false, knownIds: [], owed: false });
  });
  it('stays open while a decision result is still shown', () => {
    expect(run({ open: true, knownIds: ['a'], owed: false }, { ids: [], hold: true }).open).toBe(true);
  });
  it('never slides in by itself on the Approvals page, and what it listed there is not an arrival later', () => {
    const on = run(INITIAL_PANEL, { ids: ['a'], onApprovalsPage: true });
    expect(on).toEqual({ open: false, knownIds: ['a'], owed: false });
    expect(run(on, { ids: ['a'] }).open).toBe(false); // left the page: strip, not panel
  });
  it('keeps a panel the person opened from a row, also when more arrive meanwhile', () => {
    const opened: PanelState = { open: true, knownIds: ['a'], owed: false };
    expect(run(opened, { ids: ['a', 'b'], onApprovalsPage: true }).open).toBe(true);
    expect(run(opened, { ids: [], onApprovalsPage: true }).open).toBe(false);
  });
});

describe('typing in a form', () => {
  it('holds an arrival back, then opens when the form is closed', () => {
    const held = run(INITIAL_PANEL, { ids: ['a'], typing: true });
    expect(held).toEqual({ open: false, knownIds: ['a'], owed: true });
    expect(run(held, { ids: ['a'], typing: true }).open).toBe(false);
    expect(run(held, { ids: ['a'], typing: false })).toEqual({ open: true, knownIds: ['a'], owed: false });
  });
  it('drops the debt when the setting is turned off meanwhile', () => {
    const held: PanelState = { open: false, knownIds: ['a'], owed: true };
    expect(run(held, { ids: ['a'], autoOpen: false }).owed).toBe(false);
  });
  it('shows the bar (not the strip) while typing, the panel when opened over the form', () => {
    expect(panelChrome({ count: 1, open: false, typing: true, onApprovalsPage: false, hold: false })).toEqual({ panel: false, bar: true, strip: false });
    expect(panelChrome({ count: 1, open: true, typing: true, onApprovalsPage: false, hold: false })).toEqual({ panel: true, bar: false, strip: false });
  });
  it('form in progress = dialog open, focus in a field, or the wizard page', () => {
    expect(isFormInProgress({ modalOpen: false, fieldFocused: false, wizardRoute: false })).toBe(false);
    expect(isFormInProgress({ modalOpen: true, fieldFocused: false, wizardRoute: false })).toBe(true);
    expect(isFormInProgress({ modalOpen: false, fieldFocused: true, wizardRoute: false })).toBe(true);
    expect(isFormInProgress({ modalOpen: false, fieldFocused: false, wizardRoute: true })).toBe(true);
    expect(isWizardRoute('/mandates/new/intent')).toBe(true);
    expect(isWizardRoute('/mandates')).toBe(false);
  });
  it('knows a typing target from a button', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    // A search box is not work in progress (nothing is lost when focus leaves it).
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('what is on screen', () => {
  it('nothing when no approval waits', () => {
    expect(panelChrome({ count: 0, open: false, typing: false, onApprovalsPage: false, hold: false })).toEqual({ panel: false, bar: false, strip: false });
  });
  it('on the Approvals page: no strip or bar, the panel only once opened', () => {
    expect(panelChrome({ count: 2, open: false, typing: false, onApprovalsPage: true, hold: false })).toEqual({ panel: false, bar: false, strip: false });
    expect(panelChrome({ count: 2, open: true, typing: false, onApprovalsPage: true, hold: false })).toEqual({ panel: true, bar: false, strip: false });
  });
  it('the strip when sent away; the panel when open', () => {
    expect(panelChrome({ count: 2, open: false, typing: false, onApprovalsPage: false, hold: false }).strip).toBe(true);
    expect(panelChrome({ count: 2, open: true, typing: false, onApprovalsPage: false, hold: false })).toEqual({ panel: true, bar: false, strip: false });
  });
  it('keeps the panel for the last result even though the queue is empty', () => {
    expect(panelChrome({ count: 0, open: true, typing: false, onApprovalsPage: false, hold: true }).panel).toBe(true);
  });
  it('no strip and no bar for a count of zero, even while the last result is still held', () => {
    expect(panelChrome({ count: 0, open: false, typing: false, onApprovalsPage: false, hold: true })).toEqual({ panel: false, bar: false, strip: false });
    expect(panelChrome({ count: 0, open: false, typing: true, onApprovalsPage: false, hold: true })).toEqual({ panel: false, bar: false, strip: false });
  });
  it('the strip says when auto is off', () => {
    expect(stripAutoLabel(true)).toBe('');
    expect(stripAutoLabel(false)).toBe('Auto off');
    expect(stripAutoLabel(null)).toBe('Auto off');
  });
});

describe('moving between approvals', () => {
  const ids = ['a', 'b', 'c'];
  it('resolves the current one, falling back to the first', () => {
    expect(resolveCurrent(ids, 'b')).toBe('b');
    expect(resolveCurrent(ids, 'gone')).toBe('a');
    expect(resolveCurrent([], 'a')).toBeNull();
  });
  it('counts "1 of N" and steps Previous / Next, stopping at the ends', () => {
    expect(positionOf(ids, 'b')).toEqual({ index: 2, total: 3 });
    expect(neighbour(ids, 'b', 1)).toBe('c');
    expect(neighbour(ids, 'b', -1)).toBe('a');
    expect(neighbour(ids, 'a', -1)).toBeNull();
    expect(neighbour(ids, 'c', 1)).toBeNull();
  });
  it('after a decision: the one that takes its place, the last when it was last, null when none left', () => {
    expect(afterDecision(ids, 'a').next).toBe('b');
    expect(afterDecision(ids, 'c').next).toBe('b');
    expect(afterDecision(['a'], 'a').next).toBeNull();
  });
});

describe('the setting lives in the gateway', () => {
  const fake = (stored: { openApprovalsAutomatically: boolean }, opts: { failRead?: boolean; failWrite?: boolean; ignoreWrite?: boolean } = {}): SettingsClient & { writes: unknown[] } => {
    const writes: unknown[] = [];
    return {
      writes,
      async getGatewaySettings() { if (opts.failRead) throw new Error('down'); return { desktopNotifications: true, ...stored }; },
      async setGatewaySettings(patch) {
        writes.push(patch);
        if (opts.failWrite) throw new Error('refused');
        if (!opts.ignoreWrite) Object.assign(stored, patch);
        return { desktopNotifications: true, ...stored };
      },
    };
  };
  it('reads what the gateway holds, null when it cannot', async () => {
    expect(await loadAutoOpen(fake({ openApprovalsAutomatically: true }))).toBe(true);
    expect(await loadAutoOpen(fake({ openApprovalsAutomatically: false }))).toBe(false);
    expect(await loadAutoOpen(fake({ openApprovalsAutomatically: true }, { failRead: true }))).toBeNull();
  });
  it('writes only the one key and returns the persisted value', async () => {
    const c = fake({ openApprovalsAutomatically: true });
    expect(await saveAutoOpen(c, false)).toBe(false);
    expect(c.writes).toEqual([{ openApprovalsAutomatically: false }]);
  });
  it('returns what the gateway kept, even when it did not take the change', async () => {
    expect(await saveAutoOpen(fake({ openApprovalsAutomatically: true }, { ignoreWrite: true }), false)).toBe(true);
  });
  it('a failed write throws — the caller shows the error and keeps the old value', async () => {
    await expect(saveAutoOpen(fake({ openApprovalsAutomatically: true }, { failWrite: true }), false)).rejects.toThrow('refused');
  });
});
