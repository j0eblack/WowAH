// Shared logic for populating / updating the items table.
// Used by the weekly scheduler in server.js and the CLI script buildItems.js.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('./blizzard');

var REALM_DELAY  = 60;
var ITEM_DELAY   = 200;
var RETRY_DELAY  = 5000;
var RATE_DELAY   = 10000;
var CONCURRENCY  = 3;

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
        console.warn('[ItemsService] Rate limited — waiting ' + (wait / 1000) + ' s…');
        await sleep(wait);
      } else {
        console.warn('[ItemsService] Request failed (' + url + '):', e.message, '— retrying in 5 s…');
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
        console.warn('[ItemsService] Rate limited — waiting ' + (wait / 1000) + ' s…');
        await sleep(wait);
      } else {
        console.warn('[ItemsService] Request failed (' + url + '):', e.message, '— retrying in 5 s…');
        await sleep(RETRY_DELAY);
      }
    }
  }
}

async function collectCommodityItems(base, ns, locale, token) {
  console.log('[ItemsService] Fetching commodities…');
  var res = await blizzardGet(base + '/data/wow/auctions/commodities', { namespace: ns, locale }, token);
  var items = new Map();
  (res.data.auctions || []).forEach(function(a) {
    if (!a.item || !a.item.id) return;
    var key = a.item.id + '|0|';
    if (!items.has(key)) items.set(key, { id: a.item.id, quality: 0, bonus_list: '' });
  });
  console.log('[ItemsService]   ' + items.size + ' items from commodities');
  return items;
}

