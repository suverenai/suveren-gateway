import { useTheme } from '../hooks/useTheme';

const THEME_ICONS: Record<string, string> = { system: '◑', light: '☀', dark: '☾' };

/** The gateway's theme switch (system, day, dark): one button, `.theme-toggle`. Shared with the phone app. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={`Theme: ${theme}`}>
      {THEME_ICONS[theme]}
    </button>
  );
}
