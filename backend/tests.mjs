import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import worker from './worker.js';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const inventoryMigration = await readFile(new URL('./migrations/0002_inventory.sql', import.meta.url), 'utf8');
const softStockMigration = await readFile(new URL('./migrations/0003_soft_stock.sql', import.meta.url), 'utf8');
const catalogMigration = await readFile(new URL('./migrations/0004_products.sql', import.meta.url), 'utf8');
const designMigration = await readFile(new URL('./migrations/0005_product_designs.sql', import.meta.url), 'utf8');
const archiveDemoMigration = await readFile(new URL('./migrations/0006_archive_demo_catalog.sql', import.meta.url), 'utf8');
const basesMigration = await readFile(new URL('./migrations/0007_garment_bases.sql', import.meta.url), 'utf8');
const mediaMigration = await readFile(new URL('./migrations/0010_media.sql', import.meta.url), 'utf8');
const collectionsMigration = await readFile(new URL('./migrations/0008_collections_articles.sql', import.meta.url), 'utf8');
const seededProducts = [...catalogMigration.matchAll(/, '(\{"id":.*\})' WHERE NOT EXISTS/g)]
  .map(match => JSON.parse(match[1].replaceAll("''", "'")));
const hash = value => createHash('sha256').update(value).digest('hex');

class D1Statement {
  constructor(database, sql, params = [], afterRead) { this.database = database; this.sql = sql; this.params = params; this.afterRead = afterRead; }
  bind(...params) { return new D1Statement(this.database, this.sql, params, this.afterRead); }
  async first(column) {
    const result = this.database.prepare(this.sql).get(...this.params);
    if (this.afterRead) await this.afterRead(this.sql);
    return column ? result?.[column] ?? null : result ?? null;
  }
  async all() {
    const results = this.database.prepare(this.sql).all(...this.params);
    if (this.afterRead) await this.afterRead(this.sql);
    return { success: true, results };
  }
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
  constructor(path = ':memory:', bootstrap = schema) {
    this.database = new DatabaseSync(path); this.database.exec('PRAGMA foreign_keys=ON; BEGIN');
    try { this.database.exec(bootstrap); this.database.exec('COMMIT'); }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
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

class R2Adapter {
  objects = new Map();
  async put(key, bytes) { this.objects.set(key, new Uint8Array(bytes)); }
  async get(key, options = {}) {
    if (!this.objects.has(key)) return null;
    const bytes = this.objects.get(key);
    return { body: options.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes };
  }
}

function environment(path, bootstrap = schema) {
  const salt = 'test-only-salt-2026-zenin';
  const env = { DB: new D1Adapter(path, bootstrap), DESIGNS: new R2Adapter(), ADMIN_USERNAME: 'Admin', ADMIN_PASSWORD_SALT: salt,
    ADMIN_PASSWORD_HASH: hash(`${salt}:test-only-password`),
    ADMIN_SESSION_SECRET: 'test-only-session-secret-with-at-least-32-characters' };
  if (bootstrap === schema) {
    // Explicit historical fixtures keep legacy order/inventory coverage. The
    // production fresh schema intentionally has no products or invented stock.
    env.DB.database.exec(catalogMigration);
    env.DB.database.exec(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<16),
      c(v) AS (VALUES(1),(2),(3),(4)),s(v) AS (VALUES('S'),('M'),('L'),('XL'),('XXL'))
      INSERT OR IGNORE INTO inventory(product_id,shirt,size,stock,updated_at)
      SELECT printf('zc-%03d',n.v),c.v,s.v,12,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM n,c,s;`);
    const bytes = testPng(), id = hash(bytes), key = `designs/${id}.png`;
    env.DESIGNS.objects.set(key, bytes);
    env.DB.database.prepare(`INSERT OR IGNORE INTO design_assets(id,object_key,byte_length,width,height,created_at,actor) VALUES(?,?,?,2,2,'2026-01-01','fixture')`).run(id,key,bytes.length);
    env.DB.database.prepare(`INSERT OR IGNORE INTO garment_bases(id,base_json,created_at,updated_at) VALUES('fixture-base',?,'2026-01-01','2026-01-01')`)
      .run(JSON.stringify({name:'Historical fixture base',type:'T-shirt',weightGsm:200,sizes:['S','M','L','XL','XXL']}));
    for (const [shirt,name] of [[1,'Washed Black'],[2,'Deep Teal'],[3,'Dusty Violet'],[4,'Faded Red']]) {
      env.DB.database.prepare('INSERT OR IGNORE INTO garment_colors(shirt,base_id,color_json) VALUES(?,?,?)')
        .run(shirt,'fixture-base',JSON.stringify({name,hex:'#222222',imageUrl:`https://orders.example/designs/${id}.png`}));
    }
  }
  return env;
}

function checkout(overrides = {}) {
  return { customer: { name: 'Test Customer', email: 'test@example.com', address: '123 Test Street',
    apartment: '', city: 'San José', postal: '10101', country: 'Costa Rica' },
  items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 1 }],
  discountCode: '', language: 'es', idempotencyKey: crypto.randomUUID(), ...overrides };
}

// Historical fixtures model rows written before the persistent catalog existed.
async function historicalOrder(env, body) {
  const now = new Date().toISOString();
  const items = body.items.map(item => {
    const product = seededProducts.find(product => product.id === item.productId);
    return { ...item, name: product.name, emoji: product.emoji, unitPrice: product.price, colorName: product.colorName };
  });
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const order = { id: `ZC-${crypto.randomUUID()}`, createdAt: now, updatedAt: now, status: 'new', customer: body.customer,
    items, totals: { subtotal, discount: 0, shipping: subtotal >= 120 ? 0 : 8, total: subtotal + (subtotal >= 120 ? 0 : 8), currency: 'USD' },
    language: body.language, discountCode: '', notes: '', tracking: { carrier: '', number: '' }, history: [{ status: 'new', at: now }] };
  await env.DB.prepare(`INSERT INTO orders(id, idempotency_hash, request_hash, tracking_hash, email_normalized, status, created_at, updated_at, order_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(order.id, hash(body.idempotencyKey), hash('historical fixture'), hash(order.id), body.customer.email,
    order.status, now, now, JSON.stringify(order)).run();
  return { status: 201, data: { order } };
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
  assert.deepEqual(admin.data.meta, { initialStock: 0, defaultLowStockThreshold: 3, mockSeed: false });
  assert.equal(admin.data.variants[0].history[0].kind, 'seed');
  assert.equal(admin.data.variants[0].lowStockThreshold, 3);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), 320);
});

test('concurrent orders both succeed at the last unit without negative stock or duplicate allocation', async t => {
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
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 2);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations WHERE active = 1').first('n'), 2);
  assert.equal(await env.DB.prepare('SELECT SUM(allocated_qty) AS n FROM reservation_allocations').first('n'), 1);
  const replay = await request(env, '/orders', { method: 'POST', body: bodies[0] });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.order.id, results[0].data.order.id);
  assert.equal(replay.data.trackingToken, results[0].data.trackingToken);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE kind = 'reserve'").first('n'), 2);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE reason = 'order_backordered' AND delta = 0").first('n'), 1);
  for (const result of results) {
    assert.equal((await request(env, `/admin/orders/${result.data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } })).status, 200);
  }
  assert.equal((await inventoryRow(env)).stock, 1, 'Only the single allocated unit can be restored');
});

test('mixed available and zero-stock lines persist their full quantities and allocate only available units', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  await adjustStock(env, token, 0, { productId: 'zc-002', shirt: 2, size: 'L' });
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n');
  const result = await request(env, '/orders', { method: 'POST', body: checkout({ items: [
    { productId: 'zc-001', shirt: 1, size: 'M', quantity: 2 },
    { productId: 'zc-002', shirt: 2, size: 'L', quantity: 2 },
  ] }) });
  assert.equal(result.status, 201);
  assert.equal(result.data.order.items.reduce((sum, item) => sum + item.quantity, 0), 4);
  assert.equal((await inventoryRow(env)).stock, 10);
  assert.equal((await inventoryRow(env, 'zc-002', 2, 'L')).stock, 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations').first('n'), 2);
  assert.equal(await env.DB.prepare('SELECT SUM(allocated_qty) AS n FROM reservation_allocations').first('n'), 2);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), before + 2);
  const admin = await request(env, '/admin/inventory', { token });
  assert.equal(admin.data.summary.lowStock, 1, 'Zero stock is included in Low stock');
});

