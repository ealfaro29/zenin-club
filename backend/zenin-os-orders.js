// ZENIN CLUB OS: isolated admin-only social-sales order conversion.
// Not routed or deployed. Call only after admin session authorization.
// Manual verification is an explicit attestation of bank receipt, never proof-image OCR.
const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
const response = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type':'application/json; charset=utf-8'}});
const required = (v, name) => typeof v === 'string' && v.trim() ? v.trim() : fail(400,'INVALID_INPUT',name+' required');
const stamp = () => new Date().toISOString();
const uid = p => p + '-' + crypto.randomUUID();

export async function markZcQuoteSent(env, body, actor) {
  const quoteId = required(body?.quoteId, 'quoteId'), t = stamp();
  const result = await env.DB.prepare("UPDATE zc_quotes SET status='sent',updated_at=? WHERE id=? AND status='draft'").bind(t,quoteId).run();
  if (result.meta?.changes !== 1) fail(409,'INVALID_QUOTE_STATE','Only draft quotes can be marked sent');
  await env.DB.prepare("INSERT INTO zc_events(id,quote_id,event_type,actor,created_at) VALUES(?,?,'quote.sent',?,?)").bind(uid('EVT'),quoteId,actor,t).run();
  return response({quoteId,status:'sent'});
}

export async function acceptZcQuote(env, body, actor) {
  const quoteId = required(body?.quoteId, 'quoteId'), t = stamp();
  const quote = await env.DB.prepare(`SELECT q.id,q.status,r.channel FROM zc_quotes q JOIN zc_requests r ON r.id=q.request_id WHERE q.id=?`).bind(quoteId).first();
  if (!quote) fail(404,'QUOTE_NOT_FOUND','Quote not found');
  if (quote.status !== 'sent') fail(409,'INVALID_QUOTE_STATE','Only sent quotes may be accepted');
  if (quote.channel === 'web') fail(409,'WEB_PAYMENT_REQUIRED','Web quotes must use verified Tilopay checkout');
  const result = await env.DB.prepare("UPDATE zc_quotes SET status='accepted',accepted_at=?,updated_at=? WHERE id=? AND status='sent'").bind(t,t,quoteId).run();
  if (result.meta?.changes !== 1) fail(409,'CONFLICT','Quote state changed');
  await env.DB.prepare("INSERT INTO zc_events(id,quote_id,event_type,actor,created_at) VALUES(?,?,'quote.accepted',?,?)").bind(uid('EVT'),quoteId,actor,t).run();
  return response({quoteId,status:'accepted'});
}

export async function verifyZcManualPayment(env, body, actor) {
  const paymentId = required(body?.paymentId,'paymentId');
  const bankReference = required(body?.bankReference,'bankReference');
  if (bankReference.length > 120) fail(400,'INVALID_INPUT','Bank reference too long');
  if (body?.bankReceiptConfirmed !== true) fail(400,'BANK_CONFIRMATION_REQUIRED','Confirm funds in bank account, not only screenshot');
  const payment = await env.DB.prepare(`SELECT p.*,q.request_id,q.status AS quote_status,q.total_minor,q.deposit_required_minor,q.currency AS quote_currency,r.channel
    FROM zc_manual_payments p JOIN zc_quotes q ON q.id=p.quote_id JOIN zc_requests r ON r.id=q.request_id WHERE p.id=?`).bind(paymentId).first();
  if (!payment) fail(404,'PAYMENT_NOT_FOUND','Payment not found');
  if (payment.status !== 'under_review') fail(409,'INVALID_PAYMENT_STATE','Payment must be under review');
  if (payment.quote_status !== 'accepted' || payment.channel === 'web') fail(409,'INVALID_QUOTE_STATE','Accepted social quote required');
  if (payment.currency !== payment.quote_currency) fail(409,'CURRENCY_MISMATCH','Payment currency mismatch');
  const t=stamp();
  // Atomic conditional update and reference uniqueness prevent duplicate verification.
  const update = await env.DB.prepare(`UPDATE zc_manual_payments SET status='verified',bank_reference=?,verified_at=?,verified_by=?,updated_at=?
    WHERE id=? AND status='under_review' AND EXISTS(SELECT 1 FROM zc_quotes WHERE id=quote_id AND status='accepted')`)
    .bind(bankReference,t,actor,t,paymentId).run();
  if (update.meta?.changes !== 1) fail(409,'CONFLICT','Payment state changed');
  await env.DB.prepare("INSERT INTO zc_events(id,quote_id,event_type,actor,created_at) VALUES(?,?,'payment.verified',?,?)").bind(uid('EVT'),payment.quote_id,actor,t).run();
  // IMPORTANT: verification does not automatically create an order yet.
  // A separate atomic conversion routine must validate cumulative verified payments,
  // shipping mode, unique order creation and idempotency before assigning an official number.
  const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM zc_manual_payments WHERE quote_id=? AND status='verified'").bind(payment.quote_id).first();
  return response({paymentId,status:'verified',verifiedTotalMinor:paid.amount,depositRequiredMinor:payment.deposit_required_minor,readyForOrderConversion:paid.amount>=payment.deposit_required_minor});
}
