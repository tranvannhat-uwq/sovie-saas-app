import { renderPurchasesPanel } from './purchases.js';

// The navigation entry now owns the purchase screen. Keep this adapter so the
// app router can retain its existing goods-panel route without inventory UI.
export function renderGoodsPanel() {
  const panel = document.getElementById('goods-panel');
  if (!panel || !panel.classList.contains('active')) return;

  renderPurchasesPanel(panel);
}
