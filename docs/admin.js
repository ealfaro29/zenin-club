import { l, getLanguage, formatMoney, formatDate, statusLabel, productName, colorLabel } from './i18n.js?v=40';
import { apiRequest, apiErrorMessage } from './orders-api.js?v=42';
import { createAdminInventory } from './admin-inventory.js?v=42';

const SESSION_KEY = 'zenin-admin-session-v1';
const STATUSES = ['new', 'preparing', 'ready', 'shipped', 'cancelled'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const expiration = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
const date = value => { try { return formatDate(value); } catch { return '—'; } };
const amount = value => formatMoney(Number(value) || 0);
const statusPill = value => `<span class="admin-status admin-status-${STATUSES.includes(value) ? value : 'new'}">${esc(statusLabel(value))}</span>`;
const countryName = value => { try { return new Intl.DisplayNames([getLanguage()], { type: 'region' }).of(value) || value; } catch { return value; } };

/** Server-backed orders administration. The server owns credential and token validation. */
export function mountAdmin({ container, shirtHTML, toast, products = [], section } = {}) {
  if (!container) throw new Error('The admin container is required.');
  let alive = true;
  let inventory;
  let pendingHref = '';
  const activeTab = section === 'inventory' ? 'inventory' : 'orders';
  let token = '';
  let expiresAt = 0;
  let listSequence = 0;
  let detailSequence = 0;
  let mutationSequence = 0;
  let searchTimer;
  const objectUrls = new Set();
  const state = {
    orders: [], total: 0, page: 1, limit: 50, status: '', search: '',
    listLoading: false, detailLoading: false, listError: '', detailError: '',
    loginBusy: false, loginError: '', loginNotice: '', actionBusy: '', actionError: '',
    selectedId: null, order: null, updatedAt: null, cancelConfirm: false,
    notes: '', notesDirty: false, carrier: '', trackingNumber: '', trackingDirty: false,
    statusDraft: 'new', statusDirty: false,
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (saved?.token && expiration(saved.expiresAt) > Date.now()) {
      token = saved.token;
      expiresAt = expiration(saved.expiresAt);
    } else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* The current visit still works if browser storage is unavailable. */ }

  const announce = message => { if (typeof toast === 'function') toast(message); };
  const clearAuth = (expired = false) => {
    token = ''; expiresAt = 0; listSequence++; detailSequence++; mutationSequence++;
    inventory?.reset(); pendingHref = '';
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* No persistent session to clear. */ }
    state.orders = []; state.total = 0; state.selectedId = null; state.order = null;
    state.actionBusy = ''; state.loginBusy = false; state.loginError = '';
    state.loginNotice = expired ? l('Tu sesión venció. Inicia sesión de nuevo.', 'Your session expired. Please sign in again.') : '';
    render();
  };
  const isUnauthorized = error => error?.status === 401 || error?.status === 403;
  const errorText = error => apiErrorMessage(error || {});
  const headerHTML = () => `<header class="admin-header"><div><span class="admin-eyebrow">ZENIN CLUB / ADMIN</span><h1>${activeTab === 'inventory' ? l('Inventario', 'Inventory') : l('Pedidos', 'Orders')}</h1><p>${activeTab === 'inventory' ? l('Disponibilidad por camiseta, color y talla. Sincronizada entre dispositivos.', 'Availability by shirt, color and size. Synced across devices.') : l('Una sola bandeja para todos tus dispositivos.', 'One order inbox across all your devices.')}</p></div><div class="admin-header-actions"><a class="admin-button admin-button-light" href="#shop">${l('Ver tienda', 'View store')} <span aria-hidden="true">↗</span></a><button class="admin-button admin-button-light" data-admin-action="logout">${l('Cerrar sesión', 'Sign out')}</button></div></header><nav class="admin-tabs" aria-label="${l('Secciones de administración', 'Admin sections')}"><a href="#admin" data-admin-tab="orders" class="${activeTab === 'orders' ? 'is-active' : ''}" ${activeTab === 'orders' ? 'aria-current="page"' : ''}>${l('Pedidos', 'Orders')}</a><a href="#admin/inventory" data-admin-tab="inventory" class="${activeTab === 'inventory' ? 'is-active' : ''}" ${activeTab === 'inventory' ? 'aria-current="page"' : ''}>${l('Inventario', 'Inventory')}</a></nav>${pendingHref ? `<div class="admin-leave-confirm" role="alert"><p>${l('Hay cambios sin guardar. ¿Descartarlos y cambiar de sección?', 'You have unsaved changes. Discard them and switch sections?')}</p><button class="admin-button admin-button-light" data-admin-action="stay-tab">${l('Seguir editando', 'Keep editing')}</button><button class="admin-button admin-button-danger" data-admin-action="leave-tab">${l('Descartar y continuar', 'Discard and continue')}</button></div>` : ''}`;
  const errorHTML = (message, retry) => message ? `<div class="admin-alert" role="alert"><span>${esc(message)}</span>${retry ? `<button class="admin-text-button" data-admin-action="${retry}">${l('Reintentar', 'Try again')}</button>` : ''}</div>` : '';
  const loginHTML = () => `<section class="admin-root admin-login"><div class="admin-login-card"><a href="#" aria-label="Zenin Club"><img class="admin-login-logo" src="assets/zenin-logo-transparent.png" alt="Zenin Club" width="80" height="77"></a><span class="admin-eyebrow">ZENIN CLUB / ADMIN</span><h1>${l('Bienvenido de vuelta', 'Welcome back')}</h1><p>${l('Inicia sesión para administrar los pedidos de la tienda.', 'Sign in to manage your store orders.')}</p>${state.loginNotice ? `<p class="admin-notice" role="status">${esc(state.loginNotice)}</p>` : ''}${errorHTML(state.loginError)}<form id="admin-login-form" class="admin-form"><label for="admin-username">${l('Usuario', 'Username')}</label><input id="admin-username" name="username" value="Admin" autocomplete="username" autocapitalize="none" spellcheck="false" required ${state.loginBusy ? 'disabled' : ''}><label for="admin-password">${l('Contraseña', 'Password')}</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required ${state.loginBusy ? 'disabled' : ''}><button class="admin-button admin-button-primary" type="submit" ${state.loginBusy ? 'disabled' : ''}>${state.loginBusy ? l('Iniciando sesión…', 'Signing in…') : l('Iniciar sesión', 'Sign in')} <span aria-hidden="true">→</span></button></form><a class="admin-login-back" href="#">← ${l('Volver a la tienda', 'Back to the store')}</a></div></section>`;
  const listHTML = () => {
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    return `${headerHTML()}<section class="admin-panel"><div class="admin-toolbar"><form id="admin-search-form" class="admin-search"><label class="admin-sr-only" for="admin-search">${l('Buscar por pedido, nombre o correo', 'Search order, name or email')}</label><input id="admin-search" name="search" type="search" value="${esc(state.search)}" placeholder="${l('Buscar pedido, nombre o correo…', 'Search order, name or email…')}" autocomplete="off"><button type="submit" aria-label="${l('Buscar pedidos', 'Search orders')}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></svg></button></form><label class="admin-status-filter" for="admin-status-filter"><span class="admin-sr-only">${l('Filtrar por estado', 'Filter by status')}</span><select id="admin-status-filter"><option value="">${l('Todos los estados', 'All statuses')}</option>${STATUSES.map(status => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${esc(statusLabel(status))}</option>`).join('')}</select></label><button class="admin-button admin-button-light" data-admin-action="refresh" ${state.listLoading ? 'disabled' : ''}>↻ ${l('Actualizar', 'Refresh')}</button><button class="admin-button admin-button-light" data-admin-action="export" ${!state.orders.length || state.listLoading ? 'disabled' : ''}>↓ ${l('CSV de esta página', 'CSV of this page')}</button></div><div class="admin-list-meta"><strong>${state.total} ${state.total === 1 ? l('pedido', 'order') : l('pedidos', 'orders')}${state.search || state.status ? ` ${l('en este filtro', 'matching this filter')}` : ''}</strong><span>${l('Más recientes primero', 'Newest first')} · ${l('Actualización automática: 30 s', 'Auto refresh: 30 s')}</span></div>${errorHTML(state.listError, 'refresh')}${state.listLoading ? `<div class="admin-empty" role="status"><span class="admin-spinner"></span><h2>${l('Cargando pedidos…', 'Loading orders…')}</h2></div>` : state.orders.length ? `<div class="admin-table-wrap"><table class="admin-orders-table"><thead><tr><th>${l('Pedido', 'Order')}</th><th>${l('Cliente', 'Customer')}</th><th>${l('Fecha', 'Date')}</th><th>Total</th><th>${l('Estado', 'Status')}</th><th><span class="admin-sr-only">${l('Abrir', 'Open')}</span></th></tr></thead><tbody>${state.orders.map(order => `<tr><td data-label="${l('Pedido', 'Order')}"><button class="admin-order-open" data-admin-order="${esc(order.id)}">${esc(order.id)}</button><small>${(order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)} ${l('artículos', 'items')}</small></td><td data-label="${l('Cliente', 'Customer')}"><strong>${esc(order.customer?.name || '—')}</strong><small>${esc(order.customer?.email || '')}</small></td><td data-label="${l('Fecha', 'Date')}">${esc(date(order.createdAt))}</td><td data-label="Total" class="admin-table-total">${amount(order.totals?.total)}</td><td data-label="${l('Estado', 'Status')}">${statusPill(order.status)}</td><td><button class="admin-open-arrow" data-admin-order="${esc(order.id)}" aria-label="${l('Abrir pedido', 'Open order')} ${esc(order.id)}">↗</button></td></tr>`).join('')}</tbody></table></div>` : !state.listError ? `<div class="admin-empty"><span class="admin-empty-mark" aria-hidden="true">↗</span><h2>${state.search || state.status ? l('No hay coincidencias', 'No matching orders') : l('Aquí llegan los próximos pedidos', 'Your next orders arrive here')}</h2><p>${state.search || state.status ? l('Prueba otro nombre o estado.', 'Try another name or status.') : l('Los pedidos de la tienda aparecerán en esta bandeja.', 'Store orders will appear in this inbox.')}</p>${state.search || state.status ? `<button class="admin-button admin-button-light" data-admin-action="clear-filters">${l('Limpiar filtros', 'Clear filters')}</button>` : ''}</div>` : ''}<footer class="admin-panel-footer"><span>${state.orders.length ? `${(state.page - 1) * state.limit + 1}–${Math.min(state.page * state.limit, state.total)} ${l('de', 'of')} ${state.total}` : '0'}</span><div class="admin-pagination"><button class="admin-button admin-button-light" data-admin-action="previous" ${state.page <= 1 || state.listLoading ? 'disabled' : ''}>← ${l('Anterior', 'Previous')}</button><span>${state.page} / ${pages}</span><button class="admin-button admin-button-light" data-admin-action="next" ${state.page >= pages || state.listLoading ? 'disabled' : ''}>${l('Siguiente', 'Next')} →</button></div></footer></section><p class="admin-sync-note" role="status">${state.updatedAt ? `${l('Última actualización', 'Last refreshed')}: ${esc(date(state.updatedAt))}` : ''}</p>`;
  };
  const itemArt = item => {
    const shirt = [1, 2, 3, 4].includes(Number(item.shirt)) ? Number(item.shirt) : 1;
    return typeof shirtHTML === 'function' ? shirtHTML({ ...item, shirt, name: productName(item), colorName: colorLabel(item.shirt || item.colorName), emoji: esc(item.emoji || ''), printLine: '' }, 'admin-item-shirt') : `<img src="assets/shirt-${shirt}.webp" alt="${esc(item.name)}" width="100" height="100">`;
  };
  const detailHTML = () => {
    const order = state.order;
    const disabled = state.actionBusy ? 'disabled' : '';
    if (!order) return `${headerHTML()}<button class="admin-back" data-admin-action="back">← ${l('Todos los pedidos', 'All orders')}</button>${errorHTML(state.detailError, 'refresh')}<section class="admin-panel admin-empty" role="status">${state.detailLoading ? `<span class="admin-spinner"></span><h2>${l('Cargando pedido…', 'Loading order…')}</h2>` : `<h2>${l('No pudimos cargar este pedido', 'We could not load this order')}</h2>`}</section>`;
    const customer = order.customer || {};
    const totals = order.totals || {};
    return `${headerHTML()}<div class="admin-detail-top"><button class="admin-back" data-admin-action="back">← ${l('Todos los pedidos', 'All orders')}</button><div class="admin-detail-actions"><button class="admin-button admin-button-light" data-admin-action="refresh" ${disabled}>↻ ${l('Actualizar', 'Refresh')}</button><button class="admin-button admin-button-light" data-admin-action="print">${l('Imprimir alistamiento', 'Print packing slip')} ↗</button></div></div><div class="admin-order-heading"><div><span class="admin-eyebrow">${l('PEDIDO', 'ORDER')}</span><h2>${esc(order.id)}</h2><p>${esc(date(order.createdAt))}</p></div>${statusPill(order.status)}</div>${errorHTML(state.detailError, 'refresh')}${errorHTML(state.actionError)}<div class="admin-detail-grid"><div class="admin-detail-main"><section class="admin-panel"><div class="admin-card-heading"><h3>${l('Artículos', 'Items')}</h3><span>${(order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)} ${l('unidades', 'units')}</span></div><div class="admin-items">${(order.items || []).map(item => `<article class="admin-item"><div class="admin-item-art">${itemArt(item)}</div><div class="admin-item-description"><h4>${esc(productName(item))}</h4><p>${esc(colorLabel(item.shirt || item.colorName))} / ${l('Talla', 'Size')} ${esc(item.size)}</p><small>${amount(item.unitPrice)} × ${esc(item.quantity)}</small></div><strong>${amount(Number(item.unitPrice) * Number(item.quantity))}</strong></article>`).join('')}</div><div class="admin-totals"><div><span>Subtotal</span><span>${amount(totals.subtotal)}</span></div>${Number(totals.discount) ? `<div><span>${l('Descuento', 'Discount')}${order.discountCode ? ` · ${esc(order.discountCode)}` : ''}</span><span>−${amount(totals.discount)}</span></div>` : ''}<div><span>${l('Envío', 'Shipping')}</span><span>${Number(totals.shipping) ? amount(totals.shipping) : l('Gratis', 'Free')}</span></div><div class="admin-total"><strong>Total</strong><strong>${amount(totals.total)} <small>USD</small></strong></div></div></section><section class="admin-panel"><div class="admin-card-heading"><h3>${l('Notas internas', 'Internal notes')}</h3><span>${state.notesDirty ? l('Sin guardar', 'Unsaved') : ''}</span></div><form id="admin-notes-form" class="admin-section-form"><label class="admin-sr-only" for="admin-notes">${l('Notas internas', 'Internal notes')}</label><textarea id="admin-notes" name="notes" ${disabled} rows="4" maxlength="5000" placeholder="${l('Instrucciones de preparación o notas para tu equipo…', 'Packing instructions or notes for your team…')}">${esc(state.notes)}</textarea><div class="admin-form-footer"><span>${l('Estas notas solo aparecen en administración.', 'These notes are only visible in admin.')}</span><button class="admin-button admin-button-primary" type="submit" ${disabled || !state.notesDirty ? 'disabled' : ''}>${state.actionBusy === 'notes' ? l('Guardando…', 'Saving…') : l('Guardar notas', 'Save notes')}</button></div></form></section>${order.history?.length ? `<section class="admin-panel"><div class="admin-card-heading"><h3>${l('Historial del pedido', 'Order history')}</h3></div><ol class="admin-history">${[...order.history].reverse().map(entry => `<li><span>${statusPill(entry.status)}</span><time datetime="${esc(entry.at)}">${esc(date(entry.at))}</time></li>`).join('')}</ol></section>` : ''}</div><aside class="admin-detail-aside"><section class="admin-panel"><div class="admin-card-heading"><h3>${l('Estado del pedido', 'Order status')}</h3></div><form id="admin-status-form" class="admin-section-form"><label class="admin-sr-only" for="admin-order-status">${l('Estado del pedido', 'Order status')}</label><select id="admin-order-status" ${disabled}>${STATUSES.map(status => `<option value="${status}" ${state.statusDraft === status ? 'selected' : ''}>${esc(statusLabel(status))}</option>`).join('')}</select><button class="admin-button admin-button-primary admin-button-wide" type="submit" ${disabled || state.statusDraft === order.status ? 'disabled' : ''}>${state.actionBusy === 'status' ? l('Guardando…', 'Saving…') : l('Actualizar estado', 'Update status')}</button>${state.cancelConfirm ? `<div class="admin-cancel-confirm" role="alert"><p>${l('¿Cancelar este pedido? Puedes volver a abrirlo cambiando su estado.', 'Cancel this order? You can reopen it by changing its status.')}</p><button class="admin-button admin-button-danger" type="button" data-admin-action="confirm-cancel" ${disabled}>${l('Sí, cancelar pedido', 'Yes, cancel order')}</button><button class="admin-text-button" type="button" data-admin-action="dismiss-cancel">${l('Mantener pedido', 'Keep order')}</button></div>` : ''}</form></section><section class="admin-panel"><div class="admin-card-heading"><h3>${l('Cliente', 'Customer')}</h3></div><div class="admin-customer"><strong>${esc(customer.name || '—')}</strong><a href="mailto:${esc(customer.email || '')}">${esc(customer.email || '')}</a><span>${l('Idioma del pedido', 'Order language')}: ${order.language === 'en' ? 'English' : 'Español'}</span></div><div class="admin-subsection"><h4>${l('Dirección de envío', 'Shipping address')}</h4><address>${[customer.address, customer.apartment, [customer.city, customer.postal].filter(Boolean).join(', '), countryName(customer.country || '')].filter(Boolean).map(line => esc(line)).join('<br>') || '—'}</address></div></section><section class="admin-panel"><div class="admin-card-heading"><h3>${l('Seguimiento del envío', 'Shipment tracking')}</h3><span>${state.trackingDirty ? l('Sin guardar', 'Unsaved') : ''}</span></div><form id="admin-tracking-form" class="admin-section-form"><label for="admin-carrier">${l('Transportista', 'Carrier')}</label><input id="admin-carrier" name="carrier" ${disabled} value="${esc(state.carrier)}" maxlength="80" placeholder="${l('Nombre del transportista', 'Carrier name')}"><label for="admin-tracking-number">${l('Número de seguimiento', 'Tracking number')}</label><input id="admin-tracking-number" name="number" ${disabled} value="${esc(state.trackingNumber)}" maxlength="160" placeholder="${l('Número de guía', 'Tracking number')}"><button class="admin-button admin-button-primary admin-button-wide" type="submit" ${disabled || !state.trackingDirty ? 'disabled' : ''}>${state.actionBusy === 'tracking' ? l('Guardando…', 'Saving…') : l('Guardar seguimiento', 'Save tracking')}</button></form></section></aside></div><p class="admin-sync-note" role="status">${state.updatedAt ? `${l('Última actualización', 'Last refreshed')}: ${esc(date(state.updatedAt))}` : ''} · ${l('Los cambios se guardan para todos tus dispositivos.', 'Changes are saved across all your devices.')}</p>`;
  };

  function render() {
    if (!alive) return;
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = active?.id;
    const selection = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    container.innerHTML = token ? `<section class="admin-root admin-dashboard">${activeTab === 'inventory' ? headerHTML() + inventory.html() : state.selectedId ? detailHTML() : listHTML()}</section>` : loginHTML();
    if (focusedId) {
      const replacement = document.getElementById(focusedId);
      if (replacement && container.contains(replacement) && !replacement.disabled) {
        replacement.focus({ preventScroll: true });
        if (selection) { try { replacement.setSelectionRange(...selection); } catch { /* Select controls have no text selection. */ } }
      }
    }
  }
  const sessionValid = () => {
    if (!token) return false;
    if (expiresAt && expiresAt <= Date.now()) { clearAuth(true); return false; }
    return true;
  };
  async function loadList({ quiet = false } = {}) {
    if (!sessionValid()) return;
    const sequence = ++listSequence;
    const requestToken = token;
    state.listLoading = !quiet;
    if (!quiet) { state.orders = []; state.total = 0; state.listError = ''; render(); }
    try {
      const query = new URLSearchParams({ page: String(state.page), limit: String(state.limit) });
      if (state.status) query.set('status', state.status);
      if (state.search.trim()) query.set('search', state.search.trim());
      const data = await apiRequest(`/admin/orders?${query}`, { token: requestToken });
      if (!alive || sequence !== listSequence || token !== requestToken) return;
      if (!Array.isArray(data.orders)) throw new Error(l('La respuesta de pedidos no es válida.', 'The order response is invalid.'));
      state.orders = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      state.total = Math.max(0, Number(data.total) || 0);
      state.listError = ''; state.updatedAt = new Date().toISOString();
      const lastPage = Math.max(1, Math.ceil(state.total / state.limit));
      if (state.page > lastPage) { state.page = lastPage; loadList(); return; }
    } catch (error) {
      if (!alive || sequence !== listSequence || token !== requestToken) return;
      if (isUnauthorized(error)) { clearAuth(true); return; }
      state.listError = errorText(error);
    } finally {
      if (alive && sequence === listSequence && token === requestToken) { state.listLoading = false; render(); }
    }
  }
  async function loadDetail(id, { quiet = false } = {}) {
    if (!sessionValid()) return;
    const sequence = ++detailSequence;
    const requestToken = token;
    state.detailLoading = !quiet;
    if (!quiet) render();
    try {
      const data = await apiRequest(`/admin/orders/${encodeURIComponent(id)}`, { token: requestToken });
      if (!alive || sequence !== detailSequence || token !== requestToken || state.selectedId !== id) return;
      if (!data.order?.id) throw new Error(l('La respuesta del pedido no es válida.', 'The order response is invalid.'));
      state.order = data.order;
      if (!state.notesDirty) state.notes = data.order.notes || '';
      if (!state.trackingDirty) { state.carrier = data.order.tracking?.carrier || ''; state.trackingNumber = data.order.tracking?.number || ''; }
      if (!state.statusDirty) state.statusDraft = data.order.status;
      state.detailError = ''; state.updatedAt = new Date().toISOString();
    } catch (error) {
      if (!alive || sequence !== detailSequence || token !== requestToken) return;
      if (isUnauthorized(error)) { clearAuth(true); return; }
      state.detailError = errorText(error);
    } finally {
      if (alive && sequence === detailSequence && token === requestToken) { state.detailLoading = false; render(); }
    }
  }
  async function saveOrder(body, action) {
    if (!sessionValid() || !state.order || state.actionBusy) return;
    const id = state.order.id;
    const expectedVersion = state.order.version;
    const requestToken = token;
    const mutation = ++mutationSequence;
    detailSequence++;
    state.actionBusy = action; state.actionError = ''; render();
    try {
      const data = await apiRequest(`/admin/orders/${encodeURIComponent(id)}`, { method: 'PATCH', token: requestToken, body: { ...body, ...(Number.isInteger(expectedVersion) ? { expectedVersion } : {}) } });
      if (!alive || token !== requestToken || state.selectedId !== id) return;
      if (!data.order?.id) throw new Error(l('No pudimos confirmar el cambio. Actualiza el pedido.', 'We could not confirm the change. Refresh this order.'));
      state.order = data.order;
      if (action === 'notes') { state.notes = data.order.notes || ''; state.notesDirty = false; }
      if (action === 'tracking') { state.carrier = data.order.tracking?.carrier || ''; state.trackingNumber = data.order.tracking?.number || ''; state.trackingDirty = false; }
      if (action === 'status') { state.statusDraft = data.order.status; state.statusDirty = false; state.cancelConfirm = false; }
      state.updatedAt = new Date().toISOString();
      announce(l('Cambios guardados.', 'Changes saved.'));
    } catch (error) {
      if (!alive || token !== requestToken || state.selectedId !== id) return;
      if (isUnauthorized(error)) { clearAuth(true); return; }
      state.actionError = errorText(error);
    } finally {
      if (alive && token === requestToken && mutation === mutationSequence) { state.actionBusy = ''; render(); }
    }
  }
  const refresh = quiet => activeTab === 'inventory' ? inventory.load({ quiet }) : state.selectedId ? loadDetail(state.selectedId, { quiet }) : loadList({ quiet });
  const openOrder = id => {
    detailSequence++;
    state.selectedId = id; state.order = null; state.detailError = ''; state.actionError = '';
    state.notesDirty = false; state.trackingDirty = false; state.statusDirty = false; state.cancelConfirm = false;
    loadDetail(id);
    container.scrollIntoView({ behavior: 'instant', block: 'start' });
  };
  function exportPage() {
    if (!state.orders.length) return;
    const cell = value => {
      let text = String(value ?? '');
      if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [[l('Pedido', 'Order'), l('Fecha', 'Date'), l('Estado', 'Status'), l('Cliente', 'Customer'), 'Email', l('Unidades', 'Units'), 'Subtotal USD', l('Descuento USD', 'Discount USD'), l('Envío USD', 'Shipping USD'), 'Total USD', l('Transportista', 'Carrier'), l('Seguimiento', 'Tracking')]];
    for (const order of state.orders) rows.push([order.id, order.createdAt, statusLabel(order.status), order.customer?.name, order.customer?.email, (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0), order.totals?.subtotal, order.totals?.discount, order.totals?.shipping, order.totals?.total, order.tracking?.carrier, order.tracking?.number]);
    const blob = new Blob(['\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); objectUrls.add(url);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `zenin-${getLanguage() === 'es' ? 'pedidos-pagina' : 'orders-page'}-${state.page}.csv`;
    anchor.click();
    announce(l('CSV exportado: solo los pedidos de esta página.', 'CSV exported: orders on this page only.'));
  }
  function printPackingSlip() {
    const order = state.order; if (!order) return;
    const printWindow = window.open('', '_blank', 'width=900,height=1000');
    if (!printWindow) { announce(l('Permite la ventana de impresión e inténtalo de nuevo.', 'Allow the print window and try again.')); return; }
    printWindow.opener = null;
    const customer = order.customer || {};
    const address = [customer.name, customer.address, customer.apartment, [customer.city, customer.postal].filter(Boolean).join(', '), countryName(customer.country || '')].filter(Boolean).map(esc).join('<br>');
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html lang="${getLanguage()}"><head><meta charset="utf-8"><title>${esc(order.id)} · Zenin Club</title><style>body{font:14px/1.5 Arial,sans-serif;color:#111;margin:45px}header{border-bottom:2px solid #111;padding-bottom:20px;display:flex;justify-content:space-between;gap:25px}h1{font-size:26px;line-height:1.1;margin:0 0 8px}h2{font-size:17px;margin:26px 0 8px}p{margin:5px 0}address{font-style:normal}table{width:100%;border-collapse:collapse;margin-top:30px}th,td{text-align:left;padding:13px 8px;border-bottom:1px solid #ccc}th{font-size:11px;text-transform:uppercase}td:last-child,th:last-child{text-align:right}.meta{font-size:12px;color:#555}footer{margin-top:45px;padding-top:15px;border-top:1px solid #111;font-size:12px}@media print{body{margin:12mm}@page{margin:10mm}}</style></head><body><header><div><h1>ZENIN CLUB</h1><p>${l('Alistamiento de pedido', 'Packing slip')}</p></div><div><strong>${esc(order.id)}</strong><p class="meta">${esc(date(order.createdAt))}</p><p>${esc(statusLabel(order.status))}</p></div></header><h2>${l('Enviar a', 'Ship to')}</h2><address>${address || '—'}</address><p class="meta">${esc(customer.email || '')}</p><table><thead><tr><th>${l('Artículo', 'Item')}</th><th>${l('Color / talla', 'Color / size')}</th><th>${l('Cantidad', 'Quantity')}</th></tr></thead><tbody>${(order.items || []).map(item => `<tr><td>${esc(productName(item))}</td><td>${esc(colorLabel(item.shirt || item.colorName))} / ${esc(item.size)}</td><td>${esc(item.quantity)}</td></tr>`).join('')}</tbody></table>${order.tracking?.number ? `<h2>${l('Seguimiento del envío', 'Shipment tracking')}</h2><p>${esc(order.tracking.carrier)} · ${esc(order.tracking.number)}</p>` : ''}<footer>${l('Gracias por ser parte de Zenin Club.', 'Thanks for being part of Zenin Club.')}</footer></body></html>`);
    printWindow.document.close(); printWindow.focus(); printWindow.print();
  }

  async function onSubmit(event) {
    const form = event.target;
    if (!container.contains(form) || !form.id?.startsWith('admin-')) return;
    event.preventDefault();
    if (form.id === 'admin-login-form') {
      if (state.loginBusy || !form.reportValidity()) return;
      const values = new FormData(form);
      state.loginBusy = true; state.loginError = ''; state.loginNotice = '';
      render();
      try {
        const data = await apiRequest('/admin/login', { method: 'POST', body: { username: String(values.get('username') || '').trim(), password: String(values.get('password') || '') } });
        if (!alive) return;
        if (!data.token || !Number.isFinite(expiration(data.expiresAt))) throw new Error(l('El servidor no pudo iniciar una sesión válida.', 'The server could not start a valid session.'));
        token = data.token; expiresAt = expiration(data.expiresAt);
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, expiresAt })); } catch { /* Keep this session in memory only. */ }
        state.loginBusy = false; refresh(false);
      } catch (error) {
        if (!alive) return;
        state.loginBusy = false;
        state.loginError = isUnauthorized(error) ? l('Usuario o contraseña incorrectos.', 'Incorrect username or password.') : errorText(error);
        render(); container.querySelector('#admin-password')?.focus();
      }
      return;
    }
    if (form.id === 'admin-search-form') { window.clearTimeout(searchTimer); state.page = 1; loadList(); }
    if (form.id === 'admin-notes-form') saveOrder({ notes: state.notes }, 'notes');
    if (form.id === 'admin-tracking-form') saveOrder({ tracking: { carrier: state.carrier.trim(), number: state.trackingNumber.trim() } }, 'tracking');
    if (form.id === 'admin-status-form' && STATUSES.includes(state.statusDraft)) {
      if (state.statusDraft === 'cancelled' && state.order?.status !== 'cancelled') { state.cancelConfirm = true; render(); }
      else saveOrder({ status: state.statusDraft }, 'status');
    }
  }
  function onClick(event) {
    const tab = event.target.closest('a[data-admin-tab]');
    const dirty = activeTab === 'inventory' ? inventory.hasUnsaved() : state.notesDirty || state.trackingDirty || state.statusDirty;
    if (tab && tab.dataset.adminTab !== activeTab && dirty) { event.preventDefault(); pendingHref = tab.getAttribute('href'); render(); return; }
    if (activeTab === 'inventory' && inventory.onClick(event)) return;
    const button = event.target.closest('button'); if (!button || !container.contains(button)) return;
    if (button.dataset.adminOrder) { openOrder(button.dataset.adminOrder); return; }
    switch (button.dataset.adminAction) {
      case 'logout': clearAuth(); break;
      case 'stay-tab': pendingHref = ''; render(); break;
      case 'leave-tab': { const href = pendingHref; pendingHref = ''; if (href) location.hash = href; break; }
      case 'refresh': refresh(false); break;
      case 'export': exportPage(); break;
      case 'print': printPackingSlip(); break;
      case 'back': detailSequence++; mutationSequence++; state.selectedId = null; state.order = null; state.actionError = ''; state.actionBusy = ''; loadList(); break;
      case 'previous': state.page = Math.max(1, state.page - 1); loadList(); break;
      case 'next': state.page++; loadList(); break;
      case 'clear-filters': state.search = ''; state.status = ''; state.page = 1; loadList(); break;
      case 'confirm-cancel': saveOrder({ status: 'cancelled' }, 'status'); break;
      case 'dismiss-cancel': state.cancelConfirm = false; state.statusDraft = state.order.status; state.statusDirty = false; render(); break;
    }
  }
  function onInput(event) {
    if (activeTab === 'inventory' && inventory.onInput(event)) return;
    const target = event.target;
    if (target.id === 'admin-search') {
      state.search = target.value;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => { state.page = 1; loadList(); }, 350);
    }
    if (target.id === 'admin-notes') {
      state.notes = target.value; state.notesDirty = state.notes !== (state.order?.notes || '');
      const save = container.querySelector('#admin-notes-form button[type="submit"]'); if (save) save.disabled = !state.notesDirty || !!state.actionBusy;
    }
    if (target.id === 'admin-carrier' || target.id === 'admin-tracking-number') {
      if (target.id === 'admin-carrier') state.carrier = target.value; else state.trackingNumber = target.value;
      state.trackingDirty = state.carrier !== (state.order?.tracking?.carrier || '') || state.trackingNumber !== (state.order?.tracking?.number || '');
      const save = container.querySelector('#admin-tracking-form button[type="submit"]'); if (save) save.disabled = !state.trackingDirty || !!state.actionBusy;
    }
  }
  function onChange(event) {
    if (activeTab === 'inventory' && inventory.onChange(event)) return;
    if (event.target.id === 'admin-status-filter') { state.status = event.target.value; state.page = 1; loadList(); }
    if (event.target.id === 'admin-order-status') { state.statusDraft = event.target.value; state.statusDirty = state.statusDraft !== state.order?.status; state.cancelConfirm = false; render(); }
  }
  inventory = createAdminInventory({ products, shirtHTML, onChange: render, announce, request: async (path, options = {}) => {
    if (!sessionValid()) throw Object.assign(new Error(), { code: 'STALE_REQUEST' });
    const requestToken = token;
    try {
      const data = await apiRequest(path, { ...options, token: requestToken });
      if (!alive || token !== requestToken) throw Object.assign(new Error(), { code: 'STALE_REQUEST' });
      return data;
    } catch (error) {
      if (alive && token === requestToken && isUnauthorized(error)) clearAuth(true);
      throw error;
    }
  } });
  const onBeforeUnload = event => {
    if (activeTab === 'inventory' ? inventory.hasUnsaved() : state.notesDirty || state.trackingDirty || state.statusDirty) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  const onVisibility = () => { if (document.visibilityState === 'visible' && token && !state.actionBusy) refresh(true); };
  const onLanguage = () => render();
  container.addEventListener('submit', onSubmit);
  container.addEventListener('click', onClick);
  container.addEventListener('input', onInput);
  container.addEventListener('change', onChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('zenin:language', onLanguage);
  const timer = window.setInterval(() => { if (alive && document.visibilityState === 'visible' && token && !state.actionBusy) refresh(true); }, 30000);
  render();
  if (token) refresh(false);
  return () => {
    alive = false; listSequence++; detailSequence++; mutationSequence++;
    inventory.cleanup(); window.removeEventListener('beforeunload', onBeforeUnload);
    window.clearInterval(timer); window.clearTimeout(searchTimer);
    container.removeEventListener('submit', onSubmit); container.removeEventListener('click', onClick);
    container.removeEventListener('input', onInput); container.removeEventListener('change', onChange);
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('zenin:language', onLanguage);
    objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear();
  };
}
