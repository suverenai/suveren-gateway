import { describe, it, expect, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { useUpdateCheck, noteHealth, resetHealthSeenForTests } from './useUpdateCheck';

function Probe() {
  const u = useUpdateCheck();
  return <span>{`v=${u.version} update=${u.updateAvailable} latest=${u.latestVersion ?? '-'} method=${u.installMethod}`}</span>;
}

describe('useUpdateCheck: a new mount starts from what this page was last told (DEC-100: the frame does not move)', () => {
  beforeEach(() => resetHealthSeenForTests());
  it('nothing seen yet: empty, as before', () => {
    expect(renderToString(<Probe />)).toContain('v= update=false latest=- method=docker');
  });
  it('after an answer: the next mount has the version and the update bar from its first render', () => {
    noteHealth({ version: '0.45.0', updateAvailable: true, latestVersion: '0.45.1', installMethod: 'npm' });
    expect(renderToString(<Probe />)).toContain('v=0.45.0 update=true latest=0.45.1 method=npm');
  });
  it('an update once seen stays seen; a later answer without fields keeps the earlier ones', () => {
    noteHealth({ version: '0.45.0', updateAvailable: true, latestVersion: '0.45.1', installMethod: 'npm' });
    noteHealth({ updateAvailable: false });
    expect(renderToString(<Probe />)).toContain('v=0.45.0 update=true latest=0.45.1 method=npm');
  });
});
