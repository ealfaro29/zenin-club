import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import worker from './worker.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const inventoryMigration = await readFile(new URL('./migrations/0002_inventory.sql', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');

class D1Statement {
  constructor(database, sql, params = [], afterRead) { this.database = database; this.sql = sql; this.params = params; this.afterRead = afterRead; }
  bind(...params) { return new D1Statement(this.database, this.sql, params, this.afterRead); }
  async first(column) {
    const result = this.database.prepare(this.sql).get(...this.params);
    if (this.afterRead) await this.afterRead(this.sql);
    return column ? result?.[column] ?? null : result ?? null;
  }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.params) }; }
  execute() {
    const before = this.database.prepare('SELECT total_changes() AS n').get().n;
    const result = this.database.prepare(this.sql).run(...this.params);
    const after = this.database.prepare('SELECT total_changes() AS n').get().n;
    // D1 reports trigger side effects too, unlike SQLite's direct changes count.
    return { success: true, meta: { changes: Number(after - before), last_row_id: Number(result.lastInsertRowid) } };
  }
  async run() { return this.execute(); }
}

class D1Adapter {
  constructor(path = ':memory:', bootstrap = schema) { this.database = new DatabaseSync(path); this.database.exec(bootstrap); }
  prepare(sql) { return new D1Statement(this.database, sql, [], this.afterRead); }
  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.database.close(); }
}

function environment(path, bootstrap = schema) {
  const salt = 'test-only-salt-2026-zenin';
  return { DB: new D1Adapter(path, bootstrap), ADMIN_USERNAME: 'Admin', ADMIN_PASSWORD_SALT: salt,
    ADMIN_PASSWORD_HASH: hash(`${salt}:test-only-password`),
    ADMIN_SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters' };
}

function checkout(overrides = {}) {
  return { customer: { name: 'Test Customer', email: 'test@example.com', address: '123 Test Street',
    apartment: '', city: 'San José', postal: '10101', country: 'Costa Rica' },
  items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 1 }],
  discountCode: '', language: 'es', idempotencyKey: crypto.randomUUID(), ...overrides };
}

async function request(env, path, { method = 'GET', body, token, ip = '192.0.2.1', origin = 'https://ealfaro29.github.io', raw } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const response = await worker.fetch(new Request(`https://orders.example${path}`, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
  return { status: response.status, headers: response.headers,
    data: response.status === 204 ? null : await response.json() };
}

async function adminToken(env) {
  const result = await request(env, '/admin/login', { method: 'POST', body: { username: 'Admin', password: 'test-only-password' }, ip: '192.0.2.254' });
  assert.equal(result.status, 200);
  return result.data.token;
}

test('server prices, shipping threshold, discounts and variants are authoritative', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const payload = checkout({ items: [{ productId: 'zc-001', shirt: 4, size: 'XXL', quantity: 3, unitPrice: 0.01, name: 'tampered' }], discountCode: 'zenin10' });
  const result = await request(env, '/orders', { method: 'POST', body: payload });
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.order.totals, { subtotal: 126, discount: 12.6, shipping: 0, total: 113.4, currency: 'USD' });
  assert.equal(result.data.order.items[0].name, 'Midnight Snack Tee');
  assert.equal(result.data.order.items[0].unitPrice, 42);
  assert.equal(result.data.order.items[0].colorName, 'Faded Red');
  assert.equal(result.data.order.language, 'es');
  assert.equal(result.data.order.status, 'new');
  assert.deepEqual(result.data.order.history, [{ status: 'new', at: result.data.order.createdAt }]);
  assert.equal(Object.hasOwn(result.data.order, 'notes'), false);
  const small = await request(env, '/orders', { method: 'POST', body: checkout({ discountCode: 'ZENIN10' }) });
  assert.deepEqual(small.data.order.totals, { subtotal: 42, discount: 4.2, shipping: 8, total: 45.8, currency: 'USD' });
});

