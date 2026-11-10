#!/usr/bin/env node
/*
 * Work out the premium patch sites of an extension tree and print them as
 * find/replace pairs.
 *
 * The obfuscator re-randomises its string tables with every build, so the
 * patch sites have to be found by their *meaning*:
 *
 *   - the property "isPremium" whose value is the always-false `!1`
 *   - comparisons against the premium threshold 1.1 that carry the same
 *     always-false tail
 *   - the "premium" property that falls back to 10 when there is no license
 *
 * Usage:
 *   node tools/emit_patches.js <extension-dir>
 *
 * The output is what unlock_dot.js needs. Run it once per release and add the
 * result as a build profile.
 */
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
  const decoder = [...calls.entries()].sort((a, b) => b[1] - a[1])[0];
  const table = [...tables.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!decoder || !table) return null;
  return { decoder: decoder[0], table: table[0] };
}


/**
 * Read the index table straight out of the source. The table is an array
 * literal of numbers and short strings, so it can be read without running
 * the file - which matters for the big ES module chunks.
 */
function parseTableLiteral(src, tableName) {
  const at = src.indexOf(tableName + '=[');
  if (at === -1) return null;
  const start = src.indexOf('[', at);
  let depth = 0;
  let end = start;
  let quote = null;
  let esc = false;
  for (; end < src.length; end++) {
    const c = src[end];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(start, end + 1);
  try {
    // only literals are evaluated here (numbers, strings, void 0x0, null)
    return vm.runInNewContext(literal, Object.create(null), { timeout: 5000 });
  } catch (e) {
    return null;
  }
}

async function makeDecoder(file) {
  const src = fs.readFileSync(file, 'utf8');
  const d = discover(src);
  if (!d) return null;
  const parsed = parseTableLiteral(src, d.table);

  const ctx = {
    console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date,
    RegExp, Error, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    decodeURIComponent, encodeURIComponent, escape, unescape, parseInt, parseFloat, isNaN,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
    require: (x) => stub('r.' + x),
  };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.location = {
    protocol: 'chrome-extension:', href: 'chrome-extension://test/x.html', host: 'test',
    hostname: 'test', origin: 'chrome-extension://test', search: '', hash: '', pathname: '/x.html',
  };
  ctx.navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Linux x86_64', language: 'en-US', languages: ['en-US'],
    hardwareConcurrency: 8, deviceMemory: 8,
  };
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss');
  ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: (a) => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(ctx);

  /*
   * The epilogue is *prepended*: the decoder is a function declaration (so it
   * is hoisted and usable right away) and the table is captured lazily on the
   * first call. That way the decoder still works when the file throws while
   * it is evaluated - which some of these bundles do.
   */
  const epilogue =
    `globalThis.__D__=function(i){try{` +
    `if(globalThis.__T__===undefined){try{globalThis.__T__=${d.table}}catch(e){}}` +
    `return ${d.decoder}(${d.table}[i])}catch(e){return null}};\n`;

  const isModule = /(^|[;\n])\s*(import|export)\s/.test(src);
  try {
    if (isModule) {
      const m = new vm.SourceTextModule(epilogue + src, { context: ctx, identifier: file });
      const linker = async (spec, ref) => {
        const p = path.resolve(path.dirname(ref.identifier), spec);
        const mod = new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { context: ctx, identifier: p });
        await mod.link(linker);
        await mod.evaluate();
        return mod;
      };
      await m.link(linker);
      try { await m.evaluate(); } catch (e) { /* the decoder may still be up */ }
    } else {
      try {
        vm.runInContext(epilogue + src, ctx, { timeout: 300000 });
      } catch (e) { /* the decoder may still be up */ }
    }
  } catch (e) {
    /*
     * The module could not be linked (some of these bundles import a 7 MB
     * helper). Strip the imports and exports and run it as a plain script -
     * the string decoder does not need any of it.
     */
    if (!isModule) {
      return { decode: null, tableValues: parsed, table: d.table, decoder: d.decoder };
    }
    try {
      const stripped = src
        .replace(/import\s+([^;]*?)\s+from\s*['"][^'"]+['"];?/g, (all, what) => {
          const names = what.replace(/\*\s*as\s+/g, '').replace(/[{}]/g, ',');
          return 'const ' + names.split(',').map((n) => n.trim()).filter(Boolean)
            .map((n) => n + ' = undefined').join(', ') + ';';
        })
        .replace(/\bimport\s*\(/g, 'Promise.resolve(')
        .replace(/export\s*\{[^}]*\};?/g, '')
        .replace(/export\s+default\s+/g, 'const __default__ = ')
        .replace(/export\s+(const|let|var|function|class|async)\s/g, '$1 ');
      vm.runInContext(epilogue + stripped, ctx, { timeout: 300000 });
    } catch (e2) {
      /* the decoder may still be up */
    }
    return { decode: null, tableValues: parsed, table: d.table, decoder: d.decoder };
  }
  if (typeof ctx.__D__ !== 'function') {
    // no decoder: the table values are still enough for the comparison sites
    return { decode: null, tableValues: parsed, table: d.table, decoder: d.decoder };
  }
  if (!ctx.__T__) { try { vm.runInContext(`globalThis.__T__=${d.table};`, ctx); } catch (e) { /* ignore */ } }
  return {
    decode: ctx.__D__,
    tableValues: (parsed && parsed.length ? parsed : ctx.__T__),
    table: d.table,
    decoder: d.decoder,
  };
}

