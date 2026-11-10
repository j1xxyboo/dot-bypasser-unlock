#!/usr/bin/env node
/*
 * Unlock the premium tier of the Asheo extension.
 *
 * Asheo (like Dot Bypasser) is an MV3 extension whose premium tier is decided
 * by the service worker:
 *
 *   functions/premium-gate.js   can() / require() / getPlan() / getEntitlement()
 *   functions/build-attest.js   the signed build attestation ("is this the
 *                               build we shipped?")
 *
 * Two things have to be dealt with:
 *
 *  1. the feature gate - `can(feature)` decides whether a premium feature may
 *     be used. It is forced to true.
 *
 *  2. the build attestation - build-hashes.json is ES256 signed, so editing
 *     any file makes the signature check fail and the extension locks itself
 *     down ("TOTAL LOCKDOWN"). The signature covers the *manifest*
 *     (build-hashes.json), not the files themselves, so the per-file hash
 *     comparison is what trips. That comparison is skipped - the signature
 *     check stays, so the digest the extension reports to the server is still
 *     the genuine one.
 *
 * Usage: node tools/asheo_unlock.js <extension-dir>
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || 'asheo-latest');

function patch(file, find, replace, expected = 1) {
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
  if (count !== expected) {
    console.log('  !  ' + file + ': expected ' + expected + ' occurrence(s), found ' + count);
    return false;
  }
  fs.writeFileSync(p, src.split(find).join(replace));
  console.log('  *  ' + file + ': ' + JSON.stringify(find.slice(0, 60)));
  return true;
}

console.log('Asheo unlock');
console.log('target:', ROOT);

console.log('[1/3] premium gate');
patch('functions/premium-gate.js',
  'export async function can(feature){',
  'export async function can(feature){return true;');
patch('functions/premium-gate.js',
  'export async function require(feature){',
  'export async function require(feature){return true;');

console.log('[2/3] entitlement');
/*
 * The popup asks the background for {action:"premium.get"} and gets this
 * shape back (captured from the running extension):
 *
 *   { tier:"free", source:"license", isFounder:false,
 *     features:{browserMods:false, ruleOpsLab:false, liveHud:false,
 *               advancedProtection:false, apiAccess:false, experimentalFeatures:false},
 *     capabilities:{customEncryptedGateways:false, binGenerator:false, adyenGateway:false},
 *     limits:{binPool:2, ccQueue:10, ruleLimit:20, profileLimit:2, randomRouting:false},
 *     plan:"free", planDisplayName:"Free", licenseType:"free", status:"inactive", ... }
 *
 * The same object with everything switched on is what a premium install sees.
 */
const PREMIUM = [
  '{',
  '"tier":"premium","source":"license","isFounder":true,',
  '"features":{"browserMods":true,"ruleOpsLab":true,"liveHud":true,',
  '"advancedProtection":true,"apiAccess":true,"experimentalFeatures":true},',
  '"capabilities":{"customEncryptedGateways":true,"binGenerator":true,"adyenGateway":true},',
  '"limits":{"binPool":9999,"ccQueue":9999,"ruleLimit":99999,"profileLimit":999,"randomRouting":true},',
  '"expiresAt":null,"plan":"premium","planDisplayName":"Premium","licenseType":"premium",',
  '"status":"active","activatedAt":Date.now(),"nextBillingDate":null,',
  '"seatsAllowed":999,"seatsUsed":0,"activationCount":1,"maxActivations":null,',
  '"currentDeviceId":null,"deviceLocked":false,"canTransfer":true,',
  '"featureKeys":["browserMods","ruleOpsLab","liveHud","advancedProtection",',
  '"apiAccess","experimentalFeatures"],"customFeatures":{},',
  '"capabilityKeys":["customEncryptedGateways","binGenerator"],',
  '"limitKeys":["binPool","ccQueue","ruleLimit","profileLimit","randomRouting"],',
  '"metadata":{},"kid":null,"kind":"license","keyName":null,"jti":"unlocked",',
  '"activated":true',
  '}',
].join('');

