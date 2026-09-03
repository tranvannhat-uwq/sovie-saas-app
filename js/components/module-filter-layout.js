import { safeCreateIcons } from '../utils.js';

const FILTER_LAYOUT_READY = 'filterLayoutReady';

export const FILTER_LABELS = Object.freeze({
  'product-search-input': 'Tìm kiếm',
  'product-brand-filter': 'Thương hiệu',
  'product-package-filter': 'Loại bao bì',
  'product-status-filter': 'Trạng thái',
  'raw-search-input': 'Tìm kiếm',
  'semi-search-input': 'Tìm kiếm',
  'finished-stock-search-input': 'Tìm kiếm',
  'finished-stock-brand-filter': 'Thương hiệu',
  'history-search-input': 'Tìm kiếm',
  'history-date-mode': 'Thời gian',
  'history-company-filter': 'Công ty',
  'history-brand-filter': 'Thương hiệu',
  'history-status-filter': 'Trạng thái',
  'history-creator-filter': 'Nhân viên lên đơn',
  'customer-search-input': 'Tìm kiếm',
  'customer-managed-filter': 'Nhân viên quản lý',
  'customer-sort-key': 'Sắp xếp theo',
  'customer-sort-nulls': 'Giá trị trống',
  'supplier-search-input': 'Tìm kiếm',
  'price-matrix-product-search': 'Tìm kiếm SKU',
  'pricelist-visible-picker': 'Bảng giá hiển thị',
  'price-matrix-brand-filter': 'Thương hiệu',
  'price-matrix-package-filter': 'Quy cách',
  'price-matrix-group-filter': 'Nhóm sản phẩm',
  'user-search-input': 'Tìm kiếm',
  'activity-search': 'Tìm kiếm',
  'activity-actor-filter': 'Nhân viên',
  'activity-action-filter': 'Hành động',
  'activity-module-filter': 'Phân hệ',
  'activity-start-filter': 'Từ ngày',
  'activity-end-filter': 'Đến ngày',
  'platform-account-search': 'Tìm kiếm',
  'platform-account-status': 'Trạng thái',
  'report-debt-search': 'Tìm kiếm khách hàng',
  'report-return-filter': 'Nhóm dữ liệu'
});

export function createFilterPanel({
  title = 'Bộ lọc',
  subtitle = 'Tinh chỉnh dữ liệu',
  onReset = null,
  bodyContent = null
} = {}) {
  const sidebar = document.createElement('aside');
  sidebar.className = 'module-filter-sidebar';
  sidebar.setAttribute('aria-label', title);
  sidebar.append(createFilterHeading(subtitle, title));

  const chips = document.createElement('div');
  chips.className = 'module-filter-active-chips';
  chips.hidden = true;
  sidebar.append(chips);

  const body = document.createElement('div');
  body.className = 'module-filter-body';
  if (bodyContent) {
    if (Array.isArray(bodyContent)) bodyContent.forEach(item => item && body.append(item));
    else body.append(bodyContent);
  }
  sidebar.append(body);
  sidebar.append(createFilterFooter({ onReset }));
  return sidebar;
}

export function createFilterSection({
  title = '',
  isCollapsible = false,
  defaultOpen = true,
  content = []
} = {}) {
  if (isCollapsible) {
    const details = document.createElement('details');
    details.className = 'module-filter-collapsible customer-filter-compact-group';
    details.open = defaultOpen;

    const summary = document.createElement('summary');
    summary.className = 'module-filter-collapsible-summary customer-filter-compact-summary';
    summary.innerHTML = `<span>${title}</span><span class="module-filter-collapsible-chevron customer-filter-compact-chevron" aria-hidden="true"></span>`;

    const contentBox = document.createElement('div');
    contentBox.className = 'module-filter-collapsible-content customer-filter-compact-fields';
    (Array.isArray(content) ? content : [content]).forEach(node => node && contentBox.append(node));

    details.append(summary, contentBox);
    return details;
  }

  const section = document.createElement('div');
  section.className = 'module-filter-section';
  if (title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'module-filter-section-title';
    titleEl.textContent = title;
    section.append(titleEl);
  }
  (Array.isArray(content) ? content : [content]).forEach(node => node && section.append(node));
  return section;
}

