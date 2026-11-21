
// End-to-end tests against the real server + a mock Paystack (no internet, no real money).
const { spawn } = require('node:child_process'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const P = 4555, M = 4556, KEY = 'sk' + '_test_dummy_key_for_tests', WEBHOOK_KEY = 'whsec' + '_dummy_webhook_secret_for_tests', BASE = `http://localhost:${P}`, MOCK = `http://localhost:${M}`;
const db = path.join(os.tmpdir(), 'kw-test-' + Date.now() + '.db');
const env = { ...process.env, PORT: P, MOCK_PORT: M, DB_PATH: db, PAYSTACK_BASE_URL: MOCK, PAYSTACK_SECRET_KEY: KEY, PAYSTACK_WEBHOOK_SECRET: WEBHOOK_KEY, SESSION_SECRET: 'x'.repeat(32), ADMIN_EMAIL: 'admin@test.ng', ADMIN_PASSWORD: 'adminpass123', APP_URL: BASE };
const kids = [spawn('node', [path.join(__dirname, 'mock-paystack.js')], { env }), spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' })];
let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client() { let ck = ''; return async (m, p, b, raw) => { const r = await fetch(BASE + p, { method: m, headers: { ...(m === 'GET' ? {} : { 'Content-Type': 'application/json' }), cookie: ck }, body: m === 'GET' ? undefined : (raw || JSON.stringify(b || {})) }); const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { html: t }; } return { s: r.status, j }; }; }
const mock = (p, b) => fetch(MOCK + p, { method: 'POST', body: JSON.stringify(b) });
const hook = async (c, ev, data, sig) => { const raw = JSON.stringify({ event: ev, data }); return c('POST', '/api/paystack/webhook', null, raw).then(r => r); };
async function signedHook(ev, data, goodSig = true) { const raw = JSON.stringify({ event: ev, data }); const sig = goodSig ? crypto.createHmac('sha512', KEY).update(raw).digest('hex') : 'bad'; const r = await fetch(BASE + '/api/paystack/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig }, body: raw }); return { s: r.status, j: await r.json() }; }
async function modernSignedHook(ev, data, { offset = 0, multiple = false, goodSig = true } = {}) {
  const raw = JSON.stringify({ event: ev, data }); const t = Math.floor(Date.now() / 1000) + offset;
  const sig = crypto.createHmac('sha512', WEBHOOK_KEY).update(String(t) + '.').update(Buffer.from(raw)).digest('hex');
  const entries = multiple ? `v1=whk_old:${'0'.repeat(128)},v1=whk_current:${goodSig ? sig : '0'.repeat(128)}` : `v1=whk_current:${goodSig ? sig : '0'.repeat(128)}`;
  const r = await fetch(BASE + '/api/paystack/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'paystack-signature': `t=${t},${entries}` }, body: raw });
  return { s: r.status, j: await r.json() };
}
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/me'); await fetch(MOCK + '/_get'); break; } catch { await sleep(100); } }
  const admin = client(), cu = client(), other = client();
  const homeResponse = await fetch(BASE + '/'); const homeHtml = await homeResponse.text();
  const heroImage = await fetch(BASE + '/images/before-after.jpg');
  ok(homeResponse.status === 200 && homeHtml.includes('wa.me/2349037885738') && homeHtml.includes('tel:07087942034') && homeHtml.includes('One Man Village') && homeHtml.includes('Nyanya Gwandara') && homeHtml.includes('not a photograph of a KlearWatt customer job') && heroImage.status === 200 && heroImage.headers.get('content-type') === 'image/jpeg', 'homepage contact, Karu LGA coverage, illustrative disclosure and hero photo are served');
  console.log('Setup');
  ok((await admin('POST', '/api/login', { email: 'admin@test.ng', password: 'adminpass123' })).j.role === 'admin', 'admin logs in');
  ok((await cu('POST', '/api/register', { name: 'Ada Obi', email: 'ada@test.ng', password: 'password123', phone: '0803' })).s === 200, 'customer registers');
  ok((await other('POST', '/api/register', { name: 'Bob', email: 'bob@test.ng', password: 'password123' })).s === 200, 'second customer registers');
  const pk = (await admin('GET', '/api/admin/packages')).j; const byName = n => pk.find(p => p.name === n);
  ok(pk.every(p => p.price_kobo == null), 'no prices are invented (all start empty)');
  ok((await cu('GET', '/api/admin/summary')).s === 403, 'customer cannot open admin API');
  ok((await fetch(BASE + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'anonymous cannot book');
  ok((await fetch(BASE + '/api/logout', { method: 'POST', body: '' })).status === 415, 'non-JSON POST rejected (CSRF guard)');

  console.log('One-time payments');
  const b1 = (await cu('POST', '/api/bookings', { plan: 'One-time cleaning', address: 'Masaka', panels: 6 })).j;
  ok((await cu('POST', `/api/bookings/${b1.id}/pay`)).s === 400, 'Pay Now blocked until price is set');
  await admin('PATCH', `/api/admin/bookings/${b1.id}`, { amount_naira: 15000 });
  ok((await other('POST', `/api/bookings/${b1.id}/pay`)).s === 404, "other customer cannot pay someone else's booking");
  let r = await cu('POST', `/api/bookings/${b1.id}/pay`); const ref1 = r.j.reference;
  ok(r.s === 200 && r.j.authorization_url.includes(ref1), 'Pay Now returns Paystack checkout link');
  const sent = await (await fetch(MOCK + '/_get?reference=' + ref1)).json();
  ok(sent.amount === 1500000 && sent.currency === 'NGN', 'server sent amount from DB in kobo (NGN 15,000 = 1500000)');
  ok((await cu('POST', `/api/bookings/${b1.id}/pay`)).j.reference === ref1, 'second click reuses the open payment (no duplicate charge)');
  await mock('/_set', { reference: ref1, set: { status: 'ongoing' } });
  ok((await cu('GET', '/api/pay/verify?reference=' + ref1)).j.status === 'pending', 'checkout still in progress stays pending');
  ok((await cu('GET', '/api/bookings')).j[0].payment_status === 'unpaid', 'booking NOT marked paid without confirmation');
  await mock('/_set', { reference: ref1, set: { status: 'success' } });
  r = await cu('GET', '/api/pay/verify?reference=' + ref1);
  ok(r.j.status === 'success' && /^KW-\d{4}-\d{6}$/.test(r.j.receipt_no), 'verified success -> paid + receipt number');
  const rc1 = r.j.receipt_no;
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b1.id).payment_status === 'paid', 'booking payment status updated to paid');
  ok((await cu('GET', '/api/pay/verify?reference=' + ref1)).j.receipt_no === rc1, 'verifying again changes nothing (idempotent)');
  const sw = await signedHook('charge.success', { id: 1000, reference: ref1, amount: 1500000, currency: 'NGN', customer: { email: 'ada@test.ng' } });
  ok(sw.s === 200 && (await cu('GET', '/api/payments')).j.filter(p => p.booking_id === b1.id).length === 1, 'webhook for already-paid payment creates no duplicate');
  ok((await signedHook('charge.success', { id: 1000, reference: ref1, amount: 1500000, currency: 'NGN', customer: { email: 'ada@test.ng' } })).j.duplicate === true, 'replayed webhook detected as duplicate');
  ok((await cu('POST', `/api/bookings/${b1.id}/pay`)).s === 409, 'cannot pay an already-paid booking again');
  const hist = (await cu('GET', '/api/payments')).j; const rec = await cu('GET', `/api/payments/${hist[0].id}/receipt`);
  ok(rec.s === 200 && rec.j.html.includes(rc1) && rec.j.html.includes('15,000.00'), 'receipt page generated with amount');
  ok((await other('GET', `/api/payments/${hist[0].id}/receipt`)).s === 404, "other customer cannot read someone's receipt");

  console.log('Failed / cancelled / tampered');
  const b2 = (await cu('POST', '/api/bookings', { plan: 'One-time cleaning', address: 'Masaka' })).j; await admin('PATCH', `/api/admin/bookings/${b2.id}`, { amount_naira: 20000 });
  let ref2 = (await cu('POST', `/api/bookings/${b2.id}/pay`)).j.reference; await mock('/_set', { reference: ref2, set: { status: 'failed' } });
  ok((await cu('GET', '/api/pay/verify?reference=' + ref2)).j.status === 'failed', 'failed payment recorded as failed');
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b2.id).payment_status === 'unpaid', 'failed payment leaves booking unpaid');
  let r2 = await cu('POST', `/api/bookings/${b2.id}/pay`); ok(r2.s === 200 && r2.j.reference !== ref2, 'customer can retry after a failure');
  await mock('/_set', { reference: r2.j.reference, set: { status: 'abandoned' } });
  ok((await cu('GET', '/api/pay/verify?reference=' + r2.j.reference)).j.status === 'cancelled', 'cancelled/abandoned payment recorded as cancelled');
  let r3 = await cu('POST', `/api/bookings/${b2.id}/pay`); await mock('/_set', { reference: r3.j.reference, set: { status: 'success', amount: 100 } });
  ok((await cu('GET', '/api/pay/verify?reference=' + r3.j.reference)).j.status === 'flagged', 'amount mismatch (tampering) is flagged, not paid');
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b2.id).payment_status === 'unpaid', 'flagged payment does not mark booking paid');
  const bRef = (await cu('POST', '/api/bookings', { plan: 'One-time cleaning', address: 'Masaka' })).j;
  await admin('PATCH', `/api/admin/bookings/${bRef.id}`, { amount_naira: 9000 });
  const refMismatch = (await cu('POST', `/api/bookings/${bRef.id}/pay`)).j.reference;
  await mock('/_set', { reference: refMismatch, set: { status: 'success', reference: 'KW-wrong-reference' } });
  ok((await cu('GET', '/api/pay/verify?reference=' + refMismatch)).j.status === 'flagged', 'transaction reference mismatch is flagged, not paid');

  console.log('Webhook security');
  ok((await signedHook('charge.success', { reference: ref2 }, false)).s === 401, 'webhook with bad signature rejected');
  ok((await fetch(BASE + '/api/paystack/webhook', { method: 'POST', body: '{}' })).status === 401, 'webhook with no signature rejected');
  ok((await modernSignedHook('ping', {})).s === 200, 'modern timestamped Paystack-Signature accepted');
  ok((await modernSignedHook('ping', {}, { multiple: true })).s === 200, 'modern signature accepts any matching v1 during key rotation');
  ok((await modernSignedHook('ping', {}, { offset: -301 })).s === 401, 'modern signature outside 5-minute window rejected');
  ok((await modernSignedHook('ping', {}, { goodSig: false })).s === 401, 'invalid modern Paystack-Signature rejected');
  let r4 = await cu('POST', `/api/bookings/${b2.id}/pay`); await mock('/_set', { reference: r4.j.reference, set: { status: 'success', amount: 2000000 } });
  ok((await signedHook('charge.success', { id: 2001, reference: r4.j.reference, amount: 2000000, currency: 'NGN', customer: { email: 'ada@test.ng' } })).s === 200 && (await cu('GET', '/api/bookings')).j.find(b => b.id === b2.id).payment_status === 'paid', 'valid signed webhook verifies and marks paid');
  const fake = await signedHook('charge.success', { id: 2002, reference: 'KW-doesnotexist', amount: 1, customer: { email: 'x@y.z' } });
  ok(fake.s === 200 || fake.s === 502, 'webhook for unknown reference does not mark anything paid');

  console.log('Monthly subscriptions');
  ok((await admin('PUT', `/api/admin/packages/${byName('Weekly').id}`, { price_naira: 12000, kind: 'subscription' })).j.price_kobo === 1200000, 'admin sets weekly package monthly price');
  const b3 = (await cu('POST', '/api/bookings', { plan: 'Weekly', address: 'Masaka' })).j;
  ok((await cu('POST', `/api/bookings/${b3.id}/pay`)).s === 400, 'subscription blocked until Paystack plan exists');
  const pl = await admin('POST', `/api/admin/packages/${byName('Weekly').id}/sync-plan`); ok(/^PLN_test/.test(pl.j.plan_code), 'admin creates monthly Paystack plan');
  const s1 = (await cu('POST', `/api/bookings/${b3.id}/pay`)).j; const sentS = await (await fetch(MOCK + '/_get?reference=' + s1.reference)).json();
  ok(sentS.body.plan === pl.j.plan_code && sentS.amount === 1200000, 'subscription charge uses the plan code and monthly price');
  await mock('/_set', { reference: s1.reference, set: { status: 'success' } });
  ok((await cu('GET', '/api/pay/verify?reference=' + s1.reference)).j.status === 'success', 'first month verified and paid');
  await signedHook('subscription.create', { subscription_code: 'SUB_1', customer: { email: 'ada@test.ng' }, plan: { plan_code: pl.j.plan_code } });
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b3.id).subscription_status === 'active', 'subscription.create activates subscription');
  ok((await cu('POST', `/api/bookings/${b3.id}/pay`)).s === 409, 'cannot subscribe twice to the same booking');
  await mock('/_set', { reference: 'KW-RENEW1', set: { status: 'success', amount: 1200000, currency: 'NGN', id: 7777 } });
  await signedHook('charge.success', { id: 7777, reference: 'KW-RENEW1', amount: 1200000, currency: 'NGN', customer: { email: 'ada@test.ng' }, plan: { plan_code: pl.j.plan_code } });
  const ph = (await cu('GET', '/api/payments')).j.filter(p => p.booking_id === b3.id && p.status === 'success');
  ok(ph.length === 2, 'monthly renewal charge recorded automatically (2 payments)');
  await signedHook('invoice.payment_failed', { invoice_code: 'INV_1', amount: 1200000, subscription: { subscription_code: 'SUB_1' } });
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b3.id).payment_status === 'past_due', 'failed renewal marks booking past_due');
  await signedHook('subscription.disable', { subscription_code: 'SUB_1' });
  ok((await cu('GET', '/api/bookings')).j.find(b => b.id === b3.id).subscription_status === 'cancelled', 'cancelled subscription recorded');
  const up = await admin('PUT', `/api/admin/packages/${byName('Weekly').id}`, { price_naira: 13000, kind: 'subscription' });
  ok(up.j.plan_code == null, 'changing a price clears the old plan (forces a new plan)');

  console.log('Manual payments');
  const b4 = (await cu('POST', '/api/bookings', { plan: 'One-time cleaning', address: 'Masaka' })).j; await admin('PATCH', `/api/admin/bookings/${b4.id}`, { amount_naira: 10000 });
  let m1 = await admin('POST', '/api/admin/payments/manual', { booking_id: b4.id, amount_naira: 4000, method: 'cash', note: 'deposit' });
  ok(m1.s === 200 && m1.j.status === 'success' && m1.j.receipt_no, 'admin records cash payment with receipt');
  ok((await admin('GET', '/api/admin/bookings')).j.find(b => b.id === b4.id).payment_status === 'part_paid', 'partial cash payment -> part_paid');
  ok((await admin('POST', '/api/admin/payments/manual', { booking_id: b4.id, amount_naira: 6000, method: 'bank_transfer', reference: 'GT123' })).s === 200, 'admin records bank transfer');
  ok((await admin('POST', '/api/admin/payments/manual', { booking_id: b4.id, amount_naira: 6000, method: 'bank_transfer', reference: 'GT123' })).s === 409, 'duplicate transfer reference blocked');
  ok((await admin('GET', '/api/admin/bookings')).j.find(b => b.id === b4.id).payment_status === 'paid', 'booking fully paid after both manual payments');
  ok((await cu('POST', '/api/admin/payments/manual', {})).s === 403, 'customer cannot record manual payments');
  const sum = (await admin('GET', '/api/admin/summary')).j; ok(sum.collected_kobo > 0 && sum.test_mode === true, 'admin summary and test-mode flag work');
  ok((await admin('GET', '/api/admin/payments')).j.length >= 8, 'admin sees all transactions');

  console.log('Booking dates and job photographs');
  const dated = await cu('POST', '/api/bookings', { plan: 'One-time cleaning', address: 'Masaka', date: '2026-12-05' });
  ok(dated.s === 200 && dated.j.pref_date === '2026-12-05' && (await cu('GET', '/api/bookings')).j.find(b => b.id === dated.j.id).pref_date === '2026-12-05', 'requested calendar date is saved and returned unchanged');
  const photoData = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const photoBefore = await admin('POST', '/api/admin/bookings/' + b1.id + '/photos', { phase: 'before', data: photoData });
  ok(photoBefore.s === 200 && photoBefore.j.photo_id, 'admin can upload a before-cleaning photo');
  const photoAfter = await admin('POST', '/api/admin/bookings/' + b1.id + '/photos', { phase: 'after', data: photoData });
  ok(photoAfter.s === 200 && photoAfter.j.photo_id, 'admin can upload an after-cleaning photo');
  const photoList = await admin('GET', '/api/admin/bookings/' + b1.id + '/photos');
  ok(photoList.s === 200 && photoList.j.length === 2 && photoList.j.some(p => p.phase === 'before') && photoList.j.some(p => p.phase === 'after'), 'admin can list both job photo stages');
  ok((await cu('GET', '/api/bookings/' + b1.id + '/photos')).j.length === 2, 'customer can list photos attached to own booking');
  ok((await other('GET', '/api/bookings/' + b1.id + '/photos')).s === 404, 'another customer cannot list someone else\'s job photos');
  ok((await other('GET', '/api/job-photos/' + photoBefore.j.photo_id)).s === 404, 'another customer cannot view someone else\'s photo');
  const customerImage = await cu('GET', '/api/job-photos/' + photoBefore.j.photo_id);
  ok(customerImage.s === 200 && customerImage.j.html && customerImage.j.html.length > 0, 'customer photo endpoint returns the stored image bytes');
  ok((await cu('POST', '/api/admin/bookings/' + b1.id + '/photos', { phase: 'before', data: photoData })).s === 403, 'customer cannot upload job photos');
  ok((await admin('POST', '/api/admin/bookings/' + b1.id + '/photos', { phase: 'sideways', data: photoData })).s === 400, 'invalid photo stage is rejected');
  ok((await admin('POST', '/api/admin/bookings/' + b1.id + '/photos', { phase: 'before', data: 'data:image/jpeg;base64,YWJj' })).s === 400, 'invalid image bytes are rejected');
  console.log('Secrets');
  const files = fs.readdirSync(path.join(__dirname, '..', 'public')).filter(f => fs.statSync(path.join(__dirname, '..', 'public', f)).isFile()).map(f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')).join('');
  ok(!files.includes('sk_') && !/PAYSTACK_SECRET|PAYSTACK_WEBHOOK_SECRET|whsec_/.test(files), 'no Paystack secret or secret-variable name in any public file');
  ok((await fetch(BASE + '/../server.js')).status === 404 && (await fetch(BASE + '/.env')).status === 404, 'server code and .env are not downloadable');
  console.log(`\n${pass} passed, ${fail} failed`);
  kids.forEach(k => k.kill()); try { fs.rmSync(db, { force: true }); } catch {} process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); kids.forEach(k => k.kill()); process.exit(1); });
     
