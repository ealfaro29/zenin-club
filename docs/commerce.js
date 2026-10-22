const CART_KEY = 'zenin-cart-v1';
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const COLOR_NAMES = { 1: 'Washed Black', 2: 'Deep Teal', 3: 'Dusty Violet', 4: 'Faded Red' };
const COUNTRIES = [
  ['CR', 'Costa Rica'],
  ['US', 'United States'],
  ['MX', 'Mexico'],
  ['CA', 'Canada'],
  ['GB', 'United Kingdom'],
];
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/** A browser-only cart and clearly labelled simulated checkout. */
export function createCommerce({ products, shirtHTML, money, toast }) {
  const catalog = new Map(products.map((product) => [String(product.id), product]));
  const cartDialog = document.getElementById('cart-dialog');
  const cartContent = document.getElementById('cart-content');
  const checkoutDialog = document.getElementById('checkout-dialog');
  const checkoutContent = document.getElementById('checkout-content');
  const formatMoney = typeof money === 'function' ? money : (value) => `$${value.toFixed(2)}`;
  const announce = (message) => { if (typeof toast === 'function') toast(message); };
  const subscribers = new Set();
  let discountApplied = false;
  let promoMessage = '';
  let formValues = { name: '', email: '', address: '', apartment: '', city: '', postal: '', country: 'CR' };
  let confirmedOrder = null;

  const validateCart = (value) => {
    if (!Array.isArray(value)) return [];
    const unique = new Map();
    for (const item of value) {
      if (!item || !catalog.has(String(item.id)) || !SIZES.includes(item.size)) continue;
      const quantity = Number(item.quantity ?? item.qty);
      if (!Number.isInteger(quantity) || quantity < 1) continue;
      const shirt = Number(item.shirt === undefined ? catalog.get(String(item.id)).shirt : item.shirt);
      if (!Number.isInteger(shirt) || !Object.hasOwn(COLOR_NAMES, shirt)) continue;
      const key = `${String(item.id)}:${item.size}:${shirt}`;
      const previous = unique.get(key);
      unique.set(key, { id: String(item.id), size: item.size, shirt, quantity: Math.min(10, quantity + (previous?.quantity || 0)) });
    }
    return [...unique.values()];
  };
  const readCart = () => {
    try { return validateCart(JSON.parse(localStorage.getItem(CART_KEY) || '[]')); }
    catch { return []; }
  };
  let items = readCart();
  const productForItem = (item) => ({ ...catalog.get(item.id), shirt: item.shirt, colorName: COLOR_NAMES[item.shirt] });
  const getCount = () => items.reduce((count, item) => count + item.quantity, 0);
  const totals = () => {
    const subtotal = round(items.reduce((total, item) => total + Number(catalog.get(item.id).price) * item.quantity, 0));
    const discount = discountApplied ? round(subtotal * 0.1) : 0;
    const shipping = subtotal === 0 || subtotal >= 120 ? 0 : 8;
    return { subtotal, discount, shipping, total: round(subtotal - discount + shipping) };
  };
  const notify = () => subscribers.forEach((callback) => callback(getCount()));
  const save = () => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch { /* A restricted browser can still use the cart for this visit. */ }
    notify();
  };
  const heading = (title, closeTarget) => `<div class="cart-heading"><div><span class="eyebrow">ZENIN CLUB</span><h2 id="${closeTarget === 'cart' ? 'cart-title' : 'checkout-title'}">${title}</h2></div><button type="button" class="close-button" data-commerce-close="${closeTarget}" aria-label="Close ${closeTarget === 'cart' ? 'bag' : 'checkout'}"><span aria-hidden="true">×</span></button></div>`;
  const priceRows = () => {
    const { subtotal, discount, shipping, total } = totals();
    return `<div class="cart-totals"><div class="cart-total-row"><span>Subtotal</span><span>${formatMoney(subtotal)}</span></div>${discountApplied ? `<div class="cart-total-row cart-discount"><span>ZENIN10 · 10% off</span><span>−${formatMoney(discount)}</span></div>` : ''}<div class="cart-total-row"><span>Shipping</span><span>${shipping === 0 ? 'FREE' : formatMoney(shipping)}</span></div><div class="cart-total-row cart-grand-total"><span>Total</span><span>${formatMoney(total)} <small>USD</small></span></div></div>`;
  };
  const renderCart = () => {
    const { subtotal } = totals();
    if (!items.length) {
      cartContent.innerHTML = `${heading('YOUR BAG <span class="cart-count">(0)</span>', 'cart')}<div class="cart-empty"><span class="cart-empty-symbol" aria-hidden="true">↗</span><h3>Good things come in tees.</h3><p>Your bag is waiting for its first pick.</p><button class="btn btn-primary" type="button" data-commerce-close="cart">Explore the collection <span aria-hidden="true">↗</span></button></div><p class="cart-footnote">Independent graphics. Everyday essentials.</p>`;
      return;
    }
    cartContent.innerHTML = `${heading(`YOUR BAG <span class="cart-count">(${getCount()})</span>`, 'cart')}
      <div class="cart-shipping-note">${subtotal >= 120 ? 'Your shipping is on us.' : `You’re ${formatMoney(round(120 - subtotal))} away from free shipping.`}</div>
      <div class="cart-items">${items.map((item, index) => {
        const product = productForItem(item);
        return `<article class="cart-item"><div class="cart-item-image">${shirtHTML(product, 'cart-shirt')}</div><div class="cart-item-info"><div class="cart-item-top"><div><p class="cart-item-collection">${escapeHTML(product.collection || 'ZENIN ORIGINALS')}</p><h3>${escapeHTML(product.name || product.title)}</h3><p class="cart-item-size">${escapeHTML(product.colorName)} / Size ${item.size}</p></div><button type="button" class="cart-remove" data-cart-remove="${index}" aria-label="Remove ${escapeHTML(product.name || product.title)}, ${escapeHTML(product.colorName)}, size ${item.size}">Remove</button></div><div class="cart-item-bottom"><div class="cart-quantity" aria-label="Quantity for ${escapeHTML(product.name || product.title)}"><button type="button" data-cart-quantity="${index}" data-cart-delta="-1" aria-label="Decrease quantity">−</button><span aria-live="polite">${item.quantity}</span><button type="button" data-cart-quantity="${index}" data-cart-delta="1" aria-label="Increase quantity" ${item.quantity >= 10 ? 'disabled' : ''}>+</button></div><strong>${formatMoney(Number(product.price) * item.quantity)}</strong></div></div></article>`;
      }).join('')}</div>
      <div class="cart-summary"><form class="cart-promo" id="cart-promo-form"><label class="cart-promo-label" for="cart-promo-code">Have a code?</label><div class="cart-promo-controls"><input id="cart-promo-code" name="code" type="text" placeholder="Try ZENIN10" autocomplete="off" aria-describedby="cart-promo-message" ${discountApplied ? 'value="ZENIN10"' : ''}><button class="cart-promo-button" type="submit">Apply</button></div><p id="cart-promo-message" class="cart-promo-message ${discountApplied ? 'cart-promo-success' : ''}" role="status">${escapeHTML(promoMessage)}</p></form>${priceRows()}<button type="button" class="btn btn-primary cart-checkout-button" data-checkout-start>Checkout <span aria-hidden="true">↗</span></button><p class="cart-footnote">Demo store · No payment will be taken</p></div>`;
  };
  const closeDialog = (dialog) => { if (dialog.open) dialog.close(); };
  const openCart = () => {
    closeDialog(checkoutDialog);
    renderCart();
    if (!cartDialog.open) cartDialog.showModal();
  };
  const input = (name, label, autocomplete, options = {}) => `<div class="checkout-field ${options.full ? 'checkout-field-full' : ''}"><label for="checkout-${name}">${label}${options.optional ? ' <span>(optional)</span>' : ''}</label><input id="checkout-${name}" name="${name}" type="${options.type || 'text'}" value="${escapeHTML(formValues[name])}" autocomplete="${autocomplete}" ${options.optional ? '' : 'required'} ${name === 'name' ? 'minlength="2"' : ''}></div>`;
  const renderCheckout = () => {
    checkoutContent.innerHTML = `${heading('MAKE IT YOURS', 'checkout')}<p class="checkout-demo">Demo checkout · No payment will be taken</p><div class="checkout-layout"><form id="checkout-form" class="checkout-form"><h3>Contact</h3><div class="checkout-fields">${input('name', 'Full name', 'name', { full: true })}${input('email', 'Email address', 'email', { type: 'email', full: true })}</div><h3>Shipping address</h3><div class="checkout-fields">${input('address', 'Street address', 'address-line1', { full: true })}${input('apartment', 'Apartment, suite, etc.', 'address-line2', { full: true, optional: true })}${input('city', 'City', 'address-level2')}${input('postal', 'Postal code', 'postal-code')}<div class="checkout-field checkout-field-full"><label for="checkout-country">Country</label><select id="checkout-country" name="country" autocomplete="country" required>${COUNTRIES.map(([code, name]) => `<option value="${code}" ${formValues.country === code ? 'selected' : ''}>${name}</option>`).join('')}</select></div></div><p class="checkout-privacy">This is a store preview. Your details stay in this browser and are never sent anywhere.</p><button class="btn btn-primary checkout-place-order" type="submit">Place demo order <span aria-hidden="true">↗</span></button><button class="checkout-back" type="button" data-checkout-back>← Back to bag</button></form><aside class="checkout-order"><h3>THE GOOD STUFF <span>(${getCount()})</span></h3><div class="checkout-order-items">${items.map((item) => {
      const product = productForItem(item);
      return `<div class="checkout-order-item"><div class="checkout-order-image">${shirtHTML(product, 'checkout-shirt')}<span class="checkout-item-count">${item.quantity}</span></div><div class="checkout-order-description"><strong>${escapeHTML(product.name || product.title)}</strong><span>${escapeHTML(product.colorName)} / Size ${item.size}</span></div><span>${formatMoney(Number(product.price) * item.quantity)}</span></div>`;
    }).join('')}</div>${priceRows()}<p class="checkout-order-note">A little weird. A lot of you.</p></aside></div>`;
  };
  const startCheckout = () => {
    if (!items.length) return;
    confirmedOrder = null;
    closeDialog(cartDialog);
    renderCheckout();
    if (!checkoutDialog.open) checkoutDialog.showModal();
  };
  const readForm = (form) => {
    const data = new FormData(form);
    for (const name of Object.keys(formValues)) formValues[name] = String(data.get(name) || '').trim();
  };
  const renderConfirmation = () => {
    checkoutContent.innerHTML = `${heading('YOU’RE IN THE CLUB.', 'checkout')}<div class="checkout-confirmation"><div class="checkout-confirmation-mark" aria-hidden="true">✓</div><span class="eyebrow">DEMO ORDER ${escapeHTML(confirmedOrder.number)}</span><h3>Good taste.<br>Great choice.</h3><p>Thanks, ${escapeHTML(confirmedOrder.name)}. Your simulated order is complete.</p><div class="checkout-confirmation-details"><span>${confirmedOrder.count} ${confirmedOrder.count === 1 ? 'item' : 'items'}</span><strong>${formatMoney(confirmedOrder.total)} USD</strong></div><p class="checkout-demo">Demo checkout · No payment will be taken</p><p class="checkout-confirmation-note">No order was submitted and no email will be sent. This is a preview of the Zenin Club shopping experience.</p><button type="button" class="btn btn-primary" data-commerce-close="checkout">Keep exploring <span aria-hidden="true">↗</span></button></div>`;
  };
  const addItem = (productOrId, size = 'M', quantity = 1, shirt = undefined) => {
    const id = String(typeof productOrId === 'object' ? productOrId?.id : productOrId);
    const requested = Number(quantity);
    if (!catalog.has(id) || !SIZES.includes(size) || !Number.isInteger(requested) || requested < 1) return false;
    const selectedShirt = Number(shirt === undefined ? catalog.get(id).shirt : shirt);
    if (!Number.isInteger(selectedShirt) || !Object.hasOwn(COLOR_NAMES, selectedShirt)) return false;
    const existing = items.find((item) => item.id === id && item.size === size && item.shirt === selectedShirt);
    if (existing) existing.quantity = Math.min(10, existing.quantity + requested);
    else items.push({ id, size, shirt: selectedShirt, quantity: Math.min(10, requested) });
    confirmedOrder = null;
    save();
    openCart();
    announce(`${catalog.get(id).name || catalog.get(id).title} added to your bag`);
    return true;
  };
  const onChange = (callback) => {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback);
    callback(getCount());
    return () => subscribers.delete(callback);
  };

  cartContent.addEventListener('click', (event) => {
    const close = event.target.closest('[data-commerce-close]');
    if (close) { closeDialog(cartDialog); return; }
    const remove = event.target.closest('[data-cart-remove]');
    if (remove) {
      items.splice(Number(remove.dataset.cartRemove), 1);
      save();
      renderCart();
      return;
    }
    const quantityButton = event.target.closest('[data-cart-quantity]');
    if (quantityButton) {
      const index = Number(quantityButton.dataset.cartQuantity);
      if (!items[index]) return;
      const delta = Number(quantityButton.dataset.cartDelta);
      items[index].quantity = Math.min(10, items[index].quantity + delta);
      if (items[index].quantity <= 0) items.splice(index, 1);
      save();
      renderCart();
      const nextIndex = Math.min(index, items.length - 1);
      const focusTarget = cartContent.querySelector(`[data-cart-quantity="${nextIndex}"][data-cart-delta="${delta}"]:not(:disabled)`)
        || cartContent.querySelector(`[data-cart-quantity="${nextIndex}"]:not(:disabled)`)
        || cartContent.querySelector('.cart-empty .btn')
        || cartContent.querySelector('.cart-checkout-button');
      focusTarget?.focus();
      return;
    }
    if (event.target.closest('[data-checkout-start]')) startCheckout();
  });
  cartContent.addEventListener('submit', (event) => {
    if (event.target.id !== 'cart-promo-form') return;
    event.preventDefault();
    const focusApplyButton = document.activeElement?.matches('.cart-promo-button');
    const code = String(new FormData(event.target).get('code') || '').trim().toUpperCase();
    if (code === 'ZENIN10') {
      discountApplied = true;
      promoMessage = 'You’re in. 10% off your tees.';
    } else {
      promoMessage = discountApplied ? 'ZENIN10 is already applied to your bag.' : 'That code didn’t land. Try ZENIN10.';
    }
    renderCart();
    const promoInput = cartContent.querySelector('#cart-promo-code');
    if (!discountApplied && promoInput) promoInput.value = code;
    cartContent.querySelector(focusApplyButton ? '.cart-promo-button' : '#cart-promo-code')?.focus();
  });
  checkoutContent.addEventListener('input', (event) => {
    if (event.target.form?.id === 'checkout-form') readForm(event.target.form);
  });
  checkoutContent.addEventListener('change', (event) => {
    if (event.target.form?.id === 'checkout-form') readForm(event.target.form);
  });
  checkoutContent.addEventListener('click', (event) => {
    if (event.target.closest('[data-commerce-close]')) { closeDialog(checkoutDialog); return; }
    if (event.target.closest('[data-checkout-back]')) openCart();
  });
  checkoutContent.addEventListener('submit', (event) => {
    if (event.target.id !== 'checkout-form') return;
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity() || !items.length) return;
    readForm(form);
    if (!COUNTRIES.some(([code]) => code === formValues.country)) return;
    confirmedOrder = { number: `ZC-${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0')}`, name: formValues.name.split(/\s+/)[0], count: getCount(), total: totals().total };
    items = [];
    discountApplied = false;
    promoMessage = '';
    save();
    renderConfirmation();
    checkoutContent.querySelector('.close-button')?.focus();
  });
  // Clicking outside a panel closes it without opening a second modal.
  for (const dialog of [cartDialog, checkoutDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog);
    });
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== CART_KEY) return;
    items = readCart();
    notify();
    if (cartDialog.open) renderCart();
    if (checkoutDialog.open && !confirmedOrder) {
      if (items.length) renderCheckout();
      else { closeDialog(checkoutDialog); openCart(); }
    }
  });
  return { openCart, addItem, getCount, onChange };
}
