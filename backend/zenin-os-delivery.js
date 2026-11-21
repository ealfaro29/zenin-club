// Authenticated social delivery intake; no Correos label purchase.
const error=(code,message,status=400)=>{const e=new Error(message);e.code=code;e.status=status;throw e;};
const response=(data)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const required=(v,name,max=180)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)error('INVALID_DELIVERY',name+' required');return v.trim();};
export async function saveZcDelivery(env,body,actor) {
  const requestId=required(body?.requestId,'requestId',100);
  const mode=body?.deliveryMode;
  if(!['workshop_pickup','home_delivery'].includes(mode))error('INVALID_DELIVERY','Invalid delivery mode');
  const req=await env.DB.prepare('SELECT id,status FROM zc_requests WHERE id=?').bind(requestId).first();
  if(!req)error('REQUEST_NOT_FOUND','Request not found',404);
  if(['converted','cancelled'].includes(req.status))error('DELIVERY_LOCKED','Delivery cannot change after order conversion',409);
  const existing=await env.DB.prepare('SELECT id FROM zc_shipping_profiles WHERE request_id=?').bind(requestId).first();
  const name=mode==='home_delivery'?required(body.recipientName,'recipientName'):null;
  const phone=mode==='home_delivery'?required(body.recipientPhone,'recipientPhone',60):null;
  const province=mode==='home_delivery'?required(body.province,'province'):null;
  const canton=mode==='home_delivery'?required(body.canton,'canton'):null;
  const district=mode==='home_delivery'?required(body.district,'district'):null;
  const address=mode==='home_delivery'?required(body.addressLine1,'addressLine1',500):null;
  const confirmed=mode==='workshop_pickup'||body?.addressConfirmed===true;
  const now=new Date().toISOString(),id=existing?.id||'SHP-'+crypto.randomUUID();
  const stmt=existing
    ?env.DB.prepare(`UPDATE zc_shipping_profiles SET delivery_mode=?,recipient_name=?,recipient_phone=?,province=?,canton=?,district=?,address_line1=?,status=?,confirmed_at=?,updated_at=?
      WHERE request_id=? AND NOT EXISTS(SELECT 1 FROM zc_social_orders WHERE request_id=?)`)
      .bind(mode,name,phone,province,canton,district,address,confirmed?'confirmed':'incomplete',confirmed?now:null,now,requestId,requestId)
    :env.DB.prepare(`INSERT INTO zc_shipping_profiles(id,request_id,delivery_mode,recipient_name,recipient_phone,province,canton,district,address_line1,status,confirmed_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM zc_social_orders WHERE request_id=?)`)
      .bind(id,requestId,mode,name,phone,province,canton,district,address,confirmed?'confirmed':'incomplete',confirmed?now:null,now,now,requestId);
  const result=await stmt.run();
  if(result.meta?.changes!==1)error('DELIVERY_LOCKED','Delivery is locked',409);
  await env.DB.prepare(`INSERT INTO zc_events(id,request_id,event_type,actor,payload_json,created_at)
    VALUES(?,?,?,?,?,?)`).bind('EVT-'+crypto.randomUUID(),requestId,'delivery.updated',actor,JSON.stringify({mode,confirmed}),now).run();
  return response({requestId,deliveryMode:mode,status:confirmed?'confirmed':'incomplete'});
}
