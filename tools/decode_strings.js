#!/usr/bin/env node
/*
 * Decode the obfuscated strings of a file.
 *
 * The javascript-obfuscator keeps its strings in a table and decodes them with
 * a function; both are found by how often they are used. This tool evaluates
 * the file in a VM (with the browser APIs stubbed) and prints what the table
 * entries decode to.
 *
 * Usage:
 *   node --experimental-vm-modules tools/decode_strings.js <file.js> [index ...]
 *
 * Without indices every entry is printed.
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

function discover(src) {
  const calls = new Map();
  const tables = new Map();
  const re = /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\[(0x[0-9a-fA-F]+|\d+)\]\)/g;
  let m;
  while ((m = re.exec(src))) {
    calls.set(m[1], (calls.get(m[1]) || 0) + 1);
    tables.set(m[2], (tables.get(m[2]) || 0) + 1);
  }
  const table = [...tables.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!table) return null;
  /*
   * The decoder has to be defined in this file - an imported helper that is
   * called with a table index would otherwise win the frequency contest.
   */
  const defined = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/g)) defined.add(m[1]);
  const candidates = [...calls.entries()]
    .filter(([name]) => defined.has(name))
    .sort((a, b) => b[1] - a[1]);
  const decoder = candidates[0] || [...calls.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!decoder) return null;
  return { decoder: decoder[0], table: table[0], candidates: candidates.map((c) => c[0]) };
}

(async () => {
  const file = path.resolve(process.argv[2]);
  const src = fs.readFileSync(file, 'utf8');
  const d = discover(src);
  if (!d) {
    console.log('no obfuscated string table found in ' + file);
    process.exit(1);
  }
  console.log('decoder: ' + d.decoder + '   index table: ' + d.table +
    (d.candidates.length > 1 ? '   candidates: ' + d.candidates.slice(0, 5).join(', ') : ''));

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
  ctx.navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Linux x86_64', language: 'en-US', languages: ['en-US'],
    hardwareConcurrency: 8, deviceMemory: 8,
  };
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss');
  ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: (a) => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(ctx);

  const isModule = /(^|[;\n])\s*(import|export)\s/.test(src);

  async function tryDecoder(name) {
    const epilogue =
      `globalThis.__D__=function(i){try{return ${name}(${d.table}[i])}catch(e){return null}};` +
      `globalThis.__T__=${d.table};`;
    // a fresh context per attempt
    const c = Object.assign({}, ctx);
    c.globalThis = c; c.self = c; c.window = c; c.top = c; c.global = c;
    vm.createContext(c);
    try {
      if (isModule) {
        const m = new vm.SourceTextModule(epilogue + src, { context: c, identifier: file });
        const linker = async (spec, ref) => {
          const p = path.resolve(path.dirname(ref.identifier), spec);
          const mod = new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { context: c, identifier: p });
          await mod.link(linker);
          await mod.evaluate();
          return mod;
        };
        await m.link(linker);
        try { await m.evaluate(); } catch (e) { /* the decoder may still be up */ }
      } else {
        try {
          vm.runInContext(epilogue + src, c, { timeout: 300000 });
        } catch (e) { /* the decoder may still be up */ }
      }
    } catch (e) {
      // retry without the imports
      try {
        const stripped = src
          .replace(/import\s+([^;]*?)\s+from\s*['"][^'"]+['"];?/g, 'const __unused__ = undefined;')
          .replace(/\bimport\s*\(/g, 'Promise.resolve(')
          .replace(/export\s*\{[^}]*\};?/g, '')
          .replace(/export\s+default\s+/g, 'const __default__ = ')
          .replace(/export\s+(const|let|var|function|class|async)\s/g, '$1 ');
        vm.runInContext(epilogue + stripped, c, { timeout: 300000 });
      } catch (e2) { /* ignore */ }
    }
    if (typeof c.__D__ !== 'function') return null;
    // does it actually decode to strings?
    let strings = 0;
    for (let i = 0; i < 40; i++) {
      const v = c.__D__(i);
      if (typeof v === 'string' && v.length) strings++;
    }
    if (strings < 3) return null;
    return c;
  }

  let found = null;
  const names = (d.candidates && d.candidates.length ? d.candidates : [d.decoder]).slice(0, 6);
  for (const name of names) {
    const c = await tryDecoder(name);
    if (c) { found = c; console.log('using decoder: ' + name); break; }
  }
  if (!found) {
    console.log('the decoder did not come up');
    process.exit(1);
  }
  const ctx2 = found;

  const wanted = process.argv.slice(3).map(Number);
  const table = ctx2.__T__ || [];
  const list = wanted.length ? wanted : table.map((_, i) => i);
  for (const i of list) {
    if (i < 0 || i >= table.length) continue;
    const v = ctx2.__D__(i);
    if (typeof v === 'string' && v.length) {
      console.log(String(i).padStart(4) + '  ' + JSON.stringify(v));
    }
  }
  process.exit(0);
})();
