// End-to-end tests in Chromium: the real page (index.html + app.js + _headers CSP),
// the real Cloudflare Functions (middleware, gateway, share pages, image proxy) and the
// simulated Apps Script server. Nothing reaches Google; every check is an assertion.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loadGas } = require('./helpers/gas-mock');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://wafra.test';
const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';
const GW = 'g'.repeat(40);
const PIN = 'correct-pin-123';
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const SV_H = ['الاسم', 'المهنة', 'الهاتف', 'يخدم مناطق', 'ملاحظات', 'رابط الموقع', 'صورة'];
const EV_H = ['النوع', 'الاسم', 'العائلة', 'من تاريخ', 'إلى تاريخ', 'مكان الرجال', 'العنوان', 'وقت الرجال', 'مكان النساء', 'وقت النساء', 'الهاتف', 'رابط الموقع', 'ملاحظات', 'صورة', 'سبب الدعوة', 'الدفن'];
const DIW_H = ['اسم الديوان', 'صاحب الديوان', 'القطعة', 'الشارع / المنزل', 'الأيام', 'وقت الاستقبال', 'الهاتف', 'رابط الموقع', 'ملاحظات', 'الاعتذار', 'سبب الاعتذار', 'صورة', 'شعار'];
const AD_H = ['العنوان', 'الجهة', 'من تاريخ', 'إلى تاريخ', 'المكان', 'الوقت', 'التفاصيل', 'رابط', 'الهاتف', 'رابط الموقع', 'صورة', 'فيديو'];

// static CSP + headers from _headers ("/*" block)
const STATIC_HEADERS = (() => {
  const h = {}; let on = false;
  for (const line of fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) on = line.trim() === '/*';
    else if (on && line.includes(':')) { const i = line.indexOf(':'); h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  }
  return h;
})();

let mods;
const openBrowsers = new Set();
// close every browser after each test, also when an assertion fails (otherwise the run would hang)
test.afterEach(async () => { for (const b of openBrowsers) await b.close().catch(() => {}); openBrowsers.clear(); });
async function loadMods() {
  mods = mods || {
    mw: await import('../functions/_middleware.js'),
    api: await import('../functions/api/[[route]].js'),
    img: await import('../functions/img.js'),
    e: await import('../functions/e/[id].js'),
    d: await import('../functions/d/[id].js'),
    a: await import('../functions/a/[id].js')
  };
  return mods;
}

function makeServer(opts = {}) {
  const G = loadGas({
    start: opts.start || Date.parse('2026-11-27T13:00:00Z'),
    props: { GATEWAY_SECRET: GW, PIN },
    sheets: {
      'المناسبات': [EV_H, ['فرح', 'محمد سالم', 'آل سالم', '2026-11-29', '2026-11-29', 'صالة الوفرة', 'قطعة 3', 'بعد صلاة العشاء', '', '', '', '', '', '', '', ''],
        ['دعوة عشاء', 'أبو فهد', 'آل ناصر', '2026-11-27', '2026-11-27', 'ديوان', 'قطعة 6', 'بعد صلاة العشاء', '', '', '', '', '', '', '', ''],
        ['عزاء', 'قديم', 'آل', '2026-10-01', '2026-10-03', '', '', '', '', '', '', '', '', '', '', '']],
      'الدواوين': [DIW_H, ['ديوان أحمد', 'أحمد', '6', '', 'الأحد', 'بعد العشاء', '99887766', '', '', '', '', '', ''], ['ديوان أحمد', 'آخر', '3', '', 'الاثنين', '', '', '', '', '', '', '', '']],
      'الإعلانات': [AD_H, ['إعلان جارٍ', 'جهة', '2026-11-20', '2026-12-10', '', '', '', '', '', '', '', ''], ['إعلان منتهٍ', 'جهة', '2026-11-01', '2026-11-05', '', '', '', '', '', '', '', '']],
      'الخدمات': [SV_H, ['أبو محمد', 'حداد', '99887766', '', '', '', ''], ['أبو علي', 'كهربائي', '55443322', '', '', '', '']],
      'الصيدليات': [['اسم الصيدلية', 'الهاتف', 'ساعات العمل', 'التوصيل', 'العنوان', 'رابط الموقع', 'حساب إنستغرام أو رابط', 'ملاحظات', 'صورة أو شعار'], ['صيدلية الوفرة', '22224444', '24 ساعة', '', '', '', '', '', '']]
    }
  });
  G.down = false;
  return G;
}

