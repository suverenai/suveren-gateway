import { useState, useEffect, useCallback } from 'react';

type Theme = 'system' | 'light' | 'dark';

const LS_THEME = 'suveren-theme';
const LS_THEME_LEGACY = 'hap-theme';

function getEffective(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Migrate `hap-theme` → `suveren-theme` once. Runs at module import. */
(function migrateLegacyTheme() {
  const legacy = localStorage.getItem(LS_THEME_LEGACY);
  if (legacy !== null && localStorage.getItem(LS_THEME) === null) {
    localStorage.setItem(LS_THEME, legacy);
  }
  if (legacy !== null) localStorage.removeItem(LS_THEME_LEGACY);
})();

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(LS_THEME);
    return (stored === 'light' || stored === 'dark') ? stored : 'system';
  });

  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() =>
    getEffective(theme)
  );

  // Apply data-theme attribute on <html> element and track effective theme
  useEffect(() => {
    const el = document.documentElement;
    const eff = getEffective(theme);

    // Always set data-theme so CSS [data-theme="dark"] selectors work
    el.setAttribute('data-theme', eff);

    if (theme === 'system') {
      localStorage.removeItem(LS_THEME);
    } else {
      localStorage.setItem(LS_THEME, theme);
    }

    setEffectiveTheme(getEffective(theme));
  }, [theme]);

  // Listen for system changes when in system mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setEffectiveTheme(getEffective('system'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(prev => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  }, []);

  return { theme, effectiveTheme, toggle };
}