export function createFilterField({
  label = '',
  control = null,
  id = '',
  helpText = ''
} = {}) {
  const field = document.createElement('div');
  field.className = 'module-filter-field';

  if (label) {
    const labelEl = document.createElement('label');
    labelEl.className = 'module-filter-field-label';
    labelEl.textContent = label;
    if (id) labelEl.htmlFor = id;
    field.append(labelEl);
  }
  if (control) field.append(control);
  if (helpText) {
    const help = document.createElement('small');
    help.className = 'module-filter-help-text';
    help.textContent = helpText;
    field.append(help);
  }
  return field;
}

export function createFilterSearch({
  id = '',
  placeholder = 'Tìm kiếm...',
  value = '',
  onInput = null
} = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'search-wrapper module-filter-field';

  const label = document.createElement('label');
  label.className = 'module-filter-field-label';
  label.textContent = 'Tìm kiếm';
  if (id) label.htmlFor = id;
  wrapper.append(label);

  const icon = document.createElement('i');
  icon.dataset.lucide = 'search';
  icon.className = 'search-icon';
  wrapper.append(icon);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-control form-control-search';
  if (id) input.id = id;
  input.placeholder = placeholder;
  input.value = value;
  if (onInput) input.addEventListener('input', onInput);
  wrapper.append(input);

  return wrapper;
}

export function createFilterSelect({
  id = '',
  label = '',
  options = [],
  value = '',
  onChange = null
} = {}) {
  const select = document.createElement('select');
  select.className = 'form-control';
  if (id) select.id = id;

  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = typeof opt === 'object' ? opt.value : opt;
    option.textContent = typeof opt === 'object' ? opt.label : opt;
    if (option.value === value) option.selected = true;
    select.append(option);
  });

  if (onChange) select.addEventListener('change', onChange);
  return createFilterField({ label, control: select, id });
}

export function createFilterCheckboxGroup({
  title = '',
  items = [],
  onChange = null
} = {}) {
  const group = document.createElement('div');
  group.className = 'custom-checkbox-group';

  items.forEach(item => {
    const label = document.createElement('label');
    label.className = 'custom-control';

    const input = document.createElement('input');
    input.type = 'checkbox';
    if (item.id) input.id = item.id;
    if (item.value) input.value = item.value;
    input.checked = Boolean(item.checked);
    if (onChange) input.addEventListener('change', onChange);

    const span = document.createElement('span');
    span.textContent = item.label || '';

    label.append(input, span);
    group.append(label);
  });

  return createFilterSection({ title, content: [group] });
}

export function createFilterRadioGroup({
  title = '',
  name = '',
  items = [],
  value = '',
  asSegmented = false,
  onChange = null
} = {}) {
  const group = document.createElement('div');
  group.className = asSegmented ? 'kiot-pill-group' : 'custom-radio-group';

  items.forEach(item => {
    if (asSegmented) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `kiot-pill-btn ${item.value === value ? 'active' : ''}`;
      button.dataset.value = item.value;
      button.textContent = item.label;
      button.addEventListener('click', () => {
        group.querySelectorAll('.kiot-pill-btn').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        if (onChange) onChange(item.value);
      });
      group.append(button);
    } else {
      const label = document.createElement('label');
      label.className = 'custom-control';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = item.value;
      input.checked = item.value === value;
      if (onChange) input.addEventListener('change', () => onChange(item.value));

      const span = document.createElement('span');
      span.textContent = item.label;

      label.append(input, span);
      group.append(label);
    }
  });

  return createFilterSection({ title, content: [group] });
}

export function createFilterDateRange({
  idPrefix = 'filter-date',
  fromLabel = 'Từ ngày',
  toLabel = 'Đến ngày',
  fromDate = '',
  toDate = '',
  onChange = null
} = {}) {
  const container = document.createElement('div');
  container.className = 'module-filter-range';

  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.className = 'form-control';
  fromInput.id = `${idPrefix}-from`;
  fromInput.value = fromDate;
  fromInput.title = fromLabel;
  if (onChange) fromInput.addEventListener('change', onChange);

  const toInput = document.createElement('input');
  toInput.type = 'date';
  toInput.className = 'form-control';
  toInput.id = `${idPrefix}-to`;
  toInput.value = toDate;
  toInput.title = toLabel;
  if (onChange) toInput.addEventListener('change', onChange);

  container.append(fromInput, toInput);
  return container;
}

