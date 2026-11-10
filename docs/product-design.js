const LEGACY_SHIRTS = [
  {shirt:1,colorName:'Washed Black',hex:'#28282a'},
  {shirt:2,colorName:'Deep Teal',hex:'#008b84'},
  {shirt:3,colorName:'Dusty Violet',hex:'#65518c'},
  {shirt:4,colorName:'Faded Red',hex:'#9b4a4c'},
];
const LEGACY_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const validShirt = shirt => Number.isSafeInteger(Number(shirt)) && Number(shirt) > 0;
const imageUrl = value => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim(), globalThis.location?.href || 'https://zenin.invalid/');
    return ['https:', 'http:', 'blob:'].includes(url.protocol) ? value.trim() : '';
  } catch { return ''; }
};

/** Legacy shirt images are retained solely for historical orders without base snapshots. */
export function getShirtOptions(product) {
  if (!Array.isArray(product?.shirtOptions)) return LEGACY_SHIRTS.map(option => ({...option,imageUrl:`assets/shirt-${option.shirt}.webp`,sizes:[...LEGACY_SIZES],legacy:true}));
  const seen = new Set();
  return product.shirtOptions.filter(option => option && validShirt(option.shirt) && !seen.has(Number(option.shirt)) && seen.add(Number(option.shirt))).map(option => ({...option,shirt:Number(option.shirt),imageUrl:imageUrl(option.imageUrl)}));
}

export function getShirtOption(product, shirt = product?.shirt) {
  return getShirtOptions(product).find(option => option.shirt === Number(shirt));
}

export function getAvailableShirts(product) {
  const options = getShirtOptions(product).map(option => option.shirt);
  if (product?.availableShirts == null) return options;
  if (!Array.isArray(product.availableShirts)) return [];
  return [...new Set(product.availableShirts.map(Number).filter(shirt => validShirt(shirt) && options.includes(shirt)))];
}

export function getDefaultShirt(product) {
  const available = getAvailableShirts(product);
  const preferred = Number(product?.shirt);
  return available.includes(preferred) ? preferred : available[0] || (validShirt(preferred) ? preferred : 1);
}

export function getShirtSizes(product, shirt = getDefaultShirt(product)) {
  const sizes = getShirtOption(product, shirt)?.sizes ?? product?.sizes ?? LEGACY_SIZES;
  return Array.isArray(sizes) ? [...new Set(sizes.filter(size => typeof size === 'string' && size.trim() && size.trim().length <= 24).map(size => size.trim()))] : [];
}

export const isShirtAvailable = (product, shirt) => getAvailableShirts(product).includes(Number(shirt));

/** Public uploaded images and local object URLs used only while previewing a file. */
export const getDesignUrl = product => imageUrl(product?.designUrl);

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
function hexToHsl(hex) {
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16 & 255) / 255, g = (value >> 8 & 255) / 255, b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l, 0];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l, d];
}
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/**
 * Product photo backdrop derived from the garment color: the same hue, with
 * enough lightness contrast that dark, light and saturated shirts all stand out.
 */
export function stageColors(hex) {
  if (!HEX.test(String(hex || ''))) return { stage: '#3a3a40', glow: '#5a5a63' };
  const [h, s, l, chroma] = hexToHsl(hex);
  // Near-greys (low chroma) get a clean neutral backdrop; HSL saturation overstates tint at the extremes.
  const neutral = chroma < .07 || s < .1;
  const tone = neutral ? 0 : clamp(s * .55, .12, .42);
  const light = l < .32 ? clamp(.5 + l * .4, .5, .62) : l > .78 ? clamp(.24 + (1 - l) * .4, .22, .34) : l < .55 ? clamp(l + .26, .55, .72) : clamp(l - .3, .25, .42);
  return { stage: hsl(neutral ? 0 : h, neutral ? 0 : tone, light), glow: hsl(neutral ? 0 : h, neutral ? 0 : tone * .8, clamp(light + .16, 0, .86)) };
}
export const stageStyle = hex => { const { stage, glow } = stageColors(hex); return `--stage:${stage};--stage-glow:${glow}`; };

export const DEFAULT_PRINT_AREA = Object.freeze({ x: 33, y: 29.2, w: 34, h: 40 });
export function printAreaStyle(area) {
  const value = area && ['x', 'y', 'w', 'h'].every(key => Number.isFinite(Number(area[key]))) ? area : DEFAULT_PRINT_AREA;
  return `--print-x:${Number(value.x)}%;--print-y:${Number(value.y)}%;--print-w:${Number(value.w)}%;--print-h:${Number(value.h)}%`;
}

export const isArticle = product => product?.kind === 'article';
export const printSides = product => isArticle(product) ? 'none' : ['front', 'back', 'both'].includes(product?.printSides) ? product.printSides : 'front';
export const hasBackView = product => !isArticle(product) && printSides(product) !== 'front' && Boolean(imageUrl(product?.backDesignUrl));
export function sideDesignUrl(product, side = 'front') {
  if (isArticle(product)) return '';
  const sides = printSides(product);
  if (side === 'back') return sides === 'front' ? '' : imageUrl(product?.backDesignUrl) || (sides === 'back' ? imageUrl(product?.designUrl) : '');
  return sides === 'back' ? '' : imageUrl(product?.frontDesignUrl) || imageUrl(product?.designUrl);
}
/** Preferred side to present a product: back-only prints show the back photo. */
export const primarySide = product => printSides(product) === 'back' ? 'back' : 'front';

export function getOptionPrice(product, shirt = getDefaultShirt(product)) {
  const price = Number(getShirtOption(product, shirt)?.price);
  return Number.isFinite(price) && price > 0 ? price : Number(product?.price) || 0;
}
export function getPriceRange(product) {
  const prices = getAvailableShirts(product).map(shirt => getOptionPrice(product, shirt)).filter(price => price > 0);
  if (!prices.length) return { min: Number(product?.price) || 0, max: Number(product?.price) || 0 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
