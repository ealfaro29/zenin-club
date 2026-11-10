import { apiRequest } from './orders-api.js?v=46';
import { l } from './i18n.js?v=46';

const MAX_AGE = 60000;
const validSize = size => typeof size === 'string' && size.trim().length > 0 && size.length <= 24;
const validShirt = shirt => Number.isSafeInteger(Number(shirt)) && Number(shirt) > 0;
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
  if (!validShirt(shirt) || !validSize(size)) return null;
  return variants.get(keyFor(productId, shirt, size))?.stock ?? 0;
}
export function getProductAvailability(productId, shirt) {
  const snapshot = getInventoryState();
  const matching=[...variants.values()].filter(variant=>variant.productId===String(productId)&&(shirt===undefined||Number(variant.shirt)===Number(shirt)));
  const sizeNames=[...new Set(matching.map(variant=>variant.size))];
  const sizes = Object.fromEntries(sizeNames.map(size => [size, null]));
  if (snapshot.status !== 'ready') return { ...snapshot, available: null, totalStock: null, sizes };
  let totalStock = 0;
  for (const size of sizeNames) {
    sizes[size] = matching.filter(variant=>variant.size===size).reduce((sum,variant)=>sum+variant.stock,0);
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
        if (!variant || typeof variant.productId !== 'string' || !validShirt(variant.shirt) || !validSize(variant.size) || !Number.isInteger(variant.stock) || variant.stock < 0 || next.has(keyFor(variant.productId, variant.shirt, variant.size))) { const error = new Error(); error.code = 'INVENTORY_UNAVAILABLE'; throw error; }
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
  return l('La información de stock no está disponible. Puedes continuar con tu compra.', 'Stock information is unavailable. You can still place your order.');
}
export const inventoryErrorMessage = () => inventoryMessage();
