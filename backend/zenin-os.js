// ZENIN CLUB OS module 01: admin-only request and quotation handlers.
// This module is deliberately independent of checkout and Tilopay.
// Wire into worker.js only after integration tests are added.
const reply = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
const invalid = (message) => { const error = new Error(message); error.status = 400; error.code = 'INVALID_ZC_INPUT'; throw error; };
const string = (value, name, max = 250) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) invalid(name + ' is required or invalid');
  return value.trim();
};
const money = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) invalid(name + ' must be a nonnegative integer in minor units');
  return value;
};
const id = prefix => prefix + '-' + crypto.randomUUID();
const now = () => new Date().toISOString();

export async function createZcRequest(env, body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid request');
  const channel = string(body.channel, 'channel', 30);
  if (!['whatsapp', 'instagram', 'facebook', 'web', 'other'].includes(channel)) invalid('Invalid channel');
  const customer = body.customer;
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) invalid('Customer is required');
  const name = string(customer.name, 'customer.name', 160);
  const phone = customer.phone == null ? null : string(customer.phone, 'customer.phone', 60);
  const email = customer.email == null ? null : string(customer.email, 'customer.email', 254);
  if (!phone && !email) invalid('Customer phone or email is required');
  const description = body.description == null ? '' : String(body.description).trim();
  if (description.length > 3000) invalid('Description too long');
  const timestamp = now(), customerId = id('CUS'), requestId = id('REQ');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO zc_customers(id,name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .bind(customerId, name, phone, email, timestamp, timestamp),
    env.DB.prepare("INSERT INTO zc_requests(id,customer_id,channel,status,description,created_at,updated_at) VALUES(?,?,?,'open',?,?,?)")
      .bind(requestId, customerId, channel, description, timestamp, timestamp),
    env.DB.prepare('INSERT INTO zc_events(id,request_id,event_type,actor,created_at) VALUES(?,?,?,?,?)')
      .bind(id('EVT'), requestId, 'request.created', actor, timestamp),
  ]);
  return reply({ request: { id: requestId, customerId, channel, status: 'open' } }, 201);
}

export async function createZcQuote(env, body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid quote');
  const requestId = string(body.requestId, 'requestId', 100);
  const request = await env.DB.prepare('SELECT id,status FROM zc_requests WHERE id = ?').bind(requestId).first();
  if (!request) { const e = new Error('Request not found'); e.status = 404; e.code = 'REQUEST_NOT_FOUND'; throw e; }
  if (!['open','quoted'].includes(request.status)) invalid('Request cannot be quoted');
  const currency = string(body.currency, 'currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) invalid('Invalid currency');
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > 40) invalid('Provide 1 to 40 items');
  const parsed = items.map((item, position) => ({
    id: id('QIT'), position,
    description: string(item?.description, 'item.description', 500),
    quantity: money(item?.quantity, 'item.quantity'),
    unitPriceMinor: money(item?.unitPriceMinor, 'item.unitPriceMinor'),
  }));
  if (parsed.some(item => item.quantity === 0)) invalid('Item quantity must be positive');
  const subtotal = parsed.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  if (!Number.isSafeInteger(subtotal)) invalid('Subtotal too large');
  const discount = money(body.discountMinor ?? 0, 'discountMinor');
  const shipping = money(body.shippingMinor ?? 0, 'shippingMinor');
  if (discount > subtotal) invalid('Discount exceeds subtotal');
  const total = subtotal - discount + shipping;
  if (!Number.isSafeInteger(total)) invalid('Total too large');
  // The 50% deposit covers merchandise only. Shipping is due with the
  // remaining balance before dispatch; workshop pickup has no shipping fee.
  const merchandiseTotal = subtotal - discount;
  const deposit = Math.ceil(merchandiseTotal / 2);
  if (body.depositRequiredMinor !== undefined && body.depositRequiredMinor !== deposit)
    invalid('Deposit must equal 50% of discounted merchandise, excluding shipping');
  if (body.deliveryMode !== undefined) {
    if (!['workshop_pickup', 'home_delivery'].includes(body.deliveryMode)) invalid('Invalid delivery mode');
    if (body.deliveryMode === 'workshop_pickup' && shipping !== 0) invalid('Workshop pickup must have free shipping');
    if (body.deliveryMode === 'home_delivery' && currency === 'CRC' && shipping !== 250000)
      invalid('Home delivery fee must be CRC 2500');
  }
  const prior = await env.DB.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM zc_quotes WHERE request_id = ?').bind(requestId).first();
  const revision = Number(prior.revision) + 1;
  const quoteId = id('QUO'), timestamp = now();
  const statements = [
    env.DB.prepare("INSERT INTO zc_quotes(id,request_id,revision,status,currency,subtotal_minor,discount_minor,shipping_minor,total_minor,deposit_required_minor,created_at,updated_at) VALUES(?,?,?,'draft',?,?,?,?,?,?,?,?)")
      .bind(quoteId, requestId, revision, currency, subtotal, discount, shipping, total, deposit, timestamp, timestamp),
    ...parsed.map(item => env.DB.prepare('INSERT INTO zc_quote_items(id,quote_id,position,description,quantity,unit_price_minor) VALUES(?,?,?,?,?,?)')
      .bind(item.id, quoteId, item.position, item.description, item.quantity, item.unitPriceMinor)),
    env.DB.prepare("UPDATE zc_requests SET status = 'quoted', updated_at = ? WHERE id = ?")
      .bind(timestamp, requestId),
    env.DB.prepare('INSERT INTO zc_events(id,request_id,quote_id,event_type,actor,created_at) VALUES(?,?,?,?,?,?)')
      .bind(id('EVT'), requestId, quoteId, 'quote.created', actor, timestamp),
  ];
  await env.DB.batch(statements);
  return reply({ quote: { id: quoteId, requestId, revision, status: 'draft', currency, subtotalMinor: subtotal, discountMinor: discount, shippingMinor: shipping, totalMinor: total, depositRequiredMinor: deposit } }, 201);
}

export async function recordZcPaymentProof(env, body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid payment');
  const quoteId = string(body.quoteId, 'quoteId', 100);
  const quote = await env.DB.prepare('SELECT id,status,currency FROM zc_quotes WHERE id = ?').bind(quoteId).first();
  if (!quote) { const e = new Error('Quote not found'); e.status = 404; e.code = 'QUOTE_NOT_FOUND'; throw e; }
  if (quote.status !== 'accepted') invalid('Only accepted quotes can receive payment proofs');
  const amount = money(body.amountMinor, 'amountMinor');
  if (!amount) invalid('Payment amount must be positive');
  const kind = string(body.kind, 'kind', 20);
  if (!['deposit','balance','other'].includes(kind)) invalid('Invalid payment kind');
  // The R2 key must come from a separate authenticated upload endpoint, not user-supplied URLs.
  const reference = body.bankReference == null ? null : string(body.bankReference, 'bankReference', 120);
  const paymentId = id('PAY'), timestamp = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO zc_manual_payments(id,quote_id,kind,method,amount_minor,currency,status,bank_reference,created_at,updated_at) VALUES(?,?,?,'sinpe',?,?,'under_review',?,?,?)")
      .bind(paymentId, quoteId, kind, amount, quote.currency, reference, timestamp, timestamp),
    env.DB.prepare('INSERT INTO zc_events(id,quote_id,event_type,actor,created_at) VALUES(?,?,?,?,?)')
      .bind(id('EVT'), quoteId, 'payment.review_requested', actor, timestamp),
  ]);
  return reply({ payment: { id: paymentId, quoteId, status: 'under_review', amountMinor: amount, currency: quote.currency } }, 201);
}