async function newPage(G, browserOpts = {}) {
  await loadMods();
  const env = { GAS_URL, GATEWAY_SECRET: GW };
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url === GAS_URL) {
      if (G.down) throw new Error('simulated outage');
      return new Response(JSON.stringify(JSON.parse(G.api.doPost({ postData: { contents: init.body } }).t)));
    }
    if (url.startsWith('https://drive.google.com/thumbnail')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('unexpected fetch ' + url);
  };
  const browser = await chromium.launch();
  openBrowsers.add(browser);
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kuwait', locale: 'ar-KW' }, browserOpts));
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(G.clock.t));
  const log = { errors: [], csp: [], posts: [] };
  page.on('pageerror', e => log.errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) log.csp.push(m.text()); });
  await ctx.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort(); // nothing leaves the test (fonts, Google)
    if (/^\/(api|img|e|d|a)(\/|$)/.test(url.pathname)) {
      if (url.pathname.startsWith('/api/') && req.method() === 'POST') { try { log.posts.push(JSON.parse(req.postData() || '{}').action || url.pathname); } catch (e) {} }
      const headers = new Headers(await req.allHeaders());
      headers.set('cf-connecting-ip', '1.1.1.1');
      const request = new Request(req.url(), { method: req.method(), headers, body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
      const waits = [];
      const wu = p => waits.push(p);
      const next = async () => {
        if (url.pathname.startsWith('/api/')) return mods.api.onRequest({ request, env, params: { route: url.pathname.slice(5).split('/') }, waitUntil: wu });
        if (url.pathname === '/img') return mods.img.onRequestGet({ request, env, waitUntil: wu });
        const m = url.pathname.match(/^\/([eda])\/(.*)$/);
        return mods[m[1]].onRequestGet({ request, env, params: { id: decodeURIComponent(m[2]) }, waitUntil: wu });
      };
      const res = await mods.mw.onRequest({ request, env, next });
      await Promise.all(waits);
      const h = {}; res.headers.forEach((v, k) => { h[k] = v; });
      return route.fulfill({ status: res.status, headers: h, body: Buffer.from(await res.arrayBuffer()) });
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const p = path.join(ROOT, path.normalize(file));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return route.fulfill({ status: 404, body: '' });
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[path.extname(p)] || 'application/octet-stream';
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': type }, STATIC_HEADERS), body: fs.readFileSync(p) });
  });
  return { browser, ctx, page, log };
}
const open = async (page, hash) => { await page.goto(ORIGIN + '/' + (hash || '')); await page.waitForFunction(() => !/جارٍ التحميل|جارٍ تحميل/.test(document.body.innerText), null, { timeout: 15000 }); await page.waitForTimeout(300); };
async function loginUI(page, pin) {
  await page.click('#adminIn');
  await page.fill('#pin-in', pin || PIN);
  await page.click('#pinGo');
}

test('visitor: page loads from the gateway, old stored PIN is wiped, no CSP violations', async () => {
  const G = makeServer();
  const { browser, page, log, ctx } = await newPage(G);
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('wafra-admin-pin', 'old-secret'); sessionStorage.setItem('seeded', '1'); } } catch (e) {} });
  await open(page);
  assert.equal(await page.evaluate(() => localStorage.getItem('wafra-admin-pin')), null);
  const ev = await page.innerText('#view-events');
  assert.ok(ev.includes('محمد سالم'));
  assert.ok(!ev.includes('قديم'), 'expired item is not even sent to visitors');
  for (const tab of ['diwaniyas', 'ads', 'services', 'pharmacies', 'mosques', 'salons', 'realestate', 'restaurants', 'cafes']) {
    await page.click('#tab-' + tab); await page.waitForTimeout(150);
    assert.equal(await page.isVisible('#view-' + tab), true, tab);
  }
  await page.click('#tab-ads');
  assert.ok(!(await page.innerText('#view-ads')).includes('إعلان منتهٍ'));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.csp, [], 'no Content-Security-Policy violations');
  assert.equal(G.props.stat_views, '1');
  await browser.close();
});

