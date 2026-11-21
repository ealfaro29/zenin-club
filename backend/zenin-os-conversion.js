// ZENIN CLUB OS: social quote -> official order. NOT ROUTED OR DEPLOYED.
// Requires migrations 0012-0014. No stock reservations, no Tilopay changes.
// Must be called only after admin authorization. D1 batch is transactional.
const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
const sha = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map(v => v.toString(16).padStart(2, '0')).join('');
const tokenFor = async (env, id, key) => {
  if (typeof env.ADMIN_SESSION_SECRET !== 'string' || env.ADMIN_SESSION_SECRET.length < 32) fail(503,'NOT_CONFIGURED','Tracking secret is not configured');
  const keyBytes = new TextEncoder().encode(env.ADMIN_SESSION_SECRET);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,new TextEncoder().encode(`zenin:order-tracking:v1:${id}:${key}`)));
  return btoa(String.fromCharCode(...signature)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,'');
};
const response = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8'}});

export async function convertZcQuoteToOrder(env, body, actor) {
  const quoteId = typeof body?.quoteId === 'string' ? body.quoteId.trim() : '';
  if (!quoteId || quoteId.length > 100) fail(400,'INVALID_QUOTE','Valid quoteId required');
  const existing = await env.DB.prepare('SELECT order_id FROM zc_order_links WHERE quote_id=?').bind(quoteId).first();
  if (existing) return response({orderId:existing.order_id,alreadyCreated:true});
  const q = await env.DB.prepare(`SELECT q.*,r.channel,r.customer_id,r.status AS request_status,
    c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email
    FROM zc_quotes q JOIN zc_requests r ON r.id=q.request_id
    JOIN zc_customers c ON c.id=r.customer_id WHERE q.id=?`).bind(quoteId).first();
  if (!q) fail(404,'QUOTE_NOT_FOUND','Quote not found');
  if (q.status !== 'accepted' || q.channel === 'web') fail(409,'QUOTE_NOT_ACCEPTED','Accepted social quote required');
  const items = (await env.DB.prepare('SELECT description,quantity,unit_price_minor FROM zc_quote_items WHERE quote_id=? ORDER BY position').bind(quoteId).all()).results;
  if (!items.length) fail(409,'EMPTY_QUOTE','Quote has no items');
  const verified = await env.DB.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS amount FROM zc_manual_payments
    WHERE quote_id=? AND status='verified' AND currency=?`).bind(quoteId,q.currency).first();
  if (Number(verified.amount) < q.deposit_required_minor || q.deposit_required_minor <= 0)
    fail(409,'DEPOSIT_NOT_VERIFIED','Required deposit has not been verified');
  const merchandise = q.subtotal_minor - q.discount_minor;
  if (q.deposit_required_minor !== Math.ceil(merchandise / 2))
    fail(409,'INVALID_DEPOSIT','Deposit must be 50% of discounted merchandise');
  const delivery = await env.DB.prepare('SELECT delivery_mode,status FROM zc_shipping_profiles WHERE request_id=?').bind(q.request_id).first();
  if (!delivery || !['workshop_pickup','home_delivery'].includes(delivery.delivery_mode))
    fail(409,'DELIVERY_MODE_REQUIRED','Choose delivery mode before converting');
  if (delivery.delivery_mode === 'workshop_pickup' && q.shipping_minor !== 0)
    fail(409,'INVALID_SHIPPING','Workshop pickup is free');
  if (delivery.delivery_mode === 'home_delivery' && (delivery.status !== 'confirmed' || (q.currency === 'CRC' && q.shipping_minor !== 250000)))
    fail(409,'SHIPPING_NOT_CONFIRMED','Confirm address and shipping fee');
  const t=new Date().toISOString(), id='ZC-'+crypto.randomUUID(), idem=await sha('zenin:quote:'+quoteId);
  const trackingToken=await tokenFor(env,id,idem), trackingHash=await sha(trackingToken);
  const order={id,createdAt:t,updatedAt:t,status:'new',source:'social',quoteId,
    customer:{name:q.customer_name,phone:q.customer_phone,email:q.customer_email},
    items:items.map(item=>({name:item.description,quantity:item.quantity,unitPriceMinor:item.unit_price_minor})),
    totals:{subtotalMinor:q.subtotal_minor,discountMinor:q.discount_minor,shippingMinor:q.shipping_minor,
      totalMinor:q.total_minor,currency:q.currency,verifiedPaidMinor:Number(verified.amount),
      remainingMinor:Math.max(0,q.total_minor-Number(verified.amount))},
    deliveryMode:delivery.delivery_mode,tracking:{carrier:'',number:''},
    history:[{status:'new',at:t}],notes:''};
  // Conditional INSERT guards against a payment being unverified between read and write.
  // The subsequent link and request transition share the same D1 transaction.
  const insert=env.DB.prepare(`INSERT INTO orders(id,idempotency_hash,request_hash,tracking_hash,email_normalized,status,created_at,updated_at,order_json)
    SELECT ?,?,?,?,?,?,?,?,?
    WHERE (SELECT status FROM zc_quotes WHERE id=?)='accepted'
      AND (SELECT COALESCE(SUM(amount_minor),0) FROM zc_manual_payments WHERE quote_id=? AND status='verified' AND currency=?)>=?
      AND NOT EXISTS(SELECT 1 FROM zc_order_links WHERE quote_id=?)`)
    .bind(id,idem,idem,trackingHash,(q.customer_email||'').toLowerCase(),'new',t,t,JSON.stringify(order),
      quoteId,quoteId,q.currency,q.deposit_required_minor,quoteId);
  try {
    const results=await env.DB.batch([
      insert,
      env.DB.prepare(`INSERT INTO zc_order_links(quote_id,order_id,created_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=?)`).bind(quoteId,id,t,id),
      env.DB.prepare(`UPDATE zc_requests SET status='converted',updated_at=?
        WHERE id=? AND EXISTS(SELECT 1 FROM zc_order_links WHERE quote_id=? AND order_id=?)`).bind(t,q.request_id,quoteId,id),
      env.DB.prepare(`INSERT INTO zc_events(id,request_id,quote_id,event_type,actor,created_at)
        SELECT ?,?,?,'order.created',?,? WHERE EXISTS(SELECT 1 FROM zc_order_links WHERE quote_id=? AND order_id=?)`)
        .bind('EVT-'+crypto.randomUUID(),q.request_id,quoteId,actor,t,quoteId,id),
    ]);
    if (results[0].meta?.changes !== 1) fail(409,'CONVERSION_CONFLICT','Conversion was not completed');
  } catch (error) {
    const winner=await env.DB.prepare('SELECT order_id FROM zc_order_links WHERE quote_id=?').bind(quoteId).first();
    if (winner) return response({orderId:winner.order_id,alreadyCreated:true});
    throw error;
  }
  // The token is returned only on first creation. Never expose it in list APIs or logs.
  return response({orderId:id,trackingToken,deliveryMode:delivery.delivery_mode,remainingMinor:order.totals.remainingMinor},201);
}
