const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Evaluate expressions INSIDE an ES module's own scope by appending an
   export-of-globals epilogue, then linking normally. */

function stub(name){return new Proxy(function(){},{get(t,p){if(p==='then')return undefined;if(p===Symbol.toPrimitive)return ()=>undefined;if(p==='toString')return ()=>'';if(p==='valueOf')return ()=>0;if(p==='length')return 0;return stub(name+'.'+String(p));},apply(){return stub(name+'()');},construct(){return stub('new '+name);}});}

async function evalInModule(file, exprs, opts = {}) {
  const ctx = { console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date, RegExp, Error, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, decodeURIComponent, encodeURIComponent, escape, unescape, parseInt, parseFloat, isNaN, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, module: { exports: {} }, require: (x) => stub('r.' + x) };
  ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
  ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
  ctx.navigator = stub('navigator'); ctx.location = stub('location');
  ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss'); ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
  ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
  ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: (a) => a };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = (f) => setTimeout(f, 0);
  vm.createContext(ctx);

  const src = fs.readFileSync(file, 'utf8');
  const epilogue = '\nglobalThis.__M__={' + exprs.map((e, i) => `k${i}:(()=>{try{return (${e})}catch(e){return "__ERR__"+e.message}})()`).join(',') + '};\n';
  const tmp = path.join(path.dirname(file), '__mprobe_' + path.basename(file).replace(/\.js$/, '') + '_' + Date.now() + '.mjs');
  fs.writeFileSync(tmp, src + epilogue);

  const mk = (p) => new vm.SourceTextModule(fs.readFileSync(p, 'utf8'), { context: ctx, identifier: p });
  const linker = async (spec, ref) => {
    const p = path.resolve(path.dirname(ref.identifier), spec);
    const m = mk(p);
    await m.link(linker);
    await m.evaluate();
    return m;
  };
  try {
    const m = mk(tmp);
    await m.link(linker);
    await m.evaluate();
  } catch (e) {
    console.error('MODULE EVAL ERROR:', e.message);
  }
  const out = ctx.__M__ || {};
  exprs.forEach((e, i) => console.log(e, '=>', JSON.stringify(out['k' + i])));
  try { fs.unlinkSync(tmp); } catch {}
  return out;
}

(async () => {
  const file = process.argv[2];
  await evalInModule(file, process.argv.slice(3));
  process.exit(0);
})();
