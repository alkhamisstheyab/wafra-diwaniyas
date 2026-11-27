// In-memory simulation of the Google Apps Script services that apps-script/Code.gs uses.
// Loads Code.gs into an isolated VM context with a controllable clock, so tests can
// exercise sessions, expiry, rate limits, sheets, Drive files and logging without Google.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function makeClock(start) {
  const clock = { t: start || Date.parse('2026-11-27T13:00:00Z') };
  const Real = Date;
  class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(clock.t); }
    static now() { return clock.t; }
  }
  FakeDate.UTC = Real.UTC; FakeDate.parse = Real.parse;
  clock.Date = FakeDate;
  clock.advance = ms => { clock.t += ms; };
  return clock;
}

function makeSheet(name, rows) {
  const d = (rows || []).map(r => r.slice());
  const formats = {};
  const sh = {
    name, d, formats, rtl: false,
    getName: () => name,
    getLastRow: () => d.length,
    getLastColumn: () => Math.max(0, ...d.map(r => r.length)),
    getRange(r, c, nr = 1, nc = 1) {
      const R = {
        setNumberFormat(f) { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) formats[(r + i) + ':' + (c + j)] = f; return R; },
        setFontWeight: () => R, setFontColor: () => R, setBackground: () => R,
        getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (d[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; },
        getValue() { const v = (d[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
        setValues(v) {
          if (v.length !== nr || v.some(x => x.length !== nc)) throw new Error('setValues dimension mismatch');
          for (let i = 0; i < nr; i++) { d[r - 1 + i] = d[r - 1 + i] || []; for (let j = 0; j < nc; j++) d[r - 1 + i][c - 1 + j] = sheetsStore(v[i][j], formats[(r + i) + ':' + (c + j)]); }
          return R;
        },
        setValue(v) { d[r - 1] = d[r - 1] || []; d[r - 1][c - 1] = sheetsStore(v, formats[r + ':' + c]); return R; }
      };
      return R;
    },
    deleteRow(r) { d.splice(r - 1, 1); },
    setRightToLeft(v) { sh.rtl = v; }, setFrozenRows() {}
  };
  return sh;
}
// Models how Sheets keeps a typed value: a leading apostrophe marks text and is not stored.
// A value starting with "=" in a cell NOT formatted as text would become a formula: flagged so tests catch it.
function sheetsStore(v, fmt) {
  const s = v;
  if (typeof s === 'string' && s[0] === "'") return s.slice(1);
  if (typeof s === 'string' && /^[=]/.test(s) && fmt !== '@') return { FORMULA: s };
  return s;
}

function makeDrive(clock) {
  let n = 0;
  const files = {}, folders = {};
  const iter = arr => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function folder(name, parent) {
    const id = 'fold' + (++n);
    const f = {
      id, name, parent,
      getId: () => id, getName: () => name,
      getFoldersByName: nm => iter(Object.values(folders).filter(x => x.parent === id && x.name === nm)),
      createFolder: nm => folder(nm, id),
      createFile(blob) {
        const fid = 'file' + String(++n).padStart(28, '0');
        const file = { id: fid, name: blob.name, type: blob.type, bytes: blob.bytes, parent: id, shared: false, trashed: false, created: clock.t,
          getId: () => fid, getParents: () => iter([folders[file.parent]]), moveTo(fo) { file.parent = fo.getId(); },
          setSharing(access) { file.shared = access === 'ANYONE_WITH_LINK'; }, getDateCreated: () => new Date(file.created), setTrashed(v) { file.trashed = v; },
          makeCopy() {} };
        files[fid] = file; return file;
      },
      getFiles: () => iter(Object.values(files).filter(x => x.parent === id && !x.trashed))
    };
    folders[id] = f; return f;
  }
  const root = folder('root', null);
  return {
    files, folders,
    api: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', PRIVATE: 'PRIVATE' }, Permission: { VIEW: 'VIEW', NONE: 'NONE' },
      getFoldersByName: nm => iter(Object.values(folders).filter(x => x.name === nm)),
      createFolder: nm => folder(nm, root.id),
      getFileById: id => { if (!files[id]) throw new Error('No item with the given ID'); return files[id]; },
      getRootFolder: () => root
    }
  };
}

function loadGas(opts = {}) {
  const clock = makeClock(opts.start);
  const props = Object.assign({}, opts.props || {});
  const cache = {};
  const sheets = {};
  Object.entries(opts.sheets || {}).forEach(([name, rows]) => { sheets[name] = makeSheet(name, rows); });
  const drive = makeDrive(clock);
  const events = [];
  const failLogWrites = { n: 0 };
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => { if (failLogWrites.n && n === 'سجل العمليات') throw new Error('simulated'); return (sheets[n] = makeSheet(n, [])); },
    getId: () => 'ss1'
  };
  const fmtParts = (date, tz) => {
    const p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(date).forEach(x => { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return p;
  };
  const ctx = {
    console,
    Date: clock.Date, Math, JSON, String, Number, Object, Array, Error, RegExp, isNaN, parseInt, Intl,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      setProperties: o => { Object.assign(props, o); },
      deleteProperty: k => { delete props[k]; },
      getProperties: () => Object.assign({}, props)
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => { const e = cache[k]; if (!e || e.exp <= clock.t) return null; return e.v; },
      put: (k, v, ttl) => { events.push('cache.put:' + k.slice(0, 3)); cache[k] = { v: String(v), exp: clock.t + (ttl || 600) * 1000 }; },
      remove: k => { delete cache[k]; }
    }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { events.push('lock'); }, tryLock: () => { events.push('lock'); return true; },
      releaseLock: () => { events.push('unlock'); }
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      base64Decode: s => { if (!/^[A-Za-z0-9+/=]*$/.test(s)) throw new Error('bad base64'); return Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)); },
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      formatDate: (date, tz, pattern) => {
        const p = fmtParts(date, tz);
        return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      sleep: ms => { events.push('sleep:' + ms); }
    },
    ContentService: { createTextOutput: t => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    DriveApp: drive.api,
    UrlFetchApp: { fetch: opts.fetch || (() => { throw new Error('network disabled in tests'); }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ inTimezone: () => ({ create() {} }) }) }) }) }) }
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(code + '\n;this.__api={doPost,doGet,validateRow,publicData,checkSession};', ctx, { filename: 'Code.gs' });
  const api = ctx.__api;
  const post = body => JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).t);
  const get = params => JSON.parse(api.doGet({ parameter: params || {} }).t);
  return { api, post, get, props, cache, sheets, drive, clock, events, failLogWrites, ctx };
}

module.exports = { loadGas };
