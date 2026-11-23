import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createZcRequest,createZcQuote,recordZcPaymentProof} from './zenin-os.js';
import {markZcQuoteSent,acceptZcQuote,verifyZcManualPayment} from './zenin-os-orders.js';
import {saveZcDelivery} from './zenin-os-delivery.js';
import {convertZcQuoteToOrder} from './zenin-os-conversion.js';
import {updateZcSocialOrderStatus,listZcSocialOrders} from './zenin-os-admin.js';

const migrationFiles=['0012_zenin_os_module_01.sql','0013_zenin_os_shipping.sql','0014_delivery_modes.sql','0015_lead_followups.sql','0016_single_followup.sql','0017_social_orders.sql','0018_social_order_delivery.sql'];
const ddl=await Promise.all(migrationFiles.map(p=>readFile(new URL('./migrations/'+p,import.meta.url),'utf8')));
const base=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
class Statement {
 constructor(db,sql,params=[]){this.db=db;this.sql=sql;this.params=params}
 bind(...params){return new Statement(this.db,this.sql,params)}
 async first(){return this.db.prepare(this.sql).get(...this.params)||null}
 async all(){return {results:this.db.prepare(this.sql).all(...this.params)}}
 async run(){return this.execute()}
 execute(){const result=this.db.prepare(this.sql).run(...this.params);return {meta:{changes:result.changes}}}
}
class DB {
 constructor(){this.database=new DatabaseSync(':memory:');this.database.exec(base);for(const sql of ddl)this.database.exec(sql)}
 prepare(sql){return new Statement(this.database,sql)}
 async batch(stmts){this.database.exec('BEGIN');try{const out=stmts.map(s=>s.execute());this.database.exec('COMMIT');return out}catch(e){this.database.exec('ROLLBACK');throw e}}
 close(){this.database.close()}
}
const body=async r=>r.json();
async function setup(deliveryMode='workshop_pickup'){
 const DBInstance=new DB();const env={DB:DBInstance,ADMIN_SESSION_SECRET:'test-secret-longer-than-32-characters-please'};
 const request=(await body(await createZcRequest(env,{channel:'instagram',customer:{name:'Prueba',phone:'88888888'},description:'Camiseta'},'tester'))).request;
 const shippingMinor=deliveryMode==='home_delivery'?250000:0;
 const quote=(await body(await createZcQuote(env,{requestId:request.id,currency:'CRC',items:[{description:'Camiseta',quantity:1,unitPriceMinor:1200000}],shippingMinor,deliveryMode},'tester'))).quote;
 await markZcQuoteSent(env,{quoteId:quote.id},'tester');
 await acceptZcQuote(env,{quoteId:quote.id},'tester');
 const delivery={requestId:request.id,deliveryMode,...(deliveryMode==='home_delivery'?{recipientName:'Prueba',recipientPhone:'88888888',province:'Heredia',canton:'Santa Bárbara',district:'San Pedro',addressLine1:'Dirección de prueba',addressConfirmed:true}:{})};
 await saveZcDelivery(env,delivery,'tester');
 return {env,request,quote,db:DBInstance};
}
async function pay(env,quoteId,amount,kind='deposit'){
 const payment=(await body(await recordZcPaymentProof(env,{quoteId,amountMinor:amount,kind},'tester'))).payment;
 await verifyZcManualPayment(env,{paymentId:payment.id,bankReference:'REF-'+crypto.randomUUID(),bankReceiptConfirmed:true},'tester');
}
async function rejectsCode(promise,code){await assert.rejects(promise,e=>e.code===code)}
test('social pickup: no order without verified deposit; delivery requires exact balance',async()=>{
 const {env,quote,db}=await setup();
 try{
  await rejectsCode(convertZcQuoteToOrder(env,{quoteId:quote.id},'tester'),'DEPOSIT_NOT_VERIFIED');
  await pay(env,quote.id,600000);
  const created=await body(await convertZcQuoteToOrder(env,{quoteId:quote.id},'tester'));
  assert.ok(created.orderId.startsWith('ZC-'));assert.ok(created.trackingToken);
  const repeated=await body(await convertZcQuoteToOrder(env,{quoteId:quote.id},'tester'));
  assert.equal(repeated.orderId,created.orderId);assert.equal(repeated.alreadyCreated,true);
  assert.equal(repeated.trackingToken,undefined);
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'preparing'},'tester');
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'ready'},'tester');
  await rejectsCode(updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'shipped'},'tester'),'INVALID_DELIVERY');
  await rejectsCode(updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'delivered',balanceCollectedAtPickup:true,collectedAtPickupMinor:100},'tester'),'BALANCE_CONFIRMATION_REQUIRED');
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'delivered',balanceCollectedAtPickup:true,collectedAtPickupMinor:600000},'tester');
  const listed=await body(await listZcSocialOrders(env,new URL('https://example.com/admin/zc/orders')));
  assert.equal(listed.orders[0].status,'delivered');
  assert.equal(db.database.prepare('SELECT COUNT(*) AS n FROM zc_social_orders').get().n,1);
 }finally{db.close()}
});
test('social delivery: cannot dispatch before verified full balance',async()=>{
 const {env,quote,db}=await setup('home_delivery');
 try{
  await pay(env,quote.id,600000);
  const created=await body(await convertZcQuoteToOrder(env,{quoteId:quote.id},'tester'));
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'preparing'},'tester');
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'ready'},'tester');
  await rejectsCode(updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'shipped'},'tester'),'BALANCE_NOT_VERIFIED');
  await pay(env,quote.id,850000,'balance');
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'shipped'},'tester');
  await updateZcSocialOrderStatus(env,{orderId:created.orderId,status:'delivered'},'tester');
  const listed=await body(await listZcSocialOrders(env,new URL('https://example.com/admin/zc/orders')));
  assert.equal(listed.orders[0].totals.remainingMinor,0);
 }finally{db.close()}
});
