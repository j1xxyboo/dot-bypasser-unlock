/*
 * The build profiles: one per known build of the extension.
 *
 * The obfuscator re-randomises its string tables with every release, so the
 * premium patch sites differ from build to build. tools/emit_patches.js finds
 * them and stores them here; unlock_dot.js, tools/inspect.js and the web
 * service all pick the profile that matches the tree in front of them.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'profiles.json');

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).profiles || [];
  } catch (e) {
    return [];
  }
}

/** Does this profile describe the tree in front of us? */
function profileMatches(profile, root) {
  for (const site of profile.patches) {
    const file = path.join(root, site.file);
    if (!fs.existsSync(file)) return false;
    if (!fs.readFileSync(file, 'utf8').includes(site.find)) return false;
  }
  return true;
}

/** The profile that matches the tree, or null. */
function pickProfile(root) {
  for (const profile of load()) {
    if (profileMatches(profile, root)) return profile;
  }
  return null;
}

/**
 * The profile of a tree - also works for a tree that was already patched,
 * because the files that are not patched keep their original digests.
 */
function identifyProfile(root) {
  const crypto = require('crypto');
  const fs2 = require('fs');
  const path2 = require('path');
  const digest = (f) => crypto.createHash('sha256').update(fs2.readFileSync(f)).digest('hex');

  for (const profile of load()) {
    const known = profile.files || {};
    const patched = new Set((profile.patches || []).map((s2) => s2.file));
    let hits = 0;
    let total = 0;
    for (const [rel, want] of Object.entries(known)) {
      if (patched.has(rel)) continue;      // these are changed by the patcher
      total++;
      const f = path2.join(root, rel);
      if (fs2.existsSync(f) && digest(f) === want) hits++;
    }
    if (total && hits / total > 0.8) return profile;
  }
  return pickProfile(root);
}

module.exports = { load, profileMatches, pickProfile, identifyProfile, FILE };
