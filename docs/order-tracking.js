import { trackOrder, apiErrorMessage } from './orders-api.js?v=40';
import { l, getLanguage, formatMoney, formatDate, statusLabel, productName, colorLabel } from './i18n.js?v=40';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const countries = { CR: ['Costa Rica', 'Costa Rica'], US: ['Estados Unidos', 'United States'], MX: ['México', 'Mexico'], CA: ['Canadá', 'Canada'], GB: ['Reino Unido', 'United Kingdom'] };
const countryName = code => countries[code] ? l(...countries[code]) : code;
const errorText = apiErrorMessage;

export function mountOrderTracking({ container, id, token, shirtHTML, toast }) {
  if (!container) return () => {};
  const controller = new AbortController();
  let disposed = false, order = null, loading = false, error = null, lastUpdated = null, requestId = 0, retryAfterUntil = 0;
  let lookup = { id: id || '', token: token || '', email: '' };
  const options = { signal: controller.signal };
  const currentFocus = () => ({ id: document.activeElement?.id, selection: document.activeElement && 'selectionStart' in document.activeElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null });
  const restoreFocus = focus => { if (!focus?.id) return; const element = document.getElementById(focus.id); element?.focus(); if (focus.selection && element?.setSelectionRange && element.type !== 'email') { try { element.setSelectionRange(...focus.selection); } catch {} } };
  const lookupForm = () => `<section class="order-track-lookup"><h2>${l('Busca tu pedido', 'Find your order')}</h2><p>${l('Usa tu referencia y el correo que indicaste al comprar.', 'Use your order reference and the email address you used at checkout.')}</p><form class="order-track-form" id="order-track-form" novalidate><div class="order-track-field"><label for="order-track-id">${l('Referencia del pedido', 'Order reference')}</label><input id="order-track-id" name="id" value="${esc(lookup.id)}" placeholder="ZC-…" autocomplete="off" required ${loading ? 'disabled' : ''}></div><div class="order-track-field"><label for="order-track-email">${l('Correo electrónico', 'Email address')}</label><input id="order-track-email" name="email" type="email" value="${esc(lookup.email)}" autocomplete="email" required ${loading ? 'disabled' : ''}></div><button id="order-track-submit" class="btn btn-primary" type="submit" ${loading ? 'disabled' : ''}>${loading ? l('Consultando…', 'Looking up…') : l('Consultar pedido', 'Find order')} <span aria-hidden="true">↗</span></button></form></section>`;
  const orderDetails = () => {
    const totals = order.totals;
    return `<section class="order-track-summary"><div class="order-track-status" data-status="${esc(order.status)}"><span class="eyebrow">${l('ESTADO ACTUAL', 'CURRENT STATUS')}</span><h2>${esc(statusLabel(order.status))}</h2><p>${order.status === 'new' ? l('Recibimos tu pedido. Pronto comenzaremos a prepararlo.', 'Your order is saved. We’ll start preparing it soon.') : order.status === 'preparing' ? l('Estamos preparando tus camisetas.', 'We’re getting your tees ready.') : order.status === 'ready' ? l('Tu pedido está listo para el siguiente paso.', 'Your order is ready for the next step.') : order.status === 'shipped' ? l('Tu pedido ya fue enviado.', 'Your order has shipped.') : l('Este pedido fue cancelado.', 'This order has been cancelled.')}</p></div><dl class="order-track-details"><div><dt>${l('Referencia', 'Reference')}</dt><dd>${esc(order.id)}</dd></div><div><dt>${l('Creado', 'Placed')}</dt><dd>${formatDate(order.createdAt)}</dd></div><div><dt>${l('Actualizado', 'Updated')}</dt><dd>${formatDate(order.updatedAt || order.createdAt)}</dd></div><div><dt>${l('Correo', 'Email')}</dt><dd>${esc(order.customer.email)}</dd></div></dl></section><div class="order-track-layout"><section class="order-track-products"><h2>${l('Tu pedido', 'Your order')}</h2><div class="order-track-items">${order.items.map(item => { const product = { ...item, id: item.productId, name: productName(item), colorName: colorLabel(item.shirt) }; return `<article class="order-track-item"><div class="order-track-item-image">${shirtHTML(product, 'order-track-shirt')}</div><div><h3>${esc(productName(item))}</h3><p>${esc(colorLabel(item.shirt))} / ${l('Talla', 'Size')} ${esc(item.size)}</p><p>${l('Cantidad', 'Quantity')}: ${item.quantity}</p></div><strong>${formatMoney(item.unitPrice * item.quantity)}</strong></article>`; }).join('')}</div><dl class="order-track-totals"><div><dt>${l('Subtotal', 'Subtotal')}</dt><dd>${formatMoney(totals.subtotal)}</dd></div>${totals.discount ? `<div><dt>${l('Descuento', 'Discount')} · ${esc(order.discountCode || '')}</dt><dd>−${formatMoney(totals.discount)}</dd></div>` : ''}<div><dt>${l('Envío', 'Shipping')}</dt><dd>${totals.shipping === 0 ? l('GRATIS', 'FREE') : formatMoney(totals.shipping)}</dd></div><div class="order-track-total"><dt>${l('Total', 'Total')}</dt><dd>${formatMoney(totals.total)} USD</dd></div></dl><p class="order-track-demo">${l('Pago de prueba · No se realizó ningún cobro', 'Demo payment · No payment was taken')}</p></section><aside class="order-track-aside"><section class="order-track-shipping"><h2>${l('Información de envío', 'Shipping details')}</h2><address>${esc(order.customer.name)}<br>${esc(order.customer.address)}${order.customer.apartment ? `<br>${esc(order.customer.apartment)}` : ''}<br>${esc(order.customer.city)}, ${esc(order.customer.postal)}<br>${esc(countryName(order.customer.country))}</address>${order.tracking?.carrier || order.tracking?.number ? `<dl><div><dt>${l('Transportista', 'Carrier')}</dt><dd>${esc(order.tracking.carrier || l('Por confirmar', 'To be confirmed'))}</dd></div><div><dt>${l('Número de seguimiento', 'Tracking number')}</dt><dd>${esc(order.tracking.number || l('Por confirmar', 'To be confirmed'))}</dd></div></dl>` : `<p>${l('La información de seguimiento aparecerá aquí cuando esté disponible.', 'Tracking information will appear here when it is available.')}</p>`}</section><section class="order-track-history"><h2>${l('Historial del pedido', 'Order timeline')}</h2><ol class="order-track-timeline">${(order.history?.length ? order.history : [{ status: order.status, at: order.createdAt }]).map(entry => `<li data-status="${esc(entry.status)}"><strong>${esc(statusLabel(entry.status))}</strong><time datetime="${esc(entry.at)}">${formatDate(entry.at)}</time></li>`).join('')}</ol></section></aside></div><div class="order-track-actions"><button class="btn btn-outline" type="button" id="order-track-refresh" data-order-refresh ${loading ? 'disabled' : ''}>${loading ? l('Actualizando…', 'Refreshing…') : l('Actualizar estado', 'Refresh status')}</button><button class="order-track-other" type="button" data-order-other>${l('Consultar otro pedido', 'Find another order')}</button><a href="#shop" class="btn btn-primary">${l('Seguir comprando', 'Keep shopping')} ↗</a></div><p class="order-track-updated" role="status">${l('Consulta al servidor', 'Last server check')}: ${lastUpdated ? formatDate(lastUpdated) : '—'} · ${l('Se actualiza automáticamente cada 60 segundos mientras esta página esté visible.', 'Updates automatically every 60 seconds while this page is visible.')}</p>`;
  };
  const render = (preserveFocus = true) => {
    if (disposed) return;
    const focus = preserveFocus ? currentFocus() : null;
    container.innerHTML = `<section class="order-track-page section-wrap" aria-busy="${loading}"><header class="order-track-header"><span class="eyebrow">ZENIN CLUB / ${l('PEDIDOS', 'ORDERS')}</span><h1>${l('TU PEDIDO.<br>SIEMPRE A MANO.', 'YOUR ORDER.<br>ALWAYS CLOSE.')}</h1><p>${l('Sigue cada paso de tu pedido desde cualquier dispositivo.', 'Follow every step of your order from any device.')}</p></header>${error ? `<div class="order-track-error" role="alert"><p>${esc(errorText(error))}</p>${retryAfterUntil > Date.now() ? `<p>${esc(l('Podrás volver a consultar a partir de {time}.', 'You can check again after {time}.', { time: formatDate(new Date(retryAfterUntil).toISOString()) }))}</p>` : ''}${order ? `<p>${l('Los datos que ves son la última respuesta confirmada del servidor.', 'The details below are the last confirmed server response.')}</p>` : ''}<button class="btn btn-outline" type="button" data-order-retry>${l('Reintentar', 'Retry')}</button></div>` : ''}${order ? orderDetails() : loading && lookup.token ? `<p class="order-track-loading" role="status">${l('Consultando tu pedido…', 'Loading your order…')}</p>` : lookupForm()}</section>`;
    restoreFocus(focus);
  };
  const load = async () => {
    if (disposed || loading || !lookup.id || (!lookup.token && !lookup.email)) return;
    if (Date.now() < retryAfterUntil) { render(); return; }
    const request = ++requestId;
    const credentials = { ...lookup };
    loading = true; error = null; render();
    try {
      const result = await trackOrder(credentials);
      if (disposed || request !== requestId) return;
      if (!result?.order?.id || !result.order.totals || !Array.isArray(result.order.items)) throw new Error(l('El servidor devolvió un pedido incompleto. Inténtalo de nuevo.', 'The server returned an incomplete order. Please try again.'));
      order = result.order; lastUpdated = new Date().toISOString(); retryAfterUntil = 0;
    } catch (caught) { if (!disposed && request === requestId) { error = caught; if (caught.status === 429 || caught.code === 'RATE_LIMITED') { const seconds = Number(caught.details?.retryAfter); retryAfterUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000; } } }
    finally { if (!disposed && request === requestId) { loading = false; render(); } }
  };
  container.addEventListener('input', event => { if (event.target.form?.id !== 'order-track-form') return; event.target.setCustomValidity?.(''); if (['id', 'email'].includes(event.target.name)) lookup[event.target.name] = event.target.value; }, options);
  container.addEventListener('submit', event => {
    if (event.target.id !== 'order-track-form') return; event.preventDefault();
    const form = event.target;
    for (const field of form.querySelectorAll('input')) { field.setCustomValidity(''); if (!field.value.trim()) field.setCustomValidity(l('Completa este campo.', 'Please fill out this field.')); else if (field.type === 'email' && field.validity.typeMismatch) field.setCustomValidity(l('Escribe un correo electrónico válido.', 'Please enter a valid email address.')); }
    if (!form.reportValidity()) return;
    const data = new FormData(form); lookup = { id: String(data.get('id') || '').trim(), email: String(data.get('email') || '').trim(), token: '' }; order = null; load();
  }, options);
  container.addEventListener('click', event => {
    if (event.target.closest('[data-order-refresh], [data-order-retry]')) { load(); return; }
    if (event.target.closest('[data-order-other]')) { requestId++; loading = false; lookup = { id: '', token: '', email: '' }; order = null; error = null; render(false); document.getElementById('order-track-id')?.focus(); }
  }, options);
  window.addEventListener('zenin:language', () => render(), options);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && order && (!lastUpdated || Date.now() - Date.parse(lastUpdated) >= 60000)) load(); }, options);
  const interval = window.setInterval(() => { if (!document.hidden && order) load(); }, 60000);
  render(false);
  if (lookup.id && lookup.token) load();
  return () => { disposed = true; requestId++; controller.abort(); window.clearInterval(interval); };
}