test('admin login uses an HttpOnly cookie; no secret is readable by the page', async () => {
  const G = makeServer();
  const { browser, page, ctx, log } = await newPage(G);
  await open(page);
  await loginUI(page);
  await page.waitForSelector('#adminBar:not([hidden])', { timeout: 10000 });
  const cookies = await ctx.cookies();
  const c = cookies.find(x => x.name === '__Host-wafra_s');
  assert.ok(c && c.httpOnly && c.secure && c.sameSite === 'Strict');
  assert.equal(await page.evaluate(() => document.cookie.includes('wafra_s')), false);
  const ls = await page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!ls.includes(PIN) && !ls.includes(c.value), 'nothing secret in localStorage');
  assert.deepEqual(log.csp, []);
  await browser.close();
});

test('wrong PIN message, then per-connection wait after repeated failures', async () => {
  const G = makeServer();
  const { browser, page } = await newPage(G);
  await open(page);
  await loginUI(page, 'wrong');
  await page.waitForSelector('#pinErr:not([hidden])');
  assert.equal(await page.textContent('#pinErr'), 'الرمز غير صحيح.');
  for (let i = 0; i < 5; i++) { await page.fill('#pin-in', 'wrong' + i); await page.click('#pinGo'); await page.waitForTimeout(150); }
  await page.fill('#pin-in', PIN); await page.click('#pinGo'); await page.waitForTimeout(300);
  assert.match(await page.textContent('#pinErr'), /حاول بعد \d+ دقيقة/);
  await browser.close();
});

test('admin: add through the form (double-click saves once), delete, restore', async () => {
  const G = makeServer();
  const { browser, page, log } = await newPage(G);
  page.setDefaultTimeout(8000);
  const step = m => { if (process.env.E2E_DEBUG) console.log('STEP', m); };
  await open(page);
  await loginUI(page); step('login');
  await page.waitForSelector('#adminBar:not([hidden])');
  await page.waitForTimeout(1200); step('reloaded');
  await page.evaluate(() => { location.hash = 'services'; });
  await page.click('#addSv'); await page.waitForTimeout(300);
  await page.fill('#s-name', 'أبو اختبار'); await page.fill('#s-phone', '90001234');
  await page.locator('#s-crafts input').first().check();
  const save = page.locator('#svForm button[type=submit]').first();
  step('form filled');
  await save.evaluate(b => { b.click(); b.click(); b.click(); });
  step('clicked');
  await page.waitForTimeout(1500);
  assert.equal(log.posts.filter(a => a === 'append').length, 1, 'saved exactly once');
  assert.equal(G.sheets['الخدمات'].d.filter(r => r[0] === 'أبو اختبار').length, 1);
  // delete from its card
  const card = page.locator('#svOut article, #svOut .card').filter({ hasText: 'أبو اختبار' }).first();
  await card.locator('button:has-text("تعديل")').click(); await page.waitForTimeout(300);
  await page.click('#s-del'); await page.waitForTimeout(200);
  await page.click('#s-delYes'); await page.waitForTimeout(1200);
  assert.equal(G.sheets['الخدمات'].d.filter(r => r[0] === 'أبو اختبار').length, 0);
  await page.click('#trashBtn'); await page.waitForTimeout(800);
  assert.ok((await page.innerText('#trashList')).includes('أبو اختبار'));
  await page.locator('#trashList button:has-text("استرجاع")').first().click(); await page.waitForTimeout(1500);
  assert.equal(G.sheets['الخدمات'].d.filter(r => r[0] === 'أبو اختبار').length, 1);
  await browser.close();
});

test('session expiry and logout return the page to visitor mode', async () => {
  const G = makeServer();
  const { browser, page, ctx } = await newPage(G);
  await open(page);
  await loginUI(page);
  await page.waitForSelector('#adminBar:not([hidden])');
  await page.waitForTimeout(1000);
  G.clock.advance(13 * 3600e3);
  await page.click('#trashBtn'); await page.waitForTimeout(800);
  assert.equal(await page.isHidden('#adminBar'), true, 'expired session leaves admin mode');
  await loginUI(page);
  await page.waitForSelector('#adminBar:not([hidden])'); await page.waitForTimeout(900);
  await page.click('#adminOut'); await page.waitForTimeout(1200);
  assert.equal((await ctx.cookies()).some(c => c.name === '__Host-wafra_s' && c.value), false);
  assert.equal(await page.isHidden('#adminBar'), true);
  await browser.close();
});

