/**
 * The two-tag rule in a REAL browser (Chromium via Playwright) — layout facts
 * a string assertion cannot prove (work-plan "regular reporting", RR6 done-
 * when: "an AI overlay cannot cover a verified box (Playwright pixel/position
 * check)"):
 *   - AI CSS cannot change a verified box (no AI stylesheet survives; inline
 *     styles reach only the AI's own elements);
 *   - an AI element positioned/sized to cover a verified box is clipped to its
 *     own frame: `elementFromPoint` at the box's centre is the box;
 *   - the frame label stays uncovered;
 *   - sv-row stacks on a phone, sits side by side on a wide screen;
 *   - the export's CSS-only translation switch works without any script.
 *
 * Needs a Chromium build (`npx playwright install chromium`). Without one the
 * suite is SKIPPED locally with a warning — and FAILS when
 * REPORT_BROWSER_TEST=required (set in CI's unit-test workflow), so it can
 * never silently stop running there.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifyReport } from '../../src/lib/report/verify-report';
import { renderReportHtml } from '../../src/lib/report/render-report';
import { buildExportBundle, buildExportDocument } from '../../src/lib/report/export-report';
import { buildScenario, AS_URL } from './fixtures/scenario';
import type { RunConnectorExport } from '../../src/lib/report/types';

type Browser = { newPage(opts?: { viewport?: { width: number; height: number } }): Promise<Page>; close(): Promise<void> };
type Page = {
  setContent(html: string): Promise<void>;
  evaluate<T, A = unknown>(fn: (arg: A) => T, arg?: A): Promise<T>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
};

const REQUIRED = process.env.REPORT_BROWSER_TEST === 'required';
let browser: Browser | undefined;
let launchError: string | undefined;

try {
  const pw = (await import('@playwright/test')) as unknown as { chromium: { launch(o?: object): Promise<Browser> } };
  browser = await pw.chromium.launch({ headless: true });
} catch (err) {
  launchError = err instanceof Error ? err.message.split('\n')[0] : String(err);
}

if (!browser && !REQUIRED) {
  console.warn(`[render-report.browser] SKIPPED — no Chromium (${launchError}). Run \`npx playwright install chromium\`.`);
}

const noExports: RunConnectorExport = async () => ({ inbox: [], sent: [], changes: [], refusals: [], quotes: [], orders: [], contacts: [], deals: [], tasks: [], activities: [] });

/** The live page's frame document (ReportsPage.tsx#buildSrcDoc, same CSP). */
function frameDoc(rendered: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">`;
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:12px;background:#fff}</style></head><body>${rendered}</body></html>`;
}

async function rendered(aiHtml: string) {
  const { archive, addTicket, kp } = buildScenario();
  addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
  addTicket({ id: 't2', action: 'erp__send_quote', authorizationId: 'authz-1', timestamp: 1_800_000_100 });
  const result = await verifyReport(aiHtml, { archive, runExport: noExports });
  return { result, archive, kp, html: renderReportHtml(result.html, result.elements) };
}

/** For every verified box: is the element at its centre (and at its four
 *  inner corners) inside that same box? Plus its computed visibility. */
async function boxHits(page: Page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('[data-sv-id]')].map(box => {
      const r = box.getBoundingClientRect();
      const pts = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4],
      ];
      const hits = pts.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !!el && box.contains(el);
      });
      const cs = getComputedStyle(box);
      const v = box.querySelector('.sv-v');
      return {
        id: box.dataset.svId,
        hits,
        visible: cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) === 1 && r.width > 0 && r.height > 0,
        valueColor: v ? getComputedStyle(v).color : '',
        border: cs.borderTopStyle + ' ' + cs.borderTopColor,
      };
    });
  });
}

