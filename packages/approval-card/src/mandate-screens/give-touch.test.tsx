import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GiveTouchFooter, afterProgress, giveStageText, type GiveTouchView } from './GiveTouch';
import { S13 } from './texts';

const noop = () => {};
const html = (view: GiveTouchView) => renderToStaticMarkup(<GiveTouchFooter view={view} onGive={noop} onBack={noop} onClose={noop} />);

describe('give with Touch ID: never a silent wait', () => {
  it('offered: the give button and Back', () => {
    const h = html({ s: 'offered' });
    expect(h).toContain(S13.giveButton);
    expect(h).toContain('Back');
  });
  it('touch: one line with the spinner, no buttons', () => {
    const h = html({ s: 'touch' });
    expect(h).toContain(S13.giveBusy);
    expect(h).toContain('av3-spin');
    expect(h).not.toContain('<button');
  });
  it('working: the step the gateway reports, with the spinner, no buttons', () => {
    for (const [stage, text] of [['touched', S13.giveWorkingSigning], ['requesting', S13.giveWorkingSending], ['delivering', S13.giveWorkingDelivering]] as const) {
      const h = html({ s: 'working', stage });
      expect(h).toContain(text);
      expect(h).toContain('av3-spin');
      expect(h).not.toContain('<button');
      expect(giveStageText(stage)).toBe(text);
    }
  });
  it('given: the result stamp (check mark, Signed, Recorded) and one Close', () => {
    const h = html({ s: 'given' });
    expect(h).toContain('av3-check');
    expect(h).toContain(S13.giveSigned);
    expect(h).toContain(S13.giveRecorded);
    expect(h.match(/<button/g)).toHaveLength(1);
    expect(h).toContain(S13.giveResultClose);
  });
});

describe('progress only moves forward', () => {
  it('the touch given moves the wait to "Signing…", then on', () => {
    let v: GiveTouchView = { s: 'touch' };
    v = afterProgress(v, 'touched'); expect(v).toEqual({ s: 'working', stage: 'touched' });
    v = afterProgress(v, 'requesting'); expect(v).toEqual({ s: 'working', stage: 'requesting' });
    v = afterProgress(v, 'touched'); expect(v).toEqual({ s: 'working', stage: 'requesting' });   // late signal: no step back
    v = afterProgress(v, 'delivering'); expect(v).toEqual({ s: 'working', stage: 'delivering' });
  });
  it('ignores signals when nothing is being given, and unknown words', () => {
    expect(afterProgress({ s: 'offered' }, 'touched')).toEqual({ s: 'offered' });
    expect(afterProgress({ s: 'given' }, 'delivering')).toEqual({ s: 'given' });
    expect(afterProgress({ s: 'touch' }, 'nonsense')).toEqual({ s: 'touch' });
    expect(afterProgress({ s: 'touch' }, null)).toEqual({ s: 'touch' });
  });
});