test('checkout validation rejects malformed JSON, excessive bodies and invalid product selections', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const variants = [
    [checkout({ items: [] }), 'INVALID_ITEMS'],
    [checkout({ items: [{ productId: 'unknown', shirt: 1, size: 'M', quantity: 1 }] }), 'INVALID_PRODUCT'],
    [checkout({ items: [{ productId: 'zc-001', shirt: 5, size: 'M', quantity: 1 }] }), 'INVALID_COLOR'],
    [checkout({ items: [{ productId: 'zc-001', shirt: 1, size: 'XS', quantity: 1 }] }), 'INVALID_SIZE'],
    [checkout({ items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 11 }] }), 'INVALID_QUANTITY'],
    [checkout({ customer: { ...checkout().customer, email: 'bad-address' } }), 'INVALID_FIELD'],
    [checkout({ customer: { ...checkout().customer, address: '' } }), 'INVALID_FIELD'],
    [checkout({ discountCode: 'FREE100' }), 'INVALID_DISCOUNT'],
    [checkout({ language: 'fr' }), 'INVALID_LANGUAGE'],
    [checkout({ idempotencyKey: 'x' }), 'INVALID_FIELD'],
    [checkout({ items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 6 }, { productId: 'zc-001', shirt: 1, size: 'M', quantity: 6 }] }), 'INVALID_QUANTITY'],
  ];
  for (const [body, code] of variants) {
    const result = await request(env, '/orders', { method: 'POST', body });
    assert.equal(result.status, 400, code);
    assert.equal(result.data.error.code, code);
  }
  assert.equal((await request(env, '/orders', { method: 'POST', raw: '{ broken' })).data.error.code, 'INVALID_JSON');
  assert.equal((await request(env, '/orders', { method: 'POST', raw: JSON.stringify({ value: 'x'.repeat(33000) }) })).status, 413);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n')), 0);
});

test('idempotent checkout retries persist one order and do not store the plaintext token', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const body = checkout();
  const first = await request(env, '/orders', { method: 'POST', body });
  const repeated = await request(env, '/orders', { method: 'POST', body });
  assert.equal(first.status, 201); assert.equal(repeated.status, 200);
  assert.equal(first.data.order.id, repeated.data.order.id);
  assert.equal(first.data.trackingToken, repeated.data.trackingToken);
  const conflict = await request(env, '/orders', { method: 'POST', body: { ...body, customer: { ...body.customer, name: 'Different Customer' } } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  const row = await env.DB.prepare('SELECT * FROM orders').first();
  assert.equal(row.tracking_hash, hash(first.data.trackingToken));
  assert.equal(JSON.stringify(row).includes(first.data.trackingToken), false);
  assert.equal(JSON.stringify(row).includes(body.idempotencyKey), false);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 1);
  const parallelBody = checkout();
  const parallel = await Promise.all([request(env, '/orders', { method: 'POST', body: parallelBody }), request(env, '/orders', { method: 'POST', body: parallelBody })]);
  assert.deepEqual(parallel.map(result => result.status).sort(), [200, 201]);
  assert.equal(parallel[0].data.order.id, parallel[1].data.order.id);
  assert.equal(parallel[0].data.trackingToken, parallel[1].data.trackingToken);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 2);
});

