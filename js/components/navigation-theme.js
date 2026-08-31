import {
  DEFAULT_NAV_COLOR,
  DEFAULT_NAV_LAYOUT,
  LEGACY_NAV_COLOR_STORAGE_KEY,
  NAV_COLOR_STORAGE_KEY,
  NAV_LAYOUT_STORAGE_KEY,
  getNavigationTheme,
  normalizeNavigationColor,
  normalizeNavigationLayout
} from '../domain/navigation-theme.js';

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
      localStorage.removeItem(LEGACY_NAV_COLOR_STORAGE_KEY);
    } catch (_) {
      // Theme persistence must never prevent the application from working.
    }
  }
  return theme.background;
}

export function applyNavigationLayout(layout, { persist = true } = {}) {
  const normalizedLayout = normalizeNavigationLayout(layout);
  const appLayout = document.getElementById('app-layout');
  if (appLayout) appLayout.dataset.navLayout = normalizedLayout;

  document.querySelectorAll('.nav-layout-option').forEach(button => {
    const isSelected = button.dataset.navLayout === normalizedLayout;
    button.classList.toggle('active', isSelected);
    button.setAttribute('aria-pressed', String(isSelected));
  });

  if (persist) {
    try {
      localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, normalizedLayout);
    } catch (_) {
      // Layout persistence must never prevent the application from working.
    }
  }
  return normalizedLayout;
}

export function setupNavigationColorSettings() {
  let savedColor = DEFAULT_NAV_COLOR;
  let savedLayout = DEFAULT_NAV_LAYOUT;
  try {
    const currentColor = localStorage.getItem(NAV_COLOR_STORAGE_KEY);
    const legacyColor = localStorage.getItem(LEGACY_NAV_COLOR_STORAGE_KEY);
    savedColor = currentColor
      ? normalizeNavigationColor(currentColor)
      : legacyColor && normalizeNavigationColor(legacyColor) !== '#0b70e1'
        ? normalizeNavigationColor(legacyColor)
        : DEFAULT_NAV_COLOR;
    savedLayout = normalizeNavigationLayout(localStorage.getItem(NAV_LAYOUT_STORAGE_KEY));
  } catch (_) {
    savedColor = DEFAULT_NAV_COLOR;
    savedLayout = DEFAULT_NAV_LAYOUT;
  }
  applyNavigationColor(savedColor, { persist: false });
  applyNavigationLayout(savedLayout, { persist: false });

  document.querySelectorAll('.nav-color-swatch').forEach(button => {
    button.addEventListener('click', () => applyNavigationColor(button.dataset.navColor));
  });
  document.getElementById('nav-color-picker')?.addEventListener('input', event => {
    applyNavigationColor(event.currentTarget.value);
  });
  document.getElementById('btn-reset-nav-color')?.addEventListener('click', () => {
    applyNavigationColor(DEFAULT_NAV_COLOR);
  });
  document.querySelectorAll('.nav-layout-option').forEach(button => {
    button.addEventListener('click', () => applyNavigationLayout(button.dataset.navLayout));
  });
}

export function setupNavigationDropdowns() {
  const dropdownItems = [...document.querySelectorAll('.purchase-nav-item, .staff-nav-item')];
  const closeNavigationMenus = (exceptItem = null) => {
    dropdownItems.forEach(item => {
      if (item === exceptItem) return;
      item.classList.remove('is-open');
      item.querySelector(':scope > .nav-link')?.setAttribute('aria-expanded', 'false');
    });
  };

  dropdownItems.forEach(item => {
    const trigger = item.querySelector(':scope > .nav-link');
    const menu = item.querySelector(':scope > .purchase-menu, :scope > .staff-menu');
    if (!trigger || !menu || trigger.dataset.dropdownReady === 'true') return;
    trigger.dataset.dropdownReady = 'true';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const shouldOpen = !item.classList.contains('is-open');
      closeNavigationMenus(item);
      item.classList.toggle('is-open', shouldOpen);
      trigger.setAttribute('aria-expanded', String(shouldOpen));
    });
    menu.querySelectorAll('[data-target]').forEach(link => {
      link.addEventListener('click', () => closeNavigationMenus());
    });
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.purchase-nav-item, .staff-nav-item')) closeNavigationMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNavigationMenus();
  });
}