export function createFilterNumberRange({
  idPrefix = 'filter-num',
  minPlaceholder = 'Từ',
  maxPlaceholder = 'Đến',
  minVal = '',
  maxVal = '',
  onChange = null
} = {}) {
  const container = document.createElement('div');
  container.className = 'module-filter-range';

  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.className = 'form-control';
  minInput.id = `${idPrefix}-min`;
  minInput.placeholder = minPlaceholder;
  minInput.value = minVal;
  if (onChange) minInput.addEventListener('input', onChange);

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.className = 'form-control';
  maxInput.id = `${idPrefix}-max`;
  maxInput.placeholder = maxPlaceholder;
  maxInput.value = maxVal;
  if (onChange) maxInput.addEventListener('input', onChange);

  container.append(minInput, maxInput);
  return container;
}

export function createFilterHeading(label, title = 'Bộ lọc') {
  const heading = document.createElement('div');
  heading.className = 'module-filter-heading';
  heading.innerHTML = `
    <span class="module-filter-heading-icon"><i data-lucide="sliders-horizontal"></i></span>
    <span class="module-filter-heading-copy"><strong>${title}</strong><small>${label}</small></span>
    <span class="module-filter-count" hidden aria-live="polite">0</span>
    <span class="module-filter-actions">
      <button class="module-filter-reset" type="button" title="Đặt lại bộ lọc" aria-label="Đặt lại bộ lọc"><i data-lucide="rotate-ccw"></i></button>
      <button class="module-filter-toggle" type="button" title="Thu gọn bộ lọc" aria-label="Thu gọn bộ lọc" aria-expanded="true"><i data-lucide="chevron-left"></i></button>
    </span>`;
  return heading;
}

export function createFilterFooter({ onReset = null, onApply = null } = {}) {
  const footer = document.createElement('div');
  footer.className = 'module-filter-footer';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'module-filter-footer-btn module-filter-footer-reset';
  resetBtn.innerHTML = '<i data-lucide="rotate-ccw"></i> Xóa lọc';
  resetBtn.addEventListener('click', () => {
    const sidebar = footer.closest('.module-filter-sidebar');
    if (sidebar) resetFilters(sidebar);
    if (onReset) onReset();
  });

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'module-filter-footer-btn module-filter-footer-apply';
  applyBtn.innerHTML = '<i data-lucide="check"></i> Áp dụng';
  applyBtn.addEventListener('click', () => {
    const sidebar = footer.closest('.module-filter-sidebar');
    if (sidebar) {
      closeMobileDrawer(sidebar);
      const custApply = sidebar.querySelector('#btn-apply-customer-filter-modal');
      if (custApply) custApply.click();
    }
    if (onApply) onApply();
  });

  footer.append(resetBtn, applyBtn);
  return footer;
}

function getFilterControls(sidebar) {
  return [...sidebar.querySelectorAll('.module-filter-body input, .module-filter-body select')]
    .filter(control => {
      const hiddenAncestor = control.closest('[style*="display: none"]');
      return !control.disabled
        && control.type !== 'hidden'
        && !control.closest('[hidden]')
        && (!hiddenAncestor || !sidebar.contains(hiddenAncestor));
    });
}

function rememberFilterDefaults(sidebar) {
  getFilterControls(sidebar).forEach(control => {
    if (control.dataset.filterInitialValue !== undefined) return;
    control.dataset.filterInitialValue = control.value || '';
    if (control.matches('select[multiple]')) {
      control.dataset.filterInitialSelection = JSON.stringify([...control.selectedOptions].map(option => option.value));
    }
    if (control.matches('[type="checkbox"], [type="radio"]')) {
      control.dataset.filterInitialChecked = control.checked ? 'true' : 'false';
    }
  });
  sidebar.querySelectorAll('.module-filter-body .kiot-pill-btn').forEach(button => {
    if (button.dataset.filterInitialActive === undefined) {
      button.dataset.filterInitialActive = button.classList.contains('active') ? 'true' : 'false';
    }
  });
}

