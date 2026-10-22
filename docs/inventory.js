import { apiRequest, apiErrorMessage } from './orders-api.js?v=42';
import { l } from './i18n.js?v=40';

const MAX_AGE = 60000;
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const keyFor = (productId, shirt, size) => `${String(productId)}:${Number(shirt)}:${size}`;
let variants = new Map();
let state = { status: 'idle', updatedAt: null, error: null };
let request = null;
const listeners = new Set();
export const getInventoryState = () => ({ ...state, stale: !state.updatedAt || Date.now() - Date.parse(state.updatedAt) >= MAX_AGE });
const emit = () => {
  const snapshot = getInventoryState();
  listeners.forEach(callback => callback(snapshot));
  window.dispatchEvent(new CustomEvent('zenin:inventory', { detail: snapshot }));
};
export function subscribeInventory(callback) {
  if (typeof callback !== 'function') return () => {};
  listeners.add(callback); callback(getInventoryState());
  return () => listeners.delete(callback);
}
export function getStock(productId, shirt, size) {
  if (state.status !== 'ready') return null;
  if (![1, 2, 3, 4].includes(Number(shirt)) || !SIZES.includes(size)) return null;
  return variants.get(keyFor(productId, shirt, size))?.stock ?? 0;
}
export function getProductAvailability(productId, shirt) {
  const snapshot = getInventoryState();
  const sizes = Object.fromEntries(SIZES.map(size => [size, null]));
  if (snapshot.status !== 'ready') return { ...snapshot, available: null, totalStock: null, sizes };
  let totalStock = 0;
  for (const size of SIZES) {
    sizes[size] = shirt === undefined ? [1, 2, 3, 4].reduce((sum, color) => sum + (getStock(productId, color, size) || 0), 0) : getStock(productId, shirt, size);
    totalStock += sizes[size] || 0;
  }
  return { ...snapshot, available: totalStock > 0, totalStock, sizes };
}
export function refreshInventory() {
  if (request) return request;
  state = { ...state, status: 'loading', error: null };
  request = (async () => {
    try {
      const data = await apiRequest('/inventory');
      if (!Array.isArray(data?.variants)) { const error = new Error(); error.code = 'INVENTORY_UNAVAILABLE'; throw error; }
      const next = new Map();
      for (const variant of data.variants) {
        if (!variant || typeof variant.productId !== 'string' || ![1, 2, 3, 4].includes(variant.shirt) || !SIZES.includes(variant.size) || !Number.isInteger(variant.stock) || variant.stock < 0 || next.has(keyFor(variant.productId, variant.shirt, variant.size))) { const error = new Error(); error.code = 'INVENTORY_UNAVAILABLE'; throw error; }
        next.set(keyFor(variant.productId, variant.shirt, variant.size), { ...variant });
      }
      variants = next;
      state = { status: 'ready', updatedAt: new Date().toISOString(), error: null }; emit();
      return { ...getInventoryState(), variants: [...variants.values()].map(item => ({ ...item })) };
    } catch (error) {
      state = { ...state, status: 'error', error }; emit(); throw error;
    } finally { request = null; }
  })();
  emit();
  return request;
}
export function ensureInventory() {
  if (request) return request;
  if (state.status === 'ready' && !getInventoryState().stale) return Promise.resolve({ ...getInventoryState(), variants: [...variants.values()].map(item => ({ ...item })) });
  return refreshInventory();
}
export function inventoryMessage() {
  if (state.status === 'ready') return '';
  if (state.status === 'idle' || state.status === 'loading') return l('Consultando disponibilidad…', 'Checking availability…');
  return l('No pudimos verificar el stock. Reintenta antes de comprar.', 'We could not verify stock. Please retry before buying.');
}
export const inventoryErrorMessage = () => state.error ? apiErrorMessage(state.error) : inventoryMessage();
