/*
 * The Asheo build profiles: one per known build of the extension.
 *
 * Asheo ships a signed manifest (build-hashes.json + build-hashes.sig): the
 * manifest lists the sha256 of every packaged file and is signed with ES256
 * by the vendor's release key. That signature is what tells an upload apart
 * from a tampered one, so the web service verifies it before it patches
 * anything.
 *
 * The obfuscator re-randomises its string tables with every release, so the
 * *patch sites* differ from build to build. Each known build therefore has a
 * profile with its own sites, and the profile is looked up by the digest of
 * the signed manifest - which also identifies the build exactly.
 *
 * A new profile is added by running the patcher against a fresh release and
 * recording the sites it reports.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'asheo_profiles.json');

/*
 * The vendor's ES256 public key (from functions/build-attest.js). It is pinned
 * here on purpose: reading it from the upload would make the check circular,
 * because the upload is what is being verified.
 */
const BUILD_PUBLIC_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'ZFgFWayMmv3R8LjroZYbUHSOUv_FQTQtBcEtTuodwQw',
  y: 'uzQXpG7YIHBF6M5EVDk-9PsX7q5-dySAU9C68anCOj8',
};

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).profiles || [];
  } catch (e) {
    return [];
  }
}

/** base64url -> Buffer */
function b64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Verify the signed manifest of an upload.
 *
 * Two things are checked:
 *
 *   1. the ES256 signature over build-hashes.json - proves the manifest is
 *      the vendor's and not something the uploader wrote;
 *   2. the sha256 of every file the manifest lists - proves the files are
 *      the ones the vendor shipped.
 *
 * Together they mean the upload is an authentic official build, and the
 * digest of the manifest identifies that build.
 *
 * @param {(name: string) => Buffer|undefined} read a file of the build
 * @returns {Promise<{ok: boolean, manifestHash: string|null, version: string|null,
 *                     problems: string[]}>}
 */
async function verifyOfficial(read) {
  const problems = [];

  const manifestBuf = read('build-hashes.json');
  const sigBuf = read('build-hashes.sig');
  if (!manifestBuf) problems.push('the archive has no build-hashes.json');
  if (!sigBuf) problems.push('the archive has no build-hashes.sig');
  if (problems.length) return { ok: false, manifestHash: null, version: null, problems };

  // 1. the signature
  let claim = null;
  try {
    const parts = sigBuf.toString('utf8').trim().split('.');
    if (parts.length !== 3) throw new Error('the signature is not a JWS');
    const key = await crypto.subtle.importKey(
      'jwk', BUILD_PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64u(parts[2]),
      Buffer.from(parts[0] + '.' + parts[1])
    );
    if (!ok) throw new Error('the signature does not verify against the vendor key');
    claim = JSON.parse(b64u(parts[1]).toString('utf8'));
  } catch (e) {
    problems.push('build-hashes.sig does not verify: ' + (e && e.message ? e.message : e));
    return { ok: false, manifestHash: null, version: null, problems };
  }

  // the manifest the signature covers
  const manifestHash = crypto.createHash('sha256').update(manifestBuf).digest('hex');
  if (claim.manifestHash !== manifestHash) {
    problems.push('build-hashes.json does not match its signature');
    return { ok: false, manifestHash: null, version: null, problems };
  }

  // 2. every file the manifest lists
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    problems.push('build-hashes.json is not valid JSON');
    return { ok: false, manifestHash: null, version: null, problems };
  }
  const entries = Array.isArray(manifest.files) ? manifest.files : null;
  if (!entries) {
    problems.push('build-hashes.json has no files[] list');
    return { ok: false, manifestHash: null, version: null, problems };
  }
  if (Number(claim.fileCount) !== entries.length) {
    problems.push(`build-hashes.json lists ${entries.length} files, its signature says ${claim.fileCount}`);
    return { ok: false, manifestHash: null, version: null, problems };
  }

  let mismatched = 0;
  let missing = 0;
  const listed = new Set();
  for (const entry of entries) {
    const p = String(entry.path);
    listed.add(p);
    const data = read(p);
    if (!data) { missing++; continue; }
    if (crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) mismatched++;
  }
  if (missing) problems.push(`${missing} file(s) of the release are missing from the archive`);
  if (mismatched) problems.push(`${mismatched} file(s) do not match the signed manifest`);

  // the manifest and its signature are not listed in the manifest itself
  listed.add('build-hashes.json');
  listed.add('build-hashes.sig');

  // nothing else may be in the archive: the patched build is handed back to
  // the user as an extension, so it must contain exactly the official files
  const extra = [];
  if (typeof read.all === 'function') {
    for (const name of read.all()) {
      if (!listed.has(name)) extra.push(name);
    }
  }
  if (extra.length) {
    problems.push(`${extra.length} file(s) are not part of the official release: ${extra.slice(0, 5).join(', ')}`);
  }

  return {
    ok: !missing && !mismatched && !extra.length,
    manifestHash,
    version: claim.version || (manifest.manifest && manifest.manifest.version) || null,
    problems,
  };
}

/** The profile of a build, by the digest of its signed manifest. */
function pickProfile(manifestHash) {
  for (const profile of load()) {
    if (profile.manifestHash === manifestHash) return profile;
  }
  return null;
}

/**
 * The profile of a tree on disk - used by the command line patcher, which
 * works on a directory instead of a zip.
 */
async function pickProfileFromTree(root) {
  const read = (name) => {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) return undefined;
    return fs.readFileSync(p);
  };
  const v = await verifyOfficial(read);
  if (!v.ok) return null;
  return pickProfile(v.manifestHash);
}

module.exports = {
  load,
  pickProfile,
  pickProfileFromTree,
  verifyOfficial,
  BUILD_PUBLIC_JWK,
};
