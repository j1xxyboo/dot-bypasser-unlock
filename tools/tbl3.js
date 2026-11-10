const fs=require('fs'),vm=require('vm'),path=require('path');
function stub(n){return new Proxy(function(){},{get(t,p){if(p==='then')return undefined;if(p===Symbol.toPrimitive)return()=>undefined;if(p==='toString')return()=>'';if(p==='valueOf')return()=>0;if(p==='length')return 0;return stub(n+'.'+String(p));},apply(){return stub(n+'()');},construct(){return stub('new '+n);}});}

const file=path.resolve(process.argv[2]);
const table=process.argv[3];       // e.g. UdZOaAF
const decoder=process.argv[4];     // e.g. NF0xd1l
const dir=path.dirname(file);
const src=fs.readFileSync(file,'utf8');
const ctx={console,TextDecoder,TextEncoder,Buffer,Uint8Array,String,Array,Math,JSON,Date,RegExp,Error,Promise,Map,Set,WeakMap,WeakSet,Symbol,Proxy,Reflect,decodeURIComponent,encodeURIComponent,escape,unescape,parseInt,parseFloat,isNaN,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,structuredClone,module:{exports:{}},require:x=>stub('r.'+x)};
ctx.globalThis=ctx;ctx.self=ctx;ctx.window=ctx;ctx.top=ctx;ctx.global=ctx;
ctx.chrome=stub('chrome');ctx.browser=stub('browser');ctx.document=stub('document');ctx.navigator=stub('navigator');ctx.location=stub('location');
ctx.localStorage=stub('ls');ctx.sessionStorage=stub('ss');ctx.fetch=stub('fetch');ctx.indexedDB=stub('idb');
ctx.MutationObserver=stub('MO');ctx.ResizeObserver=stub('RO');ctx.IntersectionObserver=stub('IO');
ctx.crypto={subtle:{digest:async()=>new Uint8Array(32)},getRandomValues:a=>a};ctx.performance={now:()=>Date.now()};
ctx.requestAnimationFrame=f=>setTimeout(f,0);
vm.createContext(ctx);
const tmp=path.join(dir,'__tbl3.mjs');
fs.writeFileSync(tmp, src+'\nglobalThis.__DUMP__=(function(){var o={};for(var i=0;i<arguments.length;i++){try{var v='+decoder+'(arguments[i]);if(typeof v==="string")o["0x"+i.toString(16)]=v;}catch(e){}}return o;}).apply(null,'+table+');\n');
const MAIN=async()=>{
const mk=p=>new vm.SourceTextModule(fs.readFileSync(p,'utf8'),{context:ctx,identifier:p});
const linker=async(spec,ref)=>{const p=path.resolve(path.dirname(ref.identifier),spec);const m=mk(p);await m.link(linker);await m.evaluate();return m;};
try{const m=mk(tmp);await m.link(linker);await m.evaluate();}catch(e){console.error('ERR',e.message);}
const d=ctx.__DUMP__||{};
const needle=process.argv[5]?process.argv[5].toLowerCase():null;
for(const k of Object.keys(d)){ if(!needle||d[k].toLowerCase().includes(needle)) console.log(k, JSON.stringify(d[k])); }
try{fs.unlinkSync(tmp);}catch{}
};
MAIN();