function isControlActive(control) {
  if (control.matches('select[multiple]')) {
    const current = JSON.stringify([...control.selectedOptions].map(option => option.value));
    return current !== (control.dataset.filterInitialSelection || '[]');
  }
  if (control.matches('[type="checkbox"], [type="radio"]')) {
    return control.checked !== (control.dataset.filterInitialChecked === 'true');
  }
  return String(control.value || '') !== String(control.dataset.filterInitialValue || '');
}

export function createActiveFilterChips(sidebar) {
  const container = sidebar.querySelector('.module-filter-active-chips');
  if (!container) return;

  container.innerHTML = '';
  const controls = getFilterControls(sidebar);
  const chips = [];
  const handledRadioGroups = new Set();

  controls.forEach(control => {
    if (control.type === 'radio') {
      const groupName = control.name;
      if (!groupName || handledRadioGroups.has(groupName)) return;
      handledRadioGroups.add(groupName);

      const checkedRadio = sidebar.querySelector(`input[type="radio"][name="${groupName}"]:checked`);
      if (checkedRadio && isControlActive(checkedRadio)) {
        const label = checkedRadio.closest('label')?.textContent?.trim() || checkedRadio.value;
        chips.push({
          label: label,
          onRemove: () => {
            const defaultRadio = [...sidebar.querySelectorAll(`input[type="radio"][name="${groupName}"]`)]
              .find(r => r.dataset.filterInitialChecked === 'true');
            if (defaultRadio) {
              defaultRadio.checked = true;
              defaultRadio.dispatchEvent(new Event('change', { bubbles: true }));
            }
            updateFilterCount(sidebar);
          }
        });
      }
      return;
    }

    if (control.type === 'checkbox') {
      if (isControlActive(control)) {
        const labelText = control.closest('label')?.textContent?.trim()
          || control.parentElement?.textContent?.trim()
          || 'Bộ lọc';
        chips.push({
          label: labelText,
          onRemove: () => {
            control.checked = control.dataset.filterInitialChecked === 'true';
            control.dispatchEvent(new Event('change', { bubbles: true }));
            updateFilterCount(sidebar);
          }
        });
      }
      return;
    }

    if (control.tagName === 'SELECT') {
      if (isControlActive(control)) {
        const optText = control.selectedOptions[0]?.textContent?.trim() || control.value;
        const fieldLabel = inferFilterLabel(control);
        chips.push({
          label: `${fieldLabel ? fieldLabel + ': ' : ''}${optText}`,
          onRemove: () => {
            control.value = control.dataset.filterInitialValue || '';
            control.dispatchEvent(new Event('change', { bubbles: true }));
            updateFilterCount(sidebar);
          }
        });
      }
      return;
    }

    if (isControlActive(control) && control.value) {
      const fieldLabel = inferFilterLabel(control);
      chips.push({
        label: `${fieldLabel ? fieldLabel + ': ' : ''}${control.value}`,
        onRemove: () => {
          control.value = control.dataset.filterInitialValue || '';
          control.dispatchEvent(new Event(control.type === 'text' || control.type === 'search' ? 'input' : 'change', { bubbles: true }));
          updateFilterCount(sidebar);
        }
      });
    }
  });

  sidebar.querySelectorAll('.module-filter-body .kiot-pill-btn').forEach(btn => {
    if (btn.classList.contains('active') && btn.dataset.filterInitialActive !== 'true') {
      chips.push({
        label: btn.textContent.trim(),
        onRemove: () => {
          const defaultPill = btn.parentElement?.querySelector('.kiot-pill-btn[data-filter-initial-active="true"]');
          if (defaultPill) defaultPill.click();
          updateFilterCount(sidebar);
        }
      });
    }
  });

  if (chips.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  chips.forEach(chipData => {
    const chip = document.createElement('span');
    chip.className = 'module-filter-active-chip';

    const text = document.createElement('span');
    text.textContent = chipData.label;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'module-filter-active-chip-remove';
    removeBtn.innerHTML = '×';
    removeBtn.title = `Xóa điều kiện ${chipData.label}`;
    removeBtn.setAttribute('aria-label', `Xóa điều kiện ${chipData.label}`);
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chipData.onRemove();
    });

    chip.append(text, removeBtn);
    container.append(chip);
  });
}