test('cancellation returns allocations once and mixed-stock reopening always succeeds', async t => {
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
  const reopened = await status('preparing');
  assert.equal(reopened.status, 200);
  assert.equal((await inventoryRow(env)).stock, 10);
  assert.equal((await request(env, `/admin/orders/${id}`, { token })).data.order.status, 'preparing');
  assert.equal(await env.DB.prepare('SELECT SUM(active) AS n FROM reservations').first('n'), 2);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), before + 2);
  await adjustStock(env, token, 2, { productId: 'zc-002', shirt: 2, size: 'L' });
  assert.equal((await status('ready')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 10);
  assert.equal((await inventoryRow(env, 'zc-002', 2, 'L')).stock, 2);
  assert.equal((await status('shipped')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 10);
  // Returning valid reserved units remains possible after a high manual count.
  await adjustStock(env, token, 999999);
  assert.equal((await status('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 1000001);
  assert.equal((await inventoryRow(env, 'zc-002', 2, 'L')).stock, 2, 'Unallocated units must not be invented on cancellation');
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
  assert.ok(!schema.includes('WITH RECURSIVE product_numbers'), 'Fresh schema must not create demo inventory');
  assert.ok(schema.includes(softStockMigration), 'Fresh schema must include the soft-stock migration');
  assert.ok(!schema.includes('midnight-snack-tee'), 'Fresh schema must not create demo products');
  assert.ok(schema.includes(designMigration), 'Fresh schema must include the design and color migration');
  assert.ok(schema.includes(basesMigration), 'Fresh schema must include the reusable bases migration');
  assert.ok(schema.includes(collectionsMigration.split('\n').slice(2).join('\n')), 'Fresh schema must include the collections migration');
  const baseSchema = schema.split('-- Inventory bootstrap')[0];
  const env = environment(undefined, baseSchema); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = [];
  for (const quantity of [10, 8, 4]) {
    created.push(await historicalOrder(env, checkout({
      items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity }],
    })));
  }
  await request(env, `/admin/orders/${created[2].data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  const shipped = await historicalOrder(env, checkout({
    items: [{ productId: 'zc-002', shirt: 2, size: 'L', quantity: 2 }],
  }));
  await request(env, `/admin/orders/${shipped.data.order.id}`, { method: 'PATCH', token, body: { status: 'shipped' } });
  const before = await env.DB.prepare('SELECT id, order_json, version FROM orders ORDER BY id').all();
  env.DB.database.exec(inventoryMigration);
  env.DB.database.exec(catalogMigration);
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

test('zero and partial-stock purchases succeed and cancellation restores only allocated units', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  await adjustStock(env, token, 0);
  const zeroBody = checkout({ items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 10 }] });
  const zero = await request(env, '/orders', { method: 'POST', body: zeroBody });
  assert.equal(zero.status, 201); assert.equal(zero.data.order.items[0].quantity, 10);
  assert.equal((await inventoryRow(env)).stock, 0);
  const replay = await request(env, '/orders', { method: 'POST', body: zeroBody });
  assert.equal(replay.status, 200); assert.equal(replay.data.order.id, zero.data.order.id);
  assert.equal(await env.DB.prepare('SELECT SUM(allocated_qty) AS n FROM reservation_allocations').first('n'), 0);
  const zeroStatus = status => request(env, `/admin/orders/${zero.data.order.id}`, { method: 'PATCH', token, body: { status } });
  assert.equal((await zeroStatus('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal((await zeroStatus('ready')).status, 200);
  assert.equal((await zeroStatus('cancelled')).status, 200);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM inventory_movements WHERE reason = 'order_backordered' AND delta = 0").first('n'), 2);

  await adjustStock(env, token, 2);
  const partial = await request(env, '/orders', { method: 'POST', body: checkout({
    items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 5 }],
  }) });
  assert.equal(partial.status, 201); assert.equal(partial.data.order.items[0].quantity, 5);
  assert.equal((await inventoryRow(env)).stock, 0);
  assert.equal(await env.DB.prepare('SELECT allocated_qty FROM reservation_allocations WHERE order_id = ?')
    .bind(partial.data.order.id).first('allocated_qty'), 2);
  await adjustStock(env, token, 7);
  const cancel = await request(env, `/admin/orders/${partial.data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  assert.equal(cancel.status, 200);
  assert.equal((await inventoryRow(env)).stock, 9, 'Return the two allocated units, not all five requested units');
});

test('soft-stock migration backfills hard-stock allocations once and preserves zero allocations on rerun', async t => {
  const strictSchema = schema.split('-- Soft stock bootstrap')[0];
  const env = environment(undefined, strictSchema); t.after(() => env.DB.close());
  env.DB.database.exec(inventoryMigration);
  const token = await adminToken(env);
  const active = await historicalOrder(env, checkout({
    items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 4 }],
  }));
  const cancelled = await historicalOrder(env, checkout({
    items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 3 }],
  }));
  await request(env, `/admin/orders/${cancelled.data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  assert.equal((await inventoryRow(env)).stock, 8);
  const before = (await env.DB.prepare('SELECT id, order_json, version FROM orders ORDER BY id').all()).results;
  env.DB.database.exec(softStockMigration);
  env.DB.database.exec(catalogMigration);
  assert.equal((await inventoryRow(env)).stock, 8);
  assert.equal(await env.DB.prepare('SELECT allocated_qty FROM reservation_allocations WHERE order_id = ?')
    .bind(active.data.order.id).first('allocated_qty'), 4);
  assert.equal(await env.DB.prepare('SELECT allocated_qty FROM reservation_allocations WHERE order_id = ?')
    .bind(cancelled.data.order.id).first('allocated_qty'), 0);
  assert.deepEqual((await env.DB.prepare('SELECT id, order_json, version FROM orders ORDER BY id').all()).results, before);
  env.DB.database.exec(softStockMigration);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservation_allocations').first('n'), 2);
  await adjustStock(env, token, 0);
  const low = await request(env, '/orders', { method: 'POST', body: checkout({
    items: [{ productId: 'zc-001', shirt: 1, size: 'M', quantity: 5 }],
  }) });
  assert.equal(low.status, 201);
  env.DB.database.exec(softStockMigration);
  assert.equal(await env.DB.prepare('SELECT allocated_qty FROM reservation_allocations WHERE order_id = ?')
    .bind(low.data.order.id).first('allocated_qty'), 0);
  await request(env, `/admin/orders/${low.data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  assert.equal((await inventoryRow(env)).stock, 0);
  await request(env, `/admin/orders/${active.data.order.id}`, { method: 'PATCH', token, body: { status: 'cancelled' } });
  assert.equal((await inventoryRow(env)).stock, 4);
  await request(env, `/admin/orders/${cancelled.data.order.id}`, { method: 'PATCH', token, body: { status: 'preparing' } });
  assert.equal((await inventoryRow(env)).stock, 1);
  const allocations = (await env.DB.prepare('SELECT * FROM reservation_allocations ORDER BY order_id').all()).results;
  const movements = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n');
  env.DB.database.exec('BEGIN'); env.DB.database.exec(schema); env.DB.database.exec('COMMIT');
  assert.equal((await inventoryRow(env)).stock, 1, 'Rerunning the complete fresh schema must preserve soft stock');
  assert.deepEqual((await env.DB.prepare('SELECT * FROM reservation_allocations ORDER BY order_id').all()).results, allocations);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), movements);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('reservations_insert_guard', 'reservations_reopen_guard')").first('n'), 0);
});

const productDraft = (overrides = {}) => ({ name: 'Cloud Test Tee', nameEs: 'Camiseta Nube de Prueba',
  category: 'originals', price: 49.95, designUrl: `https://orders.example/designs/${hash(testPng())}.png`,
  availableShirts: [1,2,3,4], shirt: 2, initialStock: 0, lowStockThreshold: 2,
  description: 'A newly created tee.', descriptionEs: 'Una nueva camiseta.', printLine: 'HEAD IN THE CLOUDS',
  idempotencyKey: crypto.randomUUID(), ...overrides });

test('persistent catalog starts with the legacy products and protects creation/archive endpoints', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const catalog = await request(env, '/products');
  assert.equal(catalog.status, 200); assert.equal(catalog.data.products.length, 16);
  assert.equal(catalog.data.products.find(product => product.id === 'zc-001').name, 'Midnight Snack Tee');
  assert.equal((await request(env, '/admin/products')).status, 401);
  assert.equal((await request(env, '/admin/products', { method: 'POST', body: productDraft() })).status, 401);
  assert.equal((await request(env, '/admin/products/zc-001', { method: 'DELETE', body: { version: 1 } })).status, 401);
  assert.equal((await request(env, '/admin/products/zc-001', { method: 'PATCH', body: { version: 1, active: false } })).status, 401);
  const token = await adminToken(env);
  for (const fields of [{ price: 0 }, { price: -1 }, { price: '20' }, { price: 1.001 }, { price: 10001 },
    { designUrl: '' }, { category: 'invalid' }, { accent: 'red; x' }, { initialStock: -1 }]) {
    const response = await request(env, '/admin/products', { method: 'POST', token, body: productDraft(fields) });
    assert.equal(response.status, 400, JSON.stringify(fields));
  }
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n'), 16);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory').first('n'), 320);
});

