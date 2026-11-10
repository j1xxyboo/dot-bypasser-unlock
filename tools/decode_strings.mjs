/*
 * Decode the obfuscated strings of an Asheo module.
 *
 *   node tools/decode_strings.mjs functions/background.js [needle]
 *
 * The obfuscator keeps its strings in a module level table and decodes them
 * through a chain of pure functions (index -> table entry -> decoder). The
 * decoder functions are collected here, evaluated in a VM and then called for
 * every index, so the result is exactly what the extension sees at runtime.
 *
 * The helpers can live at different nesting levels, so they are pulled in on
 * demand: whenever the VM reports a missing name, that function is added and
 * the whole thing is evaluated again (in a fresh context).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const file = path.resolve(process.argv[2]);
const needle = process.argv[3] || '';
const src = fs.readFileSync(file, 'utf8');

/* the import statements carry braces ({a,b} from "...") that would throw the
 * brace depth off for the whole file, so they are blanked out (same length,
 * so every offset stays valid) */
const importless = src.replace(
  /import\s*(?:\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\})\s*from\s*"[^"]*"\s*;?/g,
  (m) => ' '.repeat(m.length)
);

/** brace depth of every position (strings and comments skipped) */
function scan(s) {
  const depth = new Int32Array(s.length + 1);
  let d = 0, instr = null, esc = false, line = false, block = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (line) { if (c === '\n') line = false; depth[i] = d; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } depth[i] = d; continue; }
    if (instr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === instr) instr = null;
      depth[i] = d; continue;
    }
    if (c === '/' && n === '/') { line = true; depth[i] = d; continue; }
    if (c === '/' && n === '*') { block = true; depth[i] = d; continue; }
    if (c === '"' || c === "'" || c === '`') { instr = c; depth[i] = d; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
    depth[i] = d;
  }
  return depth;
}

const depth = scan(importless);

/** the index of the bracket that closes the one at `open` (string aware) */
function matchBracket(open) {
  const openCh = src[open];
  const closeCh = openCh === '{' ? '}' : openCh === '[' ? ']' : ')';
  let d = 0, instr = null, esc = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (instr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === instr) instr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { instr = c; continue; }
    if (c === openCh) d++;
    else if (c === closeCh) { d--; if (d === 0) return i; }
  }
  return -1;
}

/* every function declaration in the file, by name (the shallowest one wins) */
const fnSrc = new Map();
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  const open = src.indexOf('{', m.index);
  if (open < 0) continue;
  const end = matchBracket(open);
  if (end < 0) continue;
  const text = src.slice(m.index, end + 1);
  const d = depth[m.index];
  const prev = fnSrc.get(m[1]);
  if (!prev || d < prev.depth) fnSrc.set(m[1], { text, depth: d });
}

/* every module level literal array */
const arrSrc = new Map();
for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)) {
  if (depth[m.index] !== 0) continue;
  const open = src.indexOf('[', m.index);
  const end = matchBracket(open);
  if (end < 0) continue;
  arrSrc.set(m[1], src.slice(m.index, end + 1) + ';');
}

