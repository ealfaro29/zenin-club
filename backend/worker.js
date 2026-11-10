const COLORS = { 1: 'Washed Black', 2: 'Deep Teal', 3: 'Dusty Violet', 4: 'Faded Red' };
const COLLECTIONS = { originals: 'Zenin Originals', food: 'Food Court', faces: 'Mood Swings', objects: 'Everyday Objects', cars: 'After Hours' };
const SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL']);
const STATUSES = new Set(['new', 'preparing', 'ready', 'shipped', 'cancelled']);
const ORIGINS = new Set(['https://zeninclub.shop', 'https://www.zeninclub.shop', 'https://ealfaro29.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173']);
const MAX_BODY = 32 * 1024;
const MAX_DESIGN_BYTES = 5 * 1024 * 1024;
const MAX_DESIGN_SIDE = 8192;
const MAX_DESIGN_PIXELS = 16 * 1024 * 1024;
const SESSION_SECONDS = 6 * 60 * 60;
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const failure = (status, code, message, extra) => { throw new ApiError(status, code, message, extra); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const decode64 = text => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
};
const constantEqual = (left, right) => {
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return different === 0;
};

function requireDatabase(env) {
  if (!env.DB?.prepare) failure(503, 'SERVICE_UNAVAILABLE', 'Order storage is unavailable.');
}

function requireSecret(env) {
  if (typeof env.ADMIN_SESSION_SECRET !== 'string' || env.ADMIN_SESSION_SECRET.length < 32) {
    failure(503, 'SERVICE_UNAVAILABLE', 'Order service is not configured.');
  }
}

async function hmac(env, value) {
  requireSecret(env);
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.ADMIN_SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(value));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    failure(415, 'JSON_REQUIRED', 'Send an application/json request.');
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) {
    failure(413, 'BODY_TOO_LARGE', 'Request exceeds 32 KB.');
  }
  const reader = request.body?.getReader();
  if (!reader) failure(400, 'INVALID_JSON', 'A JSON object is required.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) {
        await reader.cancel();
        failure(413, 'BODY_TOO_LARGE', 'Request exceeds 32 KB.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { failure(400, 'INVALID_JSON', 'A valid JSON object is required.'); }
  if (!object(body)) failure(400, 'INVALID_JSON', 'A JSON object is required.');
  return body;
}

const offeredShirts = product => product.availableShirts || [1, 2, 3, 4];
const designPath = id => `/designs/${id}.png`;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function pngDimensions(bytes) {
  const invalid = () => failure(400, 'INVALID_PNG', 'Upload a valid, complete PNG image.');
  if (bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, colorType = 0, palette = false, imageData = false, dataEnded = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    let crc = 0xffffffff;
    for (let index = offset + 4; index < offset + 8 + length; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset + 8 + length)) invalid();
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) invalid();
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      if (!width || !height || width > MAX_DESIGN_SIDE || height > MAX_DESIGN_SIDE || width * height > MAX_DESIGN_PIXELS) {
        failure(400, 'DESIGN_DIMENSIONS', 'PNG dimensions must be at most 8192 per side and 16 megapixels.');
      }
      colorType = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[colorType]?.includes(bytes[offset + 16]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (type === 'IHDR') invalid();
    else if (type === 'PLTE') {
      if (palette || imageData || !length || length % 3 || length > 768 || [0, 4].includes(colorType)) invalid();
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (colorType === 3 && !palette)) invalid();
      if (length) imageData = true;
    } else if (type === 'IEND') {
      if (length || !imageData || offset + 12 !== bytes.length) invalid();
      return { width, height };
    } else {
      if (type[0] === type[0].toUpperCase()) invalid();
      if (imageData) dataEnded = true;
    }
    offset += length + 12;
  }
  invalid();
}