test('created products have all variants and their Spanish names/prices are snapshotted on zero-stock purchases', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = await request(env, '/admin/products', { method: 'POST', token, body: productDraft() });
  assert.equal(created.status, 201);
  const product = created.data.product;
  assert.match(product.id, /^zc-[0-9a-f-]{36}$/); assert.equal(product.active, true); assert.equal(product.version, 1);
  assert.equal(product.nameEs, 'Camiseta Nube de Prueba'); assert.equal(product.collection, 'Zenin Originals');
  assert.equal((await request(env, '/products')).data.products.length, 17);
  const variants = (await request(env, '/inventory')).data.variants.filter(variant => variant.productId === product.id);
  assert.equal(variants.length, 20); assert.ok(variants.every(variant => variant.stock === 0));
  const detail = await request(env, `/admin/inventory/${product.id}/4/XL`, { token });
  assert.equal(detail.status, 200); assert.equal(detail.data.variant.nameEs, product.nameEs);
  assert.equal(detail.data.history[0].actor, 'Admin'); assert.equal(detail.data.history[0].reason, 'product_created');
  const order = await request(env, '/orders', { method: 'POST', body: checkout({
    items: [{ productId: product.id, shirt: 4, size: 'XL', quantity: 2, unitPrice: 0.01 }],
  }) });
  assert.equal(order.status, 201);
  assert.equal(order.data.order.items[0].name, product.name); assert.equal(order.data.order.items[0].nameEs, product.nameEs);
  assert.equal(order.data.order.items[0].unitPrice, 49.95); assert.equal(order.data.order.items[0].colorName, 'Faded Red');
  assert.equal(order.data.order.totals.total, 107.9);
  assert.equal((await inventoryRow(env, product.id, 4, 'XL')).stock, 0);
});

test('product creation retries are idempotent and do not recreate inventory or accept reused identifiers', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const body = productDraft({ initialStock: 6 });
  const parallel = await Promise.all([request(env, '/admin/products', { method: 'POST', token, body }),
    request(env, '/admin/products', { method: 'POST', token, body })]);
  assert.deepEqual(parallel.map(response => response.status).sort(), [200, 201]);
  const product = parallel[0].data.product;
  assert.equal(parallel[1].data.product.id, product.id);
  await adjustStock(env, token, 1, { productId: product.id });
  const replay = await request(env, '/admin/products', { method: 'POST', token, body });
  assert.equal(replay.status, 200); assert.equal(replay.data.product.id, product.id);
  assert.equal((await inventoryRow(env, product.id)).stock, 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory WHERE product_id = ?').bind(product.id).first('n'), 20);
  assert.equal((await request(env, '/admin/products', { method: 'POST', token,
    body: { ...body, name: 'Different request' } })).data.error.code, 'IDEMPOTENCY_CONFLICT');
  const duplicateSlug = await request(env, '/admin/products', { method: 'POST', token,
    body: productDraft({ slug: 'midnight-snack-tee' }) });
  assert.equal(duplicateSlug.status, 409); assert.equal(duplicateSlug.data.error.code, 'SLUG_TAKEN');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n'), 17);
});

test('archiving hides products/variants but preserves order snapshots, audit and idempotent recovery', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const createBody = productDraft();
  const created = await request(env, '/admin/products', { method: 'POST', token, body: createBody });
  const product = created.data.product;
  const orderBody = checkout({ items: [{ productId: product.id, shirt: 1, size: 'M', quantity: 2 }] });
  const purchased = await request(env, '/orders', { method: 'POST', body: orderBody });
  const auditBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?').bind(product.id).first('n');
  const archived = await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: product.version } });
  assert.equal(archived.status, 200); assert.equal(archived.data.archived, true); assert.equal(archived.data.id, product.id);
  assert.equal(archived.data.product.version, 2);
  assert.equal((await request(env, '/products')).data.products.some(item => item.id === product.id), false);
  assert.equal((await request(env, '/inventory')).data.variants.some(item => item.productId === product.id), false);
  assert.equal((await request(env, '/admin/inventory', { token })).data.variants.some(item => item.productId === product.id), false);
  assert.equal((await request(env, '/admin/inventory?includeArchived=true', { token })).data.variants.filter(item => item.productId === product.id).length, 20);
  assert.equal((await request(env, `/admin/inventory/${product.id}/1/M`, { token })).data.variant.active, false);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = ?').bind(product.id).first('n'), auditBefore);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: purchased.data.order.id, token: purchased.data.trackingToken } });
  assert.equal(tracked.data.order.items[0].nameEs, product.nameEs);
  const recovered = await request(env, '/orders', { method: 'POST', body: orderBody });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.order.id, purchased.data.order.id);
  assert.equal((await request(env, '/orders', { method: 'POST', body: { ...orderBody, idempotencyKey: crypto.randomUUID() } })).data.error.code, 'INVALID_PRODUCT');
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: 'unknown-id', shirt: 1, size: 'M', quantity: 1 }] }) })).data.error.code, 'INVALID_PRODUCT');
  const repeated = await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: 1 } });
  assert.equal(repeated.status, 200); assert.equal(repeated.data.product.version, 2);
  const creationReplay = await request(env, '/admin/products', { method: 'POST', token, body: createBody });
  assert.equal(creationReplay.status, 200); assert.equal(creationReplay.data.product.active, false);
  const restored = await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token, body: { version: 2, active: true } });
  assert.equal(restored.status, 200); assert.equal(restored.data.product.version, 3);
  assert.equal((await request(env, '/products')).data.products.some(item => item.id === product.id), true);
  const edited = await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token,
    body: { version: 3, nameEs: 'Nombre actualizado', price: 60 } });
  assert.equal(edited.status, 200); assert.equal(edited.data.product.price, 60);
  assert.equal((await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: 3 } })).data.error.code, 'PRODUCT_CHANGED');
  const stillOriginal = await request(env, '/orders/track', { method: 'POST', body: { id: purchased.data.order.id, token: purchased.data.trackingToken } });
  assert.equal(stillOriginal.data.order.items[0].nameEs, product.nameEs);
  assert.equal(stillOriginal.data.order.items[0].unitPrice, 49.95);
});

test('empty catalogs and edited seed rows survive migration reruns and a fresh database connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zenin-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'catalog.sqlite');
  const env = environment(path);
  const token = await adminToken(env);
  const order = await request(env, '/orders', { method: 'POST', body: checkout() });
  const before = (await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(order.data.order.id).first()).order_json;
  const edited = await request(env, '/admin/products/zc-001', { method: 'PATCH', token, body: { version: 1, ...productDraft({ shirt: 1, name: 'Changed seed name' }) } });
  assert.equal(edited.status, 200);
  env.DB.database.exec(catalogMigration);
  assert.equal((await request(env, '/products')).data.products.find(product => product.id === 'zc-001').name, 'Changed seed name');
  env.DB.database.exec("UPDATE products SET active = 0, deleted_at = '2026-10-21T00:00:00Z', version = version + 1");
  env.DB.database.exec(catalogMigration);
  assert.deepEqual((await request(env, '/products')).data.products, []);
  env.DB.close();
  env.DB = new D1Adapter(path); t.after(() => env.DB.close());
  assert.deepEqual((await request(env, '/products')).data.products, []);
  assert.deepEqual((await request(env, '/inventory')).data.variants, []);
  assert.equal((await request(env, '/admin/products?includeArchived=true', { token })).data.products.length, 16);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory').first('n'), 320);
  assert.equal((await env.DB.prepare('SELECT order_json FROM orders WHERE id = ?').bind(order.data.order.id).first()).order_json, before);
});

test('product and inventory creation roll back together if a database trigger rejects a variant', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  env.DB.database.exec("CREATE TRIGGER test_product_atomicity BEFORE INSERT ON inventory WHEN NEW.product_id LIKE 'zc-%-%' AND NEW.size = 'XL' BEGIN SELECT RAISE(ABORT, 'TEST_VARIANT_FAILURE'); END");
  const result = await request(env, '/admin/products', { method: 'POST', token, body: productDraft() });
  assert.equal(result.status, 500);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n'), 16);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory').first('n'), 320);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_movements').first('n'), 320);
});

test('an archive committed after the checkout catalog read prevents a new order atomically', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  let archived = false;
  env.DB.afterRead = async sql => {
    if (sql !== 'SELECT id, product_json FROM products WHERE active = 1') return;
    env.DB.afterRead = null;
    const result = await request(env, '/admin/products/zc-001', { method: 'DELETE', token, body: { version: 1 } });
    assert.equal(result.status, 200);
    archived = true;
  };
  const result = await request(env, '/orders', { method: 'POST', body: checkout() });
  assert.equal(archived, true);
  assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_PRODUCT');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations').first('n'), 0);
  assert.equal((await inventoryRow(env)).stock, 12);
});

function pngChunk(type, data) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, 8 + data.length)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function testPng(width = 2, height = 2) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

