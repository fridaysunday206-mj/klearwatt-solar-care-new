
// Tiny fake Paystack used ONLY by the automated tests.
const http = require('node:http');
const tx = new Map(); let planN = 0;
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    const j = b ? JSON.parse(b) : {}; const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x');
    if (!u.pathname.startsWith('/_') && !new RegExp('^Bearer sk' + '_' + 'test' + '_').test(req.headers.authorization || '')) return send(401, { status: false, message: 'Invalid key' });
    if (u.pathname === '/transaction/initialize') { tx.set(j.reference, { reference: j.reference, status: 'abandoned', amount: j.amount, currency: j.currency, id: 1000 + tx.size, body: j }); return send(200, { status: true, data: { authorization_url: 'https://checkout.paystack.test/' + j.reference, reference: j.reference } }); }
    if (u.pathname.startsWith('/transaction/verify/')) { const t = tx.get(decodeURIComponent(u.pathname.split('/').pop())); return t ? send(200, { status: true, data: { reference: t.reference, status: t.status, amount: t.amount, currency: t.currency, id: t.id } }) : send(404, { status: false, message: 'Transaction not found' }); }
    if (u.pathname === '/plan') return send(200, { status: true, data: { plan_code: 'PLN_test' + (++planN), amount: j.amount } });
    if (u.pathname === '/_set') { tx.set(j.reference, { ...(tx.get(j.reference) || { reference: j.reference, id: 5000 + tx.size, currency: 'NGN' }), ...j.set }); return send(200, { ok: 1 }); }
    if (u.pathname === '/_get') return send(200, tx.get(u.searchParams.get('reference')) || {});
    send(404, { status: false, message: 'nope' });
  });
}).listen(+process.env.MOCK_PORT || 4556);
                                                                         
