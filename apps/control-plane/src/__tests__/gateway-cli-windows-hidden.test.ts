/**
 * On Windows, `start --detach` (and with it the installer's Start-menu entry)
 * must not leave a console window open for the gateway's lifetime — closing
 * that window would kill the gateway. Window visibility cannot be observed on
 * a CI runner, so this pins the two settings that decide it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../../../..');

describe('Windows: no console window for the running gateway', () => {
  it('start --detach spawns server.js with windowsHide', () => {
    const src = readFileSync(join(root, 'bundle/bin/suveren-gateway.js'), 'utf8');
    const detachSpawn = src.slice(src.indexOf('if (detach) {'), src.indexOf('writeFileSync(PID_FILE'));
    expect(detachSpawn).toContain('detached: true');
    expect(detachSpawn).toContain('windowsHide: true');
  });

  it('server.js spawns the control plane, MCP server and CA re-exec with windowsHide', () => {
    const src = readFileSync(join(root, 'bundle/server.js'), 'utf8');
    const spawns = src.split('spawn(').slice(1).map(s => s.slice(0, s.indexOf(');')));
    expect(spawns.length).toBe(3);
    for (const call of spawns) expect(call).toContain('windowsHide: true');
  });

  it('the Start-menu shortcut runs the launcher headless (conhost --headless, no console window)', () => {
    const wxs = readFileSync(join(root, 'bundle/windows/wix/Product.wxs'), 'utf8');
    const shortcut = wxs.slice(wxs.indexOf('<Shortcut'), wxs.indexOf('/>', wxs.indexOf('<Shortcut')));
    expect(shortcut).toContain('Target="[WindowsFolder]System32\\conhost.exe"');
    expect(shortcut).toContain('Arguments="--headless cmd.exe /c &quot;&quot;[#LauncherCmd]&quot; open-ui&quot;"');
  });

  it('the Finish checkbox action runs headless too — never `start` (it runs a .cmd with cmd /K, keeping a window)', () => {
    const wxs = readFileSync(join(root, 'bundle/windows/wix/Product.wxs'), 'utf8');
    const at = wxs.indexOf('Id="LaunchGatewayAfterInstall"');
    const action = wxs.slice(at, wxs.indexOf('/>', at));
    expect(action).toContain('ExeCommand="conhost.exe --headless cmd.exe /c');
    expect(action).not.toMatch(/\bstart\b/);
  });
});
