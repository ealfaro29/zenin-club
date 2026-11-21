// Admin-only social orders queue. Caller must authorize the session.
const json = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export async function listZcSocialOrders(env, url) {
  const allowed = new Set(['new','preparing','ready','shipped','cancelled']);
  const status = url.searchParams.get('status');
  if (status && !allowed.has(status)) {
    const e = new Error('Invalid order status'); e.status=400; e.code='INVALID_STATUS'; throw e;
  }
  const limit = Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'30',10)||30));
  const rows = await (status
    ? env.DB.prepare(`SELECT s.id,s.quote_id,s.request_id,s.status,s.created_at,s.updated_at,
       s.order_json,c.name AS customer_name,c.phone AS customer_phone,r.channel
       FROM zc_social_orders s JOIN zc_requests r ON r.id=s.request_id
       JOIN zc_customers c ON c.id=r.customer_id WHERE s.status=?
       ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).bind(status,limit)
    : env.DB.prepare(`SELECT s.id,s.quote_id,s.request_id,s.status,s.created_at,s.updated_at,
       s.order_json,c.name AS customer_name,c.phone AS customer_phone,r.channel
       FROM zc_social_orders s JOIN zc_requests r ON r.id=s.request_id
       JOIN zc_customers c ON c.id=r.customer_id
       ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).bind(limit)).all();
  return json({orders:(rows.results||[]).map(row=>{
    const data=JSON.parse(row.order_json);
    return {id:row.id,quoteId:row.quote_id,requestId:row.request_id,
      status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,
      channel:row.channel,customer:{name:row.customer_name,phone:row.customer_phone},
      deliveryMode:data.deliveryMode,totals:data.totals};
  }),limit});
}
