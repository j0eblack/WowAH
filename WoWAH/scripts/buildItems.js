#!/usr/bin/env node
// Populates / updates the items table from EU auction data.
// Run with: node scripts/buildItems.js
//
//   1. Commodities AH       → collects base item IDs (quality 0, no bonus_list)
//   2. All connected realms → collects (item_id, quality, bonus_list) triples
//   3. For each new triple: fetches name, icon, and actual item_level (with bonus IDs)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('../lib/blizzard');

var REALM_DELAY  = 60;    // ms between realm auction requests
var RETRY_DELAY  = 5000;  // ms before retrying a failed request
var RATE_DELAY   = 10000; // ms to wait on 429 if no Retry-After header
var CONCURRENCY  = 3;     // parallel item fetches — keep low to avoid rate limits

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function getQuality(item) {
  var mods = item.modifiers || [];
  for (var i = 0; i < mods.length; i++) {
    if (mods[i].type === 9) return mods[i].value;
  }
  return 0;
}

function getBonusList(item) {
  return (item.bonus_lists || []).slice().sort(function(x, y) { return x - y; }).join(',');
}

async function blizzardGet(url, params, token) {
  for (;;) {
    try {
      return await axios.get(url, {
        params,
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 15000,
      });
    } catch (e) {
      if (e.response && e.response.status === 429) {
        var retryAfter = parseInt(e.response.headers['retry-after'] || '0', 10);
        var wait = retryAfter > 0 ? retryAfter * 1000 : RATE_DELAY;
        console.warn('  Rate limited — waiting ' + (wait / 1000) + ' s…');
        await sleep(wait);
      } else {
        console.warn('  Request failed (' + url + '):', e.message, '— retrying in 5 s…');
        await sleep(RETRY_DELAY);
      }
    }
  }
}

async function blizzardGetOrNull(url, params, token) {
  for (;;) {
    try {
      return await axios.get(url, {
        params,
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 15000,
      });
    } catch (e) {
      if (e.response && e.response.status === 404) return null;
      if (e.response && e.response.status === 429) {
        var retryAfter = parseInt(e.response.headers['retry-after'] || '0', 10);
        var wait = retryAfter > 0 ? retryAfter * 1000 : RATE_DELAY;
        console.warn('  Rate limited — waiting ' + (wait / 1000) + ' s…');
        await sleep(wait);
      } else {
        console.warn('  Request failed (' + url + '):', e.message, '— retrying in 5 s…');
        await sleep(RETRY_DELAY);
      }
    }
  }
}

// ── Collect (id, quality, bonus_list) from commodities ───────

async function collectCommodityItems(base, ns, locale, token) {
  console.log('  Fetching commodities…');
  var res = await blizzardGet(base + '/data/wow/auctions/commodities', { namespace: ns, locale }, token);
  var items = new Map();
  (res.data.auctions || []).forEach(function(a) {
    if (!a.item || !a.item.id) return;
    // Commodities have no bonus_lists or quality modifiers
    var key = a.item.id + '|0|';
    if (!items.has(key)) items.set(key, { id: a.item.id, quality: 0, bonus_list: '' });
  });
  console.log('    ' + items.size + ' items from commodities');
  return items;
}

// ── Collect (id, quality, bonus_list) from realm auctions ────