function updateFilterCount(sidebar) {
  const controls = getFilterControls(sidebar);
  const radioGroups = new Map();
  controls.filter(control => control.type === 'radio').forEach(control => {
    const key = control.name || control.id;
    if (!radioGroups.has(key)) radioGroups.set(key, []);
    radioGroups.get(key).push(control);
  });
  const changedRadioGroups = [...radioGroups.values()].filter(group => group.some(isControlActive)).length;
  const changedPills = [...sidebar.querySelectorAll('.module-filter-body .kiot-pill-btn')]
    .filter(button => button.classList.contains('active') !== (button.dataset.filterInitialActive === 'true'));
  const count = controls.filter(control => control.type !== 'radio' && isControlActive(control)).length
    + changedRadioGroups
    + (changedPills.length ? 1 : 0);

  const badge = sidebar.querySelector(':scope > .module-filter-heading .module-filter-count');
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
    badge.setAttribute('aria-label', `${count} điều kiện lọc đang bật`);
  }

  const mobileTriggerBadge = sidebar.closest('.module-split-layout')?.querySelector('.module-filter-mobile-trigger .module-filter-count');
  if (mobileTriggerBadge) {
    mobileTriggerBadge.textContent = String(count);
    mobileTriggerBadge.hidden = count === 0;
  }

  sidebar.classList.toggle('has-active-filters', count > 0);
  createActiveFilterChips(sidebar);
}

export function resetFilters(sidebar) {
  const customerReset = sidebar.querySelector('#btn-reset-customer-query');
  if (customerReset) {
    customerReset.click();
    window.setTimeout(() => updateFilterCount(sidebar), 0);
    return;
  }

  getFilterControls(sidebar).forEach(control => {
    if (control.matches('[type="checkbox"], [type="radio"]')) {
      control.checked = control.dataset.filterInitialChecked === 'true';
    } else if (control.matches('select[multiple]')) {
      const selectedValues = new Set(JSON.parse(control.dataset.filterInitialSelection || '[]'));
      [...control.options].forEach(option => { option.selected = selectedValues.has(option.value); });
    } else {
      control.value = control.dataset.filterInitialValue || '';
    }
    const eventName = control.matches('input[type="text"], input[type="search"]') ? 'input' : 'change';
    control.dispatchEvent(new Event(eventName, { bubbles: true }));
  });

  const initialPill = sidebar.querySelector('.module-filter-body .kiot-pill-btn[data-filter-initial-active="true"]');
  if (initialPill && !initialPill.classList.contains('active')) initialPill.click();

  window.setTimeout(() => updateFilterCount(sidebar), 0);
}

function inferFilterLabel(node) {
  const control = node.matches?.('input, select, details') ? node : node.querySelector?.('input, select, details');
  const key = node.id || control?.id || '';
  if (FILTER_LABELS[key]) return FILTER_LABELS[key];
  if (node.classList?.contains('history-status-multi-filter')) return 'Trạng thái';
  if (control?.type === 'date') return control.title || 'Ngày';
  if (control?.type === 'search' || control?.type === 'text') return 'Tìm kiếm';
  if (control?.tagName === 'SELECT') {
    const text = control.options?.[0]?.textContent?.replace(/^\s*--\s*|\s*--\s*$/g, '').trim();
    return text || 'Lựa chọn';
  }
  if (control?.tagName === 'DETAILS') return 'Lựa chọn hiển thị';
  return '';
}

function addFieldLabel(field) {
  if (!field || field.dataset.filterFieldReady === 'true') return;
  const labelText = inferFilterLabel(field);
  if (!labelText) return;

  const control = field.matches?.('input, select, details') ? field : field.querySelector?.('input, select, details');
  const label = document.createElement(field.tagName === 'LABEL' ? 'span' : 'label');
  label.className = 'module-filter-field-label';
  label.textContent = labelText;
  if (control?.id && control.tagName !== 'DETAILS') label.htmlFor = control.id;

  field.classList.add('module-filter-field');
  field.prepend(label);
  field.dataset.filterFieldReady = 'true';
}

function sanitizeFilterStyles(node) {
  if (!node || node.nodeType !== 1) return;
  node.style.removeProperty('width');
  node.style.removeProperty('min-width');
  node.style.removeProperty('max-width');
  node.style.removeProperty('grid-template-columns');
  node.style.removeProperty('flex');

  node.querySelectorAll('*').forEach(el => {
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.classList.contains('search-wrapper') || el.classList.contains('filter-wrapper')) {
      el.style.removeProperty('width');
      el.style.removeProperty('min-width');
      el.style.removeProperty('height');
    }
  });
}

