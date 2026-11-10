const fs=require('fs'),vm=require('vm'),path=require('path');
function stub(n){return new Proxy(function(){},{get(t,p){if(p==='then')return undefined;if(p===Symbol.toPrimitive)return()=>undefined;if(p==='toString')return()=>'';if(p==='valueOf')return()=>0;if(p==='length')return 0;return stub(n+'.'+String(p));},apply(){return stub(n+'()');},construct(){return stub('new '+n);}});}

const file=path.resolve(process.argv[2]);
const src=fs.readFileSync(file,'utf8');
const ctx={console,TextDecoder,TextEncoder,Buffer,Uint8Array,String,Array,Math,JSON,Date,RegExp,Error,Promise,Map,Set,WeakMap,WeakSet,Symbol,Proxy,Reflect,decodeURIComponent,encodeURIComponent,escape,unescape,parseInt,parseFloat,isNaN,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,structuredClone,require:x=>stub('r.'+x)};
ctx.globalThis=ctx;ctx.self=ctx;ctx.window=ctx;ctx.top=ctx;ctx.global=ctx;
ctx.chrome=stub('chrome');ctx.browser=stub('browser');ctx.document=stub('document');ctx.navigator=stub('navigator');ctx.location=stub('location');
ctx.localStorage=stub('ls');ctx.sessionStorage=stub('ss');ctx.fetch=stub('fetch');ctx.indexedDB=stub('idb');
ctx.MutationObserver=stub('MO');ctx.ResizeObserver=stub('RO');ctx.IntersectionObserver=stub('IO');
ctx.crypto={subtle:{digest:async()=>new Uint8Array(32)},getRandomValues:a=>a};ctx.performance={now:()=>Date.now()};
ctx.requestAnimationFrame=f=>setTimeout(f,0);
vm.createContext(ctx);
const tmp=path.join(path.dirname(file),'__cfg.js');
fs.writeFileSync(tmp, src+'\nglobalThis.__CFG__=sCzieD;');
try{vm.runInContext(fs.readFileSync(tmp,'utf8'),ctx,{timeout:180000});}catch(e){console.error('ERR',e.message);}
console.log(JSON.stringify(ctx.__CFG__,null,1));
try{fs.unlinkSync(tmp);}catch{}
