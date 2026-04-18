const express = require('express');
const router = express.Router();
const db = require('../db');
const blizzard = require('../lib/blizzard');
const auctionService = require('../lib/auctionService');

var REGIONS = blizzard.REGIONS;

// GET /api/auctions/fetch?region=eu  — manual trigger (commodities)
router.get('/auctions/fetch', async function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();
  if (!REGIONS[regionKey]) return res.status(400).json({ error: 'Unknown region "' + regionKey + '".' });
  try {
    var result = await auctionService.fetchAndSave(regionKey);
    res.json({ message: 'Snapshot saved: ' + result.count + ' items (' + regionKey.toUpperCase() + ').', count: result.count, region: regionKey });
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 401) { blizzard.invalidateToken(); return res.status(401).json({ error: 'Blizzard rejected the token.' }); }
    if (status === 404) return res.status(502).json({ error: 'Blizzard API returned 404.' });
    res.status(500).json({ error: 'Fetch failed. Status: ' + (status || 'no response') });
  }
});

// GET /api/auctions?region=eu  — current commodity snapshot
router.get('/auctions', function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();
  var auctions = db.prepare(
    'SELECT cp.item_id, cp.quality, cp.bonus_list, cp.quantity, cp.unit_price, cp.recorded_at AS fetched_at, cp.region, i.name, i.icon, i.item_level ' +
    'FROM current_prices cp LEFT JOIN items i ON i.id = cp.item_id AND i.quality = cp.quality AND i.bonus_list = cp.bonus_list ' +
    'WHERE cp.region = ? ORDER BY cp.unit_price ASC'
  ).all(regionKey);
  var fetchedAt = auctions.length > 0 ? auctions[0].fetched_at : null;
  res.json({ auctions: auctions, fetched_at: fetchedAt, region: regionKey });
});

// GET /api/realms?region=eu  — list of known connected realms
router.get('/realms', function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();
  var realms = db.prepare('SELECT id, name FROM realms WHERE region = ? ORDER BY name ASC').all(regionKey);
  res.json(realms);
});

// GET /api/regions
router.get('/regions', function(req, res) {
  res.json(Object.keys(REGIONS));
});

// Blizzard item_class IDs → UI category keys
var CATEGORY_CLASS_MAP = {
  gear:       [2, 4],   // Weapon, Armor
  consumable: [0],      // Consumable
  material:   [7],      // Trade Goods
  recipe:     [9],      // Recipe
  pet:        [17],     // Battle Pet
  container:  [1],      // Container (bags)
  misc:       [14],     // Miscellaneous
};

// GET /api/flipping?region=eu&category=all
// Returns items with the biggest price spread across connected realms,
// with top-3 cheapest buy realms and top-3 most expensive sell realms.
router.get('/flipping', function(req, res) {
  var regionKey = (req.query.region   || 'eu').toLowerCase();
  var category  = (req.query.category || 'all').toLowerCase();

  if (!REGIONS[regionKey]) return res.status(400).json({ error: 'Unknown region.' });

  var classFilter = CATEGORY_CLASS_MAP[category] || null;

  try {
    // ── Step 1: top items by price spread across realms ──────────
    var spreadSql =
      'SELECT crp.item_id, crp.quality, crp.bonus_list, ' +
      '  i.name, i.icon, i.item_level, i.item_class, i.item_subclass, ' +
      '  MIN(crp.unit_price) AS min_price, ' +
      '  MAX(crp.unit_price) AS max_price, ' +
      '  (MAX(crp.unit_price) - MIN(crp.unit_price)) AS spread, ' +
      '  COUNT(DISTINCT crp.connected_realm_id) AS realm_count ' +
      'FROM current_realm_prices crp ' +
      'LEFT JOIN items i ON i.id = crp.item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
      'WHERE crp.region = ? ';

    var params = [regionKey];

    if (classFilter) {
      spreadSql += 'AND i.item_class IN (' + classFilter.map(function() { return '?'; }).join(',') + ') ';
      params = params.concat(classFilter);
    }

    spreadSql +=
      'GROUP BY crp.item_id, crp.quality, crp.bonus_list ' +
      'HAVING realm_count >= 2 AND spread > 0 ' +
      'ORDER BY spread DESC ' +
      'LIMIT 200';

    var topItems = db.prepare(spreadSql).all(params);
    if (!topItems.length) return res.json([]);

    // ── Step 2: all realm prices for these items (with realm names) ──
    var itemIds  = [];
    var itemKeys = new Set();
    topItems.forEach(function(it) {
      var key = it.item_id + '|' + it.quality + '|' + it.bonus_list;
      if (!itemKeys.has(key)) { itemKeys.add(key); itemIds.push(it.item_id); }
    });
    var idHoles = itemIds.map(function() { return '?'; }).join(',');

    var allPrices = db.prepare(
      'SELECT crp.item_id, crp.quality, crp.bonus_list, ' +
      '  crp.connected_realm_id, crp.unit_price, crp.quantity, ' +
      '  GROUP_CONCAT(r.name, \' / \') AS realm_names ' +
      'FROM current_realm_prices crp ' +
      'JOIN realms r ON r.connected_realm_id = crp.connected_realm_id AND r.region = crp.region ' +
      'WHERE crp.region = ? AND crp.item_id IN (' + idHoles + ') ' +
      'GROUP BY crp.item_id, crp.quality, crp.bonus_list, crp.connected_realm_id ' +
      'ORDER BY crp.item_id, crp.quality, crp.bonus_list, crp.unit_price ASC'
    ).all([regionKey].concat(itemIds));

    // Index by exact item key
    var pricesByItem = {};
    allPrices.forEach(function(p) {
      var key = p.item_id + '|' + p.quality + '|' + p.bonus_list;
      if (!pricesByItem[key]) pricesByItem[key] = [];
      pricesByItem[key].push(p);
    });

    // ── Step 3: assemble result ───────────────────────────────────
    var result = topItems.map(function(item) {
      var key    = item.item_id + '|' + item.quality + '|' + item.bonus_list;
      var prices = pricesByItem[key] || []; // sorted ASC by unit_price

      // top-3 cheapest (buy) and top-3 most expensive (sell)
      var buyRealms  = prices.slice(0, 3);
      var sellRealms = prices.slice(-3).reverse();

      return {
        item_id:      item.item_id,
        quality:      item.quality,
        bonus_list:   item.bonus_list,
        name:         item.name,
        icon:         item.icon,
        item_level:   item.item_level,
        item_class:   item.item_class,
        item_subclass:item.item_subclass,
        min_price:    item.min_price,
        max_price:    item.max_price,
        spread:       item.spread,
        buy_realms:   buyRealms,
        sell_realms:  sellRealms,
      };
    });

    res.json(result);
  } catch (e) {
    console.error('[Flipping] Error:', e.message);
    res.status(500).json({ error: 'Failed to load flipping data: ' + e.message });
  }
});

module.exports = router;
