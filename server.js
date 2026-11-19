'use strict';
// KlearWatt Solar Care - website + Paystack payments. Zero npm dependencies. Needs Node 22.13+.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const E = k => process.env[k] || '';
const PORT = +E('PORT') || 3000, APP_URL = (E('APP_URL') || `http://localhost:${PORT}`).replace(/\/$/, '');
const PS_BASE = E('PAYSTACK_BASE_URL') || 'https://api.paystack.co';
const SECRET = E('SESSION_SECRET');
if (SECRET.length < 24) { console.error('Set SESSION_SECRET (24+ random characters) in .env'); process.exit(1); }
const PUB = path.join(__dirname, 'public');

// ---------- database ----------
const db = new DatabaseSync(E('DB_PATH') || path.join(__dirname, 'data.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT);
CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, frequency TEXT, price_kobo INTEGER, plan_code TEXT, plan_amount_kobo INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), package_id INTEGER NOT NULL REFERENCES packages(id), address TEXT, panels INTEGER, pref_date TEXT, access TEXT, notes TEXT, amount_kobo INTEGER, status TEXT NOT NULL DEFAULT 'requested', payment_status TEXT NOT NULL DEFAULT 'unpaid', plan_code TEXT, subscription_code TEXT, subscription_status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, reference TEXT UNIQUE NOT NULL, booking_id INTEGER REFERENCES bookings(id), user_id INTEGER REFERENCES users(id), amount_kobo INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, auth_url TEXT, receipt_no TEXT UNIQUE, note TEXT, gateway_id TEXT, paid_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS webhook_events(key TEXT PRIMARY KEY, type TEXT, received_at TEXT);
CREATE TABLE IF NOT EXISTS quote_requests(id INTEGER PRIMARY KEY, customer_type TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, organisation TEXT, site_type TEXT, panel_count INTEGER, mounting TEXT, access TEXT, address TEXT NOT NULL, frequency TEXT, preferred_date TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'new', quote_kobo INTEGER, created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS job_photos(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE, phase TEXT NOT NULL CHECK(phase IN ('before','after')), mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')), data BLOB NOT NULL, uploaded_at TEXT NOT NULL);`);
// Prices are NOT invented: they start empty and are set by the admin.
for (const [n, k, f] of [['Every two weeks', 'subscription', 'biweekly'], ['Weekly', 'subscription', 'weekly'], ['One-time cleaning', 'one_time', 'once']])
  db.prepare('INSERT OR IGNORE INTO packages(name,kind,frequency) VALUES(?,?,?)').run(n, k, f);
const now = () => new Date().toISOString();
const tx = f => { db.exec('BEGIN IMMEDIATE'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- auth helpers ----------
const hash = p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const check = (p, h) => { const [s, k] = h.split(':'); const a = crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), b = Buffer.from(k, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const sameStr = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mkCookie = uid => { const v = uid + '.' + (Date.now() + 7 * 864e5); return `kw=${v}.${sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${APP_URL.startsWith('https') ? '; Secure' : ''}`; };
const clearCookie = 'kw=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
function userFrom(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('kw='));
  if (!c) return null;
  const [uid, exp, sig] = c.slice(3).split('.');
  if (!sig || +exp < Date.now() || !sameStr(sig, sign(uid + '.' + exp))) return null;
  return db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(+uid) || null;
}
const hits = new Map();
function limit(req) { const ip = req.socket.remoteAddress, t = Date.now(); let h = hits.get(ip); if (!h || h.r < t) h = { n: 0, r: t + 9e5 }; if (++h.n > 20) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.'); hits.set(ip, h); }

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const toKobo = n => { const v = Math.round(Number(n) * 100); if (!Number.isFinite(v) || v <= 0 || v > 1e11) throw new HttpError(400, 'Enter a valid amount in naira'); return v; };
const str = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Paystack ----------
async function ps(method, p, body) {
  if (!E('PAYSTACK_SECRET_KEY')) throw new HttpError(503, 'Online payment is not set up yet. Please pay by cash or transfer, or contact us.');
  let r, j;
  try {
    r = await fetch(PS_BASE + p, { method, headers: { Authorization: 'Bearer ' + E('PAYSTACK_SECRET_KEY'), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    j = await r.json();
  } catch { throw new HttpError(502, 'Could not reach Paystack. Please try again.'); }
  if (!r.ok || j.status === false) throw new HttpError(502, 'Paystack: ' + (j.message || 'request failed'));
  return j.data;
}
const getPay = ref => db.prepare('SELECT * FROM payments WHERE reference=?').get(ref);
function markSuccess(ref, gwId) { // atomic + idempotent: only the first caller flips the payment
  return tx(() => {
    const p = getPay(ref);
    if (!p || p.status === 'success') return false;
    const t = now();
    db.prepare("UPDATE payments SET status='success',gateway_id=?,paid_at=?,receipt_no=? WHERE id=?").run(gwId == null ? null : String(gwId), t, `KW-${t.slice(0, 4)}-${String(p.id).padStart(6, '0')}`, p.id);
    if (p.booking_id) db.prepare("UPDATE bookings SET payment_status='paid',status=CASE WHEN status='requested' THEN 'confirmed' ELSE status END WHERE id=?").run(p.booking_id);
    return true;
  });
}
// Ask Paystack (server-to-server) what really happened. Only a verified success with matching amount/currency marks paid.
// final=true (customer returned / admin re-check): 'abandoned' means cancelled. final=false (double-click, webhook): an unpaid checkout may still be open, so never cancel it.
async function syncPayment(ref, final = true) {
  let p = getPay(ref);
  if (!p) return null;
  if (p.status === 'success' || p.method !== 'paystack') return p;
  const d = await ps('GET', '/transaction/verify/' + encodeURIComponent(ref));
  if (d.status === 'success') {
    if (d.reference !== ref || d.amount !== p.amount_kobo || d.currency !== 'NGN') db.prepare("UPDATE payments SET status='flagged',note=? WHERE reference=? AND status<>'success'").run(`Reference/amount/currency mismatch: expected ${ref}, ${p.amount_kobo} NGN, got ${d.reference}, ${d.amount} ${d.currency}`, ref);
    else markSuccess(ref, d.id);
  } else if (d.status === 'failed') db.prepare("UPDATE payments SET status='failed' WHERE reference=? AND status='pending'").run(ref);
  else if (d.status === 'abandoned' && final) db.prepare("UPDATE payments SET status='cancelled' WHERE reference=? AND status='pending'").run(ref);
  return getPay(ref);
}
function verifyModernPaystackSignature(raw, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(raw) || typeof header !== 'string' || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name === 't') {
      if (timestamp !== null || !/^\d+$/.test(value)) return false;
      timestamp = Number(value);
    } else if (name === 'v1') {
      const j = value.indexOf(':');
      if (j !== -1) signatures.push(value.slice(j + 1));
    }
  }
  if (timestamp === null || signatures.length === 0 || Math.abs(now - timestamp) > 300) return false;
  const expected = crypto.createHmac('sha512', secret).update(String(timestamp) + '.').update(raw).digest('hex');
  return signatures.some(sig => /^[0-9a-f]{128}$/.test(sig) && sameStr(sig, expected));
}
const payable = b => b.kind === 'subscription' ? b.price_kobo : b.amount_kobo;
function canPay(b) {
  const amt = payable(b);
  if (!amt || amt <= 0) return false;
  if (b.kind === 'subscription') return !!b.plan_code_pkg && b.subscription_status !== 'active';
  return b.payment_status !== 'paid';
}
const BK = `SELECT b.*, p.name plan, p.kind, p.frequency, p.price_kobo, p.plan_code plan_code_pkg FROM bookings b JOIN packages p ON p.id=b.package_id`;
const shapeBooking = b => ({ id: b.id, plan: b.plan, kind: b.kind, frequency: b.frequency, address: b.address, panels: b.panels, pref_date: b.pref_date, status: b.status, payment_status: b.payment_status, subscription_status: b.subscription_status, amount_kobo: payable(b) || null, can_pay: canPay(b), created_at: b.created_at });
const shapePay = p => ({ id: p.id, reference: p.reference, booking_id: p.booking_id, plan: p.plan, amount_kobo: p.amount_kobo, method: p.method, status: p.status, receipt_no: p.receipt_no, paid_at: p.paid_at, created_at: p.created_at, note: p.note });

// ---------- webhook event handling ----------
async function handleEvent(type, d) {
  const email = ((d.customer && d.customer.email) || '').toLowerCase();
  const planCode = d.plan && (d.plan.plan_code || (typeof d.plan === 'string' ? d.plan : null));
  const bookingFor = () => db.prepare('SELECT b.id,b.user_id FROM bookings b JOIN users u ON u.id=b.user_id WHERE u.email=? AND b.plan_code=? ORDER BY b.id DESC').get(email, planCode);
  if (type === 'charge.success') {
    if (!d.reference) return;
    if (!getPay(d.reference)) { // subscription renewal created by Paystack
      if (!planCode) return;
      const b = bookingFor(); if (!b) return;
      db.prepare("INSERT OR IGNORE INTO payments(reference,booking_id,user_id,amount_kobo,method,status,note,created_at) VALUES(?,?,?,?,'paystack','pending','Subscription renewal',?)").run(d.reference, b.id, b.user_id, d.amount, now());
    }
    await syncPayment(d.reference, false); // never trust the webhook body alone: re-verify with Paystack
  } else if (type === 'subscription.create') {
    const b = planCode && bookingFor();
    if (b) db.prepare("UPDATE bookings SET subscription_code=?,subscription_status='active' WHERE id=?").run(d.subscription_code, b.id);
  } else if (type === 'invoice.payment_failed') {
    const code = d.subscription && d.subscription.subscription_code;
    const b = code && db.prepare('SELECT id,user_id FROM bookings WHERE subscription_code=?').get(code);
    if (b) {
      db.prepare("UPDATE bookings SET payment_status='past_due' WHERE id=?").run(b.id);
      db.prepare("INSERT OR IGNORE INTO payments(reference,booking_id,user_id,amount_kobo,method,status,note,created_at) VALUES(?,?,?,?,'paystack','failed','Subscription renewal failed',?)").run('INV-' + (d.invoice_code || d.id || crypto.randomBytes(4).toString('hex')), b.id, b.user_id, d.amount || 0, now());
    }
  } else if (type === 'subscription.disable' || type === 'subscription.not_renew') {
    db.prepare("UPDATE bookings SET subscription_status='cancelled' WHERE subscription_code=?").run(d.subscription_code);
  }
}

// ---------- routes ----------
const routes = [];
const route = (m, pat, auth, fn, raw = false) => routes.push({ m, re: new RegExp('^' + pat.replace(/:\w+/g, '([^/]+)') + '$'), auth, fn, raw });
const pubUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

route('POST', '/api/register', null, c => {
  limit(c.req);
  const name = str(c.data.name, 80), email = str(c.data.email, 120).toLowerCase(), phone = str(c.data.phone, 30), pw = String(c.data.password || '');
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter your name and a valid email');
  if (pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'That email is already registered. Please log in.');
  const id = db.prepare('INSERT INTO users(name,email,phone,pass,created_at) VALUES(?,?,?,?,?)').run(name, email, phone, hash(pw), now()).lastInsertRowid;
  c.hdr['Set-Cookie'] = mkCookie(id);
  return pubUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
});
route('POST', '/api/login', null, c => {
  limit(c.req);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(str(c.data.email, 120).toLowerCase());
  if (!u || !check(String(c.data.password || ''), u.pass)) throw new HttpError(401, 'Wrong email or password');
  c.hdr['Set-Cookie'] = mkCookie(u.id);
  return pubUser(u);
});
route('POST', '/api/logout', null, c => { c.hdr['Set-Cookie'] = clearCookie; return {}; });
route('GET', '/api/me', null, c => c.u ? pubUser(c.u) : { guest: true });
route('GET', '/api/packages', null, () => db.prepare('SELECT name,kind,frequency,price_kobo FROM packages WHERE active=1').all());

// Public quotation enquiries are stored for the admin team; they are not bookings or payments.
route('POST', '/api/quote-requests', null, c => {
  limit(c.req);
  const d = c.data;
  const type = ['residential', 'commercial'].includes(d.customer_type) ? d.customer_type : null;
  const name = str(d.name, 80), phone = str(d.phone, 30), address = str(d.address, 240);
  if (!type || !name || !phone || !address) throw new HttpError(400, 'Choose residential or commercial and provide your name, phone and site address.');
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str(d.email, 120))) throw new HttpError(400, 'Enter a valid email address or leave it blank.');
  const count = d.panel_count === '' || d.panel_count == null ? null : Number(d.panel_count);
  if (count != null && (!Number.isInteger(count) || count < 1 || count > 10000000)) throw new HttpError(400, 'Enter a valid panel count.');
  const id = db.prepare(`INSERT INTO quote_requests(customer_type,name,phone,email,organisation,site_type,panel_count,mounting,access,address,frequency,preferred_date,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(type, name, phone, str(d.email, 120).toLowerCase(), str(d.organisation, 120), str(d.site_type, 100), count, str(d.mounting, 60), str(d.access, 60), address, str(d.frequency, 60), str(d.preferred_date, 20), str(d.notes, 1000), now(), now()).lastInsertRowid;
  return { ok: true, request_id: id, message: 'Your quotation request has been received. KlearWatt will contact you to discuss the details.' };
});

route('POST', '/api/bookings', 'user', c => {
  const pk = db.prepare('SELECT * FROM packages WHERE name=? AND active=1').get(str(c.data.plan));
  if (!pk) throw new HttpError(400, 'Choose a service option');
  const address = str(c.data.address, 200); if (!address) throw new HttpError(400, 'Address is required');
  const panels = Math.max(0, parseInt(c.data.panels, 10) || 0) || null;
  const amount = pk.kind === 'one_time' ? pk.price_kobo : null; // default from admin price if set; admin may quote per job
  const id = db.prepare('INSERT INTO bookings(user_id,package_id,address,panels,pref_date,access,notes,amount_kobo,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.u.id, pk.id, address, panels, str(c.data.date, 20), str(c.data.access, 40), str(c.data.notes, 600), amount, now()).lastInsertRowid;
  if (!c.u.phone && c.data.phone) db.prepare('UPDATE users SET phone=? WHERE id=?').run(str(c.data.phone, 30), c.u.id);
  return shapeBooking(db.prepare(BK + ' WHERE b.id=?').get(id));
});
route('GET', '/api/bookings', 'user', c => db.prepare(BK + ' WHERE b.user_id=? ORDER BY b.id DESC').all(c.u.id).map(shapeBooking));
route('GET', '/api/payments', 'user', c => db.prepare('SELECT y.*, p.name plan FROM payments y LEFT JOIN bookings b ON b.id=y.booking_id LEFT JOIN packages p ON p.id=b.package_id WHERE y.user_id=? AND y.status<>\'pending\' ORDER BY y.id DESC').all(c.u.id).map(shapePay));

// Pay Now: the amount is ALWAYS taken from the database, never from the browser.
route('POST', '/api/bookings/:id/pay', 'user', async c => {
  const b = db.prepare(BK + ' WHERE b.id=? AND b.user_id=?').get(+c.m[1], c.u.id);
  if (!b) throw new HttpError(404, 'Booking not found');
  if (b.kind === 'subscription' ? b.subscription_status === 'active' : b.payment_status === 'paid') throw new HttpError(409, b.kind === 'subscription' ? 'This subscription is already active.' : 'This booking is already paid.');
  const amount = payable(b);
  if (!amount) throw new HttpError(400, 'Your price has not been confirmed yet. We will send you a quote first.');
  if (b.kind === 'subscription' && !b.plan_code_pkg) throw new HttpError(400, 'This subscription is not ready for online payment yet. Please contact us.');
  const open = db.prepare("SELECT * FROM payments WHERE booking_id=? AND method='paystack' AND status='pending' AND auth_url IS NOT NULL AND created_at>? ORDER BY id DESC").get(b.id, new Date(Date.now() - 30 * 6e4).toISOString());
  if (open) { // do not create a second charge while one is open
    const fresh = await syncPayment(open.reference, false);
    if (fresh.status === 'success') throw new HttpError(409, 'This booking is already paid.');
    if (fresh.status === 'pending') return { authorization_url: fresh.auth_url, reference: fresh.reference, reused: true };
  }
  const ref = 'KW-' + crypto.randomBytes(9).toString('hex');
  db.prepare("INSERT INTO payments(reference,booking_id,user_id,amount_kobo,method,status,created_at) VALUES(?,?,?,?,'paystack','pending',?)").run(ref, b.id, c.u.id, amount, now());
  try {
    const body = { email: c.u.email, amount, currency: 'NGN', reference: ref, callback_url: APP_URL + '/account.html', metadata: { booking_id: b.id, user_id: c.u.id, cancel_action: APP_URL + '/account.html?reference=' + ref } };
    if (b.kind === 'subscription') { body.plan = b.plan_code_pkg; db.prepare('UPDATE bookings SET plan_code=? WHERE id=?').run(b.plan_code_pkg, b.id); }
    const d = await ps('POST', '/transaction/initialize', body);
    db.prepare('UPDATE payments SET auth_url=? WHERE reference=?').run(d.authorization_url, ref);
    return { authorization_url: d.authorization_url, reference: ref };
  } catch (e) { db.prepare("UPDATE payments SET status='failed',note=? WHERE reference=?").run('Could not start: ' + e.message, ref); throw e; }
});
route('GET', '/api/pay/verify', 'user', async c => {
  const p = getPay(str(c.q.get('reference'), 80));
  if (!p || (p.user_id !== c.u.id && c.u.role !== 'admin')) throw new HttpError(404, 'Payment not found');
  return shapePay(await syncPayment(p.reference));
});
route('GET', '/api/payments/:id/receipt', 'user', c => {
  const p = db.prepare('SELECT y.*, u.name cname, u.email cemail, u.phone cphone, p.name plan, b.address FROM payments y LEFT JOIN users u ON u.id=y.user_id LEFT JOIN bookings b ON b.id=y.booking_id LEFT JOIN packages p ON p.id=b.package_id WHERE y.id=?').get(+c.m[1]);
  if (!p || (p.user_id !== c.u.id && c.u.role !== 'admin') || p.status !== 'success') throw new HttpError(404, 'Receipt not available');
  const row = (k, v) => `<tr><td>${k}</td><td><b>${esc(v)}</b></td></tr>`;
  return { html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${esc(p.receipt_no)}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#17231f}h1{margin:0;color:#12372d}.t{color:#65736c}table{width:100%;border-collapse:collapse;margin:18px 0}td{padding:9px 4px;border-bottom:1px solid #e2e8df}td:first-child{color:#65736c;width:40%}.amt{font-size:1.6rem;margin:6px 0 0}button{padding:10px 16px;border:0;border-radius:8px;background:#12372d;color:#fff;font-weight:700}@media print{button{display:none}}</style><h1>KlearWatt Solar Care</h1><div class="t">Dust Off. Power On. · Karu LGA, Nasarawa State · WhatsApp: 09037885738 · Calls: 07087942034 · Email: fridaysunday206@gmail.com</div><h2>Payment receipt</h2><div class="amt">&#8358;${(p.amount_kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</div><table>${row('Receipt no.', p.receipt_no)}${row('Date paid', new Date(p.paid_at).toLocaleString('en-NG'))}${row('Customer', p.cname)}${row('Email', p.cemail)}${row('Service', p.plan || '-')}${row('Address', p.address || '-')}${row('Method', { paystack: 'Paystack (card/bank/USSD)', cash: 'Cash', bank_transfer: 'Bank transfer' }[p.method] || p.method)}${row('Reference', p.reference)}${row('Status', 'PAID')}</table><button onclick="print()">Print / Save as PDF</button>` };
});

route('POST', '/api/paystack/webhook', null, async c => {
  const key = E('PAYSTACK_SECRET_KEY');
  const legacySig = String(c.req.headers['x-paystack-signature'] || '');
  const legacyExpected = key ? crypto.createHmac('sha512', key).update(c.raw).digest('hex') : '';
  const legacyValid = !!key && /^[0-9a-f]{128}$/.test(legacySig) && sameStr(legacySig, legacyExpected);
  const modernValid = verifyModernPaystackSignature(c.raw, String(c.req.headers['paystack-signature'] || ''), E('PAYSTACK_WEBHOOK_SECRET'));
  if (!legacyValid && !modernValid) throw new HttpError(401, 'Invalid signature');
  let ev; try { ev = JSON.parse(c.raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
  const d = ev.data || {};
  const k = ev.event + ':' + (d.id || d.reference || d.subscription_code || d.invoice_code || crypto.createHash('sha256').update(c.raw).digest('hex'));
  if (db.prepare('INSERT OR IGNORE INTO webhook_events(key,type,received_at) VALUES(?,?,?)').run(k, ev.event, now()).changes === 0) return { ok: true, duplicate: true };
  try { await handleEvent(ev.event, d); } catch (e) { db.prepare('DELETE FROM webhook_events WHERE key=?').run(k); throw e; } // let Paystack retry
  return { ok: true };
}, true);

// ---------- admin ----------
route('GET', '/api/admin/summary', 'admin', () => ({
  collected_kobo: db.prepare("SELECT COALESCE(SUM(amount_kobo),0) s FROM payments WHERE status='success'").get().s,
  paid_count: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='success'").get().n,
  pending_count: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='pending'").get().n,
  flagged_count: db.prepare("SELECT COUNT(*) n FROM payments WHERE status='flagged'").get().n,
  bookings: db.prepare('SELECT COUNT(*) n FROM bookings').get().n, customers: db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,
  paystack_configured: !!E('PAYSTACK_SECRET_KEY'), test_mode: E('PAYSTACK_SECRET_KEY').startsWith('sk' + '_' + 'test' + '_'),
}));
route('GET', '/api/admin/packages', 'admin', () => db.prepare('SELECT * FROM packages ORDER BY id').all());
route('PUT', '/api/admin/packages/:id', 'admin', c => {
  const p = db.prepare('SELECT * FROM packages WHERE id=?').get(+c.m[1]); if (!p) throw new HttpError(404, 'Not found');
  const price = c.data.price_naira === '' || c.data.price_naira == null ? null : toKobo(c.data.price_naira);
  const kind = ['one_time', 'subscription'].includes(c.data.kind) ? c.data.kind : p.kind;
  const changed = price !== p.price_kobo || kind !== p.kind;
  db.prepare('UPDATE packages SET price_kobo=?,kind=?,active=?,plan_code=CASE WHEN ? THEN NULL ELSE plan_code END,plan_amount_kobo=CASE WHEN ? THEN NULL ELSE plan_amount_kobo END WHERE id=?').run(price, kind, c.data.active === false ? 0 : 1, changed ? 1 : 0, changed ? 1 : 0, p.id);
  return db.prepare('SELECT * FROM packages WHERE id=?').get(p.id);
});
route('POST', '/api/admin/packages/:id/sync-plan', 'admin', async c => { // creates the monthly Paystack plan for a subscription package
  const p = db.prepare('SELECT * FROM packages WHERE id=?').get(+c.m[1]);
  if (!p || p.kind !== 'subscription' || !p.price_kobo) throw new HttpError(400, 'Set a monthly price and make this package a subscription first');
  if (p.plan_code) return p;
  const d = await ps('POST', '/plan', { name: `KlearWatt - ${p.name} (monthly)`, amount: p.price_kobo, interval: 'monthly', currency: 'NGN' });
  db.prepare('UPDATE packages SET plan_code=?,plan_amount_kobo=? WHERE id=?').run(d.plan_code, p.price_kobo, p.id);
  return db.prepare('SELECT * FROM packages WHERE id=?').get(p.id);
});
route('GET', '/api/admin/bookings', 'admin', () => db.prepare(BK.replace('SELECT b.*,', 'SELECT u.name cname,u.phone cphone,u.email cemail,b.*,').replace('JOIN packages p', 'JOIN users u ON u.id=b.user_id JOIN packages p') + ' ORDER BY b.id DESC LIMIT 500').all().map(b => ({ ...shapeBooking(b), customer: b.cname, phone: b.cphone, email: b.cemail, quote_kobo: b.amount_kobo })));
route('GET', '/api/admin/quote-requests', 'admin', () => db.prepare('SELECT * FROM quote_requests ORDER BY id DESC LIMIT 500').all());
// Job photos are stored in SQLite so they follow the database onto its persistent Railway volume.
route('GET', '/api/admin/bookings/:id/photos', 'admin', c => {
  const id = +c.m[1];
  if (!db.prepare('SELECT 1 FROM bookings WHERE id=?').get(id)) throw new HttpError(404, 'Booking not found');
  return db.prepare('SELECT id,phase,mime,uploaded_at FROM job_photos WHERE booking_id=? ORDER BY id').all(id);
});
route('POST', '/api/admin/bookings/:id/photos', 'admin', c => {
  const id = +c.m[1];
  if (!db.prepare('SELECT 1 FROM bookings WHERE id=?').get(id)) throw new HttpError(404, 'Booking not found');
  const phase = c.data.phase;
  if (!['before','after'].includes(phase)) throw new HttpError(400, 'Choose before-cleaning or after-cleaning.');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(String(c.data.data || ''));
  if (!match) throw new HttpError(400, 'Choose a JPG, PNG or WebP image.');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 1800000) throw new HttpError(413, 'Photo is too large. Choose a smaller image.');
  const idPhoto = db.prepare('INSERT INTO job_photos(booking_id,phase,mime,data,uploaded_at) VALUES(?,?,?,?,?)').run(id, phase, match[1], data, now()).lastInsertRowid;
  return { ok: true, photo_id: idPhoto };
});
route('GET', '/api/admin/job-photos/:id', 'admin', c => {
  const p = db.prepare('SELECT mime,data FROM job_photos WHERE id=?').get(+c.m[1]);
  if (!p) throw new HttpError(404, 'Photo not found');
  return { image: p };
});
route('PATCH', '/api/admin/quote-requests/:id', 'admin', c => {
  const q = db.prepare('SELECT * FROM quote_requests WHERE id=?').get(+c.m[1]); if (!q) throw new HttpError(404, 'Quotation request not found');
  const allowed = ['new', 'reviewing', 'quoted', 'accepted', 'declined'];
  if (allowed.includes(c.data.status)) db.prepare('UPDATE quote_requests SET status=?,updated_at=? WHERE id=?').run(c.data.status, now(), q.id);
  if ('quote_naira' in c.data) db.prepare('UPDATE quote_requests SET quote_kobo=?,updated_at=? WHERE id=?').run(c.data.quote_naira === '' || c.data.quote_naira == null ? null : toKobo(c.data.quote_naira), now(), q.id);
  return db.prepare('SELECT * FROM quote_requests WHERE id=?').get(q.id);
});
route('PATCH', '/api/admin/bookings/:id', 'admin', c => {
  const b = db.prepare('SELECT id FROM bookings WHERE id=?').get(+c.m[1]); if (!b) throw new HttpError(404, 'Not found');
  if ('amount_naira' in c.data) db.prepare('UPDATE bookings SET amount_kobo=? WHERE id=?').run(c.data.amount_naira === '' || c.data.amount_naira == null ? null : toKobo(c.data.amount_naira), b.id);
  if (['requested', 'confirmed', 'completed', 'cancelled'].includes(c.data.status)) db.prepare('UPDATE bookings SET status=? WHERE id=?').run(c.data.status, b.id);
  return { ok: true };
});
route('GET', '/api/admin/payments', 'admin', () => db.prepare('SELECT y.*, u.name customer, u.email, p.name plan FROM payments y LEFT JOIN users u ON u.id=y.user_id LEFT JOIN bookings b ON b.id=y.booking_id LEFT JOIN packages p ON p.id=b.package_id ORDER BY y.id DESC LIMIT 500').all().map(p => ({ ...shapePay(p), customer: p.customer, email: p.email })));
route('POST', '/api/admin/payments/:ref/verify', 'admin', async c => shapePay(await syncPayment(c.m[1])));
route('POST', '/api/admin/payments/manual', 'admin', c => { // cash / bank transfer recorded by the admin
  const b = db.prepare(BK + ' WHERE b.id=?').get(+c.data.booking_id); if (!b) throw new HttpError(404, 'Booking not found');
  const method = c.data.method === 'cash' ? 'cash' : c.data.method === 'bank_transfer' ? 'bank_transfer' : null; if (!method) throw new HttpError(400, 'Choose cash or bank transfer');
  const amount = toKobo(c.data.amount_naira), tag = str(c.data.reference, 60).replace(/[^\w.-]/g, '');
  const ref = tag ? `${method === 'cash' ? 'CASH' : 'TRF'}-${tag}` : 'MAN-' + crypto.randomBytes(6).toString('hex');
  try { db.prepare("INSERT INTO payments(reference,booking_id,user_id,amount_kobo,method,status,note,created_at) VALUES(?,?,?,?,?,'pending',?,?)").run(ref, b.id, b.user_id, amount, method, str(c.data.note, 300), now()); }
  catch { throw new HttpError(409, 'A payment with that reference is already recorded (duplicate blocked).'); }
  markSuccess(ref, null);
  if (b.kind === 'one_time' && b.amount_kobo) { // partial payments keep the booking as part_paid
    const s = db.prepare("SELECT SUM(amount_kobo) s FROM payments WHERE booking_id=? AND status='success'").get(b.id).s;
    if (s < b.amount_kobo) db.prepare("UPDATE bookings SET payment_status='part_paid' WHERE id=?").run(b.id);
  }
  return shapePay(getPay(ref));
});

// ---------- server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon' };
const readBody = req => new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > 2.5e6) { no(new HttpError(413, 'Too large')); req.destroy(); } else ch.push(d); }); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no); });
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, APP_URL);
    if (url.pathname.startsWith('/api/')) {
      const r = routes.find(r => r.m === req.method && r.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const u = userFrom(req);
      if (r.auth && !u) throw new HttpError(401, 'Please log in');
      if (r.auth === 'admin' && u.role !== 'admin') throw new HttpError(403, 'Admin only');
      const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      let data = {};
      if (req.method !== 'GET' && !r.raw) { // JSON-only writes block cross-site form posts (CSRF)
        if (!/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON required');
        try { data = raw.length ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Bad JSON'); }
      }
      const hdr = {};
      const out = await r.fn({ req, u, m: url.pathname.match(r.re), q: url.searchParams, data, raw, hdr });
      if (out && out.html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(out.html); }
      if (out && out.image) { res.writeHead(200, { 'Content-Type': out.image.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(out.image.data); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...hdr }); return res.end(JSON.stringify(out || {}));
    }
    let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: code === 500 ? 'Server error' : e.message }));
  }
});
if (E('ADMIN_EMAIL') && E('ADMIN_PASSWORD') && !db.prepare('SELECT 1 FROM users WHERE email=?').get(E('ADMIN_EMAIL').toLowerCase()))
  db.prepare("INSERT INTO users(name,email,pass,role,created_at) VALUES('Admin',?,?,'admin',?)").run(E('ADMIN_EMAIL').toLowerCase(), hash(E('ADMIN_PASSWORD')), now());
server.listen(PORT, () => console.log(`KlearWatt running on ${APP_URL}  (Paystack: ${E('PAYSTACK_SECRET_KEY') ? (E('PAYSTACK_SECRET_KEY').startsWith('sk' + '_' + 'live' + '_') ? 'LIVE' : 'test') : 'NOT configured'})`));