patch('functions/premium-gate.js',
  'export async function getEntitlement(){',
  'export async function getEntitlement(){return ' + PREMIUM + ';');

/*
 * getPlan() is the second half of the story: the background builds the
 * "status" the popup shows from it (plan, planDisplayName, tier). The
 * original return is kept and the premium fields are added.
 */
patch('functions/premium-gate.js',
  'return{[getVerifiedEntitlement(0xd7)]:{},[getVerifiedEntitlement(0xd8)]:{},' +
  '[getVerifiedEntitlement(0xd9)]:getVerifiedEntitlement(0xda)}}',
  'return{[getVerifiedEntitlement(0xd7)]:{},[getVerifiedEntitlement(0xd8)]:{},' +
  '[getVerifiedEntitlement(0xd9)]:"premium",kind:"premium",plan:"premium",' +
  'planDisplayName:"Premium",tier:"premium",licenseType:"premium",status:"active",' +
  'seat:null,seats:null}}');

/*
 * The license status the popup shows comes from getLicenseStatus()
 * (license-client.js). It reports the cached license state of the vendor's
 * server, so it is switched over as well.
 */
patch('functions/license-client.js',
  'export const getLicenseStatus=_getLicenseStatus;',
  'export const getLicenseStatus=()=>({at:Date.now(),error:null,ok:true,plan:"premium",' +
  'planDisplayName:"Premium",seat:null,seats:null,tier:"premium"});');

/*
 * The cached entitlement is what the worker sends to the vendor's server and
 * what decides which rule pack it downloads. It is deliberately NOT faked:
 * with a "premium" cached entitlement the worker asks for the premium pack,
 * the server (no license on file) refuses it, and the extension ends up with
 * no payment rules at all and a timing-out entitlement refresh.
 *
 * The local premium decision is made in two other places:
 *   - getEntitlement()  -> what the popup shows
 *   - the response patch in functions/background.js -> the activation
 */

/*
 * Switching a feature on does not only ask for the entitlement, it also asks
 * for an *activation token* from the vendor's server (feature-activation.js).
 * Without a server that request fails and the extension answers
 * "Premium check failed. Try again.".
 *
 * The token itself is NOT faked here: the real token is what the extension
 * sends to the vendor's server for the rule pack and the entitlement
 * refresh, and faking it broke both ("No payment rules found", "Timeout:
 * entitlement.refresh"). The activation is solved one level up instead - see
 * the response patch in functions/background.js.
 */

console.log('[3/3] build attestation');
// The signature check over build-hashes.json stays; only the per-file hash
// comparison is skipped, so a modified build is not detected locally.
patch('functions/build-attest.js',
  "      if (got !== want) return permanentFail('file-modified', p);",
  '      if (got !== want) { /* patch: the per-file hash check is skipped */ }');

console.log('[4/4] worker response patch');
/*
 * Switching a premium feature on asks the worker to *activate* it: the worker
 * requests an activation token from the vendor's server and answers
 *
 *   { success:false, reason:"activation_failed",
 *     message:"Premium check failed. Try again." }
 *
 * when that request cannot be made. The listener is wrapped so that such an
 * answer is turned into a success - the feature is switched on locally.
 */
const PRELUDE = `
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
{
  const p = path.join(ROOT, 'functions/background.js');
  if (fs.existsSync(p)) {
    const src = fs.readFileSync(p, 'utf8');
    if (!src.includes('patch: premium activations are answered locally')) {
      fs.writeFileSync(p, PRELUDE + src);
      console.log('  *  functions/background.js: response patch injected');
    } else {
      console.log('  -  functions/background.js: response patch already present');
    }
  } else {
    console.log('  !  functions/background.js not found');
  }
}

console.log('done.');
