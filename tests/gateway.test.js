// Integration tests: the real Cloudflare Functions code (middleware + gateway + share pages + image proxy)
// talking to the simulated Apps Script server. Only the network between them is replaced.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas-mock');

const GW = 'g'.repeat(40);
const PIN = 'correct-pin-123';
const ORIGIN = 'https://wafra.test';
const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';

let G, mods, driveCalls;
async function setup(envExtra) {
  G = loadGas({
    props: { GATEWAY_SECRET: GW, PIN },
    sheets: {
      'الخدمات': [['الاسم', 'المهنة', 'الهاتف', 'يخدم مناطق', 'ملاحظات', 'رابط الموقع', 'صورة'],
        ['أبو محمد', 'حداد', '99887766', '', '', '', 'https://drive.google.com/file/d/PUBLISHEDPHOTO1234567890/view']],
      'المناسبات': [['النوع', 'الاسم', 'العائلة', 'من تاريخ', 'إلى تاريخ', 'مكان الرجال', 'العنوان', 'وقت الرجال', 'مكان النساء', 'وقت النساء', 'الهاتف', 'رابط الموقع', 'ملاحظات', 'صورة', 'سبب', 'الدفن'],
        ['فرح', 'محمد سالم', 'آل سالم', '2026-11-29', '2026-11-29', 'صالة الوفرة', '', '', '', '', '', '', '', '', '', '']]
    }
  });
  driveCalls = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url === GAS_URL) return new Response(JSON.stringify(JSON.parse(G.api.doPost({ postData: { contents: init.body } }).t)));
    if (url.startsWith('https://drive.google.com/thumbnail')) { driveCalls.push(url); return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } }); }
    throw new Error('unexpected fetch ' + url);
  };
  mods = mods || {
    mw: await import('../functions/_middleware.js'),
    api: await import('../functions/api/[[route]].js'),
    img: await import('../functions/img.js'),
    e: await import('../functions/e/[id].js')
  };
  return Object.assign({ GAS_URL, GATEWAY_SECRET: GW }, envExtra || {});
}

async function call(env, path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('cookie', cookie);
  if (!h.has('cf-connecting-ip')) h.set('cf-connecting-ip', '1.1.1.1');
  const request = new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const url = new URL(request.url);
  const waits = [];
  const next = async () => {
    if (url.pathname.startsWith('/api/')) return mods.api.onRequest({ request, env, params: { route: url.pathname.slice(5).split('/') }, waitUntil: p => waits.push(p) });
    if (url.pathname === '/img') return mods.img.onRequestGet({ request, env, waitUntil: p => waits.push(p) });
    if (url.pathname.startsWith('/e/')) return mods.e.onRequestGet({ request, env, params: { id: decodeURIComponent(url.pathname.slice(3)) }, waitUntil: p => waits.push(p) });
    return new Response('static', { headers: { 'content-type': 'text/html' } });
  };
  const res = await mods.mw.onRequest({ request, env, next });
  await Promise.all(waits);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) {}
  return { res, text, json };
}
const write = (extra) => Object.assign({ 'x-wafra': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, extra || {});
async function loginCookie(env) {
  const r = await call(env, '/api/login', { method: 'POST', headers: write(), body: { pin: PIN } });
  return r.res.headers.get('set-cookie').split(';')[0];
}

test('login sets a HttpOnly, Secure, SameSite=Strict host cookie; no token in the body', async () => {
  const env = await setup();
  const r = await call(env, '/api/login', { method: 'POST', headers: write(), body: { pin: PIN } });
  assert.equal(r.res.status, 200);
  const c = r.res.headers.get('set-cookie');
  assert.match(c, /^__Host-wafra_s=[0-9a-f]{64};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag);
  assert.ok(!/Domain=/i.test(c));
  assert.ok(!r.text.includes(c.split(';')[0].split('=')[1]), 'token must not be readable by page scripts');
});

test('wrong PIN gets 401 and no cookie; repeated failures from one address get 429', async () => {
  const env = await setup();
  const bad = await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '6.6.6.6' }), body: { pin: 'x' } });
  assert.equal(bad.res.status, 401); assert.equal(bad.res.headers.get('set-cookie'), null);
  for (let i = 0; i < 6; i++) await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '6.6.6.6' }), body: { pin: 'x' } });
  const w = await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '6.6.6.6' }), body: { pin: PIN } });
  assert.equal(w.res.status, 429); assert.ok(Number(w.res.headers.get('retry-after')) > 0);
  const ok = await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '1.1.1.1' }), body: { pin: PIN } });
  assert.equal(ok.res.status, 200, 'another address is not affected');
});

test('a forged X-Forwarded-For does not change the rate-limit identity', async () => {
  const env = await setup();
  for (let i = 0; i < 7; i++) await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '10.0.0.' + i }), body: { pin: 'x' } });
  const w = await call(env, '/api/login', { method: 'POST', headers: write({ 'cf-connecting-ip': '7.7.7.7', 'x-forwarded-for': '10.9.9.9' }), body: { pin: PIN } });
  assert.equal(w.res.status, 429);
});

