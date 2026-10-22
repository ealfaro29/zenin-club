import { l, getLanguage, productName, colorLabel, formatDate } from './i18n.js?v=40';
import { apiErrorMessage } from './orders-api.js?v=42';

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const COLORS = { 1: '#28282a', 2: '#008b84', 3: '#65518c', 4: '#9b4a4c' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const keyOf = variant => `${variant.productId}:${variant.shirt}:${variant.size}`;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const date = value => { try { return formatDate(value); } catch { return '—'; } };
const isLow = variant => variant.stock > 0 && variant.stock <= variant.lowStockThreshold;
const inventoryError = error => error?.code === 'INVENTORY_CHANGED' ? l('El inventario cambió en otro dispositivo. Revisa los valores actuales antes de guardar de nuevo.', 'Inventory changed on another device. Review the current values before saving again.') : apiErrorMessage(error || {});

/** Inventory is authenticated through the existing admin session; no separate login or local stock. */
export function createAdminInventory({ products = [], shirtHTML, request, onChange: onRender = () => {}, announce = () => {} } = {}) {
  let alive = true;
  let sequence = 0;
  let historySequence = 0;
  const catalog = new Map(products.map(product => [product.id, product]));
  const drafts = new Map();
  const state = { variants: [], meta: null, loaded: false, loading: false, error: '', updatedAt: null, search: '', color: '', size: '', availability: '', productId: '', shirt: 1, reason: '', saving: false, saved: 0, saveTotal: 0, saveError: '', history: null, discardPrompt: false };
  const changed = () => { if (alive) onRender(); };
  const currentMap = () => new Map(state.variants.map(variant => [keyOf(variant), variant]));
  const productFor = id => catalog.get(id) || state.variants.find(variant => variant.productId === id) || { id, name: id, emoji: '' };
  const titleFor = id => productName({ ...productFor(id), id, productId: id });
  const matching = () => {
    const search = normalize(state.search.trim());
    return state.variants.filter(variant => {
      const product = productFor(variant.productId);
      return (!search || normalize(`${variant.productId} ${titleFor(variant.productId)} ${product.name} ${product.emoji}`).includes(search))
        && (!state.color || Number(state.color) === Number(variant.shirt))
        && (!state.size || state.size === variant.size)
        && (state.availability !== 'low' || isLow(variant))
        && (state.availability !== 'out' || variant.stock === 0);
    });
  };
  const selection = () => {
    const matches = matching();
    const ids = [...new Set(matches.map(variant => variant.productId))];
    const editingSelection = [...drafts.keys()].some(key => key.startsWith(`${state.productId}:`)) || document.activeElement?.dataset?.inventoryKey?.startsWith(`${state.productId}:`);
    if (editingSelection && state.productId && !ids.includes(state.productId)) ids.unshift(state.productId);
    if (!ids.includes(state.productId)) { state.productId = ids[0] || ''; state.history = null; historySequence++; }
    if (state.color) state.shirt = Number(state.color);
    else if (!editingSelection && state.productId && !matches.some(variant => variant.productId === state.productId && Number(variant.shirt) === state.shirt)) state.shirt = Number(matches.find(variant => variant.productId === state.productId)?.shirt || 1);
    return { matches, ids };
  };
  const stockStatus = variant => variant.stock === 0 ? `<span class="admin-inventory-badge admin-inventory-badge-out">${l('Agotado', 'Out of stock')}</span>` : isLow(variant) ? `<span class="admin-inventory-badge admin-inventory-badge-low">${l('Stock bajo', 'Low stock')}</span>` : `<span class="admin-inventory-badge">${l('Disponible', 'Available')}</span>`;
  const alertHTML = () => state.error || state.saveError ? `<div class="admin-inventory-alert" role="alert">${esc(state.saveError || state.error)}<button class="admin-text-button" data-inventory-action="refresh">${l('Actualizar datos', 'Refresh data')}</button></div>` : '';
  const movementLabel = kind => ({ seed: l('Stock inicial', 'Initial stock'), initial: l('Stock inicial', 'Initial stock'), legacy_topup: l('Conciliación de pedidos anteriores', 'Legacy order reconciliation'), reserve: l('Reserva de pedido', 'Order reservation'), release: l('Devolución a disponibles', 'Return to available stock'), adjustment: l('Ajuste manual', 'Manual adjustment'), manual: l('Ajuste manual', 'Manual adjustment'), order: l('Reserva de pedido', 'Order reservation'), order_reserved: l('Reserva de pedido', 'Order reservation'), order_placed: l('Reserva de pedido', 'Order reservation'), cancellation: l('Pedido cancelado', 'Order cancelled'), order_cancelled: l('Pedido cancelado', 'Order cancelled'), order_reopened: l('Pedido reabierto', 'Order reopened') })[kind] || l('Movimiento de inventario', 'Inventory movement');
  const reasonLabel = reason => ({ mock_initial_stock: l('Inventario inicial de demostración', 'Initial demo inventory'), legacy_order_reconciliation: l('Conciliación de pedidos anteriores', 'Legacy order reconciliation'), order_created: l('Pedido recibido', 'Order received'), order_reopened: l('Pedido reabierto', 'Order reopened'), order_cancelled: l('Pedido cancelado', 'Order cancelled'), order_removed: l('Pedido eliminado', 'Order removed'), manual_adjustment: l('Ajuste manual', 'Manual adjustment') })[reason] || reason;

  function html() {
    const { matches, ids } = selection();
    const available = state.variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0);
    const low = state.variants.filter(isLow).length;
    const out = state.variants.filter(variant => variant.stock === 0).length;
    const productCount = new Set(state.variants.map(variant => variant.productId)).size;
    return `<section class="admin-inventory" aria-label="${l('Inventario de camisetas', 'Shirt inventory')}"><div class="admin-inventory-overview"><div><span>${l('Unidades disponibles', 'Available units')}</span><strong>${state.loaded ? available.toLocaleString(getLanguage()==='es'?'es-CR':'en-US') : '—'}</strong><small>${l('Stock disponible para vender', 'Stock available to sell')}</small></div><div><span>${l('Productos', 'Products')}</span><strong>${state.loaded ? productCount : '—'}</strong><small>${state.loaded ? state.variants.length : '—'} ${l('combinaciones de color y talla', 'color and size combinations')}</small></div><div><span>${l('Variantes con stock bajo', 'Low-stock variants')}</span><strong class="admin-inventory-low-number">${state.loaded ? low : '—'}</strong><small>${l('Según el umbral de cada talla', 'Based on each size threshold')}</small></div><div><span>${l('Variantes agotadas', 'Out-of-stock variants')}</span><strong class="admin-inventory-out-number">${state.loaded ? out : '—'}</strong><small>${l('Sin unidades disponibles', 'No available units')}</small></div></div><div class="admin-inventory-demo"><span aria-hidden="true">ⓘ</span><p>${l('Inventario de demostración: comienza con 12 unidades disponibles por combinación de camiseta, color y talla. Ajusta estos valores a tu stock real.', 'Demo inventory: starts with 12 available units per shirt, color and size combination. Adjust these values to your actual stock.')}</p></div><section class="admin-panel"><div class="admin-inventory-toolbar"><label class="admin-inventory-search"><span class="admin-sr-only">${l('Buscar producto', 'Search product')}</span><input id="admin-inventory-search" type="search" value="${esc(state.search)}" placeholder="${l('Buscar camiseta o código…', 'Search tee or product code…')}" autocomplete="off"></label><label><span class="admin-sr-only">${l('Filtrar color', 'Filter color')}</span><select data-inventory-filter="color" aria-label="${l('Filtrar color', 'Filter color')}"><option value="">${l('Todos los colores', 'All colors')}</option>${[1, 2, 3, 4].map(shirt => `<option value="${shirt}" ${Number(state.color) === shirt ? 'selected' : ''}>${esc(colorLabel(shirt))}</option>`).join('')}</select></label><label><span class="admin-sr-only">${l('Filtrar talla', 'Filter size')}</span><select data-inventory-filter="size" aria-label="${l('Filtrar talla', 'Filter size')}"><option value="">${l('Todas las tallas', 'All sizes')}</option>${SIZES.map(size => `<option ${state.size === size ? 'selected' : ''}>${size}</option>`).join('')}</select></label><label><span class="admin-sr-only">${l('Filtrar disponibilidad', 'Filter availability')}</span><select data-inventory-filter="availability" aria-label="${l('Filtrar disponibilidad', 'Filter availability')}"><option value="">${l('Todo el inventario', 'All inventory')}</option><option value="low" ${state.availability === 'low' ? 'selected' : ''}>${l('Stock bajo', 'Low stock')}</option><option value="out" ${state.availability === 'out' ? 'selected' : ''}>${l('Agotados', 'Out of stock')}</option></select></label><button class="admin-button admin-button-light" data-inventory-action="refresh" ${state.loading || state.saving ? 'disabled' : ''}>↻ ${l('Actualizar', 'Refresh')}</button></div>${alertHTML()}${state.loading && !state.loaded ? `<div class="admin-empty" role="status"><span class="admin-spinner"></span><h2>${l('Cargando inventario…', 'Loading inventory…')}</h2></div>` : state.loaded && !ids.length ? `<div class="admin-empty"><h2>${l('No hay productos con estos filtros', 'No products match these filters')}</h2><p>${l('Prueba otro nombre, color o estado de disponibilidad.', 'Try another name, color or availability filter.')}</p><button class="admin-button admin-button-light" data-inventory-action="clear-filters">${l('Limpiar filtros', 'Clear filters')}</button></div>` : state.loaded ? `<div class="admin-inventory-workspace"><aside class="admin-inventory-products" aria-label="${l('Productos del inventario', 'Inventory products')}"><div class="admin-inventory-list-caption">${ids.length} ${l('productos', 'products')} · ${matches.length} ${l('variantes', 'variants')}</div>${ids.map(id => { const variants = matches.filter(variant => variant.productId === id); return `<button data-inventory-product="${esc(id)}" class="admin-inventory-product ${state.productId === id ? 'is-selected' : ''}" aria-pressed="${state.productId === id}"><span class="admin-inventory-product-emoji" aria-hidden="true">${esc(productFor(id).emoji || '✳')}</span><span><strong>${esc(titleFor(id))}</strong><small>${esc(id)} · ${variants.length ? `${variants.reduce((sum, variant) => sum + variant.stock, 0)} ${l('disponibles', 'available')}` : l('Selección fuera del filtro', 'Selection outside filter')}</small></span><span aria-hidden="true">›</span></button>`; }).join('')}</aside><div class="admin-inventory-editor">${editorHTML()}</div></div>` : ''}<div class="admin-inventory-savebar"><div><strong class="admin-inventory-unsaved" role="status">${drafts.size ? l('{count} variantes con cambios sin guardar', '{count} variants with unsaved changes', { count: drafts.size }) : l('Todos los cambios guardados', 'All changes saved')}</strong><span>${state.updatedAt ? `${l('Actualizado', 'Updated')}: ${esc(date(state.updatedAt))}` : l('Los valores se sincronizan entre dispositivos.', 'Values sync across devices.')}</span></div><div><button class="admin-button admin-button-light admin-inventory-discard" data-inventory-action="ask-discard" ${!drafts.size || state.saving ? 'disabled' : ''}>${l('Descartar', 'Discard')}</button><button class="admin-button admin-button-primary admin-inventory-save" data-inventory-action="save" ${!drafts.size || state.saving ? 'disabled' : ''}>${state.saving ? l('Guardando {done}/{total}…', 'Saving {done}/{total}…', { done: state.saved, total: state.saveTotal }) : l('Guardar cambios', 'Save changes')}</button></div></div>${state.discardPrompt ? `<div class="admin-inventory-discard-confirm" role="alert"><p>${l('¿Descartar todos los ajustes sin guardar? El inventario guardado no cambiará.', 'Discard all unsaved adjustments? Saved inventory will stay the same.')}</p><button class="admin-button admin-button-light" data-inventory-action="dismiss-discard">${l('Seguir editando', 'Keep editing')}</button><button class="admin-button admin-button-danger" data-inventory-action="confirm-discard">${l('Descartar ajustes', 'Discard adjustments')}</button></div>` : ''}</section><p class="admin-sync-note">${l('Solo se modifica el inventario al guardar. La actualización automática conserva tus ajustes pendientes.', 'Inventory changes only when you save. Auto refresh preserves your pending adjustments.')}</p></section>`;
  }
  function editorHTML() {
    const product = productFor(state.productId);
    const records = currentMap();
    const matchingKeys = new Set(matching().map(keyOf));
    const art = typeof shirtHTML === 'function' ? shirtHTML({ ...product, shirt: state.shirt, colorName: colorLabel(state.shirt), emoji: esc(product.emoji || '') }, 'admin-inventory-shirt') : '';
    return `<div class="admin-inventory-editor-heading"><div class="admin-inventory-art">${art}</div><div><span class="admin-eyebrow">${esc(state.productId)}</span><h2>${esc(titleFor(state.productId))}</h2><p>${l('Edita las unidades disponibles y el umbral de alerta por talla.', 'Edit available units and the low-stock threshold for each size.')}</p></div></div><div class="admin-inventory-colors" role="group" aria-label="${l('Color de la camiseta', 'Shirt color')}">${[1, 2, 3, 4].map(shirt => `<button data-inventory-color="${shirt}" class="${state.shirt === shirt ? 'is-selected' : ''}" aria-pressed="${state.shirt === shirt}" ${state.color && Number(state.color) !== shirt ? 'disabled' : ''}><span style="background:${COLORS[shirt]}" aria-hidden="true"></span>${esc(colorLabel(shirt))}</button>`).join('')}</div><div class="admin-inventory-size-grid">${SIZES.filter(size => !state.size || size === state.size).map(size => {
      const key = keyOf({ productId: state.productId, shirt: state.shirt, size });
      const variant = records.get(key);
      if (!variant) return `<div class="admin-inventory-size-card"><h3>${size}</h3><p>${l('Variante no disponible', 'Variant unavailable')}</p></div>`;
      const draft = drafts.get(key);
      const conflict = draft && Number(draft.version) !== Number(variant.version);
      return `<section class="admin-inventory-size-card ${draft ? 'is-dirty' : ''} ${conflict ? 'has-conflict' : ''} ${!matchingKeys.has(key) ? 'is-outside-filter' : ''}" data-inventory-card="${esc(key)}"><div class="admin-inventory-size-heading"><h3>${size}</h3>${stockStatus(variant)}</div><label for="admin-inventory-stock-${size}">${l('Disponible', 'Available')}</label><input id="admin-inventory-stock-${size}" data-inventory-key="${esc(key)}" data-inventory-field="stock" type="number" inputmode="numeric" min="0" max="999999" step="1" value="${esc(draft?.stock ?? variant.stock)}" ${state.saving ? 'disabled' : ''}><label for="admin-inventory-threshold-${size}">${l('Alerta de stock bajo', 'Low-stock alert')}</label><input id="admin-inventory-threshold-${size}" data-inventory-key="${esc(key)}" data-inventory-field="threshold" type="number" inputmode="numeric" min="0" max="999999" step="1" value="${esc(draft?.threshold ?? variant.lowStockThreshold)}" ${state.saving ? 'disabled' : ''}><small>${l('Se avisa al llegar a esta cantidad.', 'Alerts at or below this quantity.')}</small>${conflict ? `<div class="admin-inventory-conflict" role="alert"><p>${l('Cambió en otro dispositivo. Disponible ahora: {stock}; alerta: {threshold}. Revisa tu ajuste.', 'Changed on another device. Available now: {stock}; alert: {threshold}. Review your adjustment.', { stock: variant.stock, threshold: variant.lowStockThreshold })}</p><button data-inventory-rebase="${esc(key)}">${l('Mantener mi ajuste revisado', 'Keep my reviewed adjustment')}</button><button data-inventory-discard="${esc(key)}">${l('Usar valores actuales', 'Use current values')}</button></div>` : ''}<button class="admin-inventory-history-link" data-inventory-history="${esc(key)}">${l('Ver movimientos', 'View activity')} ↗</button></section>`;
    }).join('')}</div><label class="admin-inventory-reason" for="admin-inventory-reason"><span>${l('Motivo del ajuste', 'Adjustment reason')} <small>${l('(opcional)', '(optional)')}</small></span><input id="admin-inventory-reason" value="${esc(state.reason)}" maxlength="240" placeholder="${l('Ej.: reposición, conteo físico, corrección…', 'For example: restock, physical count, correction…')}" ${state.saving ? 'disabled' : ''}></label>${historyHTML()}`;
  }
  function historyHTML() {
    if (!state.history) return '';
    const history = state.history;
    return `<section class="admin-inventory-history"><div class="admin-inventory-history-heading"><div><span class="admin-eyebrow">${l('AUDITORÍA', 'AUDIT TRAIL')}</span><h3>${l('Movimientos', 'Stock activity')} · ${esc(history.size)} / ${esc(colorLabel(history.shirt))}</h3></div><button data-inventory-action="close-history" aria-label="${l('Cerrar movimientos', 'Close activity')}">×</button></div>${history.loading ? `<p class="admin-inventory-history-empty" role="status">${l('Cargando movimientos…', 'Loading activity…')}</p>` : history.error ? `<p class="admin-inventory-history-empty" role="alert">${esc(history.error)}</p>` : !history.entries.length ? `<p class="admin-inventory-history-empty">${l('No hay movimientos registrados para esta variante.', 'No activity has been recorded for this variant.')}</p>` : `<div class="admin-inventory-history-scroll"><table><thead><tr><th>${l('Fecha', 'Date')}</th><th>${l('Movimiento', 'Activity')}</th><th>${l('Ajuste', 'Change')}</th><th>${l('Disponible', 'Available')}</th></tr></thead><tbody>${history.entries.map(entry => `<tr><td>${esc(date(entry.at))}</td><td><strong>${esc(movementLabel(entry.kind))}</strong>${entry.reason ? `<small>${esc(reasonLabel(entry.reason))}</small>` : ''}${entry.orderId ? `<small>${l('Pedido', 'Order')} ${esc(entry.orderId)}</small>` : ''}</td><td class="${Number(entry.delta) < 0 ? 'admin-inventory-negative' : ''}">${Number(entry.delta) > 0 ? '+' : ''}${esc(entry.delta)}</td><td>${esc(entry.stockAfter)}</td></tr>`).join('')}</tbody></table></div><p class="admin-inventory-history-note">${l('Hasta 50 movimientos recientes de esta variante.', 'Up to 50 recent movements for this variant.')}</p>`}</section>`;
  }
  async function load({ quiet = false } = {}) {
    if (!alive || state.saving) return;
    const current = ++sequence;
    state.loading = true;
    if (!quiet) changed();
    try {
      const data = await request('/admin/inventory');
      if (!alive || current !== sequence) return;
      if (!Array.isArray(data.variants)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      state.variants = data.variants; state.meta = data.meta || null; state.loaded = true;
      state.error = ''; state.updatedAt = new Date().toISOString();
    } catch (error) {
      if (!alive || current !== sequence || error?.code === 'STALE_REQUEST') return;
      state.error = inventoryError(error);
    } finally { if (alive && current === sequence) { state.loading = false; changed(); } }
  }
  async function save() {
    if (!alive || state.saving || !drafts.size) return;
    const records = currentMap();
    const pending = [...drafts.entries()];
    for (const [key, draft] of pending) {
      if (![draft.stock, draft.threshold].every(value => /^\d+$/.test(String(value)) && Number(value) <= 999999)) { state.saveError = l('Usa cantidades enteras entre 0 y 999999.', 'Use whole numbers between 0 and 999999.'); changed(); return; }
      if (Number(records.get(key)?.version) !== Number(draft.version)) { state.saveError = inventoryError({ code: 'INVENTORY_CHANGED' }); changed(); return; }
    }
    const saveRun = ++sequence; state.loading = false; state.saving = true; state.saved = 0; state.saveTotal = pending.length; state.saveError = ''; changed();
    let refreshConflict = false;
    try {
      for (const [key, draft] of pending) {
        if (!alive) return;
        const variant = records.get(key);
        try {
          const data = await request(`/admin/inventory/${encodeURIComponent(variant.productId)}/${variant.shirt}/${encodeURIComponent(variant.size)}`, { method: 'PATCH', body: { stock: Number(draft.stock), lowStockThreshold: Number(draft.threshold), version: Number(draft.version), ...(state.reason.trim() ? { reason: state.reason.trim() } : {}) } });
          if (!alive || saveRun !== sequence) return;
          if (!data.variant || keyOf(data.variant) !== key) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
          const index = state.variants.findIndex(item => keyOf(item) === key);
          if (index >= 0) state.variants[index] = data.variant;
          drafts.delete(key); state.saved++;
          if (state.history?.key === key) state.history.entries = data.variant.history || [];
          changed();
        } catch (error) {
          if (!alive || error?.code === 'STALE_REQUEST') return;
          state.saveError = `${inventoryError(error)} ${state.saved ? l('Se guardaron {count} ajustes; los demás siguen pendientes.', '{count} adjustments were saved; the rest are still pending.', { count: state.saved }) : ''}`;
          refreshConflict = error?.code === 'INVENTORY_CHANGED';
          break;
        }
      }
    } finally {
      if (alive && saveRun === sequence) { state.saving = false; state.updatedAt = new Date().toISOString(); if (!drafts.size) { state.reason = ''; announce(l('Inventario actualizado.', 'Inventory updated.')); } changed(); if (refreshConflict) load({ quiet: true }); }
    }
  }
  async function openHistory(key) {
    const variant = currentMap().get(key); if (!variant) return;
    const current = ++historySequence;
    state.history = { key, size: variant.size, shirt: variant.shirt, entries: [], loading: true, error: '' }; changed();
    try {
      const data = await request(`/admin/inventory/${encodeURIComponent(variant.productId)}/${variant.shirt}/${encodeURIComponent(variant.size)}`);
      if (!alive || current !== historySequence) return;
      state.history.entries = data.history || data.variant?.history || [];
    } catch (error) { if (alive && current === historySequence && error?.code !== 'STALE_REQUEST') state.history.error = inventoryError(error); }
    finally { if (alive && current === historySequence && state.history) { state.history.loading = false; changed(); } }
  }
  function updateDraftControls(target) {
    const scope = target.closest('.admin-inventory'); if (!scope) return;
    const count = scope.querySelector('.admin-inventory-unsaved'); if (count) count.textContent = drafts.size ? l('{count} variantes con cambios sin guardar', '{count} variants with unsaved changes', { count: drafts.size }) : l('Todos los cambios guardados', 'All changes saved');
    for (const button of scope.querySelectorAll('.admin-inventory-save,.admin-inventory-discard')) button.disabled = !drafts.size || state.saving;
    target.closest('[data-inventory-card]')?.classList.toggle('is-dirty', drafts.has(target.dataset.inventoryKey));
  }
  function onInput(event) {
    const target = event.target;
    if (target.id === 'admin-inventory-search') { state.search = target.value; changed(); return true; }
    if (target.id === 'admin-inventory-reason') { state.reason = target.value; return true; }
    const key = target.dataset?.inventoryKey;
    if (!key || !target.dataset.inventoryField) return false;
    const variant = currentMap().get(key); if (!variant || state.saving) return true;
    const draft = drafts.get(key) || { stock: String(variant.stock), threshold: String(variant.lowStockThreshold), version: variant.version };
    draft[target.dataset.inventoryField] = target.value;
    if (Number(draft.stock) === variant.stock && Number(draft.threshold) === variant.lowStockThreshold && draft.stock !== '' && draft.threshold !== '') drafts.delete(key); else drafts.set(key, draft);
    state.saveError = ''; state.discardPrompt = false; updateDraftControls(target); return true;
  }
  function onChange(event) {
    const filter = event.target.dataset?.inventoryFilter; if (!filter) return false;
    state[filter] = event.target.value; state.history = null; historySequence++; changed(); return true;
  }
  function onClick(event) {
    const button = event.target.closest('button'); if (!button) return false;
    if (button.dataset.inventoryProduct) { state.productId = button.dataset.inventoryProduct; state.history = null; historySequence++; changed(); return true; }
    if (button.dataset.inventoryColor) { state.shirt = Number(button.dataset.inventoryColor); state.history = null; historySequence++; changed(); return true; }
    if (button.dataset.inventoryHistory) { openHistory(button.dataset.inventoryHistory); return true; }
    if (button.dataset.inventoryDiscard) { drafts.delete(button.dataset.inventoryDiscard); state.saveError = ''; changed(); return true; }
    if (button.dataset.inventoryRebase) { const key = button.dataset.inventoryRebase; const draft = drafts.get(key); const variant = currentMap().get(key); if (draft && variant) draft.version = variant.version; state.saveError = ''; changed(); return true; }
    switch (button.dataset.inventoryAction) {
      case 'refresh': load(); return true;
      case 'save': save(); return true;
      case 'ask-discard': state.discardPrompt = true; changed(); return true;
      case 'dismiss-discard': state.discardPrompt = false; changed(); return true;
      case 'confirm-discard': drafts.clear(); state.reason = ''; state.saveError = ''; state.discardPrompt = false; changed(); return true;
      case 'clear-filters': state.search = ''; state.color = ''; state.size = ''; state.availability = ''; changed(); return true;
      case 'close-history': state.history = null; historySequence++; changed(); return true;
      default: return false;
    }
  }
  const reset = () => { sequence++; historySequence++; drafts.clear(); state.variants = []; state.loaded = false; state.loading = false; state.saving = false; state.error = ''; state.saveError = ''; state.reason = ''; state.history = null; };
  return { html, load, onClick, onInput, onChange, reset, hasUnsaved: () => drafts.size > 0, isSaving: () => state.saving, cleanup: () => { alive = false; reset(); } };
}