async function uploadPng(env, token, bytes = testPng(), headers = {}) {
  const response = await worker.fetch(new Request('https://orders.example/admin/designs', {
    method: 'POST', headers: { 'Content-Type': 'image/png', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: bytes,
  }), env);
  return { status: response.status, data: await response.json() };
}

test('PNG uploads require authentication, validate the complete file and persist an immutable public R2 image', async t => {
  const env = environment(); t.after(() => env.DB.close());
  assert.equal((await uploadPng(env)).status, 401);
  const token = await adminToken(env);
  assert.equal((await uploadPng(env, token, testPng(), { 'Content-Type': 'image/svg+xml' })).status, 415);
  assert.equal((await uploadPng(env, token, testPng(), { 'Content-Length': String(5 * 1024 * 1024 + 1) })).data.error.code, 'DESIGN_TOO_LARGE');
  assert.equal((await uploadPng(env, token, new Uint8Array(5 * 1024 * 1024 + 1))).status, 413);
  const corrupted = testPng(); corrupted[40] ^= 1;
  for (const bytes of [Buffer.from('<svg/>'), testPng().subarray(0, 50), corrupted, Buffer.concat([testPng(), Buffer.from('extra')])]) {
    const result = await uploadPng(env, token, bytes);
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_PNG');
  }
  for (const [width, height] of [[0, 2], [8193, 1], [5000, 5000]]) {
    assert.equal((await uploadPng(env, token, testPng(width, height))).data.error.code, 'DESIGN_DIMENSIONS');
  }
  assert.equal(env.DESIGNS.objects.size, 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM design_assets').first('n'), 1);
  const png = testPng();
  const uploaded = await uploadPng(env, token, png);
  assert.equal(uploaded.status, 201); assert.equal(uploaded.data.width, 2); assert.equal(uploaded.data.height, 2);
  assert.equal(uploaded.data.byteLength, png.length);
  assert.equal(uploaded.data.designUrl, `https://orders.example/designs/${hash(png)}.png`);
  const retry = await uploadPng(env, token, png);
  assert.equal(retry.data.designUrl, uploaded.data.designUrl); assert.equal(env.DESIGNS.objects.size, 1);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM design_assets').first('n'), 1);
  const image = await worker.fetch(new Request(uploaded.data.designUrl), env);
  assert.equal(image.status, 200); assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(image.headers.get('Cache-Control'), /immutable/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await worker.fetch(new Request(uploaded.data.designUrl, { headers: { 'If-None-Match': image.headers.get('ETag') } }), env)).status, 304);
  const head = await worker.fetch(new Request(uploaded.data.designUrl, { method: 'HEAD' }), env);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await worker.fetch(new Request(`https://orders.example/designs/${'0'.repeat(64)}.png`), env)).status, 404);
});

test('PNG catalog products offer only selected colors, permit zero-stock orders and preserve design snapshots', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const uploaded = await uploadPng(env, token);
  const draft = productDraft({ emoji: '', shirt: 1, availableShirts: [3, 1], designUrl: uploaded.data.designUrl });
  for (const fields of [{ availableShirts: [] }, { availableShirts: [1, 1] }, { availableShirts: ['1'] },
    { availableShirts: [1, 5] }, { availableShirts: [3] }, { designUrl: 'https://other.example/designs/x.png' },
    { designUrl: `/designs/${'0'.repeat(64)}.png` }, { designUrl: 'not a url' }, { designUrl: '' }]) {
    assert.equal((await request(env, '/admin/products', { method: 'POST', token, body: { ...draft, ...fields } })).status, 400);
  }
  const created = await request(env, '/admin/products', { method: 'POST', token, body: draft });
  assert.equal(created.status, 201);
  const product = created.data.product;
  assert.equal(product.designUrl, uploaded.data.designUrl); assert.deepEqual(product.availableShirts, [1, 3]);
  const inventory = (await request(env, '/inventory')).data.variants.filter(row => row.productId === product.id);
  assert.equal(inventory.length, 10); assert.ok(inventory.every(row => [1, 3].includes(row.shirt) && row.stock === 0));
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory WHERE product_id = ?').bind(product.id).first('n'), 10);
  const unavailable = await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: product.id, shirt: 2, size: 'M', quantity: 1 }] }) });
  assert.equal(unavailable.status, 400); assert.equal(unavailable.data.error.code, 'INVALID_COLOR');
  const orderBody = checkout({ items: [{ productId: product.id, shirt: 3, size: 'M', quantity: 2 }] });
  const purchased = await request(env, '/orders', { method: 'POST', body: orderBody });
  assert.equal(purchased.status, 201); assert.equal(purchased.data.order.items[0].designUrl, product.designUrl);
  assert.deepEqual(purchased.data.order.items[0].availableShirts, [1, 3]);
  assert.equal((await inventoryRow(env, product.id, 3, 'M')).stock, 0);
  const edited = await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token,
    body: { version: 1, availableShirts: [1, 2], shirt: 2 } });
  assert.equal(edited.status, 200);
  assert.equal((await request(env, '/inventory')).data.variants.filter(row => row.productId === product.id).length, 10);
  assert.equal((await inventoryRow(env, product.id, 2, 'M')).stock, 0);
  const archived = await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: 2 } });
  assert.equal(archived.status, 200);
  for (const details of [{ token: purchased.data.trackingToken }, { email: orderBody.customer.email }]) {
    const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: purchased.data.order.id, ...details } });
    assert.equal(tracked.data.order.items[0].designUrl, product.designUrl);
    assert.deepEqual(tracked.data.order.items[0].availableShirts, [1, 3]);
  }
  const admin = await request(env, `/admin/orders/${purchased.data.order.id}`, { token });
  assert.equal(admin.data.order.items[0].designUrl, product.designUrl);
  assert.equal((await worker.fetch(new Request(product.designUrl), env)).status, 200);
  const recovered = await request(env, '/orders', { method: 'POST', body: orderBody });
  assert.equal(recovered.status, 200); assert.equal(recovered.data.order.items[0].designUrl, product.designUrl);
  env.DB.database.exec(designMigration); env.DB.database.exec(designMigration);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM design_assets').first('n'), 1);
});

test('a color removed after the checkout catalog read is rejected without creating reservations', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const created = await request(env, '/admin/products', { method: 'POST', token, body: productDraft({ shirt: 1, availableShirts: [1, 3] }) });
  const product = created.data.product;
  env.DB.afterRead = async sql => {
    if (sql !== 'SELECT id, product_json FROM products WHERE active = 1') return;
    env.DB.afterRead = null;
    assert.equal((await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token,
      body: { version: 1, availableShirts: [1] } })).status, 200);
  };
  const result = await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: product.id, shirt: 3, size: 'M', quantity: 1 }] }) });
  assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_COLOR');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations').first('n'), 0);
});

