'use strict';
/*
 * Minimal ZIP reader/writer (no dependencies).
 *
 * The patch service has to take a .zip (or the .crx that contains one) apart
 * and hand a patched archive back. Node has zlib but no zip, and the service
 * should not require the `zip`/`unzip` command line tools to be installed.
 *
 * Only what is needed here:
 *   - read:  stored (method 0) and deflated (method 8) entries
 *   - write: stored and deflated entries
 *
 * Directory entries are skipped, file names are validated against zip-slip
 * ("../" and absolute paths).
 */
const zlib = require('zlib');

/* ------------------------------------------------------------------ read */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} file name -> content
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');

  // locate the end of central directory record
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file (no end of central directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== SIG_CEN) throw new Error('corrupt zip (central directory)');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    if (buf.readUInt32LE(localOff) !== SIG_LOC) throw new Error('corrupt zip (local header)');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} in ${name}`);

    out.set(name, data);
  }
  return out;
}

/* ----------------------------------------------------------------- write */

/**
 * @param {Map<string, Buffer>|Object<string, Buffer>} files
 * @returns {Buffer} a zip archive
 */
function writeZip(files) {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x21, 12);         // mod date (1996-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CEN, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra len
    central.writeUInt16LE(0, 32);          // comment len
    central.writeUInt16LE(0, 34);          // disk number
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE(0, 38);          // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ crc */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ----------------------------------------------------------------- crx */

/**
 * A .crx file is a small header followed by the zip archive.
 * Returns the zip part, or the buffer itself when it already is a zip.
 */
function crxToZip(buf) {
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === 'Cr24') {
    // Cr24 | version (4) | header length (4) | header ... | zip
    const headerLen = buf.readUInt32LE(8);
    return buf.subarray(12 + headerLen);
  }
  return buf;
}

/** Reject names that would escape the target directory. */
function safeName(name) {
  if (!name || name.startsWith('/') || name.includes('..') || name.includes('\0')) {
    throw new Error(`unsafe file name in archive: ${JSON.stringify(name)}`);
  }
  return name;
}

module.exports = { readZip, writeZip, crxToZip, safeName };
