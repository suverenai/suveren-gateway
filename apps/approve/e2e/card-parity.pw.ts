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

// The give footer, one layout on both devices: the give button alone on the first row, "Ask for changes" | "Reject" side by side below,
// no Cancel on the phone (the head's close does that), and the commitment as one compact line above.
for (const width of [320, 375, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const id of ['crm', 'email-test']) {
      const mode = CASES.find((c) => c.id === id)!.mode;
      for (const card of ['gateway', 'phone'] as const) {
        test(`${id} ${card} at ${width}px ${theme}: compact commitment line, give on top, two equal buttons below`, async ({ page }) => {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`/fixture/index.html?case=${id}&card=${card}`);
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
          await page.waitForSelector('[data-testid=mandate-facts]');
          const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
          const band = await box('[data-testid=commitment-band]');
          const give = await box(card === 'phone' ? '[data-testid=btn-give]' : '[data-testid=btn-approve]');
          const ask = await box('[data-testid=btn-change-needed]');
          const rej = await box('[data-testid=btn-reject]');
          expect(band.height, 'the commitment line is at most 44 px high').toBeLessThanOrEqual(44);
          // one line: the title is a single row and says the mode (and no sentence under it)
          const lines = await page.locator('[data-testid=commitment-band] .mode-t').evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
          expect(lines).toBe(1);
          expect(await page.locator('[data-testid=commitment-band]').textContent()).toContain(mode === 'automatic' ? 'Automatic' : 'Review Each Action');
          expect(await page.locator('[data-testid=commitment-band] .mode-x').count()).toBe(0);
          // layout: give above, then Ask | Reject on one row, equal widths, all aligned to the same edges as the band
          expect(ask.y).toBeGreaterThan(give.y + give.height - 1);
          expect(Math.abs(ask.y - rej.y)).toBeLessThan(1);
          expect(Math.abs(ask.width - rej.width)).toBeLessThan(1.5);
          expect(ask.x).toBeLessThan(rej.x);
          expect(Math.abs(give.x - ask.x)).toBeLessThan(1);
          expect(Math.abs(give.x + give.width - (rej.x + rej.width))).toBeLessThan(1);
          expect(Math.abs(band.x - give.x)).toBeLessThan(1);
          expect(Math.abs(band.x + band.width - (give.x + give.width))).toBeLessThan(1);
          // band + give + the row together stay small
          expect(rej.y + rej.height - band.y, 'band, give button and row together').toBeLessThanOrEqual(170);
          // the words
          expect((await page.locator('[data-testid=btn-change-needed]').innerText()).trim()).toBe('Ask for changes');
          expect((await page.locator('[data-testid=btn-reject]').textContent())?.trim()).toBe('Reject');
          const names = (await page.locator('.av3-foot button').allTextContents()).map((t) => t.trim());
          expect(names).not.toContain('Cancel');
          expect(names.length).toBe(3);
          await fits(page, 'the give footer', width);
          if (SHOTS && width === 390) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `give-${id}-${card}-${theme}-390.png`), fullPage: true, clip: { x: 0, y: band.y - 160, width, height: rej.y + rej.height - band.y + 200 } }); }
        });
      }
    }
  }
}

// The phone's header: the brand row (mark, "Suveren", the black "Approvals" badge) on the first line, the page title on its own line below,
// the theme switch / pager / menu / close at the right, and all of it inside the screen.
for (const width of [320, 375, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const view of ['phone-top', 'phone-panel'] as const) {
      test(`${view} at ${width}px ${theme}: brand row, title below, nothing crowded or off screen`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`/fixture/index.html?case=crm&card=${view}`);
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        await page.waitForSelector('.logo-group');
        await expect(page.locator('.logo-group .logo')).toHaveText('Suveren');
        await expect(page.locator('.logo-group .version-badge')).toHaveText('Approvals');
        expect(await page.locator('.logo-group svg').count()).toBe(1);
        const brand = (await page.locator('.logo-group').boundingBox())!;
        const title = (await page.locator(view === 'phone-top' ? 'h1' : '.apr-title').boundingBox())!;
        expect(title.y, 'the title is on its own line below the brand').toBeGreaterThanOrEqual(brand.y + brand.height - 1);
        const badge = (await page.locator('.logo-group .version-badge').boundingBox())!;
        const right = view === 'phone-top' ? (await page.locator('.theme-toggle').boundingBox())! : (await page.locator('[data-testid=approval-later]').boundingBox())!;
        expect(right.x, 'the right-hand controls do not touch the brand').toBeGreaterThanOrEqual(badge.x + badge.width + 4);
        expect(right.x + right.width).toBeLessThanOrEqual(width);
        expect(Math.abs((right.y + right.height / 2) - (brand.y + brand.height / 2)), 'brand and right-hand controls share a line').toBeLessThan(14);
        if (view === 'phone-panel') {
          await expect(page.locator('[data-testid=approval-position]')).toHaveText('1 of 2');
          const menu = (await page.locator('[data-testid=approval-head-menu]').boundingBox())!;
          expect(menu.x).toBeGreaterThanOrEqual(badge.x + badge.width + 4);
          const pos = (await page.locator('[data-testid=approval-position]').boundingBox())!;
          const next = (await page.locator('[data-testid=approval-next]').boundingBox())!;
          expect(pos.y).toBeGreaterThanOrEqual(brand.y + brand.height - 1);
          expect(next.x + next.width).toBeLessThanOrEqual(width);
        }
        await fits(page, view, width);
        if (SHOTS && width !== 375) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `head-${view}-${theme}-${width}.png`), clip: { x: 0, y: 0, width, height: 220 } }); }
      });
    }
  }
}

// An installed iPhone app: the status bar floats over the page. The first row of the phone (the top bar, the full-screen panel's head)
// starts below the safe-area inset. Chromium has no inset, so the inset is injected as the variable both rows read.
for (const view of ['phone-top', 'phone-panel'] as const) {
  test(`${view}: the brand row starts below the safe-area inset (and the inset comes from the system's env value)`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/fixture/index.html?case=crm&card=${view}`);
    await page.waitForSelector('.logo-group');
    const css = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => r.cssText).join('\n'));
    expect(css).toMatch(/--ap-inset-top:\s*env\(safe-area-inset-top\)/);
    expect(css).toMatch(/display-mode:\s*standalone[\s\S]*--ap-inset-top:\s*max\(env\(safe-area-inset-top\)/);
    await page.addStyleTag({ content: ':root { --ap-inset-top: 59px !important; }' });
    const top = (await page.locator('.logo-group').boundingBox())!.y;
    expect(top, 'the brand row clears a 59 px status bar').toBeGreaterThanOrEqual(59);
    expect(top, 'and does not add a second inset on top of it').toBeLessThan(59 + 24);
  });
}