async function uploadDesign(request, env, actor) {
  if (!env.DESIGNS?.put) failure(503, 'DESIGN_STORAGE_UNAVAILABLE', 'Design storage is not configured.');
  if (!/^image\/png(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) failure(415, 'PNG_REQUIRED', 'Upload a PNG with Content-Type image/png.');
  if (Number(request.headers.get('Content-Length')) > MAX_DESIGN_BYTES) failure(413, 'DESIGN_TOO_LARGE', 'PNG files must be at most 5 MiB.');
  // Authenticated launch wizards upload many shirt photos and artwork in one sitting.
  await rateLimit(request, env, 'design-upload', 400, 900);
  const reader = request.body?.getReader();
  if (!reader) failure(400, 'INVALID_PNG', 'Upload a PNG image.');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DESIGN_BYTES) { await reader.cancel(); failure(413, 'DESIGN_TOO_LARGE', 'PNG files must be at most 5 MiB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const dimensions = pngDimensions(bytes);
  const id = hex(await crypto.subtle.digest('SHA-256', bytes));
  const key = `designs/${id}.png`;
  // Immutable, content-addressed objects make repeated uploads safe. Retain old
  // designs because archived products and order snapshots continue to use them.
  await env.DESIGNS.put(key, bytes, { httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(`INSERT INTO design_assets(id, object_key, byte_length, width, height, created_at, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, key, length, dimensions.width, dimensions.height, new Date().toISOString(), actor).run();
  return json({ designId: id, designUrl: new URL(designPath(id), request.url).href, ...dimensions, byteLength: length }, 201);
}

async function serveDesign(request, env, id) {
  const asset = await env.DB.prepare('SELECT * FROM design_assets WHERE id = ?').bind(id).first();
  if (!asset || !env.DESIGNS?.get) failure(404, 'DESIGN_NOT_FOUND', 'Design was not found.');
  const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${id}"` };
  if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
  const object = await env.DESIGNS.get(asset.object_key);
  if (!object) failure(404, 'DESIGN_NOT_FOUND', 'Design was not found.');
  headers['Content-Length'] = String(asset.byte_length);
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_TYPES = { mp4: 'video/mp4', webm: 'video/webm' };

/** MP4/QuickTime start with an ftyp box; WebM with the EBML magic number. */
function videoKind(bytes) {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return '';
}

async function uploadVideo(request, env, actor) {
  if (!env.DESIGNS?.put) failure(503, 'DESIGN_STORAGE_UNAVAILABLE', 'Media storage is not configured.');
  if (!/^video\/(mp4|webm|quicktime)(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) failure(415, 'VIDEO_REQUIRED', 'Upload an MP4 or WebM video.');
  const declared = Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(declared) || declared < 1) failure(411, 'LENGTH_REQUIRED', 'Send the video size.');
  if (declared > MAX_VIDEO_BYTES) failure(413, 'VIDEO_TOO_LARGE', 'Videos must be at most 50 MiB.');
  await rateLimit(request, env, 'video-upload', 60, 900);
  const reader = request.body?.getReader();
  if (!reader) failure(400, 'INVALID_VIDEO', 'Upload a video.');
  // One preallocated buffer keeps memory at the declared size inside the Worker limit.
  const bytes = new Uint8Array(declared);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > declared) { await reader.cancel(); failure(400, 'INVALID_VIDEO', 'The video size does not match.'); }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (length !== declared) failure(400, 'INVALID_VIDEO', 'The video upload is incomplete.');
  const kind = videoKind(bytes);
  if (!kind) failure(400, 'INVALID_VIDEO', 'Upload a valid MP4 or WebM video.');
  const id = hex(await crypto.subtle.digest('SHA-256', bytes));
  const key = `videos/${id}.${kind}`;
  await env.DESIGNS.put(key, bytes, { httpMetadata: { contentType: VIDEO_TYPES[kind], cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(`INSERT INTO video_assets(id, object_key, content_type, byte_length, created_at, actor)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(id, key, VIDEO_TYPES[kind], length, new Date().toISOString(), actor).run();
  return json({ videoId: id, videoUrl: new URL(`/videos/${id}.${kind}`, request.url).href, contentType: VIDEO_TYPES[kind], byteLength: length }, 201);
}

/** Byte-range responses let Safari and iOS stream and seek uploaded videos. */
async function serveVideo(request, env, id, extension) {
  const asset = await env.DB.prepare('SELECT * FROM video_assets WHERE id = ?').bind(id).first();
  if (!asset || !asset.object_key.endsWith(`.${extension}`) || !env.DESIGNS?.get) failure(404, 'VIDEO_NOT_FOUND', 'Video was not found.');
  const size = Number(asset.byte_length);
  const headers = { 'Content-Type': asset.content_type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${id}"` };
  const range = request.headers.get('Range');
  if (!range) {
    if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers });
    const object = request.method === 'HEAD' ? null : await env.DESIGNS.get(asset.object_key);
    if (request.method !== 'HEAD' && !object) failure(404, 'VIDEO_NOT_FOUND', 'Video was not found.');
    return new Response(object ? object.body : null, { headers: { ...headers, 'Content-Length': String(size) } });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = match && match[1] !== '' ? Number(match[1]) : NaN;
  let end = match && match[2] !== '' ? Number(match[2]) : size - 1;
  if (match && match[1] === '' && match[2] !== '') { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  if (!match || !Number.isSafeInteger(start) || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  const object = request.method === 'HEAD' ? null : await env.DESIGNS.get(asset.object_key, { range: { offset: start, length: end - start + 1 } });
  if (request.method !== 'HEAD' && !object) failure(404, 'VIDEO_NOT_FOUND', 'Video was not found.');
  return new Response(object ? object.body : null, { status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
}

async function validateVideoUrl(value, request, env) {
  let url;
  try { url = new URL(value, request.url); } catch { failure(400, 'INVALID_VIDEO_URL', 'Choose a video uploaded to this store.'); }
  const match = url.pathname.match(/^\/videos\/([a-f0-9]{64})\.(mp4|webm)$/);
  if (url.origin !== new URL(request.url).origin || url.username || url.password || !match || url.search || url.hash ||
      !(await env.DB.prepare('SELECT id FROM video_assets WHERE id = ?').bind(match[1]).first())) {
    failure(400, 'INVALID_VIDEO_URL', 'Choose a video uploaded to this store.');
  }
  return url.href;
}

/** Video lists for collections and landing slides: uploaded video plus optional PNG poster. */
async function videoListInput(value, request, env, field, max = 6) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) failure(400, 'INVALID_FIELD', `Choose up to ${max} videos.`, { field });
  const videos = [];
  for (const item of value) {
    if (!object(item)) failure(400, 'INVALID_FIELD', 'Invalid video.', { field });
    const posterUrl = text(item.posterUrl ?? '', 'posterUrl', { min: 0, max: 500 });
    videos.push({ url: await validateVideoUrl(text(item.url, 'videoUrl', { max: 500 }), request, env),
      posterUrl: posterUrl ? await validateDesignUrl(posterUrl, request, env) : '' });
  }
  return videos;
}

const LINK = /^(#[A-Za-z0-9/_:.-]{0,160}|https:\/\/[^\s"'<>]{4,300})$/;
async function landingInput(body, request, env) {
  const slides = body.slides;
  if (!Array.isArray(slides) || slides.length > 6) failure(400, 'INVALID_FIELD', 'Choose up to six slides.', { field: 'slides' });
  const normalized = [];
  for (const slide of slides) {
    if (!object(slide)) failure(400, 'INVALID_FIELD', 'Invalid slide.', { field: 'slides' });
    const [video] = await videoListInput([{ url: slide.videoUrl, posterUrl: slide.posterUrl }], request, env, 'slides', 1);
    const link = text(slide.link ?? '', 'link', { min: 0, max: 300 });
    if (link && !LINK.test(link)) failure(400, 'INVALID_FIELD', 'Use a store link or an https address.', { field: 'link' });
    const optional = (field, max) => text(slide[field], field, { min: 0, max, optional: true });
    normalized.push({ videoUrl: video.url, posterUrl: video.posterUrl, title: optional('title', 60), titleEn: optional('titleEn', 60),
      subtitle: optional('subtitle', 140), subtitleEn: optional('subtitleEn', 140), buttonLabel: optional('buttonLabel', 30),
      buttonLabelEn: optional('buttonLabelEn', 30), link });
  }
  return { slides: normalized };
}

async function readLanding(env) {
  const row = await env.DB.prepare(`SELECT * FROM site_settings WHERE key = 'landing'`).first();
  return row ? { ...JSON.parse(row.value_json), version: Number(row.version), updatedAt: row.updated_at } : { slides: [], version: 0, updatedAt: null };
}

async function saveLanding(request, env) {
  const body = await readJson(request);
  if (!Number.isSafeInteger(body.version) || body.version < 0) failure(400, 'INVALID_FIELD', 'Invalid settings version.', { field: 'version' });
  const landing = await landingInput(body, request, env);
  const current = await readLanding(env);
  if (current.version !== body.version) failure(409, 'SETTINGS_CHANGED', 'The landing changed. Refresh and review it.');
  const now = new Date().toISOString();
  const saved = await env.DB.prepare(`INSERT INTO site_settings(key, version, value_json, updated_at) VALUES ('landing', 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET version = site_settings.version + 1, value_json = excluded.value_json, updated_at = excluded.updated_at
    WHERE site_settings.version = ? RETURNING version`).bind(JSON.stringify(landing), now, body.version).first();
  if (!saved) failure(409, 'SETTINGS_CHANGED', 'The landing changed. Refresh and review it.');
  return json({ landing: await readLanding(env) });
}

async function adminPaymentSettings(env) {
  const stored = await readPaymentSettings(env);
  const key = await openSecret(env, stored.key);
  return { provider: 'tilopay', enabled: Boolean(stored.enabled), apiUser: stored.apiUser || '', hasPassword: Boolean(stored.password),
    keyHint: key ? `••••${key.slice(-4)}` : '', verifiedAt: stored.verifiedAt || null, version: stored.version, updatedAt: stored.updatedAt || null,
    usingWorkerSecrets: !stored.version && Boolean(env.TILOPAY_API_USER && env.TILOPAY_API_PASSWORD && env.TILOPAY_KEY) };
}

/** Logs in with the API credentials and with the integration key (SDK login), so a wrong key is caught before going live. */
async function verifyTilopay(env, config) {
  const api = await tilopayLogin(env, config);
  if (!api.access_token) failure(400, 'PAYMENT_CREDENTIALS_INVALID', 'Tilopay rejected the API user or password.');
  const sdk = await tilopayLogin(env, config, 'loginSdk');
  if (!sdk.access_token) failure(400, 'PAYMENT_KEY_INVALID', 'Tilopay rejected the integration key.');
  return { ok: true, environment: typeof sdk.environment === 'string' ? sdk.environment : null };
}

async function paymentInput(body, env, stored) {
  const apiUser = body.apiUser !== undefined ? text(body.apiUser, 'apiUser', { min: 0, max: 120 }) : stored.apiUser || '';
  const password = body.password ? text(body.password, 'password', { min: 1, max: 200 }) : await openSecret(env, stored.password);
  const key = body.key ? text(body.key, 'key', { min: 4, max: 200 }) : await openSecret(env, stored.key);
  return { apiUser, password, key };
}

async function testPaymentSettings(request, env) {
  await rateLimit(request, env, 'payment-test', 20, 900);
  const body = await readJson(request);
  const config = await paymentInput(body, env, await readPaymentSettings(env));
  if (!config.apiUser || !config.password || !config.key) failure(400, 'PAYMENT_CREDENTIALS_MISSING', 'Enter the API user, password and integration key.');
  return json(await verifyTilopay(env, config));
}

async function savePaymentSettings(request, env) {
  const body = await readJson(request);
  if (!Number.isSafeInteger(body.version) || body.version < 0) failure(400, 'INVALID_FIELD', 'Invalid settings version.', { field: 'version' });
  if (typeof body.enabled !== 'boolean') failure(400, 'INVALID_FIELD', 'Choose whether payments are enabled.', { field: 'enabled' });
  const stored = await readPaymentSettings(env);
  if (stored.version !== body.version) failure(409, 'SETTINGS_CHANGED', 'Payment settings changed. Refresh and review them.');
  const config = await paymentInput(body, env, stored);
  let verifiedAt = stored.verifiedAt || null;
  const changed = config.apiUser !== stored.apiUser || Boolean(body.password) || Boolean(body.key);
  if (body.enabled) {
    if (!config.apiUser || !config.password || !config.key) failure(400, 'PAYMENT_CREDENTIALS_MISSING', 'Enter the API user, password and integration key.');
    if (changed || !stored.enabled || !verifiedAt) { await verifyTilopay(env, config); verifiedAt = new Date().toISOString(); }
  } else if (changed) verifiedAt = null;
  const value = { provider: 'tilopay', enabled: body.enabled, apiUser: config.apiUser,
    password: config.password ? await sealSecret(env, config.password) : null, key: config.key ? await sealSecret(env, config.key) : null, verifiedAt };
  const now = new Date().toISOString();
  const saved = await env.DB.prepare(`INSERT INTO site_settings(key, version, value_json, updated_at) VALUES ('payments', 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET version = site_settings.version + 1, value_json = excluded.value_json, updated_at = excluded.updated_at
    WHERE site_settings.version = ? RETURNING version`).bind(JSON.stringify(value), now, body.version).first();
  if (!saved) failure(409, 'SETTINGS_CHANGED', 'Payment settings changed. Refresh and review them.');
  settingsCache = null;
  tilopayToken = null;
  return json({ payments: await adminPaymentSettings(env) });
}

async function validateDesignUrl(value, request, env) {
  if (!value) return;
  let url;
  try { url = new URL(value, request.url); } catch { failure(400, 'INVALID_DESIGN', 'Choose a PNG uploaded to this store.'); }
  const match = url.pathname.match(/^\/designs\/([a-f0-9]{64})\.png$/);
  if (url.origin !== new URL(request.url).origin || url.username || url.password || !match || url.search || url.hash ||
      !(await env.DB.prepare('SELECT id FROM design_assets WHERE id = ?').bind(match[1]).first())) {
    failure(400, 'INVALID_DESIGN', 'Choose a PNG uploaded to this store.');
  }
  return url.href;
}

const BASE_KINDS = new Set(['garment', 'article', 'all']);

/** Garment bases are shirt types; article bases are the hidden variant sets of non-apparel articles. */
async function readBases(env, includeArchived = false, kind = 'garment') {
  const bases = await env.DB.prepare(`SELECT * FROM garment_bases ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY created_at, id`).all();
  const colors = await env.DB.prepare('SELECT * FROM garment_colors WHERE active = 1 ORDER BY shirt').all();
  const all = bases.results.map(row => {
    const details = JSON.parse(row.base_json);
    return { id: row.id, ...details, kind: details.kind === 'article' ? 'article' : 'garment', active: Boolean(row.active),
      version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at,
      colors: colors.results.filter(color => color.base_id === row.id).map(color => ({ shirt: Number(color.shirt), ...JSON.parse(color.color_json) })) };
  });
  return kind === 'all' ? all : all.filter(base => base.kind === kind);
}

const optionFor = (base, color) => ({ shirt: color.shirt, baseId: base.id, baseName: base.name, type: base.type,
  weightGsm: base.weightGsm, colorName: color.name, hex: color.hex, imageUrl: color.imageUrl,
  ...(color.backImageUrl ? { backImageUrl: color.backImageUrl } : {}), ...(base.printArea ? { printArea: base.printArea } : {}),
  sizes: base.sizes, kind: base.kind || 'garment' });

function printAreaInput(value) {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) failure(400, 'INVALID_FIELD', 'Invalid print area.', { field: 'printArea' });
  const area = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const number = value[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100) failure(400, 'INVALID_FIELD', 'Invalid print area.', { field: 'printArea' });
    area[key] = Math.round(number * 10) / 10;
  }
  if (area.w < 5 || area.h < 5 || area.x + area.w > 100.05 || area.y + area.h > 100.05) failure(400, 'INVALID_FIELD', 'Print area must fit inside the photo.', { field: 'printArea' });
  return area;
}

function priceInput(value, field = 'price') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01 || value > 10000 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    failure(400, 'INVALID_FIELD', 'Price must be between 0.01 and 10000 with at most two decimal places.', { field });
  }
  return Math.round(value * 100) / 100;
}

async function baseInput(body, request, env, previous = null) {
  const value = field => body[field] !== undefined ? body[field] : previous?.[field];
  const sizes = value('sizes');
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 20 ||
      sizes.some(size => typeof size !== 'string' || !/^[\p{L}\p{N} _.+-]{1,24}$/u.test(size) || size !== size.trim()) || new Set(sizes).size !== sizes.length) {
    failure(400, 'INVALID_FIELD', 'Choose one to twenty distinct sizes.', { field: 'sizes' });
  }
  const weightGsm = value('weightGsm') ?? 0;
  if (!Number.isInteger(weightGsm) || weightGsm < 0 || weightGsm > 2000) failure(400, 'INVALID_FIELD', 'Weight must be 0 to 2000 gsm.', { field: 'weightGsm' });
  const inputColors = value('colors');
  if (!Array.isArray(inputColors) || !inputColors.length || inputColors.length > 30) failure(400, 'INVALID_FIELD', 'Choose one to thirty colors.', { field: 'colors' });
  const colors = [];
  const ids = new Set();
  for (const color of inputColors) {
    if (!object(color)) failure(400, 'INVALID_FIELD', 'Invalid color.', { field: 'colors' });
    const shirt = color.shirt;
    if (shirt !== undefined && (!previous?.colors.some(option => option.shirt === shirt) || ids.has(shirt))) failure(400, 'INVALID_COLOR', 'Choose a color belonging to this base.');
    if (shirt !== undefined) ids.add(shirt);
    const name = text(color.name, 'colorName', { max: 80 });
    const colorHex = text(color.hex, 'hex', { max: 7 });
    if (!/^#[a-f0-9]{6}$/i.test(colorHex)) failure(400, 'INVALID_FIELD', 'Use a six-digit hex color.', { field: 'hex' });
    const imageUrl = text(color.imageUrl, 'imageUrl', { max: 500 });
    const backImageUrl = text(color.backImageUrl, 'backImageUrl', { min: 0, max: 500, optional: true });
    colors.push({ ...(shirt === undefined ? {} : { shirt }), name, hex: colorHex.toLowerCase(), imageUrl: await validateDesignUrl(imageUrl, request, env),
      ...(backImageUrl ? { backImageUrl: await validateDesignUrl(backImageUrl, request, env) } : {}) });
  }
  const printArea = printAreaInput(value('printArea'));
  return { name: text(value('name'), 'name', { min: 2, max: 120 }), type: text(value('type'), 'type', { min: 2, max: 80 }), weightGsm, sizes, colors,
    ...(printArea ? { printArea } : {}) };
}

async function createBase(request, env) {
  const body = await readJson(request);
  const normalized = await baseInput(body, request, env);
  const { colors, ...base } = normalized;
  const key = text(body.idempotencyKey ?? crypto.randomUUID(), 'idempotencyKey', { min: 8, max: 128 });
  const keyHash = await sha256(`zenin:base-create:${key}`), requestHash = await sha256(JSON.stringify(normalized));
  const existing = await env.DB.prepare('SELECT * FROM garment_bases WHERE creation_key_hash = ?').bind(keyHash).first();
  const replay = async row => {
    if (row.creation_request_hash !== requestHash) failure(409, 'IDEMPOTENCY_CONFLICT', 'This creation identifier was used for another base.');
    return json({ base: (await readBases(env, true, 'all')).find(base => base.id === row.id) });
  };
  if (existing) return replay(existing);
  const id = `base-${crypto.randomUUID()}`, now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO garment_bases(id, base_json, created_at, updated_at, creation_key_hash, creation_request_hash)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(id, JSON.stringify({ ...base, kind: 'garment' }), now, now, keyHash, requestHash),
      ...colors.map(color => env.DB.prepare(`INSERT INTO garment_colors(shirt, base_id, color_json)
        VALUES ((SELECT MAX(COALESCE(MAX(shirt), 99), 99) + 1 FROM garment_colors), ?, ?)`).bind(id, JSON.stringify(color))),
    ]);
  } catch (error) {
    const winner = await env.DB.prepare('SELECT * FROM garment_bases WHERE creation_key_hash = ?').bind(keyHash).first();
    if (winner) return replay(winner);
    throw error;
  }
  return json({ base: (await readBases(env, true, 'all')).find(base => base.id === id) }, 201);
}

async function changeBase(request, env, id) {
  const previous = (await readBases(env, true, 'all')).find(base => base.id === id);
  if (!previous) failure(404, 'BASE_NOT_FOUND', 'Base was not found.');
  if (previous.kind === 'article') failure(400, 'ARTICLE_BASE', 'Edit article variants from the article editor.');
  const body = await readJson(request), version = catalogVersion(body.version);
  if (version !== previous.version) failure(409, 'BASE_CHANGED', 'This base changed. Refresh and review it.');
  if (request.method === 'DELETE' && !previous.active) return json({ base: previous, archived: true });
  if (request.method === 'PATCH' && body.active === true && !previous.active) {
    const restored = await env.DB.prepare(`UPDATE garment_bases SET active = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? RETURNING id`)
      .bind(new Date().toISOString(), id, version).first();
    if (!restored) failure(409, 'BASE_CHANGED', 'This base changed. Refresh and review it.');
    return json({ base: (await readBases(env, true, 'all')).find(base => base.id === id) });
  }
  const normalized = request.method === 'DELETE' ? previous : await baseInput(body, request, env, previous);
  const { colors, name, type, weightGsm, sizes, printArea } = normalized;
  const sizesChanged = JSON.stringify(sizes) !== JSON.stringify(previous.sizes);
  const removing = request.method === 'DELETE' ? previous.colors.map(color => color.shirt) : previous.colors.filter(color => !colors.some(next => next.shirt === color.shirt)).map(color => color.shirt);
  if (removing.length || sizesChanged) {
    const products = await env.DB.prepare('SELECT product_json FROM products WHERE active = 1').all();
    if (sizesChanged && products.results.some(row => JSON.parse(row.product_json).shirtOptions?.some(option => option.baseId === id))) {
      failure(409, 'BASE_SIZE_IN_USE', 'An active product uses these sizes. Archive or update that product before changing base sizes.');
    }
    if (products.results.some(row => offeredShirts(JSON.parse(row.product_json)).some(shirt => removing.includes(shirt)))) {
      failure(409, request.method === 'DELETE' ? 'BASE_IN_USE' : 'BASE_COLOR_IN_USE', 'An active product uses this base or color. Remove it from that product first.');
    }
  }
  const mutation = crypto.randomUUID(), now = new Date().toISOString();
  const statements = [env.DB.prepare(`UPDATE garment_bases SET base_json = ?, active = ?, version = version + 1, updated_at = ?, mutation_key = ?
    WHERE id = ? AND version = ?`).bind(JSON.stringify({ name, type, weightGsm, sizes, kind: 'garment', ...(printArea ? { printArea } : {}) }),
    request.method === 'DELETE' ? 0 : 1, now, mutation, id, version)];
  if (request.method !== 'DELETE') {
    for (const color of colors) {
      const { shirt, ...details } = color;
      statements.push(shirt === undefined ?
        env.DB.prepare(`INSERT INTO garment_colors(shirt, base_id, color_json)
          SELECT (SELECT MAX(COALESCE(MAX(shirt), 99), 99) + 1 FROM garment_colors), ?, ?
          FROM garment_bases WHERE id = ? AND mutation_key = ?`).bind(id, JSON.stringify(details), id, mutation) :
        env.DB.prepare(`UPDATE garment_colors SET color_json = ? WHERE shirt = ? AND base_id = ?
          AND EXISTS (SELECT 1 FROM garment_bases WHERE id = ? AND mutation_key = ?)`)
          .bind(JSON.stringify(details), shirt, id, id, mutation));
    }
    for (const shirt of removing) statements.push(env.DB.prepare(`UPDATE garment_colors SET active = 0 WHERE shirt = ? AND base_id = ?
      AND EXISTS (SELECT 1 FROM garment_bases WHERE id = ? AND mutation_key = ?)`).bind(shirt, id, id, mutation));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
    if (/BASE_SIZE_IN_USE/.test(message)) failure(409, 'BASE_SIZE_IN_USE', 'An active product uses these sizes.');
    if (/BASE_COLOR_IN_USE|BASE_IN_USE/.test(message)) failure(409, request.method === 'DELETE' ? 'BASE_IN_USE' : 'BASE_COLOR_IN_USE', 'An active product uses this base or color.');
    throw error;
  }
  const updated = await env.DB.prepare('SELECT mutation_key FROM garment_bases WHERE id = ?').bind(id).first();
  if (updated.mutation_key !== mutation) failure(409, 'BASE_CHANGED', 'This base changed. Refresh and review it.');
  return json({ base: (await readBases(env, true, 'all')).find(base => base.id === id), ...(request.method === 'DELETE' ? { archived: true } : {}) });
}

/** Resolve offered colors from the current bases; every used base gets an explicit price. */
async function applyProductBases(product, request, env, bases = null) {
  const wanted = product.kind === 'article' ? 'article' : 'garment';
  const available = (bases || await readBases(env, false, 'all')).filter(base => base.kind === wanted);
  const options = available.flatMap(base => base.colors.map(color => optionFor(base, color)));
  product.shirtOptions = product.availableShirts.map(shirt => options.find(option => option.shirt === shirt));
  if (product.shirtOptions.some(option => !option)) failure(400, 'INVALID_COLOR', 'Choose colors from active product bases.');
  if (product.kind === 'article' && new Set(product.shirtOptions.map(option => option.baseId)).size !== 1) {
    failure(400, 'INVALID_COLOR', 'An article offers the variants of a single article.');
  }
  if (product.kind !== 'article' && ['back', 'both'].includes(product.printSides) && product.shirtOptions.some(option => !option.backImageUrl)) {
    failure(400, 'BACK_PHOTO_REQUIRED', 'Every selected color needs a back photo for back prints.');
  }
  const used = [...new Set(product.shirtOptions.map(option => option.baseId))];
  const fallback = product.price;
  product.basePrices = Object.fromEntries(used.map(baseId => [baseId, product.basePrices?.[baseId] ?? fallback]));
  product.shirtOptions = product.shirtOptions.map(option => ({ ...option, price: product.basePrices[option.baseId] }));
  product.price = Math.min(...Object.values(product.basePrices));
  product.colorName = product.shirtOptions.find(option => option.shirt === product.shirt).colorName;
  return product;
}

const collectionFromRow = row => ({ id: row.id, slug: row.slug, ...JSON.parse(row.collection_json), sortOrder: Number(row.sort_order),
  active: Number(row.active) === 1, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at });

async function readCollections(env, includeArchived = false) {
  const rows = await env.DB.prepare(`SELECT * FROM collections ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY sort_order, created_at, id`).all();
  return rows.results.map(collectionFromRow);
}

async function applyCollection(product, env) {
  if (product.collectionId) {
    const row = await env.DB.prepare('SELECT * FROM collections WHERE id = ? AND active = 1').bind(product.collectionId).first();
    if (!row) failure(400, 'INVALID_COLLECTION', 'Choose an active collection.');
    const collection = collectionFromRow(row);
    Object.assign(product, { category: collection.slug, collection: collection.name, collectionEs: collection.nameEs || '' });
  } else Object.assign(product, { collection: product.category === 'originals' ? 'Zenin Originals' : '', collectionEs: '' });
  return product;
}

async function applyCatalogContext(product, request, env) {
  if (product.kind === 'article') Object.assign(product, { frontDesignUrl: '', backDesignUrl: '', designUrl: '' });
  else {
    product.frontDesignUrl = product.frontDesignUrl ? await validateDesignUrl(product.frontDesignUrl, request, env) : '';
    product.backDesignUrl = product.backDesignUrl ? await validateDesignUrl(product.backDesignUrl, request, env) : '';
    product.designUrl = product.frontDesignUrl || product.backDesignUrl;
  }
  await applyCollection(product, env);
  return applyProductBases(product, request, env);
}

/** Public reads always reflect current base photos, colors, prices and collection names. */
async function currentProductOptions(products, env) {
  if (products.every(product => !product.shirtOptions && !product.collectionId)) return products;
  const bases = await readBases(env, false, 'all');
  const collections = new Map((await readCollections(env, true)).map(collection => [collection.id, collection]));
  const options = new Map(bases.flatMap(base => base.colors.map(color => [color.shirt, optionFor(base, color)])));
  return products.map(product => {
    const collection = product.collectionId ? collections.get(product.collectionId) : null;
    const current = collection ? { ...product, category: collection.slug, collection: collection.name, collectionEs: collection.nameEs || '' } : product;
    if (!product.shirtOptions) return current;
    const shirtOptions = product.shirtOptions.map(option => {
      const next = options.get(option.shirt) || option;
      return { ...next, price: product.basePrices?.[next.baseId] ?? option.price ?? product.price };
    });
    return { ...current, shirtOptions, colorName: shirtOptions.find(option => option.shirt === product.shirt)?.colorName || product.colorName };
  });
}

function text(value, field, { min = 1, max = 120, optional = false, multiline = false } = {}) {
  if ((value === undefined || value === null) && optional) return '';
  if (typeof value !== 'string') failure(400, 'INVALID_FIELD', `Invalid ${field}.`, { field });
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < min || normalized.length > max ||
      (multiline ? /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/ : /[\x00-\x1F\x7F]/).test(normalized)) {
    failure(400, 'INVALID_FIELD', `Invalid ${field}.`, { field });
  }
  return normalized;
}

function email(value) {
  const normalized = text(value, 'email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    failure(400, 'INVALID_FIELD', 'Invalid email.', { field: 'email' });
  }
  return normalized;
}

function orderInput(body) {
  if (!object(body.customer)) failure(400, 'INVALID_CUSTOMER', 'Customer details are required.');
  const customer = {
    name: text(body.customer.name, 'name', { min: 2 }),
    email: email(body.customer.email),
    address: text(body.customer.address, 'address', { min: 5, max: 200 }),
    apartment: text(body.customer.apartment, 'apartment', { min: 0, max: 120, optional: true }),
    city: text(body.customer.city, 'city', { min: 2, max: 100 }),
    postal: text(body.customer.postal, 'postal', { min: 0, max: 20, optional: true }),
    country: text(body.customer.country, 'country', { min: 2, max: 80 }),
    phone: text(body.customer.phone, 'phone', { min: 0, max: 30, optional: true }),
    state: text(body.customer.state, 'state', { min: 0, max: 60, optional: true }),
  };
  if (customer.phone && !/^\+?[0-9\s().-]{7,30}$/.test(customer.phone)) failure(400, 'INVALID_FIELD', 'Invalid phone.', { field: 'phone' });
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
    failure(400, 'INVALID_ITEMS', 'Choose between 1 and 40 items.');
  }
  const variants = new Map();
  let count = 0;
  for (const item of body.items) {
    if (!object(item) || typeof item.productId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.productId)) {
      failure(400, 'INVALID_PRODUCT', 'A product is unavailable.');
    }
    if (!Number.isSafeInteger(item.shirt) || item.shirt < 1) {
      failure(400, 'INVALID_COLOR', 'Choose a valid shirt color.');
    }
    if (typeof item.size !== 'string' || !item.size.trim() || item.size.length > 24) failure(400, 'INVALID_SIZE', 'Choose a valid size.');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      failure(400, 'INVALID_QUANTITY', 'Quantity must be between 1 and 10.');
    }
    count += item.quantity;
    const key = `${item.productId}:${item.shirt}:${item.size}`;
    const quantity = (variants.get(key)?.quantity || 0) + item.quantity;
    if (quantity > 10 || count > 50) failure(400, 'INVALID_QUANTITY', 'Order quantity limit exceeded.');
    variants.set(key, { productId: item.productId, shirt: item.shirt, size: item.size, quantity });
  }
  const items = [...variants.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
  const discountCode = text(body.discountCode, 'discountCode', { min: 0, max: 32, optional: true }).toUpperCase();
  if (discountCode && discountCode !== 'ZENIN10') failure(400, 'INVALID_DISCOUNT', 'Discount code is invalid.');
  const language = body.language ?? 'es';
  if (language !== 'es' && language !== 'en') failure(400, 'INVALID_LANGUAGE', 'Choose es or en.');
  const idempotencyKey = text(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 128 });
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) failure(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid checkout identifier.');
  // Where the customer returns after paying: only the storefront origins this API serves.
  let returnUrl = '';
  if (body.returnUrl !== undefined && body.returnUrl !== null && body.returnUrl !== '') {
    let url;
    try { url = new URL(text(body.returnUrl, 'returnUrl', { max: 300 })); } catch { failure(400, 'INVALID_FIELD', 'Invalid return address.', { field: 'returnUrl' }); }
    if (!ORIGINS.has(url.origin) || url.username || url.password) failure(400, 'INVALID_FIELD', 'Invalid return address.', { field: 'returnUrl' });
    returnUrl = `${url.origin}${url.pathname}`;
  }
  return { customer, items, discountCode, language, idempotencyKey, ...(returnUrl ? { returnUrl } : {}) };
}