test('reusable bases have global colors, custom sizes, authenticated versioned CRUD and immutable order snapshots', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const imageUrl = productDraft().designUrl;
  const baseBody = { name: 'Heavy cotton', type: 'T-shirt', weightGsm: 280, sizes: ['XS', 'M', 'Talla única'],
    colors: [{ name: 'Natural', hex: '#faf2e4', imageUrl }, { name: 'Black', hex: '#111111', imageUrl }], idempotencyKey: crypto.randomUUID() };
  assert.equal((await request(env, '/admin/bases')).status, 401);
  assert.equal((await request(env, '/admin/bases', { method: 'POST', body: baseBody })).status, 401);
  for (const fields of [{ sizes: [] }, { sizes: ['M','M'] }, { weightGsm: -1 }, { colors: [{ name: 'Bad', hex: '#fff', imageUrl }] }]) {
    assert.equal((await request(env, '/admin/bases', { method: 'POST', token, body: { ...baseBody, ...fields } })).status, 400);
  }
  const created = await request(env, '/admin/bases', { method: 'POST', token, body: baseBody });
  assert.equal(created.status, 201);
  const base = created.data.base;
  assert.ok(base.colors.every(color => color.shirt >= 100)); assert.notEqual(base.colors[0].shirt, base.colors[1].shirt);
  assert.equal(base.version, 1); assert.deepEqual(base.sizes, ['XS','M','Talla única']);
  assert.equal((await request(env, '/admin/bases', { method: 'POST', token, body: baseBody })).data.base.id, base.id);
  assert.equal((await request(env, '/admin/bases', { method: 'POST', token, body: { ...baseBody, name: 'Conflicting base' } })).status, 409);
  assert.ok((await request(env, '/bases')).data.bases.some(row => row.id === base.id));
  const body = productDraft({ shirt: base.colors[0].shirt, availableShirts: base.colors.map(color => color.shirt) });
  const product = (await request(env, '/admin/products', { method: 'POST', token, body })).data.product;
  assert.equal(product.shirtOptions[0].baseId, base.id); assert.equal(product.shirtOptions[0].weightGsm, 280);
  assert.equal('emoji' in product, false);
  const variants = (await request(env, '/inventory')).data.variants.filter(row => row.productId === product.id);
  assert.equal(variants.length, 6);
  const customSize = await request(env, `/admin/inventory/${product.id}/${base.colors[0].shirt}/${encodeURIComponent('Talla única')}`, { token });
  assert.equal(customSize.status, 200); assert.equal(customSize.data.variant.size, 'Talla única'); assert.deepEqual([...new Set(variants.map(row => row.size))].sort(), ['M','Talla única','XS']);
  const order = await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: product.id, shirt: base.colors[0].shirt, size: 'XS', quantity: 2 }] }) });
  assert.equal(order.status, 201); assert.equal(order.data.order.items[0].colorName, 'Natural');
  assert.equal(order.data.order.items[0].shirtOptions.length, 1); assert.equal(order.data.order.items[0].shirtOptions[0].imageUrl, imageUrl);
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: product.id, shirt: base.colors[0].shirt, size: 'XL', quantity: 1 }] }) })).data.error.code, 'INVALID_SIZE');
  assert.equal((await request(env, `/admin/bases/${base.id}`, { method: 'DELETE', token, body: { version: 1 } })).data.error.code, 'BASE_IN_USE');
  assert.equal((await request(env, `/admin/bases/${base.id}`, { method: 'PATCH', token, body: { version: 1, sizes: ['XS','M','3XL','4XL'] } })).data.error.code, 'BASE_SIZE_IN_USE');
  assert.equal((await request(env, `/admin/bases/${base.id}`, { method: 'PATCH', token, body: { version: 1, colors: [base.colors[0]] } })).data.error.code, 'BASE_COLOR_IN_USE');
  const edited = await request(env, `/admin/bases/${base.id}`, { method: 'PATCH', token,
    body: { version: 1, name: 'Heavy cotton updated', colors: [...base.colors, { name: 'Green', hex: '#223322', imageUrl }] } });
  assert.equal(edited.status, 200); assert.equal(edited.data.base.colors.length, 3); assert.equal(edited.data.base.version, 2);
  assert.equal(edited.data.base.colors[0].shirt, base.colors[0].shirt);
  const updatedCatalog = (await request(env, '/products')).data.products.find(row => row.id === product.id);
  assert.equal(updatedCatalog.shirtOptions[0].baseName, 'Heavy cotton updated');
  assert.equal((await request(env, `/admin/bases/${base.id}`, { method: 'PATCH', token, body: { version: 1, name: 'Stale update' } })).data.error.code, 'BASE_CHANGED');
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: order.data.order.id, token: order.data.trackingToken } });
  assert.equal(tracked.data.order.items[0].shirtOptions[0].baseName, 'Heavy cotton');
  assert.equal((await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: product.version } })).status, 200);
  const archived = await request(env, `/admin/bases/${base.id}`, { method: 'DELETE', token, body: { version: 2 } });
  assert.equal(archived.status, 200); assert.equal(archived.data.archived, true);
  assert.equal((await request(env, '/bases')).data.bases.some(row => row.id === base.id), false);
  assert.ok((await request(env, '/admin/bases?includeArchived=true', { token })).data.bases.some(row => row.id === base.id));
});

test('fresh schema contains no sample catalog and base migration preserves historical orders, inventory and audit', async t => {
  const fresh = new D1Adapter(); t.after(() => fresh.close());
  assert.equal(await fresh.prepare('SELECT COUNT(*) AS n FROM products').first('n'), 0);
  assert.equal(await fresh.prepare('SELECT COUNT(*) AS n FROM inventory').first('n'), 0);
  const env = environment(); t.after(() => env.DB.close());
  const placed = await request(env, '/orders', { method: 'POST', body: checkout() });
  const before = {};
  for (const table of ['orders','inventory','reservations','reservation_allocations','inventory_movements']) {
    before[table] = (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
  }
  env.DB.database.exec('BEGIN');
  env.DB.database.exec(archiveDemoMigration); env.DB.database.exec(basesMigration);
  env.DB.database.exec('COMMIT');
  assert.deepEqual(env.DB.database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await request(env, '/products')).data.products.length, 0);
  for (const table of Object.keys(before)) assert.deepEqual((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results, before[table], table);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: placed.data.order.id, token: placed.data.trackingToken } });
  assert.equal(tracked.status, 200);
  env.DB.database.exec('BEGIN'); env.DB.database.exec(basesMigration); env.DB.database.exec('COMMIT');
  assert.deepEqual(env.DB.database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('archiving a base after its catalog read cannot create a product referring to that archived base', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env), imageUrl = productDraft().designUrl;
  const base = (await request(env, '/admin/bases', { method: 'POST', token, body: {
    name: 'Race base', type: 'T-shirt', weightGsm: 200, sizes: ['M'], colors: [{ name: 'Black', hex: '#000000', imageUrl }],
  } })).data.base;
  env.DB.afterRead = async sql => {
    if (sql !== 'SELECT * FROM garment_colors WHERE active = 1 ORDER BY shirt') return;
    env.DB.afterRead = null;
    assert.equal((await request(env, `/admin/bases/${base.id}`, { method: 'DELETE', token, body: { version: 1 } })).status, 200);
  };
  const result = await request(env, '/admin/products', { method: 'POST', token, body: productDraft({
    shirt: base.colors[0].shirt, availableShirts: [base.colors[0].shirt],
  }) });
  assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_COLOR');
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first('n'), 16);
});

test('collections, per-type prices and front/back prints drive the catalog and server-side order prices', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const imageUrl = (await uploadPng(env, token)).data.designUrl;
  const backUrl = (await uploadPng(env, token, testPng(3, 3))).data.designUrl;
  const collectionBody = { name: 'Summer Drop', nameEs: 'Drop de verano', description: 'Hot tees', coverUrl: imageUrl, accent: '#FF6600', idempotencyKey: crypto.randomUUID() };
  assert.equal((await request(env, '/admin/collections', { method: 'POST', body: collectionBody })).status, 401);
  assert.equal((await request(env, '/admin/collections', { method: 'POST', token, body: { ...collectionBody, coverUrl: '' } })).status, 400);
  const created = await request(env, '/admin/collections', { method: 'POST', token, body: collectionBody });
  assert.equal(created.status, 201);
  const collection = created.data.collection;
  assert.equal(collection.slug, 'drop-de-verano'); assert.equal(collection.accent, '#ff6600');
  assert.equal((await request(env, '/admin/collections', { method: 'POST', token, body: collectionBody })).data.collection.id, collection.id);
  assert.equal((await request(env, '/admin/collections', { method: 'POST', token, body: { ...collectionBody, idempotencyKey: crypto.randomUUID() } })).data.error.code, 'SLUG_TAKEN');
  assert.deepEqual((await request(env, '/collections')).data.collections.map(row => row.slug), ['drop-de-verano']);
  const regular = (await request(env, '/admin/bases', { method: 'POST', token, body: { name: 'Classic', type: 'Regular', weightGsm: 180, sizes: ['S', 'M'],
    colors: [{ name: 'White', hex: '#ffffff', imageUrl, backImageUrl: imageUrl }, { name: 'Sand', hex: '#d9c6a5', imageUrl }],
    printArea: { x: 30, y: 25, w: 40, h: 45 } } })).data.base;
  assert.deepEqual(regular.printArea, { x: 30, y: 25, w: 40, h: 45 }); assert.equal(regular.colors[0].backImageUrl, imageUrl);
  const oversize = (await request(env, '/admin/bases', { method: 'POST', token, body: { name: 'Oversize', type: 'Oversize', weightGsm: 260, sizes: ['M', 'L'],
    colors: [{ name: 'Black', hex: '#111111', imageUrl, backImageUrl: imageUrl }] } })).data.base;
  const draft = { name: 'Sun Tee', nameEs: 'Camiseta Sol', collectionId: collection.id, printSides: 'both', frontDesignUrl: imageUrl, backDesignUrl: backUrl,
    availableShirts: [regular.colors[0].shirt, regular.colors[1].shirt, oversize.colors[0].shirt], shirt: oversize.colors[0].shirt,
    basePrices: { [regular.id]: 30, [oversize.id]: 38.5 }, idempotencyKey: crypto.randomUUID() };
  const missingBack = await request(env, '/admin/products', { method: 'POST', token, body: draft });
  assert.equal(missingBack.status, 400); assert.equal(missingBack.data.error.code, 'BACK_PHOTO_REQUIRED');
  assert.equal((await request(env, '/admin/products', { method: 'POST', token, body: { ...draft, collectionId: 'col-00000000-0000-0000-0000-000000000000' } })).data.error.code, 'INVALID_COLLECTION');
  const body = { ...draft, availableShirts: [regular.colors[0].shirt, oversize.colors[0].shirt] };
  const product = (await request(env, '/admin/products', { method: 'POST', token, body })).data.product;
  assert.equal(product.price, 30); assert.equal(product.category, 'drop-de-verano'); assert.equal(product.collection, 'Summer Drop');
  assert.equal(product.designUrl, imageUrl); assert.equal(product.backDesignUrl, backUrl); assert.equal(product.printSides, 'both');
  const catalog = (await request(env, '/products')).data.products.find(row => row.id === product.id);
  assert.deepEqual(catalog.shirtOptions.map(option => option.price), [30, 38.5]);
  assert.deepEqual(catalog.shirtOptions[0].printArea, { x: 30, y: 25, w: 40, h: 45 });
  const order = await request(env, '/orders', { method: 'POST', body: checkout({ items: [
    { productId: product.id, shirt: oversize.colors[0].shirt, size: 'L', quantity: 2 }, { productId: product.id, shirt: regular.colors[0].shirt, size: 'S', quantity: 1 }] }) });
  assert.equal(order.status, 201);
  assert.deepEqual(order.data.order.items.map(item => item.unitPrice).sort(), [30, 38.5]);
  assert.equal(order.data.order.totals.subtotal, 107); assert.equal(order.data.order.items[0].backDesignUrl, backUrl);
  const renamed = await request(env, `/admin/collections/${collection.id}`, { method: 'PATCH', token, body: { version: 1, name: 'Summer Club' } });
  assert.equal(renamed.status, 200); assert.equal(renamed.data.collection.slug, 'drop-de-verano');
  assert.equal((await request(env, '/products')).data.products.find(row => row.id === product.id).collection, 'Summer Club');
  assert.equal((await request(env, `/admin/collections/${collection.id}`, { method: 'DELETE', token, body: { version: 2 } })).data.error.code, 'COLLECTION_IN_USE');
  const repriced = await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token, body: { version: 1, basePrices: { [regular.id]: 25, [oversize.id]: 40 } } });
  assert.equal(repriced.status, 200); assert.equal(repriced.data.product.price, 25);
  const frontOnly = await request(env, `/admin/products/${product.id}`, { method: 'PATCH', token, body: { version: 2, printSides: 'front' } });
  assert.equal(frontOnly.data.product.backDesignUrl, ''); assert.equal(frontOnly.data.product.designUrl, imageUrl);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: order.data.order.id, token: order.data.trackingToken } });
  assert.deepEqual(tracked.data.order.items.map(item => item.unitPrice).sort(), [30, 38.5]);
  assert.equal((await request(env, `/admin/products/${product.id}`, { method: 'DELETE', token, body: { version: 3 } })).status, 200);
  const archived = await request(env, `/admin/collections/${collection.id}`, { method: 'DELETE', token, body: { version: 2 } });
  assert.equal(archived.status, 200); assert.equal((await request(env, '/collections')).data.collections.length, 0);
  assert.equal((await request(env, '/admin/collections?includeArchived=true', { token })).data.collections[0].active, false);
});