async function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const info = await makeDecoder(file);
  if (!info) return { file, patches: [] };
  const { decode, table, tableValues } = info;
  const tableAt = (idx) => (tableValues ? tableValues[idx] : undefined);

  /*
   * The decoder is not idempotent: it replaces the encoded string with the
   * decoded one, so asking for the same index twice gives garbage. Every
   * index is therefore decoded exactly once.
   */
  const cache = new Map();
  const dec = (idx) => {
    if (!cache.has(idx)) cache.set(idx, decode(idx));
    return cache.get(idx);
  };

  /*
   * Every piece a computed property key can be made of:
   *   DEC(TABLE[i])  -> the decoded string
   *   TABLE[i]       -> a short string that sits in the table itself
   */
  const fragRe = new RegExp(
    '[A-Za-z_$][\\w$]*\\(' + table + '\\[(0x[0-9a-fA-F]+|\\d+)\\]\\)|' +
    table + '\\[(0x[0-9a-fA-F]+|\\d+)\\]', 'g'
  );
  const frags = [];
  let m;
  while ((m = fragRe.exec(src))) {
    let v = null;
    if (m[1] !== undefined) {
      v = info.decode ? dec(Number(m[1])) : null;
    } else {
      const raw = tableAt(Number(m[2]));
      // a number is coerced to a string when the key is built
      if (raw !== undefined && raw !== null) v = String(raw);
    }
    if (typeof v !== 'string') continue;
    frags.push({ start: m.index, end: m.index + m[0].length, text: m[0], val: v });
  }
  const byEnd = new Map();
  for (const f of frags) if (!byEnd.has(f.end)) byEnd.set(f.end, f);

  /**
   * The key expression right before `pos`: walk backwards over the fragments
   * that are joined with "+".
   */
  function keyRunBefore(pos) {
    let p = pos;
    let first = null;
    // the key ends right here, or a bracket/whitespace is in between
    while (p > 0) {
      const f = byEnd.get(p);
      if (f) { first = f; break; }
      const c = src[p - 1];
      if (/\s/.test(c) || c === ']' || c === ')') { p--; continue; }
      break;
    }
    if (!first) return null;
    const parts = [first];
    let cur = first;
    for (;;) {
      let q = cur.start;
      while (q > 0 && /\s/.test(src[q - 1])) q--;
      if (q === 0 || src[q - 1] !== '+') break;
      q--;
      while (q > 0 && /\s/.test(src[q - 1])) q--;
      const prev = byEnd.get(q);
      if (!prev) break;
      parts.unshift(prev);
      cur = prev;
    }
    return { parts, text: src.slice(parts[0].start, parts[parts.length - 1].end), value: parts.map((x) => x.val).join('') };
  }

  const patches = [];
  const add = (find, replace, label) => {
    if (src.split(find).length - 1 !== 1) return;
    patches.push({ file, find, replace, label });
  };

  /* --- 1. properties: "isPremium": <always false> --------------------- */
  /*
   * Every ":" in the file is looked at, and the key expression in front of it
   * is decoded. (A regex would swallow the text and skip the next site.)
   */
  const valueRe = /^\s*(!?)([A-Za-z_$][\w$]*\[(?:0x[0-9a-fA-F]+|\d+)\])/;
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== ':') continue;
    const vm2 = valueRe.exec(src.slice(i + 1, i + 120));
    if (!vm2) continue;
    const bang = vm2[1];
    const value = vm2[2];
    const idx = Number(value.match(/\[(0x[0-9a-fA-F]+|\d+)\]/)[1]);
    const raw = tableAt(idx);
    const run = frags.length ? keyRunBefore(i) : null;
    if (!run) continue;

    // the exact source of the property, brackets included
    const afterColon = src.slice(i + 1, i + 1 + vm2[0].length);
    const valStart = i + 1 + afterColon.indexOf(value);
    const head = src.slice(run.parts[0].start, valStart);

    if (run.value === 'isPremium' && bang === '!' && raw === 1) {
      add(head + value, head + '0', 'isPremium default');
    }
    if (run.value === 'premium' && bang === '' && raw === 10) {
      add(head + value, head + '0', 'premium fallback');
    }
  }

  /* --- 2. comparisons against 1.1 with the always-false tail ----------- */
  const cmpRe = /([A-Za-z_$][\w$]*)<((?:1\.1|[A-Za-z_$][\w$]*\[(?:0x[0-9a-fA-F]+|\d+)\]))\|\|!([A-Za-z_$][\w$]*\[(?:0x[0-9a-fA-F]+|\d+)\])/g;
  while ((m = cmpRe.exec(src))) {
    const thr = m[2];
    const tail = m[3];
    let isThr = thr === '1.1';
    if (!isThr) {
      const mm = thr.match(/\[(0x[0-9a-fA-F]+|\d+)\]/);
      if (mm) {
        const t = tableAt(Number(mm[1]));
        isThr = t === 1.1 || t === '1.1';
      }
    }
    if (!isThr) continue;
    const idx = Number(tail.match(/\[(0x[0-9a-fA-F]+|\d+)\]/)[1]);
    if (tableAt(idx) !== 1) continue;
    add(m[0], m[0].replace(tail, '0'), 'premium threshold');
  }

  /* --- 3. the "no response" path: x[key] = !1; return ------------------ */
  const nrRe = /([A-Za-z_$][\w$]*\[.{1,140}?\])=!([A-Za-z_$][\w$]*\[(?:0x[0-9a-fA-F]+|\d+)\]);return\}/g;
  while ((m = nrRe.exec(src))) {
    const idx = Number(m[2].match(/\[(0x[0-9a-fA-F]+|\d+)\]/)[1]);
    if (tableAt(idx) !== 1) continue;
    add(m[0], m[0].replace(m[2], '0'), 'no-response path');
  }

  return { file, patches };
}

