async function api(path, method = 'GET', body) {
  const r = await fetch(path, { method, headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong'), { status: r.status });
  return j;
}
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = k => k == null ? '-' : '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
const when = t => t ? new Date(t).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '-';
const pill = s => `<span class="pill ${/fail|flag|cancel|past/.test(s) ? 'bad' : /pending|part|unpaid|requested/.test(s) ? 'warn' : ''}">${esc(String(s).replace('_', ' '))}</span>`;
function show(id, text, kind) { const e = $(id); e.className = 'msg ' + (kind || ''); e.textContent = text; e.classList.toggle('hidden', !text); }