async function collectRealmItems(regionKey, base, ns, locale, token) {
  var realmIds = db.prepare(
    'SELECT DISTINCT connected_realm_id FROM realms WHERE region = ?'
  ).all(regionKey).map(function(r) { return r.connected_realm_id; });

  if (!realmIds.length) {
    console.warn('[ItemsService] No realms found for ' + regionKey.toUpperCase() + ' — run buildRealms.js first');
    return new Map();
  }
  console.log('[ItemsService]   ' + realmIds.length + ' connected realms found');

  var items = new Map();
  for (var i = 0; i < realmIds.length; i++) {
    var realmId = realmIds[i];
    process.stdout.write('[ItemsService] Realm ' + realmId + ' (' + (i + 1) + '/' + realmIds.length + ')…\r');
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
  console.log('[ItemsService]   ' + items.size + ' unique (item, quality, bonus_list) triples from realm auctions');
  return items;
}

async function fetchNewItems(itemEntries, base, staticNs, locale, token) {
  // Exclude items with no icon — they were stored by the wago path and need
  // a Blizzard API fetch to populate the icon and verify other fields.
  var known = new Set(
    db.prepare("SELECT id, quality, bonus_list FROM items WHERE icon IS NOT NULL AND icon != ''").all()
      .map(function(r) { return r.id + '|' + r.quality + '|' + r.bonus_list; })
  );
  var missing = itemEntries.filter(function(e) {
    return !known.has(e.id + '|' + e.quality + '|' + e.bonus_list);
  }).sort(function(a, b) { return b.id - a.id; });

  if (!missing.length) {
    console.log('[ItemsService] All items already in DB, skipping fetch.');
    return;
  }
  console.log('[ItemsService] Fetching ' + missing.length + ' new entries with ' + CONCURRENCY + ' parallel workers…');

  var upsert = db.prepare(
    "INSERT OR REPLACE INTO items (id, quality, bonus_list, item_level, name, icon, item_class, item_subclass, fetched_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  );
  var index = 0;
  var done  = 0;
  var total = missing.length;

  async function worker() {
    while (index < total) {
      var entry = missing[index++];
      var bonusIds = entry.bonus_list ? entry.bonus_list.split(',').map(Number) : [];
      var bonusParams = {};
      bonusIds.forEach(function(bid, i) { bonusParams['bonus[' + i + ']'] = bid; });

      var itemRes = await blizzardGetOrNull(
        base + '/data/wow/item/' + entry.id,
        Object.assign({ namespace: staticNs, locale: locale }, bonusParams),
        token
      );
      if (!itemRes) { done++; continue; }

      var name         = itemRes.data.name || ('Item #' + entry.id);
      var itemLevel    = itemRes.data.level || 0;
      var itemClass    = (itemRes.data.item_class    && itemRes.data.item_class.id    != null) ? itemRes.data.item_class.id    : null;
      var itemSubclass = (itemRes.data.item_subclass && itemRes.data.item_subclass.id != null) ? itemRes.data.item_subclass.id : null;
      var icon         = '';

      var mediaRes = await blizzardGetOrNull(
        base + '/data/wow/media/item/' + entry.id,
        { namespace: staticNs },
        token
      );
      if (mediaRes) {
        var assets = mediaRes.data.assets || [];
        if (assets.length) icon = assets[0].value;
      }

      upsert.run(entry.id, entry.quality, entry.bonus_list, itemLevel, name, icon, itemClass, itemSubclass);
      done++;
      if (done % 50 === 0 || done === total) {
        process.stdout.write('[ItemsService] Stored ' + done + ' / ' + total + '\r');
      }
      await sleep(ITEM_DELAY);
    }
  }

  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  process.stdout.write('\n');
}

// Fetches item details (name, icon, …) for a specific list of item IDs.
// Only requests the base variant (quality=0, bonus_list=''), which is all the
// crafting tab needs.  Already-known items are skipped automatically by fetchNewItems.
async function fetchItemBatch(itemIds) {
  if (!itemIds || !itemIds.length) return;
  var token   = await blizzard.getToken();
  var eu      = blizzard.REGIONS['eu'];
  var entries = itemIds.map(function(id) { return { id: id, quality: 0, bonus_list: '' }; });
  console.log('[ItemsService] Fetching details for ' + entries.length + ' items…');
  await fetchNewItems(entries, eu.host, eu.staticNamespace, eu.locale, token);
  console.log('[ItemsService] Item batch done.');
}

// Full AH scan — discovers every item currently listed and fetches details for
// unknown ones.  Very slow (hours).  Use fetchItemBatch() for targeted fetching.
async function run() {
  var token = await blizzard.getToken();
  var eu    = blizzard.REGIONS['eu'];

  var allItems = new Map();

  console.log('[ItemsService] ══ Commodities ══');
  var commodityItems = await collectCommodityItems(eu.host, eu.namespace, eu.locale, token);
  commodityItems.forEach(function(v, k) { allItems.set(k, v); });

  console.log('[ItemsService] ══ Realm auctions ══');
  var realmItems = await collectRealmItems('eu', eu.host, eu.namespace, eu.locale, token);
  realmItems.forEach(function(v, k) { allItems.set(k, v); });

  console.log('[ItemsService] Total unique triples: ' + allItems.size);
  await fetchNewItems(Array.from(allItems.values()), eu.host, eu.staticNamespace, eu.locale, token);
  console.log('[ItemsService] Done.');
}

// Stores item entries using data already fetched from wago.tools ItemSparse.
// No per-item API calls — wagoItemsMap must be the Map returned by
// wagoService.streamItemSparse().  Items already in the DB are skipped.
async function fetchNewItemsFromWago(itemEntries, wagoItemsMap) {
  if (!itemEntries || !itemEntries.length) return;

  var known = new Set(
    db.prepare('SELECT id, quality, bonus_list FROM items').all()
      .map(function(r) { return r.id + '|' + r.quality + '|' + r.bonus_list; })
  );
  var missing = itemEntries.filter(function(e) {
    return !known.has(e.id + '|' + e.quality + '|' + e.bonus_list);
  });

  if (!missing.length) {
    console.log('[ItemsService] All items already in DB, skipping.');
    return;
  }

  console.log('[ItemsService] Storing ' + missing.length + ' items from wago.tools data…');

  var upsert = db.prepare(
    "INSERT OR REPLACE INTO items (id, quality, bonus_list, item_level, name, icon, item_class, item_subclass, fetched_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  );

  var done = 0;
  missing.forEach(function(entry) {
    var data = wagoItemsMap.get(entry.id) || {};
    upsert.run(
      entry.id,
      entry.quality,
      entry.bonus_list,
      data.itemLevel  || 0,
      data.name       || ('Item #' + entry.id),
      '',               // icons are not available from wago.tools
      data.classId    || null,
      data.subclassId || null
    );
    done++;
    if (done % 100 === 0 || done === missing.length) {
      process.stdout.write('[ItemsService] Stored ' + done + ' / ' + missing.length + '\r');
    }
  });
  process.stdout.write('\n');
}

module.exports = { run, fetchItemBatch, collectCommodityItems, collectRealmItems, fetchNewItems, fetchNewItemsFromWago };