test('admin authentication is mandatory and authenticated updates remain private on tracking', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const creation = await request(env, '/orders', { method: 'POST', body: checkout() });
  const id = creation.data.order.id;
  const trackingToken = creation.data.trackingToken;
  assert.equal((await request(env, '/admin/orders')).status, 401);
  assert.equal((await request(env, `/admin/orders/${id}`, { method: 'PATCH', body: { status: 'shipped' } })).status, 401);
  assert.equal((await request(env, '/admin/login', { method: 'POST', body: { username: 'Admin', password: 'incorrect' } })).status, 401);
  const token = await adminToken(env);
  assert.equal((await request(env, '/admin/orders', { token: `${token.slice(0, -2)}aa` })).status, 401);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(payload.exp - payload.iat, 21600);
  const expiredPayload = { ...payload, iat: Math.floor(Date.now() / 1000) - 21601, exp: Math.floor(Date.now() / 1000) - 1 };
  const expiredContent = `${token.split('.')[0]}.${Buffer.from(JSON.stringify(expiredPayload)).toString('base64url')}`;
  const expiredToken = `${expiredContent}.${createHmac('sha256', env.ADMIN_SESSION_SECRET).update(expiredContent).digest('base64url')}`;
  assert.equal((await request(env, '/admin/orders', { token: expiredToken })).status, 401);
  const edited = await request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: {
    status: 'shipped', notes: 'Internal fulfillment note', tracking: { carrier: 'Correos', number: 'CR-123456' },
  } });
  assert.equal(edited.status, 200); assert.equal(edited.data.order.notes, 'Internal fulfillment note');
  assert.equal(edited.data.order.history.length, 2); assert.equal(edited.data.order.history[1].status, 'shipped');
  const unchanged = await request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { status: 'shipped' } });
  assert.equal(unchanged.data.order.history.length, 2);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id, token: trackingToken } });
  assert.equal(tracked.status, 200); assert.equal(tracked.data.order.status, 'shipped');
  assert.equal(tracked.data.order.tracking.number, 'CR-123456');
  assert.equal(tracked.data.order.customer.address, '123 Test Street');
  assert.equal(Object.hasOwn(tracked.data.order, 'notes'), false);
  assert.equal(JSON.stringify(tracked.data).includes('Internal fulfillment note'), false);
  const emailTrack = await request(env, '/orders/track', { method: 'POST', body: { id, email: 'TEST@example.com' } });
  assert.equal(emailTrack.status, 200);
  for (const credentials of [{ id, token: 'wrong-token' }, { id, email: 'wrong@example.com' }, { id: 'unknown-order', email: 'test@example.com' }]) {
    const result = await request(env, '/orders/track', { method: 'POST', body: credentials });
    assert.equal(result.status, 404); assert.equal(result.data.error.code, 'ORDER_NOT_FOUND');
  }
  assert.equal((await request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { status: 'invented' } })).status, 400);
  assert.equal((await request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { totals: { total: 0 } } })).status, 400);
  const byStatus = await request(env, '/admin/orders?status=shipped&page=1&limit=1', { token });
  assert.equal(byStatus.data.total, 1); assert.equal(byStatus.data.orders[0].notes, 'Internal fulfillment note');
  assert.equal((await request(env, '/admin/orders?search=test%40example.com', { token })).data.total, 1);
  assert.equal((await request(env, '/admin/orders?search=%25', { token })).data.total, 0);
  assert.equal((await request(env, '/admin/orders?page=0', { token })).status, 400);
});

test('overlapping admin updates do not silently overwrite each other', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const created = await request(env, '/orders', { method: 'POST', body: checkout() });
  const token = await adminToken(env);
  const id = created.data.order.id;
  // Hold both reads at the same version to model two D1 requests in flight.
  let readers = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  env.DB.afterRead = async sql => {
    if (sql !== 'SELECT * FROM orders WHERE id = ?') return;
    readers++;
    if (readers === 2) release();
    if (readers <= 2) await barrier;
  };
  const edits = await Promise.all([
    request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { status: 'preparing', notes: 'First edit' } }),
    request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { status: 'ready', notes: 'Second edit' } }),
  ]);
  env.DB.afterRead = null;
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
  assert.equal(edits.find(result => result.status === 409).data.error.code, 'ORDER_CHANGED');
  const winner = edits.find(result => result.status === 200).data.order;
  const saved = await request(env, `/admin/orders/${id}`, { token });
  assert.equal(saved.data.order.notes, winner.notes);
  assert.equal(saved.data.order.status, winner.status);
  assert.equal(saved.data.order.history.length, 2);
});

test('orders and admin edits survive a fresh database connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zenin-orders-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'orders.sqlite');
  const env = environment(path);
  const creation = await request(env, '/orders', { method: 'POST', body: checkout() });
  const id = creation.data.order.id;
  await request(env, `/admin/orders/${id}`, { method: 'PATCH', token: await adminToken(env), body: { status: 'preparing' } });
  env.DB.close();
  env.DB = new D1Adapter(path); t.after(() => env.DB.close());
  const tracking = await request(env, '/orders/track', { method: 'POST', body: { id, token: creation.data.trackingToken } });
  assert.equal(tracking.status, 200); assert.equal(tracking.data.order.status, 'preparing');
  assert.equal(tracking.data.order.history.length, 2);
  const list = await request(env, '/admin/orders', { token: await adminToken(env) });
  assert.equal(list.data.total, 1); assert.equal(list.data.orders[0].id, id);
});