async function rateLimit(request, env, scope, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = await sha256(`zenin-rate:${scope}:${ip}:${window}`);
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
  const row = await env.DB.prepare(`INSERT INTO rate_limits (bucket_key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`)
    .bind(bucket, (window + 1) * windowSeconds).first();
  if (Number(row.attempts) > limit) {
    failure(429, 'RATE_LIMITED', 'Too many attempts. Try again later.',
      { retryAfter: (window + 1) * windowSeconds - now });
  }
}

// The random order UUID and domain-separated HMAC produce an opaque, reproducible
// bearer token. Only its SHA-256 hash is persisted; retries return the same token.
async function trackingToken(env, id, idempotencyHash) {
  return base64url(await hmac(env, `zenin:order-tracking:v1:${id}:${idempotencyHash}`));
}

function publicOrder(order) {
  const { notes, returnUrl, ...visible } = order;
  if (visible.payment) { const { refundedBy, events, ...payment } = visible.payment; visible.payment = payment; }
  return visible;
}

async function replayOrder(env, row, requestHash, request) {
  if (row.request_hash !== requestHash) {
    failure(409, 'IDEMPOTENCY_CONFLICT', 'This checkout identifier was already used for another order.');
  }
  const order = JSON.parse(row.order_json);
  const payment = request && payable(order) ? await paymentLink(request, env, order) : undefined;
  return json({ order: publicOrder(order), trackingToken: await trackingToken(env, row.id, row.idempotency_hash), ...(payment ? { payment } : {}) });
}

/* ---------- Tilopay (hosted payment page) ----------
 * Card data is entered on Tilopay's page. A payment is only marked paid after
 * POST /api/v1/consult confirms an approved transaction for the exact amount;
 * redirect parameters are never trusted on their own. Each attempt gets a new
 * orderNumber because Tilopay rejects a repeated orderNumber forever. */
const TILOPAY_API = 'https://app.tilopay.com/api/v1';
const tilopayBase = env => env.TILOPAY_API_URL || TILOPAY_API; // override only for local simulation
const siteUrl = env => env.SITE_URL ? String(env.SITE_URL).replace(/#.*$/, '').replace(/\/?$/, '/') : '';
// Response.redirect() has immutable headers; the router adds security headers afterwards.
const redirectTo = location => new Response(null, { status: 303, headers: { Location: location } });
const PAYMENT_TTL_MINUTES = 60;
/* Credentials are entered by the store owner in Admin → Pagos and stored encrypted
 * (AES-GCM, key derived from ADMIN_SESSION_SECRET). Worker secrets remain a fallback. */
let settingsCache = null;
async function settingsKey(env) {
  requireSecret(env);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.ADMIN_SESSION_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('zenin-club'), info: encoder.encode('payment-credentials:v1') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sealSecret(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await settingsKey(env), encoder.encode(value));
  return { iv: base64url(iv), data: base64url(data) };
}
async function openSecret(env, sealed) {
  if (!sealed?.iv || !sealed?.data) return '';
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(sealed.iv) }, await settingsKey(env), decode64(sealed.data))); }
  catch { return ''; }
}
async function readPaymentSettings(env) {
  let row = null;
  // Before migration 0010 there is no settings table: payments are simply off.
  try { row = await env.DB.prepare(`SELECT * FROM site_settings WHERE key = 'payments'`).first(); }
  catch (error) { if (!/no such table/i.test(sqlMessage(error))) throw error; }
  return row ? { ...JSON.parse(row.value_json), version: Number(row.version), updatedAt: row.updated_at } : { enabled: false, version: 0 };
}
/** Active Tilopay credentials, or null when online payments are off. */
async function paymentSettings(env) {
  if (settingsCache && settingsCache.env === env && settingsCache.expires > Date.now()) return settingsCache.value;
  let value = null;
  const stored = await readPaymentSettings(env);
  if (stored.enabled) {
    const password = await openSecret(env, stored.password), key = await openSecret(env, stored.key);
    if (stored.apiUser && password && key) value = { apiUser: stored.apiUser, password, key };
  } else if (!stored.version && env.TILOPAY_API_USER && env.TILOPAY_API_PASSWORD && env.TILOPAY_KEY) {
    value = { apiUser: env.TILOPAY_API_USER, password: env.TILOPAY_API_PASSWORD, key: env.TILOPAY_KEY };
  }
  settingsCache = { env, value, expires: Date.now() + 30000 };
  return value;
}
const payable = order => order.payment?.provider === 'tilopay' && ['pending', 'failed'].includes(order.payment.status) && order.status !== 'cancelled';
let tilopayToken = null;