function decorateFilterGroup(group) {
  if (!group || group.dataset.filterFieldsReady === 'true') return;
  if (group.id === 'customer-advanced-filter-panel') {
    group.dataset.filterFieldsReady = 'true';
    return;
  }

  sanitizeFilterStyles(group);

  [...group.children].forEach(child => {
    if (child.matches('button, .customer-sort-label, .module-filter-field-label')) return;
    sanitizeFilterStyles(child);

    if (child.matches('input, select, details')) {
      const wrapper = document.createElement('div');
      child.replaceWith(wrapper);
      wrapper.append(child);
      addFieldLabel(wrapper);
      return;
    }
    if (child.querySelector?.('#history-date-mode')) {
      addFieldLabel(child);
      return;
    }
    if (child.classList?.contains('history-status-multi-filter')) {
      addFieldLabel(child);
      return;
    }
    const nestedControls = child.querySelectorAll?.('input, select, details') || [];
    if (nestedControls.length > 1 && child.tagName !== 'LABEL') {
      decorateFilterGroup(child);
    } else if (nestedControls.length === 1) {
      addFieldLabel(child);
    }
  });
  group.dataset.filterFieldsReady = 'true';
}

function openMobileDrawer(sidebar) {
  sidebar.classList.add('is-mobile-open');
  const backdrop = sidebar.parentElement?.querySelector('.module-filter-backdrop');
  if (backdrop) backdrop.hidden = false;
  document.body.classList.add('module-filter-drawer-open');
}

function closeMobileDrawer(sidebar) {
  sidebar.classList.remove('is-mobile-open');
  const backdrop = sidebar.parentElement?.querySelector('.module-filter-backdrop');
  if (backdrop) backdrop.hidden = true;
  document.body.classList.remove('module-filter-drawer-open');
}

function setupMobileDrawer(layout, sidebar) {
  if (layout.querySelector('.module-filter-backdrop')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'module-filter-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => closeMobileDrawer(sidebar));
  layout.append(backdrop);

  const content = layout.querySelector('.module-filter-content');
  if (content && !content.querySelector('.module-filter-mobile-trigger')) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'btn btn-secondary btn-sm module-filter-mobile-trigger';
    trigger.innerHTML = '<i data-lucide="sliders-horizontal"></i> Bộ lọc <span class="module-filter-count" hidden>0</span>';
    trigger.addEventListener('click', () => openMobileDrawer(sidebar));
    content.prepend(trigger);
  }
}

function setupFilterInteractions(sidebar) {
  const toggle = sidebar.querySelector(':scope > .module-filter-heading .module-filter-toggle');
  const reset = sidebar.querySelector(':scope > .module-filter-heading .module-filter-reset');
  const body = sidebar.querySelector(':scope > .module-filter-body');

  toggle?.addEventListener('click', () => {
    if (sidebar.classList.contains('is-mobile-open')) {
      closeMobileDrawer(sidebar);
      return;
    }
    const collapsed = sidebar.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? 'Mở bộ lọc' : 'Thu gọn bộ lọc');
    toggle.title = collapsed ? 'Mở bộ lọc' : 'Thu gọn bộ lọc';
  });

  reset?.addEventListener('click', () => resetFilters(sidebar));
  body?.addEventListener('input', () => updateFilterCount(sidebar));
  body?.addEventListener('change', () => updateFilterCount(sidebar));
  body?.addEventListener('click', event => {
    if (event.target.closest('.kiot-pill-btn')) window.setTimeout(() => updateFilterCount(sidebar), 0);
  });

  rememberFilterDefaults(sidebar);
  updateFilterCount(sidebar);
}

