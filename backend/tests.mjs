import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import worker from './worker.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
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
  async run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class D1Adapter {
  constructor(path = ':memory:') { this.database = new DatabaseSync(path); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql, [], this.afterRead); }
  close() { this.database.close(); }
}

function environment(path) {
  const salt = 'test-only-salt-2026-zenin';
  return { DB: new D1Adapter(path), ADMIN_USERNAME: 'Admin', ADMIN_PASSWORD_SALT: salt,
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