test('D1 rate limits cover login and creation; CORS never grants an unapproved origin', async t => {
  const env = environment(); t.after(() => env.DB.close());
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request(env, '/admin/login', { method: 'POST', body: { username: 'Admin', password: 'wrong' } })).status, 401);
  }
  const blocked = await request(env, '/admin/login', { method: 'POST', body: { username: 'Admin', password: 'test-only-password' } });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  const fresh = await request(env, '/admin/login', { method: 'POST', body: { username: 'Admin', password: 'test-only-password' }, ip: '192.0.2.2' });
  assert.equal(fresh.status, 200);
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ items: [] }), ip: '192.0.2.3' })).status, 400);
  }
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout(), ip: '192.0.2.3' })).status, 429);
  const denied = await request(env, '/orders', { method: 'POST', body: checkout(), origin: 'https://unapproved.example' });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  const preflight = await request(env, '/orders', { method: 'OPTIONS', origin: 'http://localhost:5173' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal((await request(env, '/health')).data.storage, 'd1');
  assert.equal((await request({ ...env, DB: undefined }, '/health')).status, 503);
  const keys = await env.DB.prepare('SELECT bucket_key FROM rate_limits').all();
  assert.ok(keys.results.every(row => /^[a-f0-9]{64}$/.test(row.bucket_key)));
});

const inventoryRow = (env, productId = 'zc-001', shirt = 1, size = 'M') => env.DB.prepare(
  'SELECT * FROM inventory WHERE product_id = ? AND shirt = ? AND size = ?').bind(productId, shirt, size).first();

async function adjustStock(env, token, stock, { productId = 'zc-001', shirt = 1, size = 'M', threshold = 3, reason = 'Stock count' } = {}) {
  const row = await inventoryRow(env, productId, shirt, size);
  return request(env, `/admin/inventory/${productId}/${shirt}/${size}`, { method: 'PATCH', token,
    body: { stock, lowStockThreshold: threshold, version: row.version, reason } });
}

test('inventory exposes all 320 seeded variants while admin audit and thresholds stay authenticated', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const available = await request(env, '/inventory');
  assert.equal(available.status, 200); assert.equal(available.data.variants.length, 320);
  assert.ok(available.data.variants.every(variant => variant.stock === 12));
  assert.deepEqual(Object.keys(available.data.variants[0]).sort(), ['productId', 'shirt', 'size', 'stock']);
  assert.equal((await request(env, '/admin/inventory')).status, 401);
  const admin = await request(env, '/admin/inventory', { token: await adminToken(env) });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.data.summary, { products: 16, variants: 320, totalStock: 3840, outOfStock: 0, lowStock: 0 });
  assert.deepEqual(admin.data.meta, { initialStock: 12, defaultLowStockThreshold: 3, mockSeed: true });
  assert.equal(admin.data.variants[0].history[0].kind, 'seed');
  assert.equal(admin.data.variants[0].lowStockThreshold, 3);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), 320);
});

test('concurrent orders cannot oversell and a successful idempotent replay does not deduct twice', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  assert.equal((await adjustStock(env, token, 1)).status, 200);
  const bodies = [checkout(), checkout()];
  let readers = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  env.DB.afterRead = async sql => {
    if (sql !== 'SELECT * FROM orders WHERE idempotency_hash = ?') return;
    readers++;
    if (readers === 2) release();
    if (readers <= 2) await barrier;
  };
  const results = await Promise.all(bodies.map(body => request(env, '/orders', { method: 'POST', body })));
  env.DB.afterRead = null;
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const rejected = results.find(result => result.status === 409);
  assert.equal(rejected.data.error.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual(rejected.data.error.items, [{ productId: 'zc-001', shirt: 1, size: 'M', requested: 1, available: 0 }]);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations WHERE active = 1').first('n'), 1);
  const winnerIndex = results.findIndex(result => result.status === 201);
  const replay = await request(env, '/orders', { method: 'POST', body: bodies[winnerIndex] });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.order.id, results[winnerIndex].data.order.id);
  assert.equal(replay.data.trackingToken, results[winnerIndex].data.trackingToken);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE kind = 'reserve'").first('n'), 1);
});

test('an insufficient line rolls back the complete multi-item order, reservations and movements', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  await adjustStock(env, token, 0, { productId: 'zc-002', shirt: 2, size: 'L' });
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n');
  const result = await request(env, '/orders', { method: 'POST', body: checkout({ items: [
    { productId: 'zc-001', shirt: 1, size: 'M', quantity: 2 },
    { productId: 'zc-002', shirt: 2, size: 'L', quantity: 2 },
  ] }) });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await inventoryRow(env)).stock, 12);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations').first('n'), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), before);
});