async function collectRealmItems(regionKey, base, ns, locale, token) {
  var realmIds = db.prepare(
    'SELECT DISTINCT connected_realm_id FROM realms WHERE region = ?'
  ).all(regionKey).map(function(r) { return r.connected_realm_id; });

  if (!realmIds.length) {
    console.warn('  No realms found for ' + regionKey.toUpperCase() + ' — run buildRealms.js first');
    return new Map();
  }
  console.log('    ' + realmIds.length + ' connected realms found (from DB)');

  var items = new Map();
  for (var i = 0; i < realmIds.length; i++) {
    var realmId = realmIds[i];
    process.stdout.write('  Realm ' + realmId + ' (' + (i + 1) + '/' + realmIds.length + ')…\r');
    var res = await blizzardGet(
      base + '/data/wow/connected-realm/' + realmId + '/auctions',
      { namespace: ns, locale }, token
    );
    (res.data.auctions || []).forEach(function(a) {
      if (!a.item || !a.item.id) return;
      var quality   = getQuality(a.item);
      var bonusList = getBonusList(a.item);
      var key = a.item.id + '|' + quality + '|' + bonusList;
      if (!items.has(key)) items.set(key, { id: a.item.id, quality: quality, bonus_list: bonusList });
    });
    await sleep(REALM_DELAY);
  }
  process.stdout.write('\n');
  console.log('    ' + items.size + ' unique (item, quality, bonus_list) triples from realm auctions');
  return items;
}

// ── Fetch name, icon, item_level for new triples ──────────────
// Passes bonus IDs to the item API so Blizzard resolves the correct ilvl.

async function fetchNewItems(itemEntries, base, staticNs, locale, token) {
  var known = new Set(
    db.prepare('SELECT id, quality, bonus_list FROM items').all()
      .map(function(r) { return r.id + '|' + r.quality + '|' + r.bonus_list; })
  );
  var missing = itemEntries.filter(function(e) {
    return !known.has(e.id + '|' + e.quality + '|' + e.bonus_list);
  });

  if (!missing.length) {
    console.log('  All items already in DB, skipping fetch.');
    return;
  }
  console.log('\n  Fetching ' + missing.length + ' new entries with ' + CONCURRENCY + ' parallel workers…');

  var upsert = db.prepare(
    "INSERT OR REPLACE INTO items (id, quality, bonus_list, item_level, name, icon, fetched_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
  );
  var index = 0;
  var done  = 0;
  var total = missing.length;

  async function worker() {
    while (index < total) {
      var entry = missing[index++];

      // Build bonus params array: [bonus[0]=x, bonus[1]=y, ...]
      var bonusIds = entry.bonus_list ? entry.bonus_list.split(',').map(Number) : [];
      var bonusParams = {};
      bonusIds.forEach(function(bid, i) { bonusParams['bonus[' + i + ']'] = bid; });

      var itemRes = await blizzardGetOrNull(
        base + '/data/wow/item/' + entry.id,
        Object.assign({ namespace: staticNs, locale: locale }, bonusParams),
        token
      );
      if (!itemRes) { done++; continue; }

      var name      = itemRes.data.name || ('Item #' + entry.id);
      var itemLevel = itemRes.data.level || 0;
      var icon      = '';

      var mediaRes = await blizzardGetOrNull(
        base + '/data/wow/media/item/' + entry.id,
        { namespace: staticNs },
        token
      );
      if (mediaRes) {
        var assets = mediaRes.data.assets || [];
        if (assets.length) icon = assets[0].value;
      }

      upsert.run(entry.id, entry.quality, entry.bonus_list, itemLevel, name, icon);
      done++;
      if (done % 50 === 0 || done === total) {
        process.stdout.write('  Stored ' + done + ' / ' + total + '\r');
      }
    }
  }

  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  process.stdout.write('\n');
}

// ── Entry point ───────────────────────────────────────────────

async function main() {
  var token = await blizzard.getToken();
  var eu = blizzard.REGIONS['eu'];

  var allItems = new Map();

  console.log('\n══ Commodities ══');
  var commodityItems = await collectCommodityItems(eu.host, eu.namespace, eu.locale, token);
  commodityItems.forEach(function(v, k) { allItems.set(k, v); });

  console.log('\n══ Realm auctions ══');
  var realmItems = await collectRealmItems('eu', eu.host, eu.namespace, eu.locale, token);
  realmItems.forEach(function(v, k) { allItems.set(k, v); });

  console.log('\nTotal unique (item, quality, bonus_list) triples: ' + allItems.size);

  await fetchNewItems(Array.from(allItems.values()), eu.host, eu.staticNamespace, eu.locale, token);

  console.log('\nDone.');
  process.exit(0);
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
