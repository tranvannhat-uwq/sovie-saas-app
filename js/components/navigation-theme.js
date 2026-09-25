function clearLegacyNavigationPreferences() {
  try {
    ['sovie_nav_layout_v2', 'sovie_nav_color', 'vieone_nav_color'].forEach(key => {
      localStorage.removeItem(key);
    });
  } catch (_) {
    // Removing obsolete preferences must not block navigation setup.
  }
}

export function setupNavigationDropdowns() {
  clearLegacyNavigationPreferences();

  const dropdownItems = [...document.querySelectorAll('.purchase-nav-item, .staff-nav-item')];
  const getTrigger = item => item?.querySelector('.purchase-menu-trigger, .staff-menu-trigger');
  const getMenu = item => item?.querySelector('.purchase-menu, .staff-menu');
  const setMenuOpen = (item, shouldOpen) => {
    if (!item) return;
    const trigger = getTrigger(item);
    const menu = getMenu(item);
    item.classList.toggle('is-open', shouldOpen);
    trigger?.setAttribute('aria-expanded', String(shouldOpen));
    menu?.setAttribute('aria-hidden', String(!shouldOpen));
  };
  const closeNavigationMenus = (exceptItem = null) => {
    dropdownItems.forEach(item => {
      if (item === exceptItem) return;
      setMenuOpen(item, false);
    });
  };

  dropdownItems.forEach(item => {
    const trigger = getTrigger(item);
    const menu = getMenu(item);
    if (!trigger || !menu || trigger.dataset.dropdownReady === 'true') return;
    trigger.dataset.dropdownReady = 'true';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
    trigger.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const shouldOpen = !item.classList.contains('is-open');
      closeNavigationMenus(item);
      setMenuOpen(item, shouldOpen);
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      closeNavigationMenus(item);
      setMenuOpen(item, true);
      menu.querySelector('[data-target]')?.focus();
    });
    menu.querySelectorAll('[data-target]').forEach(link => {
      link.addEventListener('click', () => closeNavigationMenus());
    });
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.purchase-nav-item, .staff-nav-item')) closeNavigationMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const openItem = dropdownItems.find(item => item.classList.contains('is-open'));
    closeNavigationMenus();
    getTrigger(openItem)?.focus();
  });
}
