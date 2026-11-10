const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Audit the javascript-obfuscator "self-defending" guards.
   Pattern:  function G(){var v=G.p||(G.p=VvCBdcb(T,N));if(v===C){return T(...arguments)}else{while(true){}}}
   The guard hashes the SOURCE TEXT of T. Editing T breaks the hash -> infinite loop.
   This script finds every guard, evaluates VvCBdcb(T,N) in a sandbox, and reports
   whether it still equals C.                                          */

function stub(n){return new Proxy(function(){},{get(t,p){if(p==='then')return undefined;if(p===Symbol.toPrimitive)return()=>undefined;if(p==='toString')return()=>'';if(p==='valueOf')return()=>0;if(p==='length')return 0;return stub(n+'.'+String(p));},apply(){return stub(n+'()');},construct(){return stub('new '+n);}});}

/* The same generic pattern that tools/fix_guards.js uses - the name of the
   hash function changes with every build, so it must not be hard coded. */
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
    out.push({ guard: m[1], hashFn: m[3], target: m[4], n: m[5], expected: m[7], at: m.index });
  }
  return out;
}

async function audit(file) {
  const dir = path.dirname(path.resolve(file));
  const src = fs.readFileSync(file, 'utf8');
  const guards = findGuards(src);
  if (!guards.length) return { file, total: 0, bad: [], note: 'no self-defending guards' };

  const ctx = { console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date, RegExp, Error, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, decodeURIComponent, encodeURIComponent, escape, unescape, parseInt, parseFloat, isNaN, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, module: { exports: {} }, require: x => stub('r.' + x) };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.navigator = stub('navigator'); ctx.location = stub('location');
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss'); ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: a => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = f => setTimeout(f, 0);
  vm.createContext(ctx);

  // the hash function is looked up by its name in the file's own scope
  const exprs = guards.map(g => `(()=>{try{return String(${g.hashFn}(${g.target},${g.n}))}catch(e){return "E:"+e.message}})()`);
  const epilogue = '\nglobalThis.__G__=[' + exprs.join(',') + '];\n';
  const tmp = path.join(dir, '__audit_' + path.basename(file).replace(/\.js$/, '') + '_' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, src + epilogue);
  const mk = p => new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { context: ctx, identifier: p });
  const linker = async (spec, ref) => {
    const p = path.resolve(path.dirname(ref.identifier), spec);
    const m = mk(p); await m.link(linker); await m.evaluate(); return m;
  };
  try { const m = mk(tmp); await m.link(linker); await m.evaluate(); }
  catch (e) { console.log('EVALERR', e.message); }
  const vals = ctx.__G__ || [];
  const bad = [];
  guards.forEach((g, i) => {
    if (vals[i] !== g.expected) bad.push({ ...g, actual: vals[i] });
  });
  try { fs.unlinkSync(tmp); } catch {}
  return { file, total: guards.length, bad };
}

(async () => {
  let allBad = [];
  for (const f of process.argv.slice(2)) {
    const r = await audit(f);
    console.log(`${r.file}: ${r.total} guards, ${r.bad.length} MISMATCHED`);
    for (const b of r.bad) {
      console.log(`   guard ${b.guard} -> target ${b.target}(${b.n})  expected ${b.expected}  actual ${b.actual}`);
      allBad.push({ file: r.file, ...b });
    }
  }
  if (allBad.length) {
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(allBad.map(b => ({ file: b.file, guard: b.guard, target: b.target, n: b.n, expected: b.expected, actual: b.actual })), null, 2));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
