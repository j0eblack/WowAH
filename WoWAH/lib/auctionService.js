const axios = require('axios');
const db = require('../db');
const blizzard = require('./blizzard');

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

// ── Commodities (region-wide) ─────────────────────────────────
async function fetchAndSave(regionKey) {
  var region = blizzard.REGIONS[regionKey];
  if (!region) throw new Error('Unknown region: ' + regionKey);
  var token = await blizzard.getToken();

  console.log('[Auctions] Fetching commodities for', regionKey.toUpperCase());
  var response = await axios.get(region.host + '/data/wow/auctions/commodities', {
    params: { namespace: region.namespace, locale: region.locale },
    headers: { 'Authorization': 'Bearer ' + token },
  });

  // Commodities never have bonus_lists or quality modifiers
  var grouped = {};
  for (var i = 0; i < response.data.auctions.length; i++) {
    var a = response.data.auctions[i];
    var key = a.item.id;
    if (!grouped[key]) grouped[key] = { item_id: a.item.id, quantity: 0, unit_price: a.unit_price };
    grouped[key].quantity += a.quantity;
    if (a.unit_price < grouped[key].unit_price) grouped[key].unit_price = a.unit_price;
  }
  var rows = Object.values(grouped);

  db.transaction(function(rows, regionKey) {
    var insHistory = db.prepare("INSERT INTO price_history (item_id, quality, bonus_list, unit_price, quantity, region, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
    var insCurrent = db.prepare("INSERT OR REPLACE INTO current_prices (item_id, quality, bonus_list, region, unit_price, quantity, recorded_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))");
    db.prepare('DELETE FROM current_prices WHERE region = ?').run(regionKey);
    for (var i = 0; i < rows.length; i++) {
      insHistory.run(rows[i].item_id, 0, '', rows[i].unit_price, rows[i].quantity, regionKey);
      insCurrent.run(rows[i].item_id, 0, '', regionKey, rows[i].unit_price, rows[i].quantity);
    }
  })(rows, regionKey);

  console.log('[Auctions] Commodities saved:', rows.length, 'items (' + regionKey.toUpperCase() + ')');
  return { count: rows.length, region: regionKey };
}

// ── Connected-realm auctions ──────────────────────────────────
async function fetchRealmAuctions(regionKey) {
  var region = blizzard.REGIONS[regionKey];
  if (!region) throw new Error('Unknown region: ' + regionKey);
  var token = await blizzard.getToken();

  var realmIds = db.prepare(
    'SELECT DISTINCT connected_realm_id FROM realms WHERE region = ?'
  ).all(regionKey).map(function(r) { return r.connected_realm_id; });

  if (!realmIds.length) {
    console.warn('[Realms] No realms found for', regionKey.toUpperCase(), '— run buildRealms.js first');
    return { count: 0, region: regionKey };
  }

  console.log('[Realms] Fetching', realmIds.length, 'connected realms for', regionKey.toUpperCase());

  var insertHistory = db.prepare("INSERT INTO realm_prices (item_id, quality, bonus_list, connected_realm_id, region, unit_price, quantity, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))");
  var insertCurrent = db.prepare("INSERT OR REPLACE INTO current_realm_prices (item_id, quality, bonus_list, connected_realm_id, region, unit_price, quantity, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))");
  var deleteCurrent = db.prepare('DELETE FROM current_realm_prices WHERE connected_realm_id = ? AND region = ?');
  var totalItems = 0;

  for (var i = 0; i < realmIds.length; i++) {
    var realmId = realmIds[i];
    try {
      await new Promise(function(resolve) { setTimeout(resolve, 80); });

      var auctionRes = await axios.get(region.host + '/data/wow/connected-realm/' + realmId + '/auctions', {
        params: { namespace: region.namespace, locale: region.locale },
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 15000,
      });

      // Group by item_id + quality + bonus_list: lowest buyout, sum quantity
      var grouped = {};
      (auctionRes.data.auctions || []).forEach(function(a) {
        if (!a.item || !a.item.id) return;
        var price = a.buyout ? Math.floor(a.buyout / (a.quantity || 1)) : (a.unit_price || 0);
        if (!price) return;
        var quality   = getQuality(a.item);
        var bonusList = getBonusList(a.item);
        var key = a.item.id + '|' + quality + '|' + bonusList;
        if (!grouped[key]) grouped[key] = { item_id: a.item.id, quality: quality, bonus_list: bonusList, quantity: 0, unit_price: price };
        grouped[key].quantity += (a.quantity || 1);
        if (price < grouped[key].unit_price) grouped[key].unit_price = price;
      });

      var rows = Object.values(grouped);
      db.transaction(function(rows) {
        deleteCurrent.run(realmId, regionKey);
        for (var k = 0; k < rows.length; k++) {
          var r = rows[k];
          insertHistory.run(r.item_id, r.quality, r.bonus_list, realmId, regionKey, r.unit_price, r.quantity);
          insertCurrent.run(r.item_id, r.quality, r.bonus_list, realmId, regionKey, r.unit_price, r.quantity);
        }
      })(rows);

      totalItems += rows.length;
      console.log('[Realms] Realm', realmId, '— saved', rows.length, 'items');
    } catch (e) {
      console.warn('[Realms] Realm', realmId, 'failed:', e.message);
    }
  }

  console.log('[Realms] Done for', regionKey.toUpperCase(), '—', totalItems, 'total item snapshots');
  return { count: totalItems, region: regionKey };
}

module.exports = { fetchAndSave, fetchRealmAuctions };