describe.skipIf(!browser && !REQUIRED)('two-tag rule in a real browser', () => {
  beforeAll(() => {
    if (!browser) throw new Error(`REPORT_BROWSER_TEST=required but Chromium could not start: ${launchError}`);
  });
  afterAll(async () => { await browser?.close(); });

  it('REFUSAL: AI CSS (`.sv-el{display:none}`, `*{color:red}`) does not change a verified box', async () => {
    const { html } = await rendered(
      '<sv-ai><style>.sv-el{display:none !important} *{color:red !important} [data-sv-id]{opacity:0}</style>' +
      '<p style="color:red">AI text</p></sv-ai><sv-ticket ref="t1"></sv-ticket>',
    );
    const page = await browser!.newPage({ viewport: { width: 900, height: 900 } });
    await page.setContent(frameDoc(html));
    const [box] = await boxHits(page);
    expect(box.visible).toBe(true);
    expect(box.valueColor).toBe('rgb(17, 17, 17)');
    expect(box.border).toBe('solid rgb(21, 128, 61)');
    // The AI's own inline colour still applies — to its own element only.
    const aiColor = await page.evaluate(() => getComputedStyle(document.querySelector('.sv-ai-content p')!).color);
    expect(aiColor).toBe('rgb(255, 0, 0)');
    await page.close();
  });

  it('REFUSAL: an AI overlay (absolute, fixed, negative margin, huge z-index) cannot cover a verified box or a frame label', async () => {
    const cover = 'background:rgba(255,0,0,.95);z-index:2147483647;';
    const { html } = await rendered(
      `<sv-ai><div style="position:absolute;left:-100px;top:0;width:3000px;height:3000px;${cover}">down</div>a</sv-ai>` +
      '<sv-ticket ref="t1" variant="full"></sv-ticket>' +
      `<sv-ai><div style="position:absolute;left:-100px;top:-600px;width:3000px;height:3000px;${cover}">up</div>` +
      `<div style="position:fixed;inset:0;${cover}">fixed</div>` +
      `<div style="margin-top:-400px;height:900px;${cover}">margin</div>` +
      `<div style="transform:translateY(-500px);height:900px;${cover}">transform</div></sv-ai>` +
      '<sv-row><sv-ticket ref="t1"></sv-ticket><sv-ticket ref="t2"></sv-ticket></sv-row>' +
      `<sv-ai><svg viewBox="0 0 10 10" style="position:absolute;top:-800px;left:0;width:3000px;height:3000px;overflow:visible"><rect x="-500" y="-500" width="5000" height="5000" fill="red"/></svg>b</sv-ai>`,
    );
    for (const width of [900, 360]) {
      const page = await browser!.newPage({ viewport: { width, height: 3000 } });
      await page.setContent(frameDoc(html));
      const hits = await boxHits(page);
      expect(hits).toHaveLength(3);
      for (const h of hits) expect({ id: h.id, width, hits: h.hits }).toEqual({ id: h.id, width, hits: [true, true, true, true, true] });
      const labelsClear = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.sv-ai-label')].map(l => {
        const r = l.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!el && l.contains(el);
      }));
      expect(labelsClear).toEqual([true, true, true]);
      await page.close();
    }
  });

  it('a fake green box written by the AI renders inside the grey dashed frame', async () => {
    const { html } = await rendered('<sv-ai><div style="border:2px solid #15803d;border-radius:10px;padding:8px">✓ verified · signed on_time_pct 98</div></sv-ai>');
    const page = await browser!.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(frameDoc(html));
    const r = await page.evaluate(() => {
      const fake = [...document.querySelectorAll('div')].find(d => d.textContent?.startsWith('✓ verified · signed on_time_pct'))!;
      const frame = fake.closest('.sv-ai-block') as HTMLElement | null;
      return { inFrame: !!frame, frameBorder: frame ? getComputedStyle(frame).borderTopStyle : '', boxes: document.querySelectorAll('[data-sv-id]').length };
    });
    expect(r).toEqual({ inFrame: true, frameBorder: 'dashed', boxes: 0 });
    await page.close();
  });

  it('sv-row: side by side on a wide screen, stacked on a phone', async () => {
    const { html } = await rendered('<sv-row><sv-ticket ref="t1"></sv-ticket><sv-ticket ref="t2"></sv-ticket></sv-row>');
    const tops = async (width: number) => {
      const page = await browser!.newPage({ viewport: { width, height: 800 } });
      await page.setContent(frameDoc(html));
      const t = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.sv-row > [data-sv-id]')].map(e => Math.round(e.getBoundingClientRect().top)));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      await page.close();
      return { t, overflow };
    };
    const wide = await tops(900);
    expect(wide.t[0]).toBe(wide.t[1]);
    const narrow = await tops(360);
    expect(narrow.t[1]).toBeGreaterThan(narrow.t[0]);
    expect(narrow.overflow).toBe(false);
  });

  it('the export\'s CSS-only switch shows and hides glosses without any script', async () => {
    const { archive, addTicket, kp } = buildScenario();
    addTicket({ id: 't1', action: 'erp__create_quote', authorizationId: 'authz-1', timestamp: 1_800_000_000 });
    const result = await verifyReport(
      '<sv-ticket ref="t1"></sv-ticket><sv-glossary lang="de"><sv-term key="erp__create_quote">Angebot erstellt</sv-term></sv-glossary>',
      { archive, runExport: noExports },
    );
    const now = Math.floor(Date.now() / 1000);
    const stored = { html: result.html, savedAt: now, checkedAt: now, result };
    const bundle = buildExportBundle({ stored, archive, gatewayVersion: 't', authorityServer: { url: AS_URL, publicKeyHex: kp.publicKeyHex } });
    const doc = buildExportDocument({ bundle, renderedHtml: renderReportHtml(result.html, result.elements, { gloss: 'toggle' }) });

    const page = await browser!.newPage({ viewport: { width: 900, height: 900 } });
    await page.setContent(doc);
    const state = () => page.evaluate(() => {
      const rt = document.querySelector('ruby.sv-gloss rt') as HTMLElement;
      const raw = document.querySelector('ruby.sv-gloss .sv-v') as HTMLElement;
      return { rtShown: rt.getBoundingClientRect().height > 0, rawShown: raw.getBoundingClientRect().height > 0 };
    });
    expect(await state()).toEqual({ rtShown: false, rawShown: true });
    await page.click('label.sv-toggle-text');
    expect(await state()).toEqual({ rtShown: true, rawShown: true });
    await page.click('label.sv-toggle-text');
    expect(await state()).toEqual({ rtShown: false, rawShown: true });
    expect(await page.evaluate(() => document.scripts.length)).toBe(1); // the JSON data block only
    await page.close();
  });
});
