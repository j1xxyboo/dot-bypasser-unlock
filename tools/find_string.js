/*
 * Decode the obfuscated strings of a file and find the code around them.
 *
 *   node tools/find_string.js <file.js> "<string to find>" [context]
 *
 * The file is evaluated in a VM (with the browser APIs stubbed) and the
 * module's own string decoder is used, so the result is exactly what the
 * extension sees at runtime.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function stub(n) {
  return new Proxy(function () {}, {
    get(t, p) {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => undefined;
      if (p === 'toString') return () => '';
      if (p === 'valueOf') return () => 0;
      if (p === 'length') return 0;
      return stub(n + '.' + String(p));
    },
    apply() { return stub(n + '()'); },
    construct() { return stub('new ' + n); },
  });
}

/** brace depth of every position (strings skipped) */
function depthMap(src) {
  const map = new Int32Array(src.length + 1);
  let d = 0, instr = null, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (instr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === instr) instr = null;
    } else {
      if (c === '"' || c === "'" || c === '`') instr = c;
      else if (c === '{') d++;
      else if (c === '}') d--;
    }
    map[i] = d;
  }
  return map;
}

(async () => {
  const file = path.resolve(process.argv[2]);
  const needle = process.argv[3] || '';
  const ctxLen = Number(process.argv[4] || 700);
  const src = fs.readFileSync(file, 'utf8');
  const dmap = depthMap(src);

  // the module level string table and its accessor
  const tableMatch = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[(?:"[^"]{0,200}",){50,}/.exec(src);
  if (!tableMatch) {
    console.log('no string table found');
    process.exit(1);
  }
  const tableName = tableMatch[1];

  const ctx = {
    console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date,
    RegExp, Error, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    decodeURIComponent, encodeURIComponent, escape, unescape, parseInt, parseFloat, isNaN,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    require: (x) => stub('r.' + x),
  };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
  ctx.location = {
    protocol: 'chrome-extension:', href: 'chrome-extension://test/x.html', host: 'test',
    hostname: 'test', origin: 'chrome-extension://test', search: '', hash: '', pathname: '/x.html',
  };
  ctx.navigator = { userAgent: 'Mozilla/5.0 Chrome/131', platform: 'Linux x86_64', language: 'en-US' };
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss');
  ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: (a) => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(ctx);

  // expose the module level accessors
  const names = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (dmap[m.index] <= 1) names.add(m[1]);
  }
  const epilogue = '\nglobalThis.__X__={' + [...names].map((n) => n + ':typeof ' + n + '!=="undefined"?' + n + ':undefined').join(',') + '};\n';

  try {
    vm.runInContext(epilogue + src, ctx, { timeout: 300000 });
  } catch (e) {
    console.log('eval failed: ' + String(e && e.message).slice(0, 200));
  }
  const X = ctx.__X__ || {};

  // the accessor that turns an index into a string
  const accessor = Object.keys(X).find((n) => typeof X[n] === 'function' && n !== 'crypto');
  const table = X[tableName];
  if (!table) {
    console.log('table "' + tableName + '" not reachable');
    process.exit(1);
  }

  // decode the constants table (if there is one) and every string
  const constMatch = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[(?:0x[0-9a-f]+,){50,}/.exec(src);
  const decoded = [];
  const tryDecode = (v) => {
    try {
      if (typeof v === 'number') {
        // a constant: index into the string table
        for (const fn of Object.keys(X)) {
          if (typeof X[fn] === 'function' && fn !== accessor) {
            try {
              const s = X[fn](v);
              if (typeof s === 'string' && s.length && s.length < 200) return s;
            } catch (e) { /* try the next one */ }
          }
        }
      }
      return typeof v === 'string' ? v : null;
    } catch (e) { return null; }
  };

  for (let i = 0; i < table.length; i++) {
    const s = tryDecode(table[i]);
    if (s) decoded.push([i, s]);
  }
  if (constMatch) {
    const consts = X[constMatch[1]];
    if (Array.isArray(consts)) {
      for (let i = 0; i < consts.length; i++) {
        const s = tryDecode(consts[i]);
        if (s) decoded.push([i, s, 'const']);
      }
    }
  }

  console.log('decoded ' + decoded.length + ' strings');
  const hits = decoded.filter((d) => d[1] === needle || (needle && d[1].toLowerCase().includes(needle.toLowerCase())));
  if (!hits.length) {
    console.log('"' + needle + '" not found among the decoded strings');
    // print a few for orientation
    console.log(decoded.slice(0, 12).map((d) => d[0] + ': ' + JSON.stringify(d[1])).join('\n'));
    process.exit(0);
  }
  for (const h of hits) {
    console.log('index ' + h[0] + (h[2] ? ' (' + h[2] + ')' : '') + ' -> ' + JSON.stringify(h[1]));
  }
  process.exit(0);
})();
