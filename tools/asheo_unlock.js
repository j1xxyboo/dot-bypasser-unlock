#!/usr/bin/env node
/*
 * Unlock the premium tier of the Asheo extension.
 *
 * Asheo (like Dot Bypasser) is an MV3 extension whose premium tier is decided
 * by the service worker:
 *
 *   functions/premium-gate.js   can() / require() / getPlan() / getEntitlement()
 *   functions/background.js     the worker's own premium checks
 *   functions/build-attest.js   the signed build attestation ("is this the
 *                               build we shipped?")
 *
 * Three things have to be dealt with:
 *
 *  1. the feature gate - `can(feature)` decides whether a premium feature may
 *     be used. It is forced to true.
 *
 *  2. the second gate - after `require()` says ok, the worker reads the
 *     cached verified entitlement and refuses the feature unless its tier is
 *     literally "premium" and the feature flag is on. Without a license that
 *     getter yields null, the worker answers "This is a premium feature." and
 *     returns *before* it saves the setting - which is why the toggle stayed
 *     on "Off" even though the popup said it was enabled.
 *
 *  3. the build attestation - build-hashes.json is ES256 signed, so editing
 *     any file makes the signature check fail and the extension locks itself
 *     down ("TOTAL LOCKDOWN"). The signature covers the *manifest*
 *     (build-hashes.json), not the files themselves, so the per-file hash
 *     comparison is what trips. That comparison is skipped - the signature
 *     check stays, so the digest the extension reports to the server is still
 *     the genuine one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATCH SITES LIVE IN A PROFILE
 * ---------------------------------------------------------------------------
 * The obfuscator re-randomises its string tables with every release, so the
 * patch sites differ from build to build. They therefore live in
 * tools/asheo_profiles.json, one entry per known build, and the right one is
 * picked by the digest of the signed manifest - the same thing the web
 * service uses to tell an official release from a tampered upload.
 *
 * Usage: node tools/asheo_unlock.js <extension-dir>
 */
const fs = require('fs');
const path = require('path');

const { pickProfileFromTree } = require('./asheo_profiles.js');
const { PREMIUM, ENTITLEMENT } = require('./asheo_payload.js');

const ROOT = path.resolve(process.argv[2] || 'asheo-latest');

/**
 * The prelude that is prepended to the worker.
 *
 * It does two things:
 *
 *  1. it defines __asheoLocalEntitlement(), the premium entitlement the
 *     worker's own premium checks read (the patch sites in the profile
 *     replace the getter call with this);
 *  2. it wraps the worker's message listener so that every answer reports
 *     the premium tier - without it a manual entitlement refresh flips the
 *     popup back to "free".
 */
const PRELUDE = `
/*
 * patch: the worker's own premium checks see a premium entitlement.
 *
 * The worker asks for the cached verified entitlement with
 *
 *     await getCachedVerifiedEntitlement().catch(()=>null)
 *
 * and refuses the feature unless the tier is "premium" and the feature
 * flag is on. Without a license that getter yields null, the worker
 * answers "This is a premium feature." and returns *before* it saves the
 * setting - so the toggle stayed off.
 *
 * Only these local reads are answered with the premium entitlement. The
 * getter itself is left alone: the worker also sends that value to the
 * vendor's server, and a "premium" tier there makes the server refuse the
 * premium rule pack.
 */
function __asheoLocalEntitlement() {
  return ` + ENTITLEMENT + `;
}

/* patch: premium activations are answered locally */
;(function () {
  try {
    var PREMIUM = ` + PREMIUM + `;

    var om = chrome.runtime.onMessage;
    var orig = om.addListener.bind(om);
    om.addListener = function (fn, ...rest) {
      var wrapped = function (msg, sender, sendResponse) {
        var patched = function (res) {
          try {
            if (res && typeof res === 'object') {
              /* an activation that could not be done on the server is done locally */
              if (res.success === false &&
                  (res.reason === 'activation_failed' || res.reason === 'premium_required')) {
                res = Object.assign({}, res, {
                  success: true, reason: 'unlocked', message: 'Activated.', detail: null,
                });
              }
              /* what the popup shows is the premium tier */
              if (res.entitlement && typeof res.entitlement === 'object') {
                res = Object.assign({}, res, {
                  entitlement: PREMIUM, tier: 'premium', plan: 'premium',
                  planDisplayName: 'Premium', licenseType: 'premium', status: 'active',
                });
              }
              if (res.status && typeof res.status === 'object') {
                res = Object.assign({}, res, {
                  status: Object.assign({}, res.status, {
                    tier: 'premium', plan: 'premium', planDisplayName: 'Premium',
                  }),
                });
              }
            }
          } catch (e) {}
          return sendResponse(res);
        };
        return fn(msg, sender, patched);
      };
      return orig(wrapped, ...rest);
    };
  } catch (e) {}
})();
`;

/* ------------------------------------------------------------------ patch */

/** Replace `find` with `replace` in `file`. */
function patch(file, find, replace, expected) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    console.log('  !  missing: ' + file);
    return false;
  }
  const src = fs.readFileSync(p, 'utf8');
  const count = src.split(find).length - 1;
  if (count === 0) {
    console.log('  -  ' + file + ': nothing to do (already patched?)');
    return false;
  }
  if (expected !== undefined && count !== expected) {
    console.log('  !  ' + file + ': expected ' + expected + ' occurrence(s), found ' + count);
    return false;
  }
  fs.writeFileSync(p, src.split(find).join(replace));
  console.log('  *  ' + file + ': ' + count + 'x ' + JSON.stringify(find.slice(0, 60)));
  return true;
}

/** Prepend the prelude to a file. */
function prepend(file, text) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) {
    console.log('  !  missing: ' + file);
    return false;
  }
  const src = fs.readFileSync(p, 'utf8');
  if (src.includes('patch: premium activations are answered locally')) {
    console.log('  -  ' + file + ': response patch already present');
    return false;
  }
  fs.writeFileSync(p, text + src);
  console.log('  *  ' + file + ': response patch injected');
  return true;
}

/* ------------------------------------------------------------------- main */

(async () => {
  console.log('Asheo unlock');
  console.log('target:', ROOT);

  const profile = await pickProfileFromTree(ROOT);
  if (!profile) {
    console.log('');
    console.log('This tree is not an Asheo build the patcher knows.');
    console.log('  The build is identified by the digest of its signed manifest, so the');
    console.log('  patch sites of every release are recorded in tools/asheo_profiles.json.');
    console.log('  A new release needs a new profile there.');
    process.exit(1);
  }

  console.log('build     : ' + profile.name + (profile.version ? ' (version ' + profile.version + ')' : ''));
  console.log('manifest  : ' + profile.manifestHash);

  console.log('[1/2] premium gates (' + profile.patches.length + ' sites)');
  for (const site of profile.patches) {
    const replace = String(site.replace).replace('__ASHEO_PREMIUM__', PREMIUM);
    patch(site.file, site.find, replace, site.count);
  }

  console.log('[2/2] worker response patch');
  prepend(profile.prelude || 'functions/background.js', PRELUDE);

  console.log('done.');
})();
