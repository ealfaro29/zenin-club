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
