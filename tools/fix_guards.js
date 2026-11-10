const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* javascript-obfuscator "self defending" guard repair.
 *
 *   function G(){var v=G.p||(G.p=H(T,N));if(v===C){return T(...arguments)}else{while(true){}}}
 *
 * H(T,N) hashes the SOURCE TEXT of T. Editing T invalidates C, and the guard
 * then spins in while(true) -> the renderer hangs -> the extension page is black.
 * Fix: recompute C from the edited source and write it back.
 *
 * Usage: node --experimental-vm-modules fix_guards.js <file> [...]
 */

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


/** The chunk with the application code (the one popup.html loads). */
function appChunk(root) {
  for (const page of ['popup.html', 'options.html']) {
    const p = path.join(root, page);
    if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');
    const m = html.match(/src="\/chunks\/(main-[^"]+\.js)"/);
    if (m) return path.join(root, 'chunks', m[1]);
  }
  return null;
}

const GUARD_RE = new RegExp(
  '([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\|\\|\\(\\1\\.\\2=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*),(\\d+)\\)\\);' +
  'if\\(([A-Za-z_$][\\w$]*)===(\\d+)\\)\\{return \\4\\(\\.\\.\\.arguments\\)\\}else\\{while\\(true\\)\\{\\}\\}',
  'g'
);

function findGuards(src) {
  const out = [];
  let m;
  GUARD_RE.lastIndex = 0;
  while ((m = GUARD_RE.exec(src))) {
    out.push({
      hashFn: m[3], target: m[4], n: m[5],
      expected: m[7], varName: m[1],
      start: m.index,
      expectedStart: m.index + m[0].lastIndexOf(m[7]),
    });
  }
  return out;
}

function makeCtx() {
  const ctx = {
    console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date, RegExp, Error,
    Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, decodeURIComponent, encodeURIComponent,
    escape, unescape, parseInt, parseFloat, isNaN, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, structuredClone, module: { exports: {} }, require: x => stub('r.' + x),
  };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.navigator = stub('navigator'); ctx.location = stub('location');
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss'); ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: a => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = f => setTimeout(f, 0);
  vm.createContext(ctx);
  return ctx;
}

async function evalHashes(file, guards) {
  const dir = path.dirname(path.resolve(file));
  const src = fs.readFileSync(file, 'utf8');
  const ctx = makeCtx();
  const exprs = guards.map(g => `(()=>{try{return String(${g.hashFn}(${g.target},${g.n}))}catch(e){return "E:"+e.message}})()`);
  const epilogue = '\nglobalThis.__H__=[' + exprs.join(',') + '];\n';
  const tmp = path.join(dir, '__fg_' + path.basename(file).replace(/\.js$/, '') + '_' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, src + epilogue);
  const mk = p => new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { context: ctx, identifier: p });
  const linker = async (spec, ref) => {
    const p = path.resolve(path.dirname(ref.identifier), spec);
    const m = mk(p); await m.link(linker); await m.evaluate(); return m;
  };
  try { const m = mk(tmp); await m.link(linker); await m.evaluate(); }
  catch (e) { console.log('   eval error:', e.message); }
  const vals = ctx.__H__ || [];
  try { fs.unlinkSync(tmp); } catch {}
  return vals;
}

async function fixFile(file, maxRounds = 8) {
  const abs = path.resolve(file);
  let totalFixed = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const src = fs.readFileSync(abs, 'utf8');
    const guards = findGuards(src);
    if (!guards.length) { console.log(`${file}: no self-defending guards`); return totalFixed; }
    const vals = await evalHashes(abs, guards);
    const bad = guards.map((g, i) => ({ ...g, actual: vals[i] })).filter(g => g.actual !== g.expected);
    if (!bad.length) { console.log(`${file}: ${guards.length} guards OK (round ${round})`); return totalFixed; }
    // Rewrite each mismatched expected constant.
    let out = src;
    for (const b of bad) {
      const at = out.indexOf(b.expected, b.expectedStart - (b.start === 0 ? 0 : 0));
      const idx = out.indexOf(b.expected, b.expectedStart);
      if (idx === -1) { console.log('   cannot locate constant for', b.target); continue; }
      out = out.slice(0, idx) + b.actual + out.slice(idx + b.expected.length);
      totalFixed++;
      console.log(`   fixed ${b.target}: ${b.expected} -> ${b.actual}`);
    }
    fs.writeFileSync(abs, out);
  }
  console.log(`${file}: reached max rounds`);
  return totalFixed;
}

(async () => {
  let n = 0;
  for (const arg of process.argv.slice(2)) {
    // a directory: find the app chunk (the one the pages load)
    if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
      const chunk = appChunk(arg);
      if (!chunk) {
        console.error('no app chunk found in ' + arg);
        process.exit(1);
      }
      n += await fixFile(chunk);
      continue;
    }
    n += await fixFile(arg);
  }
  console.log('total constants repaired:', n);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
