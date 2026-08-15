export const NAV_COLOR_STORAGE_KEY = 'vieone_nav_color';
export const DEFAULT_NAV_COLOR = '#22c55e';

export function normalizeNavigationColor(value, fallback = DEFAULT_NAV_COLOR) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color.slice(1).split('').map(char => char + char).join('')}`.toLowerCase();
  }
  return fallback;
}

export function getNavigationTheme(value) {
  const background = normalizeNavigationColor(value);
  const red = Number.parseInt(background.slice(1, 3), 16);
  const green = Number.parseInt(background.slice(3, 5), 16);
  const blue = Number.parseInt(background.slice(5, 7), 16);
  const perceivedBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  const usesDarkForeground = perceivedBrightness >= 170;

  return {
    background,
    foreground: usesDarkForeground ? '#0f172a' : '#ffffff',
    controlBackground: usesDarkForeground ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.15)',
    activeBackground: usesDarkForeground ? 'rgba(15, 23, 42, 0.18)' : 'rgba(0, 0, 0, 0.15)'
  };
}