async function tilopayLogin(env, config, path = 'login') {
  const response = await fetch(`${tilopayBase(env)}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiuser: config.apiUser, password: config.password, ...(path === 'loginSdk' ? { key: config.key } : {}) }) });
  return response.json().catch(() => ({}));
}
async function tilopayRequest(env, config, path, body, retry = true) {
  const owner = `${config.apiUser}:${await sha256(config.password)}`;
  if (!tilopayToken || tilopayToken.owner !== owner || tilopayToken.expires <= Date.now()) {
    const data = await tilopayLogin(env, config);
    if (!data.access_token) failure(502, 'PAYMENT_UNAVAILABLE', 'The payment provider is unavailable.');
    const seconds = Number(data.expires_in);
    tilopayToken = { owner, value: data.access_token, expires: Date.now() + (Number.isFinite(seconds) && seconds > 600 ? seconds - 300 : 3600) * 1000 };
  }
  const response = await fetch(`${tilopayBase(env)}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json',
    Authorization: `bearer ${tilopayToken.value}` }, body: JSON.stringify(body) });
  if (response.status === 401 && retry) { tilopayToken = null; return tilopayRequest(env, config, path, body, false); }
  const data = await response.json().catch(() => null);
  if (!data) failure(502, 'PAYMENT_UNAVAILABLE', 'The payment provider returned an unexpected response.');
  return data;
}

const COSTA_RICA_PROVINCES = new Set(['CR-SJ', 'CR-A', 'CR-H', 'CR-C', 'CR-P', 'CR-G', 'CR-L']);
function billingState(customer) {
  const state = (customer.state || '').toUpperCase();
  if (customer.country === 'CR') return COSTA_RICA_PROVINCES.has(state) ? state : 'CR-SJ';
  if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(state)) return state;
  return /^[A-Z0-9]{1,3}$/.test(state) ? `${customer.country}-${state}` : customer.state || customer.country;
}
const randomOrderNumber = () => `ZC${[...crypto.getRandomValues(new Uint8Array(12))].map(byte => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[byte % 34]).join('')}`;

async function updateOrderPayment(env, orderId, payment, extra = {}) {
  const now = new Date().toISOString();
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  const order = JSON.parse(row.order_json);
  order.payment = { ...order.payment, ...payment };
  order.updatedAt = now;
  if (extra.status && extra.status !== order.status) { order.status = extra.status; order.history.push({ status: extra.status, at: now }); }
  if (extra.paymentEvent) order.payment.events = [...(order.payment.events || []).slice(-19), { ...extra.paymentEvent, at: now }];
  const saved = await env.DB.prepare(`UPDATE orders SET status = ?, order_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? RETURNING version`)
    .bind(order.status, JSON.stringify(order), now, orderId, row.version).first();
  if (!saved) return updateOrderPayment(env, orderId, payment, extra);
  return { ...order, version: Number(saved.version) };
}

/** Creates a new payment attempt and returns Tilopay's hosted payment page URL. */
async function paymentLink(request, env, order) {
  const config = await paymentSettings(env);
  if (!config) return undefined;
  const orderNumber = randomOrderNumber();
  const amount = order.totals.total.toFixed(2);
  const currency = order.totals.currency || 'USD';
  const now = new Date().toISOString();
  const [firstName, ...rest] = order.customer.name.split(/\s+/);
  await env.DB.prepare(`INSERT INTO payment_attempts(order_number, order_id, amount, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'created', ?, ?)`).bind(orderNumber, order.id, amount, currency, now, now).run();
  try {
    const data = await tilopayRequest(env, config, 'processPayment', {
      redirect: new URL('/payments/tilopay/return', request.url).href, key: config.key, amount, currency, orderNumber, capture: '1',
      billToFirstName: firstName, billToLastName: rest.join(' ') || firstName, billToAddress: order.customer.address,
      billToAddress2: order.customer.apartment || '', billToCity: order.customer.city, billToState: billingState(order.customer),
      billToZipPostCode: order.customer.postal || '00000', billToCountry: order.customer.country, billToTelephone: order.customer.phone || '',
      billToEmail: order.customer.email, shipToFirstName: firstName, shipToLastName: rest.join(' ') || firstName,
      shipToAddress: order.customer.address, shipToAddress2: order.customer.apartment || '', shipToCity: order.customer.city,
      shipToState: billingState(order.customer), shipToZipPostCode: order.customer.postal || '00000', shipToCountry: order.customer.country,
      shipToTelephone: order.customer.phone || '', subscription: '0', platform: env.TILOPAY_PLATFORM || 'zenin-club',
      returnData: btoa(order.id),
    });
    if (String(data.type) !== '100' || !(env.TILOPAY_API_URL ? /^https?:\/\//: /^https:\/\//).test(data.url || '')) {
      await env.DB.prepare(`UPDATE payment_attempts SET status = 'error', updated_at = ?, result_json = ? WHERE order_number = ?`)
        .bind(new Date().toISOString(), JSON.stringify({ type: data.type, message: data.message }), orderNumber).run();
      return { error: 'PAYMENT_UNAVAILABLE' };
    }
    await updateOrderPayment(env, order.id, { orderNumber, attempts: (order.payment.attempts || 0) + 1 });
    return { provider: 'tilopay', url: data.url, orderNumber };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.code };
    throw error;
  }
}

/** Authoritative status of one attempt, from Tilopay's consult endpoint. */
async function confirmAttempt(env, attempt) {
  const config = await paymentSettings(env);
  if (!config) return 'none';
  const data = await tilopayRequest(env, config, 'consult', { key: config.key, orderNumber: attempt.order_number, merchantId: '' });
  const entries = (Array.isArray(data.response) ? data.response : []).filter(entry => String(entry.orderNumber) === attempt.order_number);
  const payments = entries.filter(entry => !entry.type || /payment|pago/i.test(String(entry.type)));
  const approved = payments.find(entry => String(entry.code) === '1');
  const now = new Date().toISOString();
  if (approved) {
    const matches = Number(approved.amount).toFixed(2) === attempt.amount && String(approved.currency || attempt.currency).toUpperCase() === attempt.currency;
    const details = { tilopayId: approved.id_tilopay, auth: approved.auth || '', card: approved.last ? `•••• ${String(approved.last).slice(-4)}` : '',
      environment: /test|prueba/i.test(String(approved.environment)) ? 'test' : 'live', response: approved.response || '' };
    await env.DB.prepare(`UPDATE payment_attempts SET status = ?, updated_at = ?, result_json = ? WHERE order_number = ?`)
      .bind(matches ? 'approved' : 'review', now, JSON.stringify(approved), attempt.order_number).run();
    const status = matches ? 'paid' : 'review';
    await updateOrderPayment(env, attempt.order_id, { status, orderNumber: attempt.order_number, ...details, message: '', ...(matches ? { paidAt: now } : {}) },
      { paymentEvent: { type: status, orderNumber: attempt.order_number } });
    return status;
  }
  const rejected = entries.find(entry => String(entry.code) !== '1');
  if (rejected) {
    await env.DB.prepare(`UPDATE payment_attempts SET status = 'rejected', updated_at = ?, result_json = ? WHERE order_number = ?`)
      .bind(now, JSON.stringify(rejected), attempt.order_number).run();
    const row = await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(attempt.order_id).first();
    if (JSON.parse(row.order_json).payment?.status !== 'paid') {
      await updateOrderPayment(env, attempt.order_id, { status: 'failed', message: String(rejected.response || rejected.description || '').slice(0, 200) },
        { paymentEvent: { type: 'rejected', orderNumber: attempt.order_number } });
    }
    return 'rejected';
  }
  return 'none';
}

async function paymentReturn(request, env) {
  const url = new URL(request.url);
  const orderNumber = (url.searchParams.get('order') || '').slice(0, 64);
  const attempt = /^[A-Z0-9]{6,40}$/.test(orderNumber)
    ? await env.DB.prepare('SELECT * FROM payment_attempts WHERE order_number = ?').bind(orderNumber).first() : null;
  const fallback = siteUrl(env);
  if (!attempt) return fallback ? redirectTo(`${fallback}#order`) : json({ error: { code: 'ORDER_NOT_FOUND', message: 'Payment was not found.' } }, 404);
  let outcome = 'none';
  try { outcome = await confirmAttempt(env, attempt); } catch { outcome = 'none'; }
  if (outcome === 'none' && url.searchParams.get('code') && url.searchParams.get('code') !== '1') {
    // The customer cancelled or was declined on Tilopay's page. A negative result is safe to record from the redirect.
    await env.DB.prepare(`UPDATE payment_attempts SET status = 'rejected', updated_at = ?, result_json = ? WHERE order_number = ? AND status = 'created'`)
      .bind(new Date().toISOString(), JSON.stringify({ code: url.searchParams.get('code'), description: (url.searchParams.get('description') || '').slice(0, 200) }), orderNumber).run();
    const row = await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(attempt.order_id).first();
    if (JSON.parse(row.order_json).payment?.status === 'pending') {
      await updateOrderPayment(env, attempt.order_id, { status: 'failed', message: (url.searchParams.get('description') || '').slice(0, 200) });
    }
  }
  const row = await env.DB.prepare('SELECT id, idempotency_hash, order_json FROM orders WHERE id = ?').bind(attempt.order_id).first();
  const token = await trackingToken(env, row.id, row.idempotency_hash);
  const site = JSON.parse(row.order_json).returnUrl || fallback;
  return redirectTo(`${site}#order/${encodeURIComponent(row.id)}/${encodeURIComponent(token)}`);
}

async function orderForCustomer(request, env, body) {
  const id = text(body.id, 'id', { max: 80 });
  const token = text(body.token, 'token', { min: 1, max: 128 });
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!row || !constantEqual(await sha256(token), row.tracking_hash)) failure(404, 'ORDER_NOT_FOUND', 'Order was not found with those details.');
  return row;
}

/** A customer can retry a declined or abandoned payment from the tracking page. */
async function retryPayment(request, env) {
  await rateLimit(request, env, 'pay', 30, 900);
  if (!(await paymentSettings(env))) failure(409, 'PAYMENTS_DISABLED', 'Online payments are not enabled.');
  const row = await orderForCustomer(request, env, await readJson(request));
  const order = JSON.parse(row.order_json);
  if (order.payment?.status === 'paid') failure(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
  if (!payable(order)) failure(409, 'ORDER_NOT_PAYABLE', 'This order can no longer be paid. Place a new order.');
  const created = await env.DB.prepare(`SELECT * FROM payment_attempts WHERE order_id = ? AND status = 'created' ORDER BY created_at DESC LIMIT 3`).bind(order.id).all();
  for (const attempt of created.results) if ((await confirmAttempt(env, attempt)) === 'paid') failure(409, 'ORDER_ALREADY_PAID', 'This order is already paid.');
  const payment = await paymentLink(request, env, order);
  if (!payment?.url) failure(502, payment?.error || 'PAYMENT_UNAVAILABLE', 'The payment page could not be opened. Try again.');
  return json({ payment });
}

/** Confirms a pending order with Tilopay on demand (customer tracking page or admin). */
async function refreshPayment(env, orderId) {
  const created = await env.DB.prepare(`SELECT * FROM payment_attempts WHERE order_id = ? AND status IN ('created', 'review') ORDER BY created_at DESC LIMIT 5`).bind(orderId).all();
  for (const attempt of created.results) if ((await confirmAttempt(env, attempt)) === 'paid') break;
}

async function refundOrder(request, env, id, actor) {
  const config = await paymentSettings(env);
  if (!config) failure(409, 'PAYMENTS_DISABLED', 'Online payments are not enabled.');
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  if (body.expectedVersion !== Number(row.version)) failure(409, 'ORDER_CHANGED', 'Order changed. Refresh and try again.');
  const order = JSON.parse(row.order_json);
  if (order.payment?.status !== 'paid') failure(409, 'ORDER_NOT_REFUNDABLE', 'Only paid orders can be refunded.');
  const attempt = await env.DB.prepare(`SELECT * FROM payment_attempts WHERE order_number = ? AND status = 'approved'`).bind(order.payment.orderNumber).first();
  if (!attempt) failure(409, 'ORDER_NOT_REFUNDABLE', 'The approved payment was not found.');
  const data = await tilopayRequest(env, config, 'processModification', { orderNumber: attempt.order_number, type: '2', amount: attempt.amount, key: config.key });
  if (String(data.type) !== '100' || String(data.ReasonCode) !== '1101') {
    failure(502, 'REFUND_REJECTED', String(data.ReasonCodeDescription || data.message || 'The refund was rejected.').slice(0, 200));
  }
  await env.DB.prepare(`UPDATE payment_attempts SET status = 'refunded', updated_at = ? WHERE order_number = ?`).bind(new Date().toISOString(), attempt.order_number).run();
  const updated = await updateOrderPayment(env, id, { status: 'refunded', refundedAt: new Date().toISOString(), refundedBy: actor },
    { status: body.cancel === false ? undefined : 'cancelled', paymentEvent: { type: 'refunded', orderNumber: attempt.order_number } });
  return json({ order: updated });
}

/** Cron: confirm payments whose customer never came back and release abandoned orders. */
async function sweepPayments(env) {
  if (!(await paymentSettings(env))) return;
  const pending = await env.DB.prepare(`SELECT * FROM payment_attempts WHERE status IN ('created', 'review')
    AND created_at <= ? AND created_at >= ? ORDER BY created_at LIMIT 40`)
    .bind(new Date(Date.now() - 5 * 60000).toISOString(), new Date(Date.now() - 3 * 86400000).toISOString()).all();
  for (const attempt of pending.results) {
    try {
      const outcome = await confirmAttempt(env, attempt);
      if (outcome === 'none' && Date.parse(attempt.created_at) < Date.now() - PAYMENT_TTL_MINUTES * 60000) {
        await env.DB.prepare(`UPDATE payment_attempts SET status = 'expired', updated_at = ? WHERE order_number = ? AND status = 'created'`)
          .bind(new Date().toISOString(), attempt.order_number).run();
      }
    } catch { /* Try again on the next run. */ }
  }
  const stale = await env.DB.prepare(`SELECT id, order_json FROM orders WHERE status != 'cancelled' AND created_at <= ?
    AND json_extract(order_json, '$.payment.status') IN ('pending', 'failed')`).bind(new Date(Date.now() - PAYMENT_TTL_MINUTES * 60000).toISOString()).all();
  for (const row of stale.results) {
    const open = await env.DB.prepare(`SELECT COUNT(*) AS n FROM payment_attempts WHERE order_id = ? AND (status = 'created' AND created_at > ?)`)
      .bind(row.id, new Date(Date.now() - PAYMENT_TTL_MINUTES * 60000).toISOString()).first('n');
    if (Number(open)) continue;
    await updateOrderPayment(env, row.id, { status: 'expired' }, { status: 'cancelled', paymentEvent: { type: 'expired' } });
  }
}

function inventoryKey(productId, shirt, size) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(productId) || !/^[1-9]\d*$/.test(String(shirt)) || !Number.isSafeInteger(Number(shirt)) || typeof size !== 'string' || !size.trim() || size.length > 24) {
    failure(404, 'INVENTORY_NOT_FOUND', 'Inventory variant was not found.');
  }
  return { productId, shirt: Number(shirt), size };
}

