const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* Probe a plain (non-module) script's own scope by appending an epilogue
   that copies the string tables we care about onto globalThis. */

function stub(n){return new Proxy(function(){},{get(t,p){if(p==='then')return undefined;if(p===Symbol.toPrimitive)return()=>undefined;if(p==='toString')return()=>'';if(p==='valueOf')return()=>0;if(p==='length')return 0;return stub(n+'.'+String(p));},apply(){return stub(n+'()');},construct(){return stub('new '+n);}});}

const file = path.resolve(process.argv[2]);
const tableName = process.argv[3];      // e.g. mIno9Zz
const decoder = process.argv[4] || 'q_7LT1h'; // decoder fn
const maxIdx = parseInt(process.argv[5] || '0x2000', 10);

const ctx = { console, TextDecoder, TextEncoder, Buffer, Uint8Array, String, Array, Math, JSON, Date, RegExp, Error, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect, decodeURIComponent, encodeURIComponent, escape, unescape, parseInt, parseFloat, isNaN, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, require: x => stub('r.' + x) };
ctx.globalThis = ctx; ctx.self = ctx; ctx.window = ctx; ctx.top = ctx; ctx.global = ctx;
ctx.chrome = stub('chrome'); ctx.browser = stub('browser'); ctx.document = stub('document');
ctx.navigator = stub('navigator'); ctx.location = stub('location');
ctx.localStorage = stub('ls'); ctx.sessionStorage = stub('ss'); ctx.fetch = stub('fetch'); ctx.indexedDB = stub('idb');
ctx.MutationObserver = stub('MO'); ctx.ResizeObserver = stub('RO'); ctx.IntersectionObserver = stub('IO');
ctx.crypto = { subtle: { digest: async () => new Uint8Array(32) }, getRandomValues: a => a };
ctx.performance = { now: () => Date.now() };
ctx.requestAnimationFrame = f => setTimeout(f, 0);
vm.createContext(ctx);

const src = fs.readFileSync(file, 'utf8');
const idxs = [];
for (let i = 0; i < maxIdx; i++) idxs.push(i);
const exprs = idxs.map(i => `(()=>{try{return ${decoder}(${tableName}[${i}])}catch(e){return null}})()`);
const epilogue = `\n;globalThis.__T__=[${exprs.join(',')}];\n`;
const tmp = path.join(path.dirname(file), '__tbl_' + path.basename(file) + '.js');
fs.writeFileSync(tmp, src + epilogue);

try { vm.runInContext(fs.readFileSync(tmp, 'utf8'), ctx, { timeout: 120000 }); }
catch (e) { console.error('RUN ERROR:', e.message); }

const vals = ctx.__T__ || [];
const needle = process.argv[6] ? process.argv[6].toLowerCase() : null;
idxs.forEach((i, k) => {
  const v = vals[k];
  if (typeof v !== 'string') return;
  if (!needle || v.toLowerCase().includes(needle)) console.log(i.toString(16), JSON.stringify(v));
});
try { fs.unlinkSync(tmp); } catch {}
process.exit(0);
