// Admin-only social orders queue. Caller must authorize the session.
const json = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export async function listZcSocialOrders(env, url) {
  const allowed = new Set(['new','preparing','ready','shipped','delivered','cancelled']);
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

const transitionError = (code,message,status=409) => {const e=new Error(message);e.status=status;e.code=code;throw e;};
const allowedTransitions = {
  new: ['preparing','cancelled'],
  preparing: ['ready','cancelled'],
  ready: ['shipped','delivered','cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

// Admin-only state transitions. Social orders never reserve legacy inventory.
export async function updateZcSocialOrderStatus(env, body, actor) {
  const orderId=typeof body?.orderId==='string'?body.orderId.trim():'';
  const next=body?.status;
  if (!orderId || orderId.length>100 || typeof next!=='string')
    transitionError('INVALID_INPUT','orderId and status are required',400);
  const row=await env.DB.prepare('SELECT * FROM zc_social_orders WHERE id=?').bind(orderId).first();
  if (!row) transitionError('ORDER_NOT_FOUND','Order not found',404);
  if (!allowedTransitions[row.status]?.includes(next))
    transitionError('INVALID_TRANSITION','Invalid order state transition');
  const order=JSON.parse(row.order_json);
  if (next==='delivered') {
    if (order.deliveryMode==='home_delivery' && row.status!=='shipped')
      transitionError('INVALID_DELIVERY','Home delivery must be shipped before delivered');
    if (order.deliveryMode==='workshop_pickup' && row.status!=='ready')
      transitionError('INVALID_DELIVERY','Pickup must be ready before delivered');
    if (order.deliveryMode==='workshop_pickup' && body?.balanceCollectedAtPickup!==true)
      transitionError('BALANCE_CONFIRMATION_REQUIRED','Confirm collection of remaining balance at pickup');
  }
  if (next==='shipped') {
    if (order.deliveryMode!=='home_delivery')
      transitionError('INVALID_DELIVERY','Workshop pickup cannot be marked shipped');
    const paid=await env.DB.prepare(`SELECT COALESCE(SUM(amount_minor),0) AS amount
      FROM zc_manual_payments WHERE quote_id=? AND status='verified' AND currency=?`)
      .bind(row.quote_id,order.totals.currency).first();
    if (Number(paid.amount)<Number(order.totals.totalMinor))
      transitionError('BALANCE_NOT_VERIFIED','Full payment including shipping must be verified before dispatch');
  }
  const now=new Date().toISOString();
  const updated={...order,status:next,updatedAt:now,history:[...(order.history||[]),{status:next,at:now}]};
  const statement=env.DB.prepare(`UPDATE zc_social_orders SET status=?,updated_at=?,order_json=?
    WHERE id=? AND status=?`).bind(next,now,JSON.stringify(updated),orderId,row.status);
  const event=env.DB.prepare(`INSERT INTO zc_events(id,request_id,quote_id,event_type,actor,payload_json,created_at)
    SELECT ?,?,?,?, ?, ?, ? WHERE EXISTS
    (SELECT 1 FROM zc_social_orders WHERE id=? AND status=? AND updated_at=?)`)
    .bind('EVT-'+crypto.randomUUID(),row.request_id,row.quote_id,'order.status_changed',actor,
      JSON.stringify({orderId,from:row.status,to:next}),now,orderId,next,now);
  const result=await env.DB.batch([statement,event]);
  if(result[0].meta?.changes!==1)
    transitionError('ORDER_CHANGED','Order changed. Refresh and retry');
  return json({orderId,status:next,updatedAt:now});
}
