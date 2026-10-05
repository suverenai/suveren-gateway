import { describe, it, expect } from 'vitest';
import { upgradeCommandFor, updateBannerClass, installerDownloadUrl, MANAGED_UPDATE_HINT, MSI_UPDATE_HINT } from './UpdateBanner';

// Pure logic only (the banner's JSX is presentation). What matters: a managed
// install gets NO command at all — not a different one, none — because the
// employee has no permission to run it (see docs/managed-settings.md). Every
// other install method keeps its existing command untouched.
describe('upgradeCommandFor', () => {
  it('managed: no command (IT, not the employee, owns the upgrade)', () => {
    expect(upgradeCommandFor('managed')).toBeNull();
  });

  it('npm: the existing restart command, unchanged', () => {
    expect(upgradeCommandFor('npm')).toBe('npm install -g @suveren/gateway@latest && suveren-gateway restart');
  });

  it('dev: the existing git pull command, unchanged', () => {
    expect(upgradeCommandFor('dev')).toBe('git pull && pnpm install');
  });

  it('docker: the existing docker command, unchanged', () => {
    expect(upgradeCommandFor('docker')).toContain('docker pull ghcr.io/suverenai/suveren-gateway:latest');
  });
});

describe('MANAGED_UPDATE_HINT', () => {
  it('matches the signed-off mockup copy exactly', () => {
    expect(MANAGED_UPDATE_HINT).toBe("Updates for this gateway come from your company's IT — no action needed here.");
  });

  it('never mentions npm, docker, or a terminal — nothing an employee could try to run', () => {
    const lower = MANAGED_UPDATE_HINT.toLowerCase();
    expect(lower).not.toContain('npm');
    expect(lower).not.toContain('docker');
    expect(lower).not.toContain('terminal');
  });
});

describe('updateBannerClass', () => {
  it('managed: neutral strip (nothing for the employee to do)', () => {
    expect(updateBannerClass('managed')).toBe('update-banner is-managed');
  });

  it('npm, dev, docker: the existing red banner, unchanged', () => {
    for (const m of ['npm', 'dev', 'docker'] as const) {
      expect(updateBannerClass(m)).toBe('update-banner');
    }
  });
});

describe('msi (Windows installer, self-installed)', () => {
  it('has no command — the update is the next installer', () => {
    expect(upgradeCommandFor('msi')).toBeNull();
  });

  it('keeps the red banner (the person has to act), unlike managed', () => {
    expect(updateBannerClass('msi')).toBe('update-banner');
  });

  it('links to the release that carries the new installer', () => {
    expect(installerDownloadUrl('0.13.2')).toBe('https://github.com/suverenai/suveren-gateway/releases/tag/v0.13.2');
    expect(installerDownloadUrl(null)).toBe('https://github.com/suverenai/suveren-gateway/releases/latest');
  });

  it('tells the person what to do and that their data stays', () => {
    expect(MSI_UPDATE_HINT).toBe('Download the new installer and run it. Your settings and mandates stay.');
  });
});