const movement = row => ({ id: Number(row.id), productId: row.product_id, shirt: Number(row.shirt), size: row.size,
  delta: Number(row.delta), stockAfter: Number(row.stock_after), lowStockThreshold: Number(row.threshold_after),
  version: Number(row.version), kind: row.kind, reason: row.reason, orderId: row.order_id,
  at: row.created_at, actor: row.actor });

function enrichedVariant(row, history = []) {
  const product = JSON.parse(row.product_json);
  const option = product.shirtOptions?.find(option => option.shirt === Number(row.shirt));
  return { productId: row.product_id, shirt: Number(row.shirt), size: row.size, stock: Number(row.stock),
    lowStockThreshold: Number(row.low_stock_threshold), version: Number(row.version), updatedAt: row.updated_at,
    name: product?.name || row.product_id, nameEs: product?.nameEs || '',
    ...(product.designUrl ? { designUrl: product.designUrl } : {}), availableShirts: offeredShirts(product),
    ...(option ? { shirtOptions: [option], baseName: option.baseName } : {}),
    colorName: option?.colorName || COLORS[row.shirt] || String(row.shirt), active: row.product_active !== 0, history };
}

async function publicInventory(env) {
  const rows = await env.DB.prepare(`SELECT i.product_id, i.shirt, i.size, i.stock FROM inventory i
    JOIN products p ON p.id = i.product_id WHERE p.active = 1 AND i.shirt IN
    (SELECT value FROM json_each(COALESCE(json_extract(p.product_json, '$.availableShirts'), '[1,2,3,4]')))
    AND (json_type(p.product_json, '$.shirtOptions') IS NULL OR EXISTS (
      SELECT 1 FROM json_each(p.product_json, '$.shirtOptions') o, json_each(o.value, '$.sizes') s
      WHERE json_extract(o.value, '$.shirt') = i.shirt AND s.value = i.size))
    ORDER BY i.product_id, i.shirt, i.size`).all();
  return json({ variants: rows.results.map(row => ({ productId: row.product_id, shirt: Number(row.shirt), size: row.size, stock: Number(row.stock) })) });
}

async function adminInventory(env, includeArchived = false) {
  const rows = await env.DB.prepare(`SELECT i.*, p.product_json, p.active AS product_active FROM inventory i
    JOIN products p ON p.id = i.product_id ${includeArchived ? '' : `WHERE p.active = 1 AND i.shirt IN
    (SELECT value FROM json_each(COALESCE(json_extract(p.product_json, '$.availableShirts'), '[1,2,3,4]')))
    AND (json_type(p.product_json, '$.shirtOptions') IS NULL OR EXISTS (
      SELECT 1 FROM json_each(p.product_json, '$.shirtOptions') o, json_each(o.value, '$.sizes') s
      WHERE json_extract(o.value, '$.shirt') = i.shirt AND s.value = i.size))`}
    ORDER BY i.product_id, i.shirt, i.size`).all();
  const audit = await env.DB.prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER
    (PARTITION BY product_id, shirt, size ORDER BY id DESC) AS audit_rank FROM inventory_movements)
    WHERE audit_rank <= 10 ORDER BY id DESC`).all();
  const histories = new Map();
  for (const row of audit.results) {
    const key = `${row.product_id}:${row.shirt}:${row.size}`;
    if (!histories.has(key)) histories.set(key, []);
    histories.get(key).push(movement(row));
  }
  const variants = rows.results.map(row => enrichedVariant(row, histories.get(`${row.product_id}:${row.shirt}:${row.size}`) || []));
  return json({ variants, summary: { products: new Set(variants.map(variant => variant.productId)).size,
    variants: variants.length, totalStock: variants.reduce((sum, variant) => sum + variant.stock, 0),
    outOfStock: variants.filter(variant => variant.stock === 0).length,
    lowStock: variants.filter(variant => variant.stock <= variant.lowStockThreshold).length },
  meta: { initialStock: 0, defaultLowStockThreshold: 3, mockSeed: false } });
}

async function inventoryDetail(env, key, limit = 50) {
  const row = await env.DB.prepare(`SELECT i.*, p.product_json, p.active AS product_active FROM inventory i
    JOIN products p ON p.id = i.product_id WHERE i.product_id = ? AND i.shirt = ? AND i.size = ?`)
    .bind(key.productId, key.shirt, key.size).first();
  if (!row) failure(404, 'INVENTORY_NOT_FOUND', 'Inventory variant was not found.');
  const audit = await env.DB.prepare(`SELECT * FROM inventory_movements WHERE product_id = ? AND shirt = ? AND size = ?
    ORDER BY id DESC LIMIT ?`).bind(key.productId, key.shirt, key.size, limit).all();
  const history = audit.results.map(movement);
  return { variant: enrichedVariant(row, history.slice(0, 10)), history };
}

async function updateInventory(request, env, key, actor) {
  const body = await readJson(request);
  if (Object.keys(body).some(field => !['stock', 'lowStockThreshold', 'version', 'reason'].includes(field))) {
    failure(400, 'INVALID_UPDATE', 'Update stock, low-stock threshold, and version.');
  }
  for (const field of ['stock', 'lowStockThreshold']) {
    if (!Number.isInteger(body[field]) || body[field] < 0 || body[field] > 999999) {
      failure(400, 'INVALID_FIELD', `Invalid ${field}.`, { field });
    }
  }
  if (!Number.isSafeInteger(body.version) || body.version < 1) {
    failure(400, 'INVALID_FIELD', 'Invalid inventory version.', { field: 'version' });
  }
  const reason = text(body.reason, 'reason', { min: 0, max: 240, optional: true }) || 'manual_adjustment';
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE inventory SET stock = ?, low_stock_threshold = ?, version = version + 1,
    updated_at = ?, last_kind = 'adjustment', last_reason = ?, last_actor = ?, last_order_id = NULL
    WHERE product_id = ? AND shirt = ? AND size = ? AND version = ? RETURNING product_id, version`)
    .bind(body.stock, body.lowStockThreshold, now, reason, actor, key.productId, key.shirt, key.size, body.version).first();
  // D1 change counts include audit-trigger writes. The returned row is the CAS
  // success signal; a zero-row update returns null without changing inventory.
  if (!result) {
    const current = await inventoryDetail(env, key, 1);
    failure(409, 'INVENTORY_CHANGED', 'Inventory changed. Refresh and review your adjustment.', { currentVersion: current.variant.version });
  }
  const detail = await inventoryDetail(env, key, 10);
  return json({ variant: detail.variant });
}

const productJson = row => { const { revision, ...product } = JSON.parse(row.product_json); return product; };
const productFromRow = row => ({ ...productJson(row), active: Number(row.active) === 1,
  version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at });

async function readProducts(env, includeArchived = false, admin = false) {
  const rows = await env.DB.prepare(`SELECT * FROM products ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY created_at, id`).all();
  const products = rows.results.map(row => {
    const { emoji, ...product } = admin ? productFromRow(row) : productJson(row);
    return product;
  });
  return json({ products: await currentProductOptions(products, env) });
}

const PRINT_SIDES = new Set(['front', 'back', 'both']);

function catalogInput(body, previous = null) {
  const value = field => body[field] !== undefined ? body[field] : previous?.[field];
  const kind = previous ? (previous.kind === 'article' ? 'article' : 'apparel') : (body.kind ?? 'apparel');
  if (!['apparel', 'article'].includes(kind) || (previous && body.kind !== undefined && body.kind !== kind)) {
    failure(400, 'INVALID_FIELD', 'Choose apparel or article.', { field: 'kind' });
  }
  const collectionId = text(value('collectionId') ?? '', 'collectionId', { min: 0, max: 80 });
  if (collectionId && !/^col-[A-Za-z0-9-]{8,60}$/.test(collectionId)) failure(400, 'INVALID_COLLECTION', 'Choose an active collection.');
  // Products outside a collection keep the historical "originals" category or none.
  const category = collectionId ? '' : body.category !== undefined ? body.category : previous ? (previous.collectionId ? '' : previous.category ?? 'originals') : 'originals';
  if (!collectionId && !['', 'originals'].includes(category)) failure(400, 'INVALID_FIELD', 'Choose a collection.', { field: 'category' });
  // A plain price edit resets per-type prices; articles always use one price.
  let basePrices = kind === 'article' || (body.price !== undefined && body.basePrices === undefined) ? null : value('basePrices') ?? null;
  if (basePrices !== null) {
    if (!object(basePrices) || Object.keys(basePrices).length > 30 || Object.keys(basePrices).some(key => !/^[A-Za-z0-9_-]{1,80}$/.test(key))) {
      failure(400, 'INVALID_FIELD', 'Invalid prices by shirt type.', { field: 'basePrices' });
    }
    basePrices = Object.fromEntries(Object.entries(basePrices).map(([key, amount]) => [key, priceInput(amount, 'basePrices')]));
  }
  const lowest = basePrices && Object.keys(basePrices).length ? Math.min(...Object.values(basePrices)) : undefined;
  const price = body.price !== undefined ? priceInput(body.price)
    : body.basePrices !== undefined && lowest !== undefined ? lowest
      : previous?.price !== undefined ? priceInput(previous.price) : lowest ?? priceInput(undefined);
  let printSides = 'front', frontDesignUrl = '', backDesignUrl = '';
  if (kind === 'apparel') {
    const previousFront = previous ? (previous.frontDesignUrl ?? (previous.printSides === 'back' ? '' : previous.designUrl || '')) : '';
    const front = body.frontDesignUrl !== undefined ? body.frontDesignUrl : body.designUrl !== undefined && body.backDesignUrl === undefined ? body.designUrl : previousFront;
    const back = body.backDesignUrl !== undefined ? body.backDesignUrl : previous?.backDesignUrl || '';
    printSides = body.printSides ?? previous?.printSides ?? (front && back ? 'both' : back && !front ? 'back' : 'front');
    if (!PRINT_SIDES.has(printSides)) failure(400, 'INVALID_FIELD', 'Choose front, back or both.', { field: 'printSides' });
    if (printSides !== 'back') frontDesignUrl = text(front, 'designUrl', { max: 500 });
    if (printSides !== 'front') backDesignUrl = text(back, 'backDesignUrl', { max: 500 });
  }
  const shirt = value('shirt');
  if (!Number.isSafeInteger(shirt) || shirt < 1) failure(400, 'INVALID_COLOR', 'Choose a valid shirt color.');
  let availableShirts = value('availableShirts');
  {
    if (!Array.isArray(availableShirts) || !availableShirts.length || availableShirts.length > 120 ||
        new Set(availableShirts).size !== availableShirts.length ||
        availableShirts.some(value => !Number.isSafeInteger(value) || value < 1)) {
      failure(400, 'INVALID_FIELD', 'Choose distinct colors from your product bases.', { field: 'availableShirts' });
    }
    availableShirts = [...availableShirts].sort((left, right) => left - right);
    if (!availableShirts.includes(shirt)) failure(400, 'INVALID_COLOR', 'The default shirt must be one of the offered colors.');
  }
  const accent = text(value('accent') ?? '#df3143', 'accent', { max: 7 });
  if (!/^#[a-f0-9]{6}$/i.test(accent)) failure(400, 'INVALID_FIELD', 'Use a six-digit hex color.', { field: 'accent' });
  const slug = text(value('slug'), 'slug', { min: 0, max: 120, optional: true });
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) failure(400, 'INVALID_FIELD', 'Invalid product slug.', { field: 'slug' });
  return { kind, name: text(value('name'), 'name', { min: 2, max: 120 }),
    nameEs: text(value('nameEs'), 'nameEs', { min: 0, max: 120, optional: true }),
    ...(kind === 'article' ? { articleType: text(value('articleType') ?? '', 'articleType', { min: 0, max: 80 }) } : {}),
    collectionId, category, collection: COLLECTIONS[category] || '', price, ...(basePrices ? { basePrices } : {}),
    shirt, printSides: kind === 'article' ? 'none' : printSides, frontDesignUrl, backDesignUrl,
    designUrl: frontDesignUrl || backDesignUrl, availableShirts,
    description: text(value('description'), 'description', { min: 0, max: 2000, optional: true }),
    descriptionEs: text(value('descriptionEs'), 'descriptionEs', { min: 0, max: 2000, optional: true }),
    printLine: text(value('printLine'), 'printLine', { min: 0, max: 120, optional: true }),
    tag: text(value('tag'), 'tag', { min: 0, max: 40, optional: true }), accent, slug };
}