test('changing the PIN from the security panel logs every device out', async () => {
  const G = makeServer();
  const { browser, page } = await newPage(G);
  await open(page);
  await loginUI(page);
  await page.waitForSelector('#adminBar:not([hidden])'); await page.waitForTimeout(900);
  await page.click('#secBtn'); await page.waitForTimeout(500);
  assert.match(await page.textContent('#secInfo'), /الأجهزة الداخلة الآن/);
  await page.fill('#pc-old', PIN); await page.fill('#pc-new', 'brand-new-pin-42'); await page.fill('#pc-new2', 'brand-new-pin-42');
  await page.click('#pcGo'); await page.waitForTimeout(1500);
  assert.equal(await page.isHidden('#adminBar'), true);
  assert.ok(G.props.PIN_HASH && !G.props.PIN);
  await loginUI(page, 'brand-new-pin-42');
  await page.waitForSelector('#adminBar:not([hidden])');
  await browser.close();
});

test('visitor requests need consent; every card has a report link', async () => {
  const G = makeServer();
  const { browser, page } = await newPage(G);
  await open(page, '#services');
  const report = page.locator('#svOut a.report').first();
  const href = await report.getAttribute('href');
  assert.match(decodeURIComponent(href), /القسم: الخدمات/);
  await page.click('#addSv'); await page.waitForTimeout(300);
  await page.fill('#s-name', 'زائر'); await page.fill('#s-phone', '90009999');
  await page.locator('#s-crafts input').first().check();
  await page.locator('#svForm button[type=submit]').first().click(); await page.waitForTimeout(500);
  assert.equal(await page.getAttribute('#sendLink', 'aria-disabled'), 'true');
  assert.equal(await page.getAttribute('#sendLink', 'href'), '#');
  await page.check('#sendConsent');
  const link = await page.getAttribute('#sendLink', 'href');
  assert.match(link, /^https:\/\/wa\.me\//);
  assert.match(decodeURIComponent(link), /موافق على نشر بيانات التواصل/);
  await browser.close();
});

test('outage: first visit explains the problem; a returning visitor sees the last public copy', async () => {
  const G = makeServer();
  const { browser, page } = await newPage(G);
  await open(page);
  G.down = true;
  await page.reload(); await page.waitForTimeout(1500);
  const note = await page.textContent('#statusNote');
  assert.match(note, /آخر نسخة حُفظت على جهازك/);
  assert.ok((await page.innerText('#view-events')).includes('محمد سالم'));
  const fresh = await newPage(G);
  await fresh.page.goto(ORIGIN + '/'); await fresh.page.waitForTimeout(1500);
  assert.match(await fresh.page.textContent('#statusNote'), /تعذّر تحميل البيانات/);
  await fresh.browser.close();
  await browser.close();
});

test('regression: deep links, Arabic search, Kuwait time for a visitor abroad', async () => {
  const G = makeServer({ start: Date.parse('2026-11-27T22:30:00Z') }); // 01:30 on the 28th in Kuwait
  const { browser, page } = await newPage(G, { timezoneId: 'America/New_York' });
  await open(page, '#pharmacies');
  assert.equal(await page.isVisible('#view-pharmacies'), true);
  assert.match(await page.textContent('#todayLine'), /28 نوفمبر/);
  assert.ok(!(await page.innerText('#view-events')).includes('أبو فهد'), "yesterday's dinner is over");
  await page.click('#tab-diwaniyas'); await page.fill('#q', 'احمد'); await page.waitForTimeout(300);
  assert.ok((await page.innerText('#view-diwaniyas')).includes('ديوان أحمد'));
  await browser.close();
});

test('layout from 320 to 1920 pixels: no horizontal scrolling', async () => {
  const G = makeServer();
  for (const width of [320, 390, 768, 1280, 1920]) {
    const { browser, page } = await newPage(G, { viewport: { width, height: 900 } });
    await open(page);
    for (const tab of ['events', 'diwaniyas', 'services', 'realestate']) {
      await page.click('#tab-' + tab); await page.waitForTimeout(120);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(over <= 0, width + 'px ' + tab + ' overflows by ' + over);
    }
    await browser.close();
  }
});

test('share pages and image proxy through the browser', async () => {
  const G = makeServer();
  const { browser, page } = await newPage(G);
  const res = await page.goto(ORIGIN + '/e/' + encodeURIComponent('x</script><script>window.pwned=1</script>'));
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.ok(res.headers()['content-security-policy']);
  const img = await page.goto(ORIGIN + '/img?id=NOTPUBLISHED1234567890ab');
  assert.equal(img.status(), 404);
  await browser.close();
});