test('articles own hidden variant bases, sell with stock and survive edits, archive and catalog migrations', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const token = await adminToken(env);
  const imageUrl = (await uploadPng(env, token)).data.designUrl;
  const collection = (await request(env, '/admin/collections', { method: 'POST', token, body: { name: 'Accesorios', coverUrl: imageUrl } })).data.collection;
  const body = { name: 'Club Bottle', nameEs: 'Botella Club', articleType: 'Botella', collectionId: collection.id, price: 18,
    sizes: ['500 ml', '750 ml'], variants: [{ name: 'Matte black', hex: '#1a1a1a', imageUrl }, { name: 'Sky', hex: '#88bbee', imageUrl }],
    defaultVariant: 1, initialStock: 4, idempotencyKey: crypto.randomUUID() };
  assert.equal((await request(env, '/admin/articles', { method: 'POST', body })).status, 401);
  assert.equal((await request(env, '/admin/articles', { method: 'POST', token, body: { ...body, variants: [] } })).status, 400);
  const created = await request(env, '/admin/articles', { method: 'POST', token, body });
  assert.equal(created.status, 201);
  const article = created.data.product;
  assert.equal(article.kind, 'article'); assert.equal(article.designUrl, ''); assert.equal(article.articleType, 'Botella');
  assert.equal(article.shirt, article.availableShirts[1]); assert.equal(article.category, 'accesorios');
  assert.equal((await request(env, '/admin/articles', { method: 'POST', token, body })).data.product.id, article.id);
  assert.equal((await request(env, '/bases')).data.bases.length > 0, true);
  assert.equal((await request(env, '/bases')).data.bases.some(base => base.kind === 'article'), false);
  assert.equal((await request(env, '/admin/bases?kind=article', { token })).data.bases.length, 1);
  const baseId = article.shirtOptions[0].baseId;
  assert.equal((await request(env, `/admin/bases/${baseId}`, { method: 'PATCH', token, body: { version: 1, name: 'Hijack' } })).data.error.code, 'ARTICLE_BASE');
  const garment = (await request(env, '/bases')).data.bases[0];
  assert.equal((await request(env, '/admin/products', { method: 'POST', token, body: productDraft({ shirt: article.shirt, availableShirts: [article.shirt] }) })).data.error.code, 'INVALID_COLOR');
  assert.ok(garment);
  const inventory = (await request(env, '/inventory')).data.variants.filter(row => row.productId === article.id);
  assert.equal(inventory.length, 4); assert.ok(inventory.every(row => row.stock === 4));
  const order = await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: article.id, shirt: article.shirt, size: '750 ml', quantity: 2 }] }) });
  assert.equal(order.status, 201); assert.equal(order.data.order.items[0].unitPrice, 18); assert.equal(order.data.order.items[0].kind, 'article');
  assert.equal((await inventoryRow(env, article.id, article.shirt, '750 ml')).stock, 2);
  const edited = await request(env, `/admin/articles/${article.id}`, { method: 'PATCH', token, body: { version: 1, price: 20, sizes: ['Única'],
    variants: [{ ...article.shirtOptions[1], shirt: article.shirt, name: 'Sky blue', imageUrl }, { name: 'Forest', hex: '#225533', imageUrl }] } });
  assert.equal(edited.status, 200);
  const updated = edited.data.product;
  assert.equal(updated.version, 2); assert.equal(updated.price, 20); assert.equal(updated.availableShirts.length, 2);
  assert.ok(updated.availableShirts.includes(article.shirt)); assert.ok(!updated.availableShirts.includes(article.availableShirts[0]));
  assert.equal(updated.shirtOptions.find(option => option.shirt === article.shirt).colorName, 'Sky blue');
  assert.deepEqual(updated.shirtOptions[0].sizes, ['Única']); assert.equal('revision' in updated, false);
  const publicArticle = (await request(env, '/products')).data.products.find(row => row.id === article.id);
  assert.equal('revision' in publicArticle, false); assert.equal(publicArticle.shirtOptions[0].price, 20);
  assert.equal((await request(env, `/admin/articles/${article.id}`, { method: 'PATCH', token, body: { version: 1, price: 21 } })).data.error.code, 'PRODUCT_CHANGED');
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: article.id, shirt: article.shirt, size: '750 ml', quantity: 1 }] }) })).data.error.code, 'INVALID_SIZE');
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: article.id, shirt: article.shirt, size: 'Única', quantity: 1 }] }) })).status, 201);
  const tracked = await request(env, '/orders/track', { method: 'POST', body: { id: order.data.order.id, token: order.data.trackingToken } });
  assert.equal(tracked.data.order.items[0].colorName, 'Sky'); assert.equal(tracked.data.order.items[0].size, '750 ml');
  env.DB.database.exec(archiveDemoMigration); env.DB.database.exec(collectionsMigration); env.DB.database.exec(collectionsMigration);
  assert.ok((await request(env, '/products')).data.products.some(row => row.id === article.id), 'Rerunning migrations keeps articles active');
  assert.equal((await request(env, `/admin/products/${article.id}`, { method: 'DELETE', token, body: { version: 2 } })).status, 200);
  const restored = await request(env, `/admin/products/${article.id}`, { method: 'PATCH', token, body: { version: 3, active: true } });
  assert.equal(restored.status, 200); assert.equal(restored.data.product.kind, 'article');
  env.DB.database.exec(await readFile(new URL('./migrations/0009_empty_catalog.sql', import.meta.url), 'utf8'));
  assert.equal((await request(env, '/products')).data.products.length, 0);
  assert.equal((await request(env, '/bases')).data.bases.length, 0);
  assert.equal((await request(env, '/collections')).data.collections.length, 0);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first('n'), 2);
});