export function setupSplitSurface({ root, filterSelectors, label = 'Tinh chỉnh dữ liệu hiển thị', title = 'Bộ lọc' }) {
  if (!root || root.dataset[FILTER_LAYOUT_READY] === 'true') return;
  const filterNodes = filterSelectors
    .map(selector => root.querySelector(selector))
    .filter((node, index, nodes) => node && nodes.indexOf(node) === index);
  if (filterNodes.length === 0) return;

  const preservedHeaders = new Set([...root.children].filter(child => child.classList.contains('panel-header')));
  const layout = document.createElement('div');
  layout.className = 'module-split-layout';

  const sidebar = document.createElement('aside');
  sidebar.className = 'module-filter-sidebar';
  sidebar.setAttribute('aria-label', title);
  sidebar.append(createFilterHeading(label, title));

  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'module-filter-active-chips';
  chipsContainer.hidden = true;
  sidebar.append(chipsContainer);

  const filterBody = document.createElement('div');
  filterBody.className = 'module-filter-body';
  filterNodes.forEach(node => {
    decorateFilterGroup(node);
    filterBody.append(node);
  });
  sidebar.append(filterBody);

  const footer = createFilterFooter();
  sidebar.append(footer);

  const content = document.createElement('div');
  content.className = 'module-filter-content';

  [...root.children].forEach(child => {
    if (!preservedHeaders.has(child) && child !== layout && child !== sidebar && child !== content) content.append(child);
  });

  layout.append(sidebar, content);
  root.append(layout);
  root.dataset[FILTER_LAYOUT_READY] = 'true';

  setupMobileDrawer(layout, sidebar);
  setupFilterInteractions(sidebar);
  safeCreateIcons();
}

function setupPanelSurface(panelId, filterSelectors, label, title) {
  const panel = document.getElementById(panelId);
  const root = panel?.querySelector(':scope > .glass-panel');
  setupSplitSurface({ root, filterSelectors, label, title });
}

export function setupCompactCustomerFilterGroups(filterPanel) {
  const body = filterPanel?.querySelector('.customer-filter-modal-body');
  if (!body || body.dataset.compactGroupsReady === 'true') return;

  [...body.querySelectorAll(':scope > .customer-filter-section')].forEach((section, index) => {
    const title = section.querySelector(':scope > strong');
    if (!title) return;

    const group = document.createElement('details');
    group.className = `customer-filter-section customer-filter-compact-group module-filter-collapsible${section.classList.contains('customer-filter-span-2') ? ' customer-filter-span-2' : ''}`;
    const summary = document.createElement('summary');
    summary.className = 'customer-filter-compact-summary module-filter-collapsible-summary';
    summary.innerHTML = `<span>${title.textContent.trim()}</span><span class="customer-filter-compact-chevron module-filter-collapsible-chevron" aria-hidden="true"></span>`;
    const fields = document.createElement('div');
    fields.className = 'customer-filter-compact-fields module-filter-collapsible-content';

    [...section.children].forEach(child => {
      if (child !== title) fields.append(child);
    });
    group.append(summary, fields);
    group.open = index === 0;
    section.replaceWith(group);
  });

  body.dataset.compactGroupsReady = 'true';
}

function setupCustomerSurface() {
  const panel = document.getElementById('customers-panel');
  const root = panel?.querySelector(':scope > .glass-panel');
  const advancedFilter = document.getElementById('customer-advanced-filter-panel');
  const queryToolbar = root?.querySelector('.customer-query-toolbar');
  const sortToolbar = root?.querySelector('.customer-sort-toolbar');

  if (queryToolbar && !queryToolbar.dataset.customerCleaned) {
    queryToolbar.dataset.customerCleaned = 'true';
    queryToolbar.dataset.filterFieldsReady = 'true';
    sanitizeFilterStyles(queryToolbar);

    const searchWrap = queryToolbar.querySelector('.search-wrapper');
    if (searchWrap) {
      sanitizeFilterStyles(searchWrap);
      const searchLbl = document.createElement('label');
      searchLbl.className = 'module-filter-field-label';
      searchLbl.textContent = 'Tìm kiếm';
      searchLbl.htmlFor = 'customer-search-input';
      searchWrap.before(searchLbl);
    }

    const managerWrap = queryToolbar.querySelector('.customer-legacy-manager-filter');
    if (managerWrap) {
      sanitizeFilterStyles(managerWrap);
      const mgrLbl = document.createElement('label');
      mgrLbl.className = 'module-filter-field-label';
      mgrLbl.textContent = 'Nhân viên quản lý';
      mgrLbl.htmlFor = 'customer-managed-filter';
      managerWrap.before(mgrLbl);
    }
  }

  if (sortToolbar && !sortToolbar.dataset.customerCleaned) {
    sortToolbar.dataset.customerCleaned = 'true';
    sortToolbar.dataset.filterFieldsReady = 'true';
    sanitizeFilterStyles(sortToolbar);

    const nullSelect = sortToolbar.querySelector('#customer-sort-nulls');
    const dirBtn = sortToolbar.querySelector('#btn-customer-sort-direction');
    if (nullSelect && dirBtn && !sortToolbar.querySelector('.customer-sort-toolbar-row')) {
      const row = document.createElement('div');
      row.className = 'customer-sort-toolbar-row';
      nullSelect.before(row);
      row.append(nullSelect, dirBtn);
    }
  }

  setupSplitSurface({
    root,
    filterSelectors: [
      '.customer-query-toolbar',
      '.customer-sort-toolbar',
      '#customer-advanced-filter-panel'
    ],
    label: 'Khách hàng và phân loại',
    title: 'Bộ lọc'
  });
  setupCompactCustomerFilterGroups(advancedFilter);
  document.getElementById('customer-filter-drawer-backdrop')?.setAttribute('hidden', '');
}

