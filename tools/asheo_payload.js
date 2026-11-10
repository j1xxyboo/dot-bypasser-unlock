/*
 * The premium entitlement the patched Asheo build reports.
 *
 * The shape was captured from the running extension ({action:"premium.get"}):
 *
 *   { tier:"free", source:"license", isFounder:false,
 *     features:{browserMods:false, ruleOpsLab:false, liveHud:false,
 *               advancedProtection:false, apiAccess:false, experimentalFeatures:false},
 *     capabilities:{customEncryptedGateways:false, binGenerator:false, adyenGateway:false},
 *     limits:{binPool:2, ccQueue:10, ruleLimit:20, profileLimit:2, randomRouting:false},
 *     plan:"free", planDisplayName:"Free", licenseType:"free", status:"inactive", ... }
 *
 * The same object with everything switched on is what a premium install sees.
 *
 * Two forms are needed:
 *
 *   PREMIUM     a JSON string - it replaces a `return {...}` of the original
 *               code, which is JSON shaped;
 *   ENTITLEMENT a JS expression - it replaces a getter call, so it is used
 *               as an object literal.
 */
'use strict';

/** the premium entitlement as JSON (for `return <PREMIUM>;`) */
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

/** the premium entitlement as a JS expression (for `return <ENTITLEMENT>;`) */
const ENTITLEMENT = [
  '{',
  'tier:"premium",source:"license",isFounder:true,',
  'features:{browserMods:true,ruleOpsLab:true,liveHud:true,',
  'advancedProtection:true,apiAccess:true,experimentalFeatures:true},',
  'capabilities:{customEncryptedGateways:true,binGenerator:true,adyenGateway:true},',
  'limits:{binPool:9999,ccQueue:9999,ruleLimit:99999,profileLimit:999,randomRouting:true},',
  'expiresAt:null,plan:"premium",planDisplayName:"Premium",licenseType:"premium",',
  'status:"active",activatedAt:Date.now(),nextBillingDate:null,',
  'seatsAllowed:999,seatsUsed:0,activationCount:1,maxActivations:null,',
  'deviceLocked:false,canTransfer:true,',
  'featureKeys:["browserMods","ruleOpsLab","liveHud","advancedProtection",',
  '"apiAccess","experimentalFeatures"],customFeatures:{},',
  'capabilityKeys:["customEncryptedGateways","binGenerator"],',
  'limitKeys:["binPool","ccQueue","ruleLimit","profileLimit","randomRouting"],',
  'metadata:{},kid:null,kind:"license",keyName:null,jti:"unlocked",activated:true',
  '}',
].join('');

module.exports = { PREMIUM, ENTITLEMENT };
