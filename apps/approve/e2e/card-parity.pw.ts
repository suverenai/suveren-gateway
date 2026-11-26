/**
 * One mandate proposal, two devices: the gateway's approval card and the phone app's give show the same facts (mode, valid, limits,
 * scope, workspace, title, intent), in the same order, in the same words, at 390 px and at 1100 px. No value column is narrower than 8 rem,
 * and no value runs out of its box. Real components and CSS (fixture/main.tsx); the pairing, the touch and the Authority Server are not here.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CASES } from '../fixture/cases';

const SHOTS = process.env.SHOTS_DIR;

interface Seen {
  mode: string | null; band: string | null; title: string; valid: string; limits: string[]; scope: string[]; workspace: string | null;
  name: string | null; intent: string | null; request: string | null; history: string | null; summary: string | null;
}

async function seen(page: Page, id: string, card: 'gateway' | 'phone', width: number, theme: 'dark' | 'light'): Promise<Seen> {
  await page.setViewportSize({ width, height: 1400 });
  await page.goto(`/fixture/index.html?case=${id}&card=${card}`);
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.waitForSelector('[data-testid=mandate-facts]');
  await page.waitForSelector('[data-testid=au10-request]');
  const text = async (sel: string) => (await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null))?.replace(/\s+/g, ' ').trim() ?? null;
  const pairs = async (sel: string) => page.locator(`${sel} [data-testid=fact-label]`).evaluateAll((labels) => labels.map((l) => `${l.textContent}: ${(l.nextElementSibling as HTMLElement).textContent}`));
  const out: Seen = {
    mode: await text('[data-testid=mode-badge]'),
    band: await text('[data-testid=commitment-band]'),
    title: (await text(card === 'phone' ? '[data-testid=give-title]' : '[data-testid=approval-summary]'))!,
    valid: (await text('[data-testid=mandate-valid]'))!,
    limits: await pairs('[data-testid=mandate-limits]'),
    scope: await pairs('[data-testid=mandate-scope]'),
    workspace: await text('[data-testid=mandate-workspace]'),
    name: await text('[data-testid=mandate-title]'),
    intent: await text('[data-testid=mandate-intent-ai] p'),
    request: await page.locator('[data-testid=au10-request] .au10-req-quote').first().textContent({ timeout: 500 }).catch(() => null),
    history: await text('[data-testid=au10-history] .au10-hist-state'),
    summary: await text('[data-testid=mandate-summary]'),
  };
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => (document.querySelectorAll('details.av3-fold') as NodeListOf<HTMLDetailsElement>).forEach((d) => { d.open = false; }));
    await page.screenshot({ path: join(SHOTS, `${id}-${card}-${width}-${theme}.png`), fullPage: true });
  }
  return out;
}

for (const width of [390, 1100]) {
  for (const c of CASES) {
    test(`${c.id} at ${width}px: the phone shows what the gateway shows`, async ({ page }) => {
      const gateway = await seen(page, c.id, 'gateway', width, 'dark');
      // The gateway card also shows the host's own rows ("Decide by …") that the phone has none of; the facts are the card's own.
      const phone = await seen(page, c.id, 'phone', width, 'dark');
      for (const key of ['mode', 'band', 'title', 'valid', 'limits', 'scope', 'workspace', 'name', 'intent', 'summary', 'request', 'history'] as const) {
        expect(phone[key], `${c.id} ${width}px: ${key}`).toEqual(gateway[key]);
      }
      expect(gateway.valid).toMatch(/^\d+ (days|hours) \(until .+\)$/);
      expect(gateway.limits.length).toBeGreaterThan(0);
      // The granted duration, not a count of what is left: 720 hours is 30 days.
      if (c.durationHours === 720) expect(gateway.valid.startsWith('30 days (until ')).toBe(true);
      // Lists read with a space after each comma
      for (const line of [...gateway.scope, ...gateway.limits]) expect(line).not.toMatch(/\w,\w/);
    });

    test(`${c.id} at ${width}px: no value column narrower than 8 rem, nothing runs out of its box`, async ({ page }) => {
      for (const card of ['gateway', 'phone'] as const) {
        await seen(page, c.id, card, width, 'light');
        const boxes = await page.locator('[data-testid=fact-value]').evaluateAll((els) => els.map((e) => ({ w: e.getBoundingClientRect().width, over: e.scrollWidth > e.clientWidth + 1, t: e.textContent })));
        const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        expect(boxes.length).toBeGreaterThan(0);
        for (const b of boxes) {
          expect(b.w, `${card} ${width}px: "${b.t}" is ${b.w}px wide`).toBeGreaterThanOrEqual(8 * rem - 1);
          expect(b.over, `${card} ${width}px: "${b.t}" runs out of its box`).toBe(false);
        }
        // Automatic is amber on the badge and the band; every other mode reads as a review (neutral)
        const tone = c.mode === 'automatic' ? 'mode-automatic' : 'mode-review';
        await expect(page.locator('[data-testid=mode-badge]')).toHaveClass(new RegExp(tone));
        await expect(page.locator('[data-testid=commitment-band]')).toHaveClass(new RegExp(tone));
      }
    });
  }
}

// The mandate list: the commitment is the badge, and the one line is the rule's summary (scope first, defaults and full enums left out).
const LIST_LINES: Record<string, string> = {
  crm: 'Daily write limit 50',
  'email-test': 'Allowed recipients test@example.com · Recipients per email 1 · Daily send limit 10 · Weekly send limit 40 · +1 more',
  website: 'Allowed repositories humanagencyprotocol/hap-protocol · Allowed environments production · Allowed pipelines deploy-website.yml · Allowed branches main · +2 more',
};
for (const [id, line] of Object.entries(LIST_LINES)) {
  test(`${id}: the gateway's mandate list card shows the badge and the summary line`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await page.goto(`/fixture/index.html?case=${id}&card=list`);
    const card = page.locator('[data-testid=mandate-card]');
    await expect(card.locator('[data-testid=mode-badge]')).toHaveCount(1);
    await expect(card.locator('.ob-one')).toHaveText(line);
    // the mode is not also a word at the start of the line
    expect(await card.locator('.ob-one').textContent()).not.toMatch(/^(Review Each Action|Automatic)/);
  });
  test(`${id}: the phone's list shows the same badge`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(`/fixture/index.html?case=${id}&card=phone-list`);
    await expect(page.locator('[data-testid=own-mandate] [data-testid=mode-badge]')).toHaveCount(1);
  });
}

// A decision reads the same on both devices: the buttons, the note box, the working line and the stamp.
async function decide(page: Page, card: 'gateway' | 'phone', kind: 'reject' | 'change') {
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto(`/fixture/index.html?case=crm&card=${card}`);
  await page.waitForSelector('[data-testid=mandate-facts]');
  const labels = (await page.locator('.av3-foot button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  const seen: Record<string, unknown> = { labels: labels.filter((l) => /Reject|changes|Changes/i.test(l)).map((l) => (/hang/i.test(l) ? 'Ask for changes' : l)) };
  if (kind === 'change') {
    await page.locator('[data-testid=btn-change-needed]').click();
    seen.noteLabel = (await page.locator('.av3-chg-l').textContent())?.trim();
    seen.noteButtons = (await page.locator('.av3-chg button').allTextContents()).map((t) => t.trim());
    await page.locator('[data-testid=change-note]').fill('Use the reply address instead.');
    await page.locator('[data-testid=btn-send-back]').click();
  } else {
    await page.locator('[data-testid=btn-reject]').click();
  }
  await page.waitForSelector('[data-testid=decision-stamp]');
  seen.stamp = (await page.locator('[data-testid=decision-stamp]').textContent())?.replace(/\s+/g, ' ').trim();
  // the buttons are gone once the stamp is up (nothing to press twice)
  seen.buttonsAfter = await page.locator('.av3-foot button').count();
  if (SHOTS) await page.waitForTimeout(700);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `stamp-${kind}-${card}-390.png`), fullPage: true });
  return seen;
}
for (const kind of ['reject', 'change'] as const) {
  test(`${kind}: the phone says and shows exactly what the gateway says`, async ({ page }) => {
    const gateway = await decide(page, 'gateway', kind);
    const phone = await decide(page, 'phone', kind);
    expect(phone).toEqual(gateway);
    expect(gateway.stamp).toBe(kind === 'reject' ? 'RejectedRecorded' : 'Sent back to the AIRecorded');
    expect(gateway.buttonsAfter).toBe(0);
  });
}

// Every state of the decision footer fits the screen: no sideways scroll, nothing of the card sticks out past the viewport edge.
async function fits(page: Page, what: string, width: number) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const out: string[] = [];
    document.querySelectorAll('main *').forEach((e) => {
      if (e.closest('.sr-only')) return; // visually hidden text, by design
      const b = e.getBoundingClientRect();
      if (b.width > 0 && (b.right > vw + 0.5 || b.left < -0.5)) out.push(`${e.tagName.toLowerCase()}.${(e as HTMLElement).className} ${Math.round(b.left)}..${Math.round(b.right)}`);
    });
    return { scroll: document.scrollingElement!.scrollWidth, vw, out: out.slice(0, 6) };
  });
  expect(r.scroll, `${what} at ${width}px: page scrolls sideways`).toBeLessThanOrEqual(r.vw);
  expect(r.out, `${what} at ${width}px: sticks out of the viewport`).toEqual([]);
}
for (const width of [320, 375, 390]) {
  for (const card of ['gateway', 'phone'] as const) {
    test(`${card} at ${width}px: the note box, the working line and the stamps stay inside the screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/fixture/index.html?case=crm&card=${card}`);
      await page.waitForSelector('[data-testid=mandate-facts]');
      await fits(page, 'the card', width);
      await page.locator('[data-testid=btn-change-needed]').click();
      await page.waitForSelector('[data-testid=change-note]');
      await page.locator('[data-testid=change-note]').fill('Use the reply address instead, and keep the limit as it is today please.');
      await fits(page, 'the note box', width);
      // iOS Safari zooms the whole page into any field whose text is under 16 px, which pushes the right edge (the textarea border and
      // "Back") off the screen and lets the page scroll sideways. Chromium has no such zoom, so the cause is checked where it lives.
      const fieldPx = await page.locator('[data-testid=change-note]').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      expect(fieldPx, `the note box at ${width}px: text under 16 px makes iOS zoom the page`).toBeGreaterThanOrEqual(16);
      if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `note-${card}-${width}.png`), fullPage: true }); }
      await page.locator('[data-testid=btn-send-back]').click();
      await page.waitForSelector('[data-testid=decision-stamp]');
      await fits(page, 'the sent-back stamp', width);
      for (const kind of ['reject'] as const) {
        await page.goto(`/fixture/index.html?case=crm&card=${card}`);
        await page.waitForSelector('[data-testid=mandate-facts]');
        await page.locator('[data-testid=btn-reject]').click();
        await page.waitForSelector('[data-testid=decision-working], [data-testid=decision-stamp]');
        await fits(page, `the ${kind} working line or stamp`, width);
        await page.waitForSelector('[data-testid=decision-stamp]');
        await fits(page, `the ${kind} stamp`, width);
      }
    });
  }
}