export function setupStandaloneSidebar(selector, label) {
  const sidebar = document.querySelector(selector);
  if (!sidebar || sidebar.dataset[FILTER_LAYOUT_READY] === 'true') return;
  sidebar.classList.add('module-filter-sidebar', 'module-filter-sidebar-standalone');

  const heading = createFilterHeading(label, 'Bộ lọc');
  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'module-filter-active-chips';
  chipsContainer.hidden = true;

  const body = document.createElement('div');
  body.className = 'module-filter-body';
  [...sidebar.children].forEach(child => {
    sanitizeFilterStyles(child);
    body.append(child);
  });

  const footer = createFilterFooter();

  sidebar.append(heading, chipsContainer, body, footer);
  sidebar.dataset[FILTER_LAYOUT_READY] = 'true';
  setupFilterInteractions(sidebar);
  safeCreateIcons();
}

function setupReportSurfaces() {
  setupSplitSurface({
    root: document.getElementById('report-subtab-debt'),
    filterSelectors: ['.report-debt-filter-row'],
    label: 'Báo cáo công nợ',
    title: 'Bộ lọc'
  });
  setupSplitSurface({
    root: document.getElementById('report-subtab-returns'),
    filterSelectors: ['.report-return-filter-row'],
    label: 'Báo cáo trả hàng',
    title: 'Bộ lọc'
  });
}

function setupPlatformAdminSurface() {
  const panel = document.getElementById('platform-admin-panel');
  const root = panel?.querySelector('.platform-accounts-card');
  setupSplitSurface({
    root,
    filterSelectors: ['.platform-account-filters'],
    label: 'Danh sách doanh nghiệp SaaS',
    title: 'Bộ lọc'
  });
}

function setupGoodsSurfaces() {
  [
    ['inv-raw-tab', 'Nguyên liệu'],
    ['inv-semi-tab', 'Bán thành phẩm'],
    ['inv-finished-tab', 'Thành phẩm']
  ].forEach(([tabId, label]) => {
    const root = document.getElementById(tabId)?.querySelector(':scope > .glass-panel');
    setupSplitSurface({ root, filterSelectors: ['.controls-row'], label, title: 'Bộ lọc' });
  });
}

export function setupModuleFilterLayouts() {
  setupPanelSurface('products-panel', ['.controls-row'], 'Danh sách sản phẩm', 'Bộ lọc');
  setupPanelSurface('history-panel', ['.controls-row'], 'Lịch sử đơn hàng', 'Bộ lọc');
  setupCustomerSurface();
  setupPanelSurface('suppliers-panel', ['.controls-row'], 'Danh sách nhà cung cấp', 'Bộ lọc');
  setupPanelSurface('pricelists-panel', ['.controls-row'], 'Ma trận bảng giá', 'Bộ lọc');
  setupPanelSurface('users-panel', ['.controls-row'], 'Thành viên và nhân sự', 'Bộ lọc');
  setupPanelSurface('activity-log-panel', ['.activity-filters'], 'Nhật ký hoạt động', 'Bộ lọc');
  setupPlatformAdminSurface();
  setupReportSurfaces();
  setupGoodsSurfaces();
  setupStandaloneSidebar('#so-quy-panel .so-quy-sidebar', 'Giao dịch thu chi');
}