test('cancellation returns stock once and a failed multi-line reopen rolls back every variant', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = await request(env, '/orders', { method: 'POST', body: checkout({ items: [
    { productId: 'zc-001', shirt: 1, size: 'M', quantity: 2 },
    { productId: 'zc-002', shirt: 2, size: 'L', quantity: 2 },
  ] }) });
  const id = created.data.order.id;
  const status = value => request(env, `/admin/orders/${id}`, { method: 'PATCH', token, body: { status: value } });
  assert.equal((await inventoryRow(env)).stock, 10);
  assert.equal((await status('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 12);
  assert.equal((await status('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 12);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE kind = 'release'").first('n'), 2);
  await adjustStock(env, token, 0, { productId: 'zc-002', shirt: 2, size: 'L' });
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n');
  const failed = await status('preparing');
  assert.equal(failed.status, 409); assert.equal(failed.data.error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await inventoryRow(env)).stock, 12);
  assert.equal((await request(env, `/admin/orders/${id}`, { token })).data.order.status, 'cancelled');
  assert.equal(await env.DB.prepare('SELECT SUM(active) AS n FROM reservations').first('n'), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), before);
  await adjustStock(env, token, 2, { productId: 'zc-002', shirt: 2, size: 'L' });
  assert.equal((await status('ready')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 10);
  assert.equal((await inventoryRow(env, 'zc-002', 2, 'L')).stock, 0);
  assert.equal((await status('shipped')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 10);
  // Returning valid reserved units remains possible after a high manual count.
  await adjustStock(env, token, 999999);
  assert.equal((await status('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 1000001);
});

test('inventory adjustments enforce versions, validate quantities and retain audit history', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const path = '/admin/inventory/zc-001/1/M';
  const initial = await request(env, path, { token });
  assert.equal(initial.status, 200); assert.equal(initial.data.variant.version, 1);
  const results = await Promise.all([2, 4].map(stock => request(env, path, { method: 'PATCH', token,
    body: { stock, lowStockThreshold: 3, version: 1, reason: 'Physical recount' } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).data.error.code, 'INVENTORY_CHANGED');
  const saved = results.find(result => result.status === 200).data.variant;
  assert.equal(saved.history[0].kind, 'adjustment'); assert.equal(saved.history[0].reason, 'Physical recount');
  assert.equal(saved.history[0].actor, 'Admin'); assert.equal(saved.history[0].delta, saved.stock - 12);
  const thresholdOnly = await request(env, path, { method: 'PATCH', token,
    body: { stock: saved.stock, lowStockThreshold: 5, version: saved.version, reason: 'New warning level' } });
  assert.equal(thresholdOnly.status, 200); assert.equal(thresholdOnly.data.variant.history[0].delta, 0);
  assert.equal(thresholdOnly.data.variant.history[0].lowStockThreshold, 5);
  for (const stock of [-1, 1.5, '3', 1000000]) {
    assert.equal((await request(env, path, { method: 'PATCH', token, body: { stock, lowStockThreshold: 3, version: 3 } })).status, 400);
  }
  assert.equal((await request(env, path, { method: 'PATCH', body: { stock: 3, lowStockThreshold: 3, version: 3 } })).status, 401);
  assert.equal((await request(env, '/admin/inventory/invalid/1/M', { token })).status, 404);
  const admin = await request(env, '/admin/inventory', { token });
  assert.equal(admin.data.summary.lowStock, 1);
  assert.equal((await request(env, path, { token })).data.history.length, 3);
});

test('legacy inventory migration preserves orders, honors active demand and is rerunnable', async t => {
  assert.ok(schema.endsWith(inventoryMigration), 'Fresh schema and standalone migration must match');
  const baseSchema = schema.split('-- Inventory bootstrap')[0];
  const env = environment(undefined, baseSchema); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = [];
  for (const quantity of [10, 8, 4]) {
    created.push(await request(env, '/orders', { method: 'POST', body: checkout({
      items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity }],
    }) }));
  }
  await request(env, `/admin/orders/${created[2].data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  const shipped = await request(env, '/orders', { method: 'POST', body: checkout({
    items: [{ productId: 'zc-002', shirt: 2, size: 'L', quantity: 2 }],
  }) });
  await request(env, `/admin/orders/${shipped.data.order.id}`, { method: 'PATCH', token, body: { status: 'shipped' } });
  const before = await env.DB.prepare('SELECT id, order_json, version FROM orders ORDER BY id').all();
  env.DB.database.exec(inventoryMigration);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal((await inventoryRow(env, 'zc-002', 2, 'L')).stock, 10);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations').first('n'), 4);
  assert.equal(await env.DB.prepare("SELECT SUM(delta) AS n FROM inventory_movements WHERE kind = 'legacy_topup'").first('n'), 6);
  assert.deepEqual((await env.DB.prepare('SELECT id, order_json, version FROM orders ORDER BY id').all()).results, before.results);
  const auditCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n');
  env.DB.database.exec(inventoryMigration);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), auditCount);
  await adjustStock(env, token, 5);
  env.DB.database.exec(inventoryMigration);
  assert.equal((await inventoryRow(env)).stock, 5, 'A rerun must not reset a manual stock count');
  const reopened = await request(env, `/admin/orders/${created[2].data.order.id}`, { method: 'PATCH', token, body: { status: 'preparing' } });
  assert.equal(reopened.status, 200); assert.equal((await inventoryRow(env)).stock, 1);
});

test('reviewed admin order versions reject stale serial edits without changing stock', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = await request(env, '/orders', { method: 'POST', body: checkout() });
  const id = created.data.order.id;
  const path = `/admin/orders/${id}`;
  const viewed = await request(env, path, { token });
  assert.equal(viewed.data.order.version, 1);
  const cancelled = await request(env, path, { method: 'PATCH', token,
    body: { status: 'cancelled', expectedVersion: viewed.data.order.version } });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.order.version, 2);
  assert.equal((await inventoryRow(env)).stock, 12);
  const stale = await request(env, path, { method: 'PATCH', token,
    body: { status: 'preparing', expectedVersion: viewed.data.order.version } });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'ORDER_CHANGED');
  assert.equal((await inventoryRow(env)).stock, 12);
  assert.equal((await request(env, path, { token })).data.order.status, 'cancelled');
  const note = await request(env, path, { method: 'PATCH', token,
    body: { notes: 'Private review', expectedVersion: 2 } });
  assert.equal(note.status, 200); assert.equal(note.data.order.version, 3);
  assert.equal((await request(env, '/admin/orders', { token })).data.orders[0].version, 3);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id, token: created.data.trackingToken } });
  assert.equal(Object.hasOwn(tracked.data.order, 'version'), false);
  assert.equal(Object.hasOwn(tracked.data.order, 'notes'), false);
  const stored = JSON.parse((await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(id).first()).order_json);
  assert.equal(Object.hasOwn(stored, 'version'), false);
  assert.equal((await request(env, path, { method: 'PATCH', token,
    body: { status: 'ready', expectedVersion: '3' } })).status, 400);
  // Transitional compatibility for an already-open older admin client.
  const olderClient = await request(env, path, { method: 'PATCH', token, body: { status: 'ready' } });
  assert.equal(olderClient.status, 200); assert.equal(olderClient.data.order.version, 4);
  assert.equal((await inventoryRow(env)).stock, 11);
});

test('audit-trigger change counts do not turn committed inventory or status updates into conflicts', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const counted = await env.DB.prepare(`UPDATE inventory SET stock = stock - 1, version = version + 1,
    last_kind = 'adjustment', last_reason = 'D1 trigger-count check', last_actor = 'test'
    WHERE product_id = 'zc-001' AND shirt = 1 AND size = 'M'`).run();
  assert.equal(counted.meta.changes, 2, 'D1 counts the inventory row and its audit insert');
  const token = await adminToken(env);
  const adjusted = await adjustStock(env, token, 5);
  assert.equal(adjusted.status, 200);
  assert.equal(adjusted.data.variant.stock, 5);
  assert.equal((await inventoryRow(env)).stock, 5);
  const created = await request(env, '/orders', { method: 'POST', body: checkout() });
  assert.equal(created.status, 201);
  const id = created.data.order.id;
  const current = await request(env, `/admin/orders/${id}`, { token });
  const cancelled = await request(env, `/admin/orders/${id}`, { method: 'PATCH', token,
    body: { status: 'cancelled', expectedVersion: current.data.order.version } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.version, current.data.order.version + 1);
  assert.equal((await inventoryRow(env)).stock, 5);
  assert.equal((await request(env, `/admin/orders/${id}`, { token })).data.order.status, 'cancelled');
});
