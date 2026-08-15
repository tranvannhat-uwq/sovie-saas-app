import { DEFAULT_NAV_COLOR, NAV_COLOR_STORAGE_KEY, getNavigationTheme, normalizeNavigationColor } from '../domain/navigation-theme.js';

export function applyNavigationColor(color, { persist = true } = {}) {
  const theme = getNavigationTheme(color);
  const root = document.documentElement;
  root.style.setProperty('--nav-background-color', theme.background);
  root.style.setProperty('--nav-foreground-color', theme.foreground);
  root.style.setProperty('--nav-control-background', theme.controlBackground);
  root.style.setProperty('--nav-active-background', theme.activeBackground);

  const picker = document.getElementById('nav-color-picker');
  if (picker) picker.value = theme.background;
  document.querySelectorAll('.nav-color-swatch').forEach(button => {
    const isSelected = normalizeNavigationColor(button.dataset.navColor) === theme.background;
    button.setAttribute('aria-pressed', String(isSelected));
  });

  if (persist) {
    try {
      localStorage.setItem(NAV_COLOR_STORAGE_KEY, theme.background);
    } catch (_) {
      // Theme persistence must never prevent the application from working.
    }
  }
  return theme.background;
}

export function setupNavigationColorSettings() {
  let savedColor = DEFAULT_NAV_COLOR;
  try {
    savedColor = normalizeNavigationColor(localStorage.getItem(NAV_COLOR_STORAGE_KEY));
  } catch (_) {
    savedColor = DEFAULT_NAV_COLOR;
  }
  applyNavigationColor(savedColor, { persist: false });

  document.querySelectorAll('.nav-color-swatch').forEach(button => {
    button.addEventListener('click', () => applyNavigationColor(button.dataset.navColor));
  });
  document.getElementById('nav-color-picker')?.addEventListener('input', event => {
    applyNavigationColor(event.currentTarget.value);
  });
  document.getElementById('btn-reset-nav-color')?.addEventListener('click', () => {
    applyNavigationColor(DEFAULT_NAV_COLOR);
  });
}