function catalogQuantity(value, fallback, field) {
  const quantity = value === undefined ? fallback : value;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999999) failure(400, 'INVALID_FIELD', `Invalid ${field}.`, { field });
  return quantity;
}

function catalogVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) failure(400, 'INVALID_FIELD', 'Invalid product version.', { field: 'version' });
  return value;
}

async function createProduct(request, env, actor) {
  const body = await readJson(request);
  if (body.kind === 'article') failure(400, 'INVALID_FIELD', 'Create articles from the article editor.', { field: 'kind' });
  const normalized = catalogInput(body);
  const initialStock = catalogQuantity(body.initialStock, 0, 'initialStock');
  const threshold = catalogQuantity(body.lowStockThreshold, 3, 'lowStockThreshold');
  const key = text(body.idempotencyKey ?? crypto.randomUUID(), 'idempotencyKey', { min: 8, max: 128 });
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) failure(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid product creation identifier.');
  const keyHash = await sha256(`zenin:product-create:${key}`);
  const requestHash = await sha256(JSON.stringify({ product: normalized, initialStock, lowStockThreshold: threshold }));
  const replay = row => {
    if (row.creation_request_hash !== requestHash) failure(409, 'IDEMPOTENCY_CONFLICT', 'This creation identifier was used for another product.');
    return json({ product: productFromRow(row) });
  };
  const existing = await env.DB.prepare('SELECT * FROM products WHERE creation_key_hash = ?').bind(keyHash).first();
  if (existing) return replay(existing);
  await applyCatalogContext(normalized, request, env);
  const id = `zc-${crypto.randomUUID()}`;
  const baseSlug = normalized.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'zenin-tee';
  const product = { id, ...normalized, slug: normalized.slug || `${baseSlug}-${id.slice(-8)}` };
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO products(id, slug, created_at, updated_at, creation_key_hash, creation_request_hash, product_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, product.slug, now, now, keyHash, requestHash, JSON.stringify(product)),
      env.DB.prepare(`INSERT INTO inventory(product_id, shirt, size, stock, low_stock_threshold, updated_at, last_reason, last_actor)
        SELECT ?, json_extract(c.value, '$.shirt'), s.value, ?, ?, ?, 'product_created', ?
        FROM json_each(?) c JOIN json_each(c.value, '$.sizes') s`)
        .bind(id, initialStock, threshold, now, actor, JSON.stringify(product.shirtOptions)),
    ]);
  } catch (error) {
    const winner = await env.DB.prepare('SELECT * FROM products WHERE creation_key_hash = ?').bind(keyHash).first();
    if (winner) return replay(winner);
    if (/products\.slug/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(409, 'SLUG_TAKEN', 'That product URL is already in use.');
    if (/INVALID_COLOR/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(400, 'INVALID_COLOR', 'A selected base or color changed. Refresh and choose it again.');
    throw error;
  }
  return json({ product: { ...product, active: true, version: 1, createdAt: now, updatedAt: now, deletedAt: null } }, 201);
}

async function changeProduct(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
  const body = request.body ? await readJson(request) : {};
  if (request.method === 'DELETE' && Number(row.active) === 0) return json({ id, archived: true, product: productFromRow(row) });
  const version = catalogVersion(body.version);
  if (version !== Number(row.version)) failure(409, 'PRODUCT_CHANGED', 'Product changed. Refresh and review the latest version.');
  if (body.active !== undefined && typeof body.active !== 'boolean') failure(400, 'INVALID_FIELD', 'Invalid active state.', { field: 'active' });
  const previous = JSON.parse(row.product_json);
  const product = request.method === 'DELETE' ? previous : { id, ...catalogInput(body, previous) };
  if (request.method !== 'DELETE') {
    await applyCatalogContext(product, request, env);
    if (product.kind === 'article' && previous.shirtOptions?.[0]?.baseId && product.shirtOptions[0].baseId !== previous.shirtOptions[0].baseId) {
      failure(400, 'INVALID_COLOR', 'An article keeps its own variants.');
    }
  }
  const active = request.method === 'DELETE' ? false : body.active ?? Boolean(row.active);
  const now = new Date().toISOString();
  let updated;
  try {
    updated = await env.DB.prepare(`UPDATE products SET slug = ?, active = ?, version = version + 1, updated_at = ?,
      deleted_at = ?, product_json = ? WHERE id = ? AND version = ? RETURNING *`)
      .bind(product.slug, active ? 1 : 0, now, active ? null : row.deleted_at || now, JSON.stringify(product), id, version).first();
  } catch (error) {
    if (/products\.slug/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(409, 'SLUG_TAKEN', 'That product URL is already in use.');
    if (/INVALID_COLOR/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(400, 'INVALID_COLOR', 'A selected base or color changed. Refresh and choose it again.');
    throw error;
  }
  if (!updated) failure(409, 'PRODUCT_CHANGED', 'Product changed. Refresh and review the latest version.');
  return json({ ...(request.method === 'DELETE' ? { id, archived: true } : {}), product: productFromRow(updated) });
}

const slugify = (value, fallback) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || fallback;
const sqlMessage = error => `${error?.message || ''} ${error?.cause?.message || ''}`;

async function collectionInput(body, request, env, previous = null) {
  const value = field => body[field] !== undefined ? body[field] : previous?.[field];
  const name = text(value('name'), 'name', { min: 2, max: 80 });
  const nameEs = text(value('nameEs'), 'nameEs', { min: 0, max: 80, optional: true });
  const slug = text(value('slug') ?? '', 'slug', { min: 0, max: 80 }) || slugify(nameEs || name, 'coleccion');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || ['new', 'all'].includes(slug)) failure(400, 'INVALID_FIELD', 'Invalid collection URL.', { field: 'slug' });
  const accent = text(value('accent') ?? '#df3143', 'accent', { max: 7 });
  if (!/^#[a-f0-9]{6}$/i.test(accent)) failure(400, 'INVALID_FIELD', 'Use a six-digit hex color.', { field: 'accent' });
  const sortOrder = value('sortOrder') ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) failure(400, 'INVALID_FIELD', 'Invalid order.', { field: 'sortOrder' });
  const coverUrl = await validateDesignUrl(text(value('coverUrl'), 'coverUrl', { max: 500 }), request, env);
  return { slug, sortOrder, details: { name, nameEs,
    description: text(value('description'), 'description', { min: 0, max: 600, optional: true, multiline: true }),
    descriptionEs: text(value('descriptionEs'), 'descriptionEs', { min: 0, max: 600, optional: true, multiline: true }),
    coverUrl, accent: accent.toLowerCase(), videos: await videoListInput(value('videos'), request, env, 'videos') } };
}

async function adminCollections(env, includeArchived) {
  const collections = await readCollections(env, includeArchived);
  const rows = await env.DB.prepare(`SELECT json_extract(product_json, '$.collectionId') AS collection_id, COUNT(*) AS total
    FROM products WHERE active = 1 GROUP BY collection_id`).all();
  const counts = new Map(rows.results.map(row => [row.collection_id, Number(row.total)]));
  return collections.map(collection => ({ ...collection, productCount: counts.get(collection.id) || 0 }));
}

async function createCollection(request, env) {
  const body = await readJson(request);
  const { slug, sortOrder, details } = await collectionInput(body, request, env);
  const key = text(body.idempotencyKey ?? crypto.randomUUID(), 'idempotencyKey', { min: 8, max: 128 });
  const keyHash = await sha256(`zenin:collection-create:${key}`), requestHash = await sha256(JSON.stringify({ slug, sortOrder, details }));
  const replay = row => {
    if (row.creation_request_hash !== requestHash) failure(409, 'IDEMPOTENCY_CONFLICT', 'This creation identifier was used for another collection.');
    return json({ collection: collectionFromRow(row) });
  };
  const existing = await env.DB.prepare('SELECT * FROM collections WHERE creation_key_hash = ?').bind(keyHash).first();
  if (existing) return replay(existing);
  const id = `col-${crypto.randomUUID()}`, now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO collections(id, slug, sort_order, collection_json, created_at, updated_at, creation_key_hash, creation_request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, slug, sortOrder, JSON.stringify(details), now, now, keyHash, requestHash).run();
  } catch (error) {
    const winner = await env.DB.prepare('SELECT * FROM collections WHERE creation_key_hash = ?').bind(keyHash).first();
    if (winner) return replay(winner);
    if (/collections\.slug/.test(sqlMessage(error))) failure(409, 'SLUG_TAKEN', 'That collection URL is already in use.');
    throw error;
  }
  return json({ collection: collectionFromRow(await env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first()) }, 201);
}

async function changeCollection(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM collections WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'COLLECTION_NOT_FOUND', 'Collection was not found.');
  const previous = collectionFromRow(row);
  const body = await readJson(request), version = catalogVersion(body.version);
  if (version !== previous.version) failure(409, 'COLLECTION_CHANGED', 'This collection changed. Refresh and review it.');
  if (request.method === 'DELETE' && !previous.active) return json({ collection: previous, archived: true });
  if (body.active !== undefined && typeof body.active !== 'boolean') failure(400, 'INVALID_FIELD', 'Invalid active state.', { field: 'active' });
  const { slug, sortOrder, details } = request.method === 'DELETE' ? { slug: previous.slug, sortOrder: previous.sortOrder,
    details: { name: previous.name, nameEs: previous.nameEs, description: previous.description, descriptionEs: previous.descriptionEs,
      coverUrl: previous.coverUrl, accent: previous.accent, videos: previous.videos || [] } } : await collectionInput(body, request, env, previous);
  const active = request.method === 'DELETE' ? 0 : body.active === undefined ? Number(previous.active) : Number(body.active);
  let updated;
  try {
    updated = await env.DB.prepare(`UPDATE collections SET slug = ?, sort_order = ?, collection_json = ?, active = ?, version = version + 1,
      updated_at = ? WHERE id = ? AND version = ? RETURNING *`).bind(slug, sortOrder, JSON.stringify(details), active, new Date().toISOString(), id, version).first();
  } catch (error) {
    if (/COLLECTION_IN_USE/.test(sqlMessage(error))) failure(409, 'COLLECTION_IN_USE', 'Move or archive the products of this collection first.');
    if (/collections\.slug/.test(sqlMessage(error))) failure(409, 'SLUG_TAKEN', 'That collection URL is already in use.');
    throw error;
  }
  if (!updated) failure(409, 'COLLECTION_CHANGED', 'This collection changed. Refresh and review it.');
  return json({ collection: collectionFromRow(updated), ...(request.method === 'DELETE' ? { archived: true } : {}) });
}

/**
 * An article (bottle, keychain…) owns a hidden article base whose colors are its
 * photographed variants, so stock, checkout, snapshots and guards reuse the shirt model.
 */
async function articleInput(body, request, env, previousBase = null, previousProduct = null) {
  const variants = body.variants !== undefined ? body.variants : previousBase?.colors;
  const sizes = body.sizes !== undefined ? body.sizes : previousBase?.sizes ?? ['Única'];
  const name = body.name !== undefined ? body.name : previousProduct?.name;
  const type = body.articleType !== undefined ? body.articleType : previousProduct?.articleType;
  const base = await baseInput({ name, type, weightGsm: 0, sizes, colors: variants }, request, env, previousBase);
  const defaultVariant = body.defaultVariant ?? 0;
  if (!Number.isInteger(defaultVariant) || defaultVariant < 0 || defaultVariant >= base.colors.length) {
    failure(400, 'INVALID_FIELD', 'Choose the main variant.', { field: 'defaultVariant' });
  }
  return { base, defaultVariant };
}

async function nextShirtId(env) {
  const max = await env.DB.prepare('SELECT MAX(shirt) AS max FROM garment_colors').first('max');
  return Math.max(99, Number(max) || 0) + 1;
}

