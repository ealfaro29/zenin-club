import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

const origin = 'http://127.0.0.1:5183';
const directory = await mkdtemp(join(tmpdir(), 'zenin-os-test-'));
await chmod(directory, 0o700);
const database = new DatabaseSync(join(directory, 'orders.sqlite'));
const migrations = [
  '0012_zenin_os_module_01', '0013_zenin_os_shipping', '0014_delivery_modes',
  '0015_lead_followups', '0016_single_followup', '0017_social_orders',
  '0018_social_order_delivery'
];
const readSql = path => readFile(new URL(path, import.meta.url), 'utf8');
const scripts = await Promise.all(['./schema.sql', ...migrations.map(name => './migrations/' + name + '.sql')].map(readSql));
database.exec('PRAGMA foreign_keys = ON; BEGIN');
for (const sql of scripts) database.exec(sql);
if (database.prepare('PRAGMA foreign_key_check').all().length) throw Error('Invalid test database foreign keys');
database.exec('COMMIT');

function statement(sql, params = []) {
  const query = database.prepare(sql);
  return {
    bind: (...values) => statement(sql, values),
    async first(column) {
      const row = query.get(...params);
      return column ? row?.[column] ?? null : row ?? null;
    },
    async all() { return { results: query.all(...params) }; },
    async run() { return this.execute(); },
    execute() {
      const result = query.run(...params);
      return { success: true, meta: { changes: result.changes } };
    }
  };
}

const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16).toString('hex');
const env = {
  ADMIN_USERNAME: 'pruebas',
  ADMIN_PASSWORD_SALT: salt,
  ADMIN_PASSWORD_HASH: createHash('sha256').update(salt + ':' + password).digest('hex'),
  ADMIN_SESSION_SECRET: randomBytes(32).toString('hex'),
  DB: {
    prepare: statement,
    async batch(statements) {
      database.exec('BEGIN');
      try {
        const results = statements.map(item => item.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  }
};

const assets = new Map([
  ['/', 'zenin-os-ventas.html'],
  ['/zenin-os-ventas.html', 'zenin-os-ventas.html'],
  ['/zenin-os-pedidos.html', 'zenin-os-pedidos.html'],
  ['/zenin-os-test-api.js', 'zenin-os-test-api.js']
]);
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'");
  try {
    if (req.headers.host !== '127.0.0.1:5183' ||
        (req.headers.origin && req.headers.origin !== origin) ||
        ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(origin + req.url);
    const asset = assets.get(url.pathname);
    if (req.method === 'GET' && asset) {
      const content = await readFile(new URL('../docs/' + asset, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' }).end(content);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/zenin-os-test-environment') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ environment: 'zenin-os-local' }));
      return;
    }
    if (!['GET', 'POST'].includes(req.method) ||
        !(url.pathname.startsWith('/admin/zc/') || ['/admin/login', '/orders/track'].includes(url.pathname))) {
      res.writeHead(404).end();
      return;
    }
    const headers = new Headers();
    for (const name of ['authorization', 'content-type']) {
      if (req.headers[name]) headers.set(name, req.headers[name]);
    }
    const response = await worker.fetch(new Request(url, {
      method: req.method, headers, ...(req.method === 'POST' ? { body: req, duplex: 'half' } : {})
    }), env);
    res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' }).end(await response.text());
  } catch {
    res.writeHead(500).end();
  }
});
server.listen(5183, '127.0.0.1', () => {
  console.log('Ventas   ' + origin + '/zenin-os-ventas.html');
  console.log('Pedidos  ' + origin + '/zenin-os-pedidos.html');
  console.log('Usuario  ' + env.ADMIN_USERNAME);
  console.log('Clave temporal  ' + password);
  console.log('SQLite  ' + join(directory, 'orders.sqlite'));
});
