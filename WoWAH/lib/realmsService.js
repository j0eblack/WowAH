// Populates / updates the realms table for all regions.
// Uses INSERT OR REPLACE — never wipes the table.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('./blizzard');

var RETRY_DELAY = 5000;

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
      console.warn('[RealmsService] Request failed (' + url + '):', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

async function buildRealmsForRegion(regionKey, region, token) {
  console.log('[RealmsService] ══ Region: ' + regionKey.toUpperCase() + ' ══');

  var idxRes = await blizzardGet(
    region.host + '/data/wow/connected-realm/index',
    { namespace: region.namespace, locale: region.locale },
    token
  );

  var entries  = idxRes.data.connected_realms || [];
  var realmIds = entries.map(function(e) {
    var m = (e.href || '').match(/connected-realm\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }).filter(Boolean);

  console.log('[RealmsService]   ' + realmIds.length + ' connected realms found');

  var upsert = db.prepare(
    'INSERT OR REPLACE INTO realms (id, connected_realm_id, region, name) VALUES (?, ?, ?, ?)'
  );

  for (var i = 0; i < realmIds.length; i++) {
    var crId = realmIds[i];
    process.stdout.write('[RealmsService] Connected realm ' + crId + ' (' + (i + 1) + '/' + realmIds.length + ')…\r');

    var res = await blizzardGet(
      region.host + '/data/wow/connected-realm/' + crId,
      { namespace: region.namespace, locale: region.locale },
      token
    );

    var realms = res.data.realms || [];
    for (var realm of realms) {
      var name = (realm.name && typeof realm.name === 'object')
        ? (realm.name[region.locale] || realm.name['en_US'] || Object.values(realm.name)[0])
        : (realm.name || '');
      upsert.run(realm.id, crId, regionKey, name);
    }
  }

  process.stdout.write('\n');
  console.log('[RealmsService]   Done with ' + regionKey.toUpperCase());
}

async function run() {
  var token = await blizzard.getToken();

  for (var regionKey of Object.keys(blizzard.REGIONS)) {
    await buildRealmsForRegion(regionKey, blizzard.REGIONS[regionKey], token);
  }

  var count = db.prepare('SELECT COUNT(*) AS n FROM realms').get().n;
  console.log('[RealmsService] Total realms in DB: ' + count);
}

module.exports = { run };