async function createArticle(request, env, actor) {
  const body = await readJson(request);
  const { base, defaultVariant } = await articleInput(body, request, env);
  const initialStock = catalogQuantity(body.initialStock, 0, 'initialStock');
  const threshold = catalogQuantity(body.lowStockThreshold, 3, 'lowStockThreshold');
  const placeholder = catalogInput({ ...body, kind: 'article', articleType: base.type, basePrices: undefined, shirt: 1, availableShirts: [1] });
  const key = text(body.idempotencyKey ?? crypto.randomUUID(), 'idempotencyKey', { min: 8, max: 128 });
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) failure(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid article creation identifier.');
  const keyHash = await sha256(`zenin:article-create:${key}`);
  const requestHash = await sha256(JSON.stringify({ base, defaultVariant, placeholder, initialStock, threshold }));
  const replay = row => {
    if (row.creation_request_hash !== requestHash) failure(409, 'IDEMPOTENCY_CONFLICT', 'This creation identifier was used for another article.');
    return json({ product: productFromRow(row) });
  };
  const existing = await env.DB.prepare('SELECT * FROM products WHERE creation_key_hash = ?').bind(keyHash).first();
  if (existing) return replay(existing);
  await applyCollection(placeholder, env);
  for (let attempt = 0; attempt < 4; attempt++) {
    const first = await nextShirtId(env);
    const baseId = `base-${crypto.randomUUID()}`, id = `zc-${crypto.randomUUID()}`, now = new Date().toISOString();
    const colors = base.colors.map((color, index) => ({ ...color, shirt: first + index }));
    const baseRecord = { id, name: base.name, type: base.type, weightGsm: 0, sizes: base.sizes, kind: 'article' };
    const product = { id, ...placeholder, shirt: colors[defaultVariant].shirt, availableShirts: colors.map(color => color.shirt) };
    await applyProductBases(product, request, env, [{ ...baseRecord, id: baseId, colors }]);
    product.slug = placeholder.slug || `${slugify(product.name, 'articulo').slice(0, 90)}-${id.slice(-8)}`;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO garment_bases(id, base_json, created_at, updated_at) VALUES (?, ?, ?, ?)`)
          .bind(baseId, JSON.stringify({ name: base.name, type: base.type, weightGsm: 0, sizes: base.sizes, kind: 'article' }), now, now),
        ...colors.map(({ shirt, ...details }) => env.DB.prepare('INSERT INTO garment_colors(shirt, base_id, color_json) VALUES (?, ?, ?)')
          .bind(shirt, baseId, JSON.stringify(details))),
        env.DB.prepare(`INSERT INTO products(id, slug, created_at, updated_at, creation_key_hash, creation_request_hash, product_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, product.slug, now, now, keyHash, requestHash, JSON.stringify(product)),
        env.DB.prepare(`INSERT INTO inventory(product_id, shirt, size, stock, low_stock_threshold, updated_at, last_reason, last_actor)
          SELECT ?, json_extract(c.value, '$.shirt'), s.value, ?, ?, ?, 'product_created', ?
          FROM json_each(?) c JOIN json_each(c.value, '$.sizes') s`).bind(id, initialStock, threshold, now, actor, JSON.stringify(product.shirtOptions)),
      ]);
      return json({ product: { ...product, active: true, version: 1, createdAt: now, updatedAt: now, deletedAt: null } }, 201);
    } catch (error) {
      const winner = await env.DB.prepare('SELECT * FROM products WHERE creation_key_hash = ?').bind(keyHash).first();
      if (winner) return replay(winner);
      if (/products\.slug/.test(sqlMessage(error))) failure(409, 'SLUG_TAKEN', 'That product URL is already in use.');
      if (!/garment_colors\.shirt|PRIMARY KEY|UNIQUE/i.test(sqlMessage(error))) throw error;
    }
  }
  failure(409, 'PRODUCT_CHANGED', 'The catalog is busy. Try again.');
}

async function changeArticle(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
  const previous = JSON.parse(row.product_json);
  if (previous.kind !== 'article') failure(400, 'INVALID_FIELD', 'This product is not an article.', { field: 'kind' });
  const body = await readJson(request), version = catalogVersion(body.version);
  if (version !== Number(row.version)) failure(409, 'PRODUCT_CHANGED', 'Product changed. Refresh and review the latest version.');
  const baseId = previous.shirtOptions[0].baseId;
  const previousBase = (await readBases(env, true, 'all')).find(base => base.id === baseId);
  if (!previousBase) failure(404, 'BASE_NOT_FOUND', 'Article variants were not found.');
  const { base, defaultVariant } = await articleInput({ ...body, defaultVariant: body.defaultVariant ?? Math.max(0,
    (body.variants ?? previousBase.colors).findIndex(color => color.shirt === previous.shirt)) }, request, env, previousBase, previous);
  const { variants, sizes, defaultVariant: ignored, ...fields } = body;
  const draft = { id, ...catalogInput({ ...fields, articleType: base.type, shirt: 1, availableShirts: [1] }, previous) };
  if (body.active !== undefined && typeof body.active !== 'boolean') failure(400, 'INVALID_FIELD', 'Invalid active state.', { field: 'active' });
  await applyCollection(draft, env);
  for (let attempt = 0; attempt < 4; attempt++) {
    let next = await nextShirtId(env);
    const colors = base.colors.map(color => color.shirt === undefined ? { ...color, shirt: next++, isNew: true } : color);
    const product = { ...draft, shirt: colors[defaultVariant].shirt, availableShirts: colors.map(color => color.shirt) };
    await applyProductBases(product, request, env, [{ ...previousBase, name: base.name, type: base.type, sizes: base.sizes, colors }]);
    const revision = crypto.randomUUID(), now = new Date().toISOString();
    product.revision = revision;
    const active = body.active ?? Boolean(row.active);
    const committed = `EXISTS (SELECT 1 FROM products WHERE id = ? AND json_extract(product_json, '$.revision') = ?)`;
    const removed = previousBase.colors.filter(color => !colors.some(next => next.shirt === color.shirt)).map(color => color.shirt);
    try {
      await env.DB.batch([
        env.DB.prepare(`UPDATE products SET slug = ?, active = ?, version = version + 1, updated_at = ?, deleted_at = ?, product_json = ?
          WHERE id = ? AND version = ?`).bind(product.slug, active ? 1 : 0, now, active ? null : row.deleted_at || now, JSON.stringify(product), id, version),
        env.DB.prepare(`UPDATE garment_bases SET base_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND ${committed}`)
          .bind(JSON.stringify({ name: base.name, type: base.type, weightGsm: 0, sizes: base.sizes, kind: 'article' }), now, baseId, id, revision),
        ...colors.map(({ shirt, isNew, ...details }) => isNew
          ? env.DB.prepare(`INSERT INTO garment_colors(shirt, base_id, color_json) SELECT ?, ?, ? WHERE ${committed}`).bind(shirt, baseId, JSON.stringify(details), id, revision)
          : env.DB.prepare(`UPDATE garment_colors SET color_json = ? WHERE shirt = ? AND base_id = ? AND ${committed}`).bind(JSON.stringify(details), shirt, baseId, id, revision)),
        ...removed.map(shirt => env.DB.prepare(`UPDATE garment_colors SET active = 0 WHERE shirt = ? AND base_id = ? AND ${committed}`).bind(shirt, baseId, id, revision)),
      ]);
    } catch (error) {
      if (/products\.slug/.test(sqlMessage(error))) failure(409, 'SLUG_TAKEN', 'That product URL is already in use.');
      if (/garment_colors\.shirt|PRIMARY KEY|UNIQUE/i.test(sqlMessage(error))) continue;
      throw error;
    }
    const saved = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    if (JSON.parse(saved.product_json).revision !== revision) failure(409, 'PRODUCT_CHANGED', 'Product changed. Refresh and review the latest version.');
    return json({ product: productFromRow(saved) });
  }
  failure(409, 'PRODUCT_CHANGED', 'The catalog is busy. Try again.');
}

async function createOrder(request, env) {
  requireSecret(env);
  await rateLimit(request, env, 'create', 20, 3600);
  const input = orderInput(await readJson(request));
  const { idempotencyKey, ...normalized } = input;
  const idempotencyHash = await sha256(idempotencyKey);
  const requestHash = await sha256(JSON.stringify(normalized));
  const previous = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash = ?').bind(idempotencyHash).first();
  if (previous) return replayOrder(env, previous, requestHash, request);
  const catalogRows = await env.DB.prepare('SELECT id, product_json FROM products WHERE active = 1').all();
  const current = await currentProductOptions(catalogRows.results.map(row => JSON.parse(row.product_json)), env);
  const catalog = new Map(current.map(product => [product.id, product]));
  if (input.items.some(item => !catalog.has(item.productId))) failure(400, 'INVALID_PRODUCT', 'A product is unavailable.');
  if (input.items.some(item => !offeredShirts(catalog.get(item.productId)).includes(item.shirt))) {
    failure(400, 'INVALID_COLOR', 'This color is not offered for this product.');
  }
  if (input.items.some(item => {
    const option = catalog.get(item.productId).shirtOptions?.find(option => option.shirt === item.shirt);
    return !(option?.sizes || [...SIZES]).includes(item.size);
  })) failure(400, 'INVALID_SIZE', 'This size is not offered for this product and base.');
  const paymentsOn = Boolean(await paymentSettings(env));
  const items = input.items.map(item => {
    const product = catalog.get(item.productId);
    const option = product.shirtOptions?.find(option => option.shirt === item.shirt);
    return { ...item, name: product.name, nameEs: product.nameEs || '',
      ...(product.kind ? { kind: product.kind } : {}), ...(product.articleType ? { articleType: product.articleType } : {}),
      ...(product.designUrl ? { designUrl: product.designUrl } : {}),
      ...(product.frontDesignUrl ? { frontDesignUrl: product.frontDesignUrl } : {}),
      ...(product.backDesignUrl ? { backDesignUrl: product.backDesignUrl } : {}),
      ...(product.printSides ? { printSides: product.printSides } : {}),
      ...(product.collection ? { collection: product.collection } : {}),
      availableShirts: offeredShirts(product), ...(option ? { shirtOptions: [option] } : {}),
      unitPrice: option?.price ?? product.price, colorName: option?.colorName || COLORS[item.shirt] || String(item.shirt) };
  });
  const subtotalCents = items.reduce((sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity, 0);
  const discountCents = input.discountCode === 'ZENIN10' ? Math.round(subtotalCents * 0.1) : 0;
  const shippingCents = subtotalCents >= 12000 ? 0 : 800;
  const now = new Date().toISOString();
  const order = {
    id: `ZC-${crypto.randomUUID()}`, createdAt: now, updatedAt: now, status: 'new',
    customer: input.customer, items,
    totals: { subtotal: subtotalCents / 100, discount: discountCents / 100, shipping: shippingCents / 100,
      total: (subtotalCents - discountCents + shippingCents) / 100, currency: 'USD' },
    discountCode: input.discountCode, language: input.language, notes: '',
    tracking: { carrier: '', number: '' }, history: [{ status: 'new', at: now }],
    ...(paymentsOn ? { payment: { provider: 'tilopay', status: 'pending', attempts: 0 }, ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}) } : {}),
  };
  if (paymentsOn && !input.customer.phone) failure(400, 'INVALID_FIELD', 'A phone number is required to pay.', { field: 'phone' });
  const token = await trackingToken(env, order.id, idempotencyHash);
  const tokenHash = await sha256(token);
  try {
    const insert = env.DB.prepare(`INSERT INTO orders
      (id, idempotency_hash, request_hash, tracking_hash, email_normalized, status, created_at, updated_at, order_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(order.id, idempotencyHash, requestHash, tokenHash, order.customer.email, order.status, now, now, JSON.stringify(order));
    // Allocation and audit triggers run in this same D1 transaction. Available
    // units are deducted down to zero; low stock never prevents a valid order.
    await env.DB.batch([insert]);
  } catch (error) {
    // A parallel checkout retry may have won the unique-key insert.
    const winner = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash = ?').bind(idempotencyHash).first();
    if (winner) return replayOrder(env, winner, requestHash, request);
    if (/INVALID_PRODUCT/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) {
      failure(400, 'INVALID_PRODUCT', 'A product is unavailable.');
    }
    if (/INVALID_COLOR/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(400, 'INVALID_COLOR', 'This color is not offered for this product.');
    if (/INVALID_SIZE/.test(`${error?.message || ''} ${error?.cause?.message || ''}`)) failure(400, 'INVALID_SIZE', 'This size is not offered for this product.');
    throw error;
  }
  const payment = order.payment ? await paymentLink(request, env, order) : undefined;
  return json({ order: publicOrder(order), trackingToken: token, ...(payment ? { payment } : {}) }, 201);
}

async function trackOrder(request, env) {
  await rateLimit(request, env, 'track', 120, 900);
  const body = await readJson(request);
  const id = text(body.id, 'id', { max: 80 });
  const suppliedToken = body.token === undefined ? '' : text(body.token, 'token', { min: 1, max: 128 });
  const suppliedEmail = suppliedToken ? '' : email(body.email);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  const valid = suppliedToken
    ? constantEqual(await sha256(suppliedToken), row?.tracking_hash || '0'.repeat(64))
    : constantEqual(suppliedEmail, row?.email_normalized || '');
  if (!row || !valid) failure(404, 'ORDER_NOT_FOUND', 'Order was not found with those details.');
  let order = JSON.parse(row.order_json);
  if (['pending', 'review'].includes(order.payment?.status) && await paymentSettings(env)) {
    try { await refreshPayment(env, row.id); } catch { /* Shown as pending; the cron confirms later. */ }
    order = JSON.parse((await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(row.id).first()).order_json);
  }
  const { returnUrl, ...visible } = publicOrder(order);
  return json({ order: visible, payments: { enabled: Boolean(await paymentSettings(env)) } });
}

async function login(request, env) {
  await rateLimit(request, env, 'login', 5, 900);
  requireSecret(env);
  if (!/^[a-f0-9]{64}$/i.test(env.ADMIN_PASSWORD_HASH || '') ||
      typeof env.ADMIN_PASSWORD_SALT !== 'string' || env.ADMIN_PASSWORD_SALT.length < 16) {
    failure(503, 'SERVICE_UNAVAILABLE', 'Admin access is not configured.');
  }
  const body = await readJson(request);
  const username = text(body.username, 'username', { max: 80 });
  // Passwords are intentionally neither trimmed nor normalized.
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) {
    failure(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
  }
  const actual = await sha256(`${env.ADMIN_PASSWORD_SALT}:${body.password}`);
  const passwordMatches = constantEqual(actual, env.ADMIN_PASSWORD_HASH.toLowerCase());
  const usernameMatches = constantEqual(username, env.ADMIN_USERNAME || 'Admin');
  if (!passwordMatches || !usernameMatches) failure(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: env.ADMIN_USERNAME || 'Admin', iss: 'zenin-club', aud: 'admin',
    iat: now, exp: now + SESSION_SECONDS, jti: crypto.randomUUID() };
  const content = `${base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  return json({ token: `${content}.${base64url(await hmac(env, content))}`, expiresAt: new Date(payload.exp * 1000).toISOString() });
}

async function authorize(request, env) {
  requireSecret(env);
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ') || authorization.length > 4096) {
    failure(401, 'UNAUTHORIZED', 'Admin sign-in is required.');
  }
  try {
    const parts = authorization.slice(7).split('.');
    if (parts.length !== 3) throw new Error('Invalid session');
    const header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
    const expected = base64url(await hmac(env, `${parts[0]}.${parts[1]}`));
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || !constantEqual(expected, parts[2]) ||
        payload.iss !== 'zenin-club' || payload.aud !== 'admin' || payload.sub !== (env.ADMIN_USERNAME || 'Admin') ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= now ||
        payload.iat > now + 60 || payload.exp - payload.iat !== SESSION_SECONDS) throw new Error('Invalid session');
    return payload;
  } catch {
    failure(401, 'UNAUTHORIZED', 'Admin session is invalid or expired.');
  }
}