test('CSRF: writes without the custom header, from another origin, or cross-site are refused', async () => {
  const env = await setup();
  const cookie = await loginCookie(env);
  const body = { action: 'append', sheet: 'services', row: ['x', 'سباك', '90000000'] };
  const noHeader = await call(env, '/api/admin', { method: 'POST', cookie, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body });
  assert.equal(noHeader.res.status, 403);
  const evil = await call(env, '/api/admin', { method: 'POST', cookie, headers: write({ origin: 'https://evil.example' }), body });
  assert.equal(evil.res.status, 403);
  const cross = await call(env, '/api/admin', { method: 'POST', cookie, headers: write({ 'sec-fetch-site': 'cross-site' }), body });
  assert.equal(cross.res.status, 403);
  const get = await call(env, '/api/admin', { method: 'GET', cookie });
  assert.equal(get.res.status, 403);
  assert.equal(G.sheets['الخدمات'].d.length, 2, 'nothing was written');
});

test('admin actions need the session cookie and work with it', async () => {
  const env = await setup();
  const none = await call(env, '/api/admin', { method: 'POST', headers: write(), body: { action: 'data' } });
  assert.equal(none.res.status, 401);
  const forged = await call(env, '/api/admin', { method: 'POST', cookie: '__Host-wafra_s=' + 'a'.repeat(64), headers: write(), body: { action: 'data' } });
  assert.equal(forged.res.status, 401);
  const cookie = await loginCookie(env);
  const ok = await call(env, '/api/admin', { method: 'POST', cookie, headers: write(), body: { action: 'append', sheet: 'services', row: ['أبو سالم', 'سباك', '90000001'] } });
  assert.equal(ok.json.ok, true);
  assert.equal(G.sheets['الخدمات'].d.at(-1)[0], 'أبو سالم');
  const unknown = await call(env, '/api/admin', { method: 'POST', cookie, headers: write(), body: { action: 'deleteEverything' } });
  assert.equal(unknown.res.status, 400);
});

test('logout clears the cookie and the old session no longer works', async () => {
  const env = await setup();
  const cookie = await loginCookie(env);
  const out = await call(env, '/api/logout', { method: 'POST', cookie, headers: write() });
  assert.match(out.res.headers.get('set-cookie'), /Max-Age=0/);
  const after = await call(env, '/api/admin', { method: 'POST', cookie, headers: write(), body: { action: 'data' } });
  assert.equal(after.res.status, 401);
  const s = await call(env, '/api/session', { cookie });
  assert.equal(s.json.ok, false);
});

test('changing the PIN logs out every device', async () => {
  const env = await setup();
  const a = await loginCookie(env);
  const b = await loginCookie(env);
  const r = await call(env, '/api/admin', { method: 'POST', cookie: a, headers: write(), body: { action: 'changePin', oldPin: PIN, newPin: 'another-pin-9876' } });
  assert.equal(r.json.ok, true);
  for (const c of [a, b]) assert.equal((await call(env, '/api/session', { cookie: c })).json.ok, false);
});

test('public endpoint: filtered data, no row numbers, security headers, no caching of private data', async () => {
  const env = await setup();
  const r = await call(env, '/api/public?hit=1&nv=1');
  assert.equal(r.json.ok, true);
  assert.ok(r.json.services.every(x => x.row === undefined));
  assert.equal(G.props.stat_views, '1', 'visit counted');
  for (const h of ['x-content-type-options', 'referrer-policy', 'content-security-policy', 'strict-transport-security']) assert.ok(r.res.headers.get(h), h);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('missing configuration gives an error reference, not internal details', async () => {
  await setup();
  const r = await call({}, '/api/public');
  assert.equal(r.res.status, 500);
  assert.match(r.json.ref, /^E-[0-9A-F]{6}$/);
  assert.ok(!/GAS_URL|GATEWAY_SECRET|stack/i.test(r.text));
});

test('oversized request bodies are refused before reaching the server', async () => {
  const env = await setup();
  const cookie = await loginCookie(env);
  const big = '{"action":"upload","data":"' + 'A'.repeat(37 * 1024 * 1024) + '"}';
  const r = await call(env, '/api/admin', { method: 'POST', cookie, headers: write(), body: big });
  assert.equal(r.res.status, 413);
});

test('share page ignores injected ids and contains no script', async () => {
  const env = await setup();
  const evil = await call(env, '/e/' + encodeURIComponent('x</script><script>alert(1)</script>'));
  assert.ok(!/<script/i.test(evil.text));
  assert.ok(evil.text.includes('url=https://wafra.test/#ev-"') || evil.text.includes('#ev-"'));
  assert.ok(evil.res.headers.get('content-security-policy').includes("default-src 'none'"));
  // a real occasion still gets its preview title
  const key = (() => { const t = '2026-11-29|محمد سالم'; let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); })();
  const ok = await call(env, '/e/' + key);
  assert.ok(ok.text.includes('زواج محمد سالم'));
});

test('image proxy serves only photos of published records', async () => {
  const env = await setup();
  const no = await call(env, '/img?id=SOMEPRIVATEFILE1234567890');
  assert.equal(no.res.status, 404);
  assert.equal(driveCalls.length, 0, 'unknown ids never reach Drive');
  const yes = await call(env, '/img?id=PUBLISHEDPHOTO1234567890');
  assert.equal(yes.res.status, 200);
  assert.equal(yes.res.headers.get('content-type'), 'image/jpeg');
  assert.ok(yes.res.headers.get('x-content-type-options'));
  const bad = await call(env, '/img?id=../../etc');
  assert.equal(bad.res.status, 400);
});