function appChunkOf(root) {
  // the app chunk is the one the pages load
  for (const page of ['popup.html', 'options.html']) {
    const p = path.join(root, page);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/src="\/chunks\/(main-[^"]+\.js)"/);
    if (m) return 'chunks/' + m[1];
  }
  return null;
}

function digestsOf(root) {
  const out = {};
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else out[rel] = require('crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(root);
  return out;
}

(async () => {
  const saveIndex = process.argv.indexOf('--save');
  const saveName = saveIndex !== -1 ? process.argv[saveIndex + 1] : null;
  const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'dot');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(root);

  const out = [];
  for (const f of files) {
    const r = await scanFile(f);
    if (r.patches && r.patches.length) {
      console.error(path.relative(root, f) + ': ' + r.patches.length + ' site(s)');
      for (const p of r.patches) {
        out.push({
          file: path.relative(root, f).split(path.sep).join('/'),
          find: p.find,
          replace: p.replace,
          label: p.label,
        });
      }
    }
  }
  if (saveName) {
    const file = path.join(__dirname, 'profiles.json');
    let db = { profiles: [] };
    if (fs.existsSync(file)) {
      try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new */ }
    }
    if (!Array.isArray(db.profiles)) db.profiles = [];
    const profile = {
      name: saveName,
      version: (() => {
        try { return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version; } catch (e) { return null; }
      })(),
      appChunk: appChunkOf(root),
      patches: out,
      files: digestsOf(root),
    };
    db.profiles = db.profiles.filter((x) => x.name !== saveName);
    db.profiles.push(profile);
    fs.writeFileSync(file, JSON.stringify(db, null, 2) + '\n');
    console.error('saved profile "' + saveName + '" with ' + out.length + ' patch sites');
  }

  console.log(JSON.stringify(out, null, 2));
})();