function testVideo(size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom')]);
  for (let index = 12; index < size; index++) bytes[index] = index % 251;
  return bytes;
}
async function uploadVideo(env, token, bytes = testVideo(), type = 'video/mp4', headers = {}) {
  const response = await worker.fetch(new Request('https://orders.example/admin/videos', {
    method: 'POST', headers: { 'Content-Type': type, 'Content-Length': String(bytes.length), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: bytes,
  }), env);
  return { status: response.status, data: await response.json() };
}

test('videos upload with authentication, stream by byte ranges and decorate collections and the landing', async t => {
  const env = environment(); t.after(() => env.DB.close());
  assert.ok(schema.includes(mediaMigration.split('\n').slice(2).join('\n')), 'Fresh schema must include the media migration');
  const token = await adminToken(env);
  assert.equal((await uploadVideo(env, null)).status, 401);
  assert.equal((await uploadVideo(env, token, new Uint8Array(64))).data.error.code, 'INVALID_VIDEO');
  assert.equal((await uploadVideo(env, token, testVideo(), 'image/png')).data.error.code, 'VIDEO_REQUIRED');
  assert.equal((await uploadVideo(env, token, testVideo(), 'video/mp4', { 'Content-Length': String(60 * 1024 * 1024) })).status, 413);
  const video = testVideo();
  const uploaded = await uploadVideo(env, token, video);
  assert.equal(uploaded.status, 201); assert.match(uploaded.data.videoUrl, /\/videos\/[a-f0-9]{64}\.mp4$/);
  assert.equal((await uploadVideo(env, token, video)).data.videoUrl, uploaded.data.videoUrl);
  const full = await worker.fetch(new Request(uploaded.data.videoUrl), env);
  assert.equal(full.status, 200); assert.equal(full.headers.get('Accept-Ranges'), 'bytes'); assert.equal(full.headers.get('Content-Type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, video.length);
  const partial = await worker.fetch(new Request(uploaded.data.videoUrl, { headers: { Range: 'bytes=100-199' } }), env);
  assert.equal(partial.status, 206); assert.equal(partial.headers.get('Content-Range'), `bytes 100-199/${video.length}`);
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), video.slice(100, 200));
  const tail = await worker.fetch(new Request(uploaded.data.videoUrl, { headers: { Range: 'bytes=-10' } }), env);
  assert.equal(tail.headers.get('Content-Range'), `bytes ${video.length - 10}-${video.length - 1}/${video.length}`);
  assert.equal((await worker.fetch(new Request(uploaded.data.videoUrl, { headers: { Range: `bytes=${video.length}-` } }), env)).status, 416);
  assert.equal((await worker.fetch(new Request(uploaded.data.videoUrl.replace('.mp4', '.webm')), env)).status, 404);
  const poster = (await uploadPng(env, token)).data.designUrl;
  const collection = (await request(env, '/admin/collections', { method: 'POST', token, body: { name: 'Reel', coverUrl: poster,
    videos: [{ url: uploaded.data.videoUrl, posterUrl: poster }] } })).data.collection;
  assert.deepEqual(collection.videos, [{ url: uploaded.data.videoUrl, posterUrl: poster }]);
  assert.equal((await request(env, '/admin/collections', { method: 'POST', token, body: { name: 'Bad reel', coverUrl: poster,
    videos: [{ url: 'https://evil.example/videos/x.mp4' }] } })).data.error.code, 'INVALID_VIDEO_URL');
  assert.deepEqual((await request(env, '/collections')).data.collections[0].videos[0].url, uploaded.data.videoUrl);
  const kept = await request(env, `/admin/collections/${collection.id}`, { method: 'PATCH', token, body: { version: 1, name: 'Reel 2' } });
  assert.equal(kept.data.collection.videos.length, 1);
  assert.deepEqual((await request(env, '/settings/landing')).data.landing.slides, []);
  const slide = { videoUrl: uploaded.data.videoUrl, posterUrl: poster, title: 'Nuevo drop', buttonLabel: 'Ver', link: `#shop/${collection.slug}` };
  assert.equal((await request(env, '/admin/settings/landing', { method: 'PUT', body: { version: 0, slides: [slide] } })).status, 401);
  assert.equal((await request(env, '/admin/settings/landing', { method: 'PUT', token, body: { version: 0, slides: [{ ...slide, link: 'javascript:alert(1)' }] } })).status, 400);
  const saved = await request(env, '/admin/settings/landing', { method: 'PUT', token, body: { version: 0, slides: [slide, { ...slide, title: 'Dos' }] } });
  assert.equal(saved.status, 200); assert.equal(saved.data.landing.version, 1); assert.equal(saved.data.landing.slides.length, 2);
  assert.equal((await request(env, '/admin/settings/landing', { method: 'PUT', token, body: { version: 0, slides: [] } })).data.error.code, 'SETTINGS_CHANGED');
  const publicLanding = (await request(env, '/settings/landing')).data.landing;
  assert.equal(publicLanding.slides[0].title, 'Nuevo drop'); assert.equal('version' in publicLanding, false);
  assert.equal((await request(env, '/admin/settings/landing', { method: 'PUT', token, body: { version: 1, slides: [] } })).data.landing.version, 2);
  env.DB.database.exec(mediaMigration); env.DB.database.exec(mediaMigration);
  assert.equal(await env.DB.prepare('SELECT COUNT(*) AS n FROM video_assets').first('n'), 1);
});

function fakeTilopay() {
  const fake = { calls: [], transactions: new Map(), refunds: [] };
  fake.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith('https://app.tilopay.com/api/v1/')) throw new Error(`Unexpected fetch ${url}`);
    const path = url.slice('https://app.tilopay.com/api/v1/'.length);
    const body = JSON.parse(init.body || '{}');
    fake.calls.push({ path, body, authorization: init.headers?.Authorization });
    const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (path === 'login') return body.apiuser === 'api-user' && body.password === 'api-pass'
      ? reply({ access_token: 'tilo-token', token_type: 'bearer', expires_in: 86400 }) : reply({ error: 'Unauthorized' });
    if (path === 'loginSdk') return body.apiuser === 'api-user' && body.password === 'api-pass' && body.key === 'key-123'
      ? reply({ access_token: 'sdk-token', token_type: 'bearer', expires_in: '2026-01-01 00:00:00' }) : reply({ error: 'Unauthorized' });
    if (path === 'processPayment') return reply({ type: '100', html: 'Use url redirect', url: `https://app.tilopay.com/pay/${body.orderNumber}` });
    if (path === 'consult') return reply({ type: '200', message: '', response: fake.transactions.get(body.orderNumber) || [] });
    if (path === 'processModification') { fake.refunds.push(body); return reply({ type: '100', transactionId: 1, ReasonCode: '1101', ReasonCodeDescription: 'Transaccion aprobada' }); }
    return reply({ type: '400', message: 'unknown' });
  };
  return fake;
}