function makeCtx() {
  const c = {
    console, TextDecoder, TextEncoder, Buffer, Uint8Array, Int8Array, Int32Array,
    Float64Array, ArrayBuffer, DataView, String, Array, Math, JSON, Date, RegExp,
    Error, TypeError, Promise, Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
    BigInt, Intl, URL, URLSearchParams, parseInt, parseFloat, isNaN,
    decodeURIComponent, encodeURIComponent, escape, unescape,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    structuredClone,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  c.globalThis = c; c.self = c; c.window = c; c.top = c; c.global = c;
  c.location = {
    protocol: 'chrome-extension:', href: 'chrome-extension://t/x.html', host: 't',
    hostname: 't', origin: 'chrome-extension://t', search: '', hash: '', pathname: '/x.html',
  };
  c.navigator = { userAgent: 'Mozilla/5.0 Chrome/131', platform: 'Linux x86_64', language: 'en-US' };
  const stubFn = () => new Proxy(function () {}, {
    get: () => stubFn(), apply: () => stubFn(), construct: () => stubFn(),
  });
  c.chrome = new Proxy({}, { get: () => stubFn() });
  c.performance = { now: () => Date.now() };
  vm.createContext(c);
  return c;
}

let ctx = makeCtx();

/* the code that is evaluated: the picked functions and the tables */
const picked = new Set();
function code() {
  const parts = [];
  for (const n of picked) parts.push(fnSrc.get(n).text);
  for (const t of arrSrc.values()) parts.push(t);
  return parts.join('\n');
}

/* evaluate in a fresh context; returns the first missing name, or null */
function evaluate() {
  ctx = makeCtx();
  const c = code();
  const names = [...picked];
  const epilogue = '\nglobalThis.__E={' + names.map((n) =>
    n + ':typeof ' + n + '!=="undefined"?' + n + ':undefined').join(',') + '};';
  try {
    vm.runInContext(c + epilogue, ctx, { timeout: 120000 });
    return null;
  } catch (e) {
    const m = /(\w+) is not defined/.exec(String(e && e.message));
    if (m && fnSrc.has(m[1])) return m[1];
    return 'ERR:' + String(e && e.message).slice(0, 200);
  }
}

/* seed: the module level functions */
for (const [n, v] of fnSrc) if (v.depth === 0) picked.add(n);

for (let round = 0; round < 60; round++) {
  const missing = evaluate();
  if (!missing) break;
  if (missing.startsWith('ERR:')) { console.log('eval failed: ' + missing.slice(4)); process.exit(1); }
  picked.add(missing);
}

/* find the accessor: a function that turns an index into a string */
const tables = Object.keys(ctx).filter((k) => Array.isArray(ctx[k]) && ctx[k].length > 20 && ctx[k].every((v) => typeof v === 'string'));
if (!tables.length) { console.log('no string table found'); process.exit(1); }
const tableName = tables[0];
const table = ctx[tableName];
console.log('table ' + tableName + ' (' + table.length + ' entries)');

const BUILTINS = new Set(['String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Date',
  'RegExp', 'Error', 'TypeError', 'Proxy', 'Reflect', 'Symbol', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'decodeURIComponent',
  'encodeURIComponent', 'escape', 'unescape', 'atob', 'btoa', 'structuredClone',
  'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'require']);

const fns = Object.keys(ctx).filter((k) => typeof ctx[k] === 'function' && !BUILTINS.has(k));
let accessor = null, accessorName = '';
for (const fn of fns) {
  const decl = new RegExp('function\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{[^}]*' + tableName + '\\[');
  if (!decl.test(src)) continue;
  let ok = 0;
  for (let i = 0; i < table.length && ok < 3; i++) {
    let out;
    try { out = ctx[fn](i); } catch (e) {
      const miss = /(\w+) is not defined/.exec(String(e && e.message));
      if (miss && fnSrc.has(miss[1]) && !picked.has(miss[1])) {
        picked.add(miss[1]);
        const r = evaluate();
        if (r) console.log('  (adding ' + miss[1] + ' -> ' + r + ')');
        try { out = ctx[fn](i); } catch (e2) { out = undefined; }
      }
    }
    if (typeof out === 'string' && out.length && out.length < 300) ok++;
  }
  if (ok >= 3) { accessor = ctx[fn]; accessorName = fn; break; }
}
if (!accessor) { console.log('no accessor found'); process.exit(1); }
console.log('accessor: ' + accessorName + '(index)');

const decoded = [];
for (let i = 0; i < table.length; i++) {
  let out;
  try { out = accessor(i); } catch (e) { out = undefined; }
  if (typeof out === 'string') decoded.push([i, out]);
}
console.log('decoded ' + decoded.length + ' strings');

if (!needle) {
  for (const d of decoded) console.log(d[0] + ': ' + JSON.stringify(d[1]));
  process.exit(0);
}
const hits = decoded.filter((d) => d[1].toLowerCase().includes(needle.toLowerCase()));
if (!hits.length) {
  console.log('"' + needle + '" not found');
  process.exit(0);
}
for (const h of hits) {
  console.log('index ' + h[0] + ' -> ' + JSON.stringify(h[1]));
  const re = new RegExp(accessorName + '\\(\\s*(0x[0-9a-fA-F]+|\\d+)\\s*\\)', 'g');
  for (const m of src.matchAll(re)) {
    if (parseInt(m[0].match(/\d+/)[0]) !== h[0]) continue;
    console.log('  used at ' + m.index + ': ...' +
      src.slice(Math.max(0, m.index - 160), m.index + 120).replace(/\n/g, ' ') + '...');
  }
}
