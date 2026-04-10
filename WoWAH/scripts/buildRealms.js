#!/usr/bin/env node
// Populates / updates the realms table for all regions.
// Run with: node scripts/buildRealms.js
//
// For each region:
//   1. Fetches the connected-realm index to get all connected realm IDs.
//   2. Fetches each connected realm to get the realm names within it.
//   3. Upserts every realm into the realms table.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('../lib/blizzard');

var RETRY_DELAY = 5000; // ms before retrying a failed request

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function blizzardGet(url, params, token) {
  for (;;) {
    try {
      return await axios.get(url, {
        params,
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 15000,
      });
    } catch (e) {
      console.warn('  Request failed (' + url + '):', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

async function buildRealmsForRegion(regionKey, region, token) {
  console.log('\n══ Region: ' + regionKey.toUpperCase() + ' ══');

  // Step 1: get all connected realm IDs
  var idxRes = await blizzardGet(
    region.host + '/data/wow/connected-realm/index',
    { namespace: region.namespace, locale: region.locale },
    token
  );

  var entries = idxRes.data.connected_realms || [];
  var realmIds = entries.map(function(e) {
    var m = (e.href || '').match(/connected-realm\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }).filter(Boolean);

  console.log('  ' + realmIds.length + ' connected realms found');

  var upsert = db.prepare(
    'INSERT OR REPLACE INTO realms (id, connected_realm_id, region, name) VALUES (?, ?, ?, ?)'
  );

  // Step 2: fetch each connected realm and store its member realm names
  for (var i = 0; i < realmIds.length; i++) {
    var crId = realmIds[i];
    process.stdout.write('  Connected realm ' + crId + ' (' + (i + 1) + '/' + realmIds.length + ')…\r');

    var res = await blizzardGet(
      region.host + '/data/wow/connected-realm/' + crId,
      { namespace: region.namespace, locale: region.locale },
      token
    );

    var realms = res.data.realms || [];
    // Each connected realm can contain multiple physical realms — store each one
    // with its own physical realm ID and the shared connected_realm_id.
    for (var realm of realms) {
      var name = (realm.name && typeof realm.name === 'object')
        ? (realm.name[region.locale] || realm.name['en_US'] || Object.values(realm.name)[0])
        : (realm.name || '');
      upsert.run(realm.id, crId, regionKey, name);
    }
  }

  process.stdout.write('\n');
  console.log('  Done with ' + regionKey.toUpperCase());
}

async function main() {
  var token = await blizzard.getToken();

  db.prepare('DELETE FROM realms').run();
  console.log('realms table cleared.');

  for (var regionKey of Object.keys(blizzard.REGIONS)) {
    await buildRealmsForRegion(regionKey, blizzard.REGIONS[regionKey], token);
  }

  var count = db.prepare('SELECT COUNT(*) AS n FROM realms').get().n;
  console.log('\nTotal realms stored: ' + count);
  console.log('Done.');
  process.exit(0);
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
