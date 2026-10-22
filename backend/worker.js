import products from '../docs/data/products.json' with { type: 'json' };

const CATALOG = new Map(products.map(product => [product.id, product]));
const COLORS = { 1: 'Washed Black', 2: 'Deep Teal', 3: 'Dusty Violet', 4: 'Faded Red' };
const SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL']);
const STATUSES = new Set(['new', 'preparing', 'ready', 'shipped', 'cancelled']);
const ORIGINS = new Set(['https://ealfaro29.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173']);
const MAX_BODY = 32 * 1024;
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
  };
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) {
    failure(400, 'INVALID_ITEMS', 'Choose between 1 and 40 items.');
  }
  const variants = new Map();
  let count = 0;
  for (const item of body.items) {
    if (!object(item) || typeof item.productId !== 'string' || !CATALOG.has(item.productId)) {
      failure(400, 'INVALID_PRODUCT', 'A product is unavailable.');
    }
    if (!Number.isInteger(item.shirt) || !Object.hasOwn(COLORS, item.shirt)) {
      failure(400, 'INVALID_COLOR', 'Choose a valid shirt color.');
    }
    if (!SIZES.has(item.size)) failure(400, 'INVALID_SIZE', 'Choose a valid size.');
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
  return { customer, items, discountCode, language, idempotencyKey };
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
  const { notes, ...visible } = order;
  return visible;
}

async function replayOrder(env, row, requestHash) {
  if (row.request_hash !== requestHash) {
    failure(409, 'IDEMPOTENCY_CONFLICT', 'This checkout identifier was already used for another order.');
  }
  const order = JSON.parse(row.order_json);
  return json({ order: publicOrder(order), trackingToken: await trackingToken(env, row.id, row.idempotency_hash) });
}

async function createOrder(request, env) {
  requireSecret(env);
  await rateLimit(request, env, 'create', 20, 3600);
  const input = orderInput(await readJson(request));
  const { idempotencyKey, ...normalized } = input;
  const idempotencyHash = await sha256(idempotencyKey);
  const requestHash = await sha256(JSON.stringify(normalized));
  const previous = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash = ?').bind(idempotencyHash).first();
  if (previous) return replayOrder(env, previous, requestHash);
  const items = input.items.map(item => {
    const product = CATALOG.get(item.productId);
    return { ...item, name: product.name, emoji: product.emoji, unitPrice: product.price, colorName: COLORS[item.shirt] };
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
  };
  const token = await trackingToken(env, order.id, idempotencyHash);
  const tokenHash = await sha256(token);
  try {
    await env.DB.prepare(`INSERT INTO orders
      (id, idempotency_hash, request_hash, tracking_hash, email_normalized, status, created_at, updated_at, order_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(order.id, idempotencyHash, requestHash, tokenHash, order.customer.email, order.status, now, now, JSON.stringify(order)).run();
  } catch (error) {
    // A parallel checkout retry may have won the unique-key insert.
    const winner = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_hash = ?').bind(idempotencyHash).first();
    if (winner) return replayOrder(env, winner, requestHash);
    throw error;
  }
  return json({ order: publicOrder(order), trackingToken: token }, 201);
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
  return json({ order: publicOrder(JSON.parse(row.order_json)) });
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
  const rows = await env.DB.prepare(`SELECT order_json FROM orders${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, (page - 1) * limit).all();
  return json({ orders: rows.results.map(row => JSON.parse(row.order_json)), total: Number(total), page, limit });
}

async function adminOrder(request, env, id) {
  if (id.length > 80) failure(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!row) failure(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const order = JSON.parse(row.order_json);
  if (request.method === 'GET') return json({ order });
  const body = await readJson(request);
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !['status', 'notes', 'tracking'].includes(key))) {
    failure(400, 'INVALID_UPDATE', 'Update status, notes, or tracking.');
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
  const result = await env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ?, order_json = ?, version = version + 1
    WHERE id = ? AND version = ?`).bind(order.status, now, JSON.stringify(order), id, row.version).run();
  if (Number(result.meta?.changes) !== 1) failure(409, 'ORDER_CHANGED', 'Order changed. Refresh and try again.');
  return json({ order });
}

export default {
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
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600',
        } });
      } else {
        requireDatabase(env);
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        if (path === '/health' && request.method === 'GET') {
          await env.DB.prepare('SELECT 1 AS ok').first();
          response = json({ status: 'ok', storage: 'd1' });
        } else if (path === '/orders' && request.method === 'POST') response = await createOrder(request, env);
        else if (path === '/orders/track' && request.method === 'POST') response = await trackOrder(request, env);
        else if (path === '/admin/login' && request.method === 'POST') response = await login(request, env);
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
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  },
};