function positiveInteger(value, fallback, max, field) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    failure(400, 'INVALID_FIELD', `Invalid ${field}.`, { field });
  }
  return Number(value);
}

async function listOrders(url, env) {
  const page = positiveInteger(url.searchParams.get('page'), 1, 100000, 'page');
  const limit = positiveInteger(url.searchParams.get('limit'), 50, 100, 'limit');
  const status = url.searchParams.get('status') || '';
  if (status && !STATUSES.has(status)) failure(400, 'INVALID_STATUS', 'Invalid order status.');
  const search = text(url.searchParams.get('search') || '', 'search', { min: 0, max: 200 });
  const clauses = [];
  const bindings = [];
  if (status) { clauses.push('status = ?'); bindings.push(status); }
  if (search) {
    clauses.push("(id LIKE ? ESCAPE '\\' OR email_normalized LIKE ? ESCAPE '\\' OR json_extract(order_json, '$.customer.name') LIKE ? ESCAPE '\\')");
    const pattern = `%${search.replace(/[\\%_]/g, match => `\\${match}`)}%`;
    bindings.push(pattern, pattern, pattern);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) AS total FROM orders${where}`).bind(...bindings).first('total');
  const rows = await env.DB.prepare(`SELECT order_json, version FROM orders${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, (page - 1) * limit).all();
  return json({ orders: rows.results.map(row => ({ ...JSON.parse(row.order_json), version: Number(row.version) })), total: Number(total), page, limit });
}

async function adminOrder(request, env, id) {
  if (id.length > 80) failure(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  let order = JSON.parse(row.order_json);
  if (request.method === 'GET') {
    if (['pending', 'review'].includes(order.payment?.status) && await paymentSettings(env)) {
      try { await refreshPayment(env, id); } catch { /* Keep showing the stored state. */ }
      const fresh = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
      return json({ order: { ...JSON.parse(fresh.order_json), version: Number(fresh.version) } });
    }
    return json({ order: { ...order, version: Number(row.version) } });
  }
  const body = await readJson(request);
  const keys = Object.keys(body);
  if (!keys.some(key => ['status', 'notes', 'tracking'].includes(key)) ||
      keys.some(key => !['status', 'notes', 'tracking', 'expectedVersion'].includes(key))) {
    failure(400, 'INVALID_UPDATE', 'Update status, notes, or tracking.');
  }
  if (body.expectedVersion !== undefined) {
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
      failure(400, 'INVALID_FIELD', 'Invalid order version.', { field: 'expectedVersion' });
    }
    if (body.expectedVersion !== Number(row.version)) {
      failure(409, 'ORDER_CHANGED', 'Order changed. Refresh and review the latest version.', { currentVersion: Number(row.version) });
    }
  }
  const now = new Date().toISOString();
  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) failure(400, 'INVALID_STATUS', 'Invalid order status.');
    if (order.status !== body.status) {
      order.status = body.status;
      order.history.push({ status: body.status, at: now });
    }
  }
  if (body.notes !== undefined) order.notes = text(body.notes, 'notes', { min: 0, max: 2000, multiline: true });
  if (body.tracking !== undefined) {
    if (!object(body.tracking) || Object.keys(body.tracking).some(key => !['carrier', 'number'].includes(key))) {
      failure(400, 'INVALID_TRACKING', 'Invalid tracking details.');
    }
    if (body.tracking.carrier !== undefined) order.tracking.carrier = text(body.tracking.carrier, 'carrier', { min: 0, max: 80 });
    if (body.tracking.number !== undefined) order.tracking.number = text(body.tracking.number, 'number', { min: 0, max: 160 });
  }
  order.updatedAt = now;
  // Reopening allocates only available units; cancellation returns exactly that
  // allocation, even if the order was originally placed with stock at zero.
  const result = await env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ?, order_json = ?, version = version + 1
    WHERE id = ? AND version = ? RETURNING id, version`).bind(order.status, now, JSON.stringify(order), id, row.version).first();
  if (!result) failure(409, 'ORDER_CHANGED', 'Order changed. Refresh and try again.');
  return json({ order: { ...order, version: Number(result.version) } });
}

export default {
  async scheduled(event, env, context) {
    context.waitUntil(sweepPayments(env));
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigin = origin && ORIGINS.has(origin) ? origin : null;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' };
    if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
    let response;
    try {
      if (origin && !allowedOrigin) failure(403, 'ORIGIN_DENIED', 'This origin is not allowed.');
      if (request.method === 'OPTIONS') {
        response = new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range', 'Access-Control-Max-Age': '600',
        } });
      } else {
        requireDatabase(env);
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        if (path === '/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT 1 AS ok').first();
          response = json({ status: 'ok', storage: 'd1' });
        } else if (path === '/products' && request.method === 'GET') response = await readProducts(env);
        else if (path === '/inventory' && request.method === 'GET') response = await publicInventory(env);
        else if (path === '/bases' && request.method === 'GET') response = json({ bases: await readBases(env) });
        else if (path === '/collections' && request.method === 'GET') {
          response = json({ collections: (await readCollections(env)).map(({ version, createdAt, updatedAt, active, ...collection }) => collection) });
        }
        else if (path === '/admin/collections' || /^\/admin\/collections\/[^/]+$/.test(path)) {
          await authorize(request, env);
          if (path === '/admin/collections' && request.method === 'GET') response = json({ collections: await adminCollections(env, url.searchParams.get('includeArchived') === 'true') });
          else if (path === '/admin/collections' && request.method === 'POST') response = await createCollection(request, env);
          else if (path !== '/admin/collections' && ['PATCH', 'DELETE'].includes(request.method)) response = await changeCollection(request, env, path.slice('/admin/collections/'.length));
          else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/admin/articles' || /^\/admin\/articles\/[^/]+$/.test(path)) {
          const session = await authorize(request, env);
          if (path === '/admin/articles' && request.method === 'POST') response = await createArticle(request, env, session.sub);
          else if (path !== '/admin/articles' && request.method === 'PATCH') response = await changeArticle(request, env, path.slice('/admin/articles/'.length));
          else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/admin/bases' || /^\/admin\/bases\/[^/]+$/.test(path)) {
          await authorize(request, env);
          const kind = url.searchParams.get('kind') || 'garment';
          if (!BASE_KINDS.has(kind)) failure(400, 'INVALID_FIELD', 'Invalid base kind.', { field: 'kind' });
          if (path === '/admin/bases' && request.method === 'GET') response = json({ bases: await readBases(env, url.searchParams.get('includeArchived') === 'true', kind) });
          else if (path === '/admin/bases' && request.method === 'POST') response = await createBase(request, env);
          else if (path !== '/admin/bases' && ['PATCH', 'DELETE'].includes(request.method)) response = await changeBase(request, env, path.slice('/admin/bases/'.length));
          else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (/^\/designs\/[a-f0-9]{64}\.png$/.test(path) && ['GET', 'HEAD'].includes(request.method)) {
          response = await serveDesign(request, env, path.slice('/designs/'.length, -4));
        }
        else if (/^\/videos\/[a-f0-9]{64}\.(mp4|webm)$/.test(path) && ['GET', 'HEAD'].includes(request.method)) {
          const [, id, extension] = path.match(/^\/videos\/([a-f0-9]{64})\.(mp4|webm)$/);
          response = await serveVideo(request, env, id, extension);
        }
        else if (path === '/admin/videos') {
          const session = await authorize(request, env);
          if (request.method !== 'POST') failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
          response = await uploadVideo(request, env, session.sub);
        }
        else if (path === '/settings/landing' && request.method === 'GET') {
          const { slides } = await readLanding(env);
          response = json({ landing: { slides } });
        }
        else if (path === '/admin/settings/landing') {
          await authorize(request, env);
          if (request.method === 'GET') response = json({ landing: await readLanding(env) });
          else if (request.method === 'PUT') response = await saveLanding(request, env);
          else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/admin/designs') {
          const session = await authorize(request, env);
          if (request.method !== 'POST') failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
          response = await uploadDesign(request, env, session.sub);
        }
        else if (path === '/orders' && request.method === 'POST') response = await createOrder(request, env);
        else if (path === '/orders/track' && request.method === 'POST') response = await trackOrder(request, env);
        else if (path === '/orders/pay' && request.method === 'POST') response = await retryPayment(request, env);
        else if (path === '/payments/config' && request.method === 'GET') {
          const enabled = Boolean(await paymentSettings(env));
          response = json({ enabled, provider: enabled ? 'tilopay' : null });
        }
        else if (path === '/admin/settings/payments' || path === '/admin/settings/payments/test') {
          await authorize(request, env);
          if (path === '/admin/settings/payments' && request.method === 'GET') response = json({ payments: await adminPaymentSettings(env) });
          else if (path === '/admin/settings/payments' && request.method === 'PUT') response = await savePaymentSettings(request, env);
          else if (path === '/admin/settings/payments/test' && request.method === 'POST') response = await testPaymentSettings(request, env);
          else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/payments/tilopay/return' && request.method === 'GET') response = await paymentReturn(request, env);
        else if (/^\/admin\/orders\/[^/]+\/refund$/.test(path) && request.method === 'POST') {
          const session = await authorize(request, env);
          response = await refundOrder(request, env, decodeURIComponent(path.split('/')[3]), session.sub);
        }
        else if (path === '/admin/login' && request.method === 'POST') response = await login(request, env);
        else if (path === '/admin/products' || /^\/admin\/products\/[^/]+$/.test(path)) {
          const session = await authorize(request, env);
          if (path === '/admin/products' && request.method === 'GET') response = await readProducts(env, url.searchParams.get('includeArchived') === 'true', true);
          else if (path === '/admin/products' && request.method === 'POST') response = await createProduct(request, env, session.sub);
          else if (path !== '/admin/products' && ['PATCH', 'DELETE'].includes(request.method)) {
            response = await changeProduct(request, env, path.slice('/admin/products/'.length));
          } else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/admin/inventory' || /^\/admin\/inventory\/[^/]+\/[^/]+\/[^/]+$/.test(path)) {
          const session = await authorize(request, env);
          if (path === '/admin/inventory' && request.method === 'GET') response = await adminInventory(env, url.searchParams.get('includeArchived') === 'true');
          else if (path !== '/admin/inventory' && ['GET', 'PATCH'].includes(request.method)) {
            const [, , , productId, shirt, encodedSize] = path.split('/');
            let size;
            try { size = decodeURIComponent(encodedSize); } catch { failure(400, 'INVALID_SIZE', 'Invalid size.'); }
            const key = inventoryKey(productId, shirt, size);
            response = request.method === 'GET' ? json(await inventoryDetail(env, key)) : await updateInventory(request, env, key, session.sub);
          } else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        }
        else if (path === '/admin/orders' || /^\/admin\/orders\/[^/]+$/.test(path)) {
          await authorize(request, env);
          if (path === '/admin/orders' && request.method === 'GET') response = await listOrders(url, env);
          else if (path !== '/admin/orders' && ['GET', 'PATCH'].includes(request.method)) {
            response = await adminOrder(request, env, decodeURIComponent(path.slice('/admin/orders/'.length)));
          } else failure(405, 'METHOD_NOT_ALLOWED', 'Method is not supported.');
        } else failure(404, 'NOT_FOUND', 'Endpoint was not found.');
      }
    } catch (error) {
      if (error instanceof ApiError) {
        response = json({ error: { code: error.code, message: error.message, ...error.extra } }, error.status,
          error.code === 'RATE_LIMITED' ? { 'Retry-After': String(error.extra.retryAfter) } : {});
      } else {
        // Do not log request bodies, customer details, credentials, or SQL errors.
        response = json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to complete this request.' } }, 500);
      }
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'Cache-Control' && response.headers.has(name)) continue;
      response.headers.set(name, value);
    }
    return response;
  },
};