test('Tilopay payments are confirmed only by consult, retried with new order numbers, expired by cron and refundable', async t => {
  const env = environment(); t.after(() => env.DB.close());
  Object.assign(env, { TILOPAY_API_USER: 'api-user', TILOPAY_API_PASSWORD: 'api-pass', TILOPAY_KEY: 'key-123', SITE_URL: 'https://ealfaro29.github.io/zenin-club' });
  const fake = fakeTilopay();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const token = await adminToken(env);
  assert.deepEqual((await request(env, '/payments/config')).data, { enabled: true, provider: 'tilopay' });
  const product = (await request(env, '/admin/products', { method: 'POST', token, body: productDraft() })).data.product;
  const customer = { ...checkout().customer, phone: '+506 8888 7777', state: 'CR-H' };
  const body = () => checkout({ customer, items: [{ productId: product.id, shirt: 2, size: 'M', quantity: 2 }] });
  const noPhone = await request(env, '/orders', { method: 'POST', body: checkout({ items: [{ productId: product.id, shirt: 2, size: 'M', quantity: 1 }] }) });
  assert.equal(noPhone.status, 400); assert.equal(noPhone.data.error.field, 'phone');

  const first = await request(env, '/orders', { method: 'POST', body: body() });
  assert.equal(first.status, 201); assert.equal(first.data.order.payment.status, 'pending');
  const sent = fake.calls.find(call => call.path === 'processPayment').body;
  assert.match(first.data.payment.url, /^https:\/\/app\.tilopay\.com\/pay\/ZC[A-Z0-9]{12}$/);
  assert.equal(sent.amount, '107.90'); assert.equal(sent.currency, 'USD'); assert.equal(sent.billToState, 'CR-H'); assert.equal(sent.key, 'key-123');
  assert.equal(sent.redirect, 'https://orders.example/payments/tilopay/return'); assert.equal(sent.capture, '1');
  assert.equal(fake.calls.find(call => call.path === 'processPayment').authorization, 'bearer tilo-token');
  const orderNumber = sent.orderNumber;
  const forged = await worker.fetch(new Request(`https://orders.example/payments/tilopay/return?code=1&order=${orderNumber}&auth=999`), env);
  assert.equal(forged.status, 303);
  assert.equal(forged.headers.get('Location'), `https://ealfaro29.github.io/zenin-club/#order/${encodeURIComponent(first.data.order.id)}/${encodeURIComponent(first.data.trackingToken)}`);
  let tracked = await request(env, '/orders/track', { method: 'POST', body: { id: first.data.order.id, token: first.data.trackingToken } });
  assert.equal(tracked.data.order.payment.status, 'pending', 'A redirect with code=1 alone never marks the order paid');
  fake.transactions.set(orderNumber, [{ id_tilopay: 7, orderNumber, amount: '107.90', currency: 'USD', code: '1', response: 'Transacción aprobada', auth: '123456', last: '5221', environment: 'Test', type: 'Payment' }]);
  await worker.fetch(new Request(`https://orders.example/payments/tilopay/return?code=1&order=${orderNumber}`), env);
  tracked = await request(env, '/orders/track', { method: 'POST', body: { id: first.data.order.id, token: first.data.trackingToken } });
  assert.equal(tracked.data.order.payment.status, 'paid'); assert.equal(tracked.data.order.payment.environment, 'test');
  assert.equal(tracked.data.order.payment.card, '•••• 5221'); assert.equal('events' in tracked.data.order.payment, false);
  assert.equal((await request(env, '/orders/pay', { method: 'POST', body: { id: first.data.order.id, token: first.data.trackingToken } })).data.error.code, 'ORDER_ALREADY_PAID');

  const second = await request(env, '/orders', { method: 'POST', body: body() });
  const secondNumber = second.data.payment.orderNumber;
  fake.transactions.set(secondNumber, [{ orderNumber: secondNumber, amount: '107.90', currency: 'USD', code: '2', response: 'Fondos insuficientes', type: 'Payment' }]);
  await worker.fetch(new Request(`https://orders.example/payments/tilopay/return?code=2&order=${secondNumber}`), env);
  const declined = (await request(env, '/orders/track', { method: 'POST', body: { id: second.data.order.id, token: second.data.trackingToken } })).data.order;
  assert.equal(declined.payment.status, 'failed'); assert.equal(declined.payment.message, 'Fondos insuficientes');
  assert.equal((await request(env, '/orders/pay', { method: 'POST', body: { id: second.data.order.id, token: 'wrong' } })).status, 404);
  const retry = await request(env, '/orders/pay', { method: 'POST', body: { id: second.data.order.id, token: second.data.trackingToken } });
  assert.equal(retry.status, 200); assert.notEqual(retry.data.payment.orderNumber, secondNumber);
  const mismatch = retry.data.payment.orderNumber;
  fake.transactions.set(mismatch, [{ orderNumber: mismatch, amount: '1.00', currency: 'USD', code: '1', type: 'Payment' }]);
  await worker.fetch(new Request(`https://orders.example/payments/tilopay/return?code=1&order=${mismatch}`), env);
  assert.equal((await request(env, '/orders/track', { method: 'POST', body: { id: second.data.order.id, token: second.data.trackingToken } })).data.order.payment.status, 'review');

  const abandoned = await request(env, '/orders', { method: 'POST', body: body() });
  const old = new Date(Date.now() - 2 * 3600000).toISOString();
  env.DB.database.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(old, abandoned.data.order.id);
  env.DB.database.prepare('UPDATE payment_attempts SET created_at = ? WHERE order_id = ?').run(old, abandoned.data.order.id);
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  const expired = (await request(env, `/admin/orders/${abandoned.data.order.id}`, { token })).data.order;
  assert.equal(expired.status, 'cancelled'); assert.equal(expired.payment.status, 'expired');
  assert.equal((await request(env, `/admin/orders/${first.data.order.id}`, { token })).data.order.status, 'new');

  const paid = (await request(env, `/admin/orders/${first.data.order.id}`, { token })).data.order;
  assert.equal((await request(env, `/admin/orders/${first.data.order.id}/refund`, { method: 'POST', body: { expectedVersion: paid.version } })).status, 401);
  assert.equal((await request(env, `/admin/orders/${first.data.order.id}/refund`, { method: 'POST', token, body: { expectedVersion: paid.version - 1 } })).data.error.code, 'ORDER_CHANGED');
  const refunded = await request(env, `/admin/orders/${first.data.order.id}/refund`, { method: 'POST', token, body: { expectedVersion: paid.version } });
  assert.equal(refunded.status, 200); assert.equal(refunded.data.order.payment.status, 'refunded'); assert.equal(refunded.data.order.status, 'cancelled');
  assert.deepEqual(fake.refunds, [{ orderNumber, type: '2', amount: '107.90', key: 'key-123' }]);
  assert.equal((await request(env, `/admin/orders/${first.data.order.id}/refund`, { method: 'POST', token, body: { expectedVersion: refunded.data.order.version } })).data.error.code, 'ORDER_NOT_REFUNDABLE');
});

test('without Tilopay credentials checkout keeps the no-charge flow', async t => {
  const env = environment(); t.after(() => env.DB.close());
  assert.deepEqual((await request(env, '/payments/config')).data, { enabled: false, provider: null });
  const created = await request(env, '/orders', { method: 'POST', body: checkout() });
  assert.equal(created.status, 201); assert.equal('payment' in created.data, false); assert.equal('payment' in created.data.order, false);
});

test('the store owner configures Tilopay from the admin; credentials are verified, encrypted and never returned', async t => {
  const env = environment(); t.after(() => env.DB.close());
  const fake = fakeTilopay();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const token = await adminToken(env);
  assert.equal((await request(env, '/admin/settings/payments')).status, 401);
  const initial = (await request(env, '/admin/settings/payments', { token })).data.payments;
  assert.equal(initial.enabled, false); assert.equal(initial.version, 0);
  const wrongPassword = await request(env, '/admin/settings/payments', { method: 'PUT', token, body: { version: 0, enabled: true, apiUser: 'api-user', password: 'nope', key: 'key-123' } });
  assert.equal(wrongPassword.data.error.code, 'PAYMENT_CREDENTIALS_INVALID');
  const wrongKey = await request(env, '/admin/settings/payments/test', { method: 'POST', token, body: { apiUser: 'api-user', password: 'api-pass', key: 'key-999' } });
  assert.equal(wrongKey.data.error.code, 'PAYMENT_KEY_INVALID');
  assert.equal((await request(env, '/admin/settings/payments/test', { method: 'POST', token, body: { apiUser: 'api-user', password: 'api-pass', key: 'key-123' } })).data.ok, true);
  assert.equal((await request(env, '/payments/config')).data.enabled, false);
  const saved = await request(env, '/admin/settings/payments', { method: 'PUT', token, body: { version: 0, enabled: true, apiUser: 'api-user', password: 'api-pass', key: 'key-123' } });
  assert.equal(saved.status, 200);
  assert.deepEqual({ ...saved.data.payments, verifiedAt: Boolean(saved.data.payments.verifiedAt), updatedAt: undefined },
    { provider: 'tilopay', enabled: true, apiUser: 'api-user', hasPassword: true, keyHint: '••••-123', verifiedAt: true, version: 1, updatedAt: undefined, usingWorkerSecrets: false });
  const raw = await env.DB.prepare(`SELECT value_json FROM site_settings WHERE key = 'payments'`).first('value_json');
  assert.equal(raw.includes('api-pass'), false); assert.equal(raw.includes('key-123'), false);
  assert.deepEqual((await request(env, '/payments/config')).data, { enabled: true, provider: 'tilopay' });
  const product = (await request(env, '/admin/products', { method: 'POST', token, body: productDraft() })).data.product;
  const customer = { ...checkout().customer, phone: '88887777', state: 'CR-SJ' };
  assert.equal((await request(env, '/orders', { method: 'POST', body: checkout({ customer, returnUrl: 'https://evil.example/shop/', items: [{ productId: product.id, shirt: 2, size: 'M', quantity: 1 }] }) })).data.error.field, 'returnUrl');
  const order = await request(env, '/orders', { method: 'POST', body: checkout({ customer, returnUrl: 'https://ealfaro29.github.io/zenin-club/index.html?x=1#shop', items: [{ productId: product.id, shirt: 2, size: 'M', quantity: 1 }] }) });
  assert.equal(order.status, 201); assert.ok(order.data.payment.url); assert.equal('returnUrl' in order.data.order, false);
  assert.equal(fake.calls.filter(call => call.path === 'processPayment').at(-1).body.key, 'key-123');
  const back = await worker.fetch(new Request(`https://orders.example/payments/tilopay/return?code=2&order=${order.data.payment.orderNumber}`), env);
  assert.match(back.headers.get('Location'), /^https:\/\/ealfaro29\.github\.io\/zenin-club\/index\.html#order\//);
  const kept = await request(env, '/admin/settings/payments', { method: 'PUT', token, body: { version: 1, enabled: true } });
  assert.equal(kept.status, 200); assert.equal(kept.data.payments.keyHint, '••••-123');
  assert.equal((await request(env, '/admin/settings/payments', { method: 'PUT', token, body: { version: 1, enabled: false } })).data.error.code, 'SETTINGS_CHANGED');
  const disabled = await request(env, '/admin/settings/payments', { method: 'PUT', token, body: { version: 2, enabled: false } });
  assert.equal(disabled.data.payments.enabled, false);
  assert.equal((await request(env, '/payments/config')).data.enabled, false);
  const offline = await request(env, '/orders', { method: 'POST', body: checkout() });
  assert.equal(offline.status, 201); assert.equal('payment' in offline.data, false);
});
