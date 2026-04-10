const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Routes ────────────────────────────────────────────────────

// GET /api/recipes/crafting?region=eu
// All craftable items where reagents are available as commodities.
// Shows direct cost and optimal cost (using cheapest quality variant per reagent).
// Quality variants are items that share the same icon — Blizzard uses the same icon
// for all quality tiers of a crafting material (e.g. Weavercloth R1/R2/R3).
var CRAFTING_SQL =
  'SELECT ' +
  '  a.item_id, ' +
  '  i.name        AS item_name, ' +
  '  i.icon        AS item_icon, ' +
  '  a.unit_price  AS sell_price, ' +
  '  r.id          AS recipe_id, ' +
  '  r.name        AS recipe_name, ' +
  '  r.profession, ' +
  '  r.expansion, ' +
  '  r.crafted_quantity, ' +
  '  SUM(rg.quantity * ra.unit_price) AS direct_cost ' +
  'FROM current_prices a ' +
  'JOIN items         i  ON i.id  = a.item_id AND i.quality = 0 AND i.bonus_list = \'\'' +
  'JOIN recipes       r  ON r.crafted_item_id = a.item_id ' +
  'JOIN reagents      rg ON rg.recipe_id = r.id ' +
  'JOIN current_prices ra ON ra.item_id = rg.item_id AND ra.region = a.region ' +
  'WHERE a.region = ? ' +
  'GROUP BY a.item_id, r.id ' +
  'ORDER BY (a.unit_price * r.crafted_quantity - SUM(rg.quantity * ra.unit_price)) DESC';

router.get('/recipes/crafting', function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();

  try {
    var rows = db.prepare(CRAFTING_SQL).all(regionKey);
    if (!rows.length) return res.json([]);

    // ── Batch 1: all reagents for every recipe in one query ──────
    var recipeIds    = rows.map(function(r) { return r.recipe_id; });
    var rIdHoles     = recipeIds.map(function() { return '?'; }).join(',');
    var allReagents  = db.prepare(
      'SELECT rg.recipe_id, rg.item_id, rg.quantity, i.name, i.icon, a.unit_price ' +
      'FROM reagents rg ' +
      'LEFT JOIN items          i ON i.id = rg.item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
      'LEFT JOIN current_prices a ON a.item_id = rg.item_id AND a.region = ? ' +
      'WHERE rg.recipe_id IN (' + rIdHoles + ')'
    ).all([regionKey].concat(recipeIds));

    // Group reagents by recipe_id
    var reagentsByRecipe = {};
    allReagents.forEach(function(rg) {
      if (!reagentsByRecipe[rg.recipe_id]) reagentsByRecipe[rg.recipe_id] = [];
      reagentsByRecipe[rg.recipe_id].push(rg);
    });

    // ── Batch 2: all quality variants for every unique icon ──────
    var iconSet = {};
    allReagents.forEach(function(rg) { if (rg.icon) iconSet[rg.icon] = true; });
    var icons = Object.keys(iconSet);

    var variantsByIcon = {};
    if (icons.length) {
      var iconHoles = icons.map(function() { return '?'; }).join(',');
      db.prepare(
        'SELECT i.icon, a.item_id, a.unit_price, i.name ' +
        'FROM current_prices a ' +
        'JOIN items i ON i.id = a.item_id AND i.quality = a.quality AND i.bonus_list = a.bonus_list ' +
        'WHERE i.icon IN (' + iconHoles + ') AND a.region = ? ' +
        'ORDER BY i.icon, a.unit_price ASC'
      ).all(icons.concat([regionKey])).forEach(function(v) {
        if (!variantsByIcon[v.icon]) variantsByIcon[v.icon] = [];
        variantsByIcon[v.icon].push(v);
      });
    }

    // ── Assemble ─────────────────────────────────────────────────
    var results = rows.map(function(row) {
      var reagents    = (reagentsByRecipe[row.recipe_id] || []).map(function(rg) {
        var variants  = rg.icon ? (variantsByIcon[rg.icon] || []) : [];
        var bestPrice = variants.length ? variants[0].unit_price : (rg.unit_price || 0);
        rg.variants   = variants;
        rg.best_price = bestPrice;
        return rg;
      });

      var optimalCost = reagents.reduce(function(s, rg) { return s + rg.quantity * rg.best_price; }, 0);
      var sellTotal   = row.sell_price * row.crafted_quantity;
      row.reagents       = reagents;
      row.direct_profit  = sellTotal - row.direct_cost;
      row.optimal_cost   = optimalCost;
      row.optimal_profit = sellTotal - optimalCost;
      return row;
    });

    results.sort(function(a, b) { return b.optimal_profit - a.optimal_profit; });
    res.json(results);
  } catch (e) {
    console.error('[Crafting] Error:', e.message);
    res.status(500).json({ error: 'Failed to load crafting data: ' + e.message });
  }
});


// GET /api/recipes/crafting-realm?region=eu&realm_id=123
// Craftable items where sell price comes from realm AH and reagent costs from commodities.
router.get('/recipes/crafting-realm', function(req, res) {
  var regionKey = (req.query.region  || 'eu').toLowerCase();
  var realmId   = parseInt(req.query.realm_id) || 0;
  if (!realmId) return res.status(400).json({ error: 'realm_id is required.' });

  try {
    // Sell price from realm, reagent costs from commodities
    var rows = db.prepare(
      'SELECT ' +
      '  a.item_id, ' +
      '  i.name        AS item_name, ' +
      '  i.icon        AS item_icon, ' +
      '  a.unit_price  AS sell_price, ' +
      '  r.id          AS recipe_id, ' +
      '  r.name        AS recipe_name, ' +
      '  r.profession, ' +
      '  r.expansion, ' +
      '  r.crafted_quantity, ' +
      '  SUM(rg.quantity * COALESCE(cp.unit_price, rp.unit_price, 0)) AS direct_cost ' +
      'FROM current_realm_prices a ' +
      'JOIN items              i   ON i.id  = a.item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
      'JOIN recipes            r   ON r.crafted_item_id = a.item_id ' +
      'JOIN reagents           rg  ON rg.recipe_id = r.id ' +
      'LEFT JOIN current_prices cp ON cp.item_id = rg.item_id AND cp.region = a.region ' +
      'LEFT JOIN current_realm_prices rp ON rp.item_id = rg.item_id AND rp.connected_realm_id = a.connected_realm_id AND rp.region = a.region ' +
      'WHERE a.region = ? AND a.connected_realm_id = ? ' +
      'GROUP BY a.item_id, r.id ' +
      'ORDER BY (a.unit_price * r.crafted_quantity - SUM(rg.quantity * COALESCE(cp.unit_price, rp.unit_price, 0))) DESC'
    ).all(regionKey, realmId);

    if (!rows.length) return res.json([]);

    var recipeIds   = rows.map(function(r) { return r.recipe_id; });
    var rIdHoles    = recipeIds.map(function() { return '?'; }).join(',');
    var allReagents = db.prepare(
      'SELECT rg.recipe_id, rg.item_id, rg.quantity, i.name, i.icon, ' +
      '  COALESCE(cp.unit_price, rp.unit_price) AS unit_price ' +
      'FROM reagents rg ' +
      'LEFT JOIN items             i  ON i.id = rg.item_id ' +
      'LEFT JOIN current_prices    cp ON cp.item_id = rg.item_id AND cp.region = ? ' +
      'LEFT JOIN current_realm_prices rp ON rp.item_id = rg.item_id AND rp.connected_realm_id = ? AND rp.region = ? ' +
      'WHERE rg.recipe_id IN (' + rIdHoles + ')'
    ).all([regionKey, realmId, regionKey].concat(recipeIds));

    var reagentsByRecipe = {};
    allReagents.forEach(function(rg) {
      if (!reagentsByRecipe[rg.recipe_id]) reagentsByRecipe[rg.recipe_id] = [];
      reagentsByRecipe[rg.recipe_id].push(rg);
    });

    var iconSet = {};
    allReagents.forEach(function(rg) { if (rg.icon) iconSet[rg.icon] = true; });
    var icons = Object.keys(iconSet);
    var variantsByIcon = {};
    if (icons.length) {
      var iconHoles = icons.map(function() { return '?'; }).join(',');
      db.prepare(
        'SELECT i.icon, a.item_id, a.unit_price, i.name ' +
        'FROM current_prices a JOIN items i ON i.id = a.item_id AND i.quality = a.quality ' +
        'WHERE i.icon IN (' + iconHoles + ') AND a.region = ? ORDER BY i.icon, a.unit_price ASC'
      ).all(icons.concat([regionKey])).forEach(function(v) {
        if (!variantsByIcon[v.icon]) variantsByIcon[v.icon] = [];
        variantsByIcon[v.icon].push(v);
      });
    }

    var results = rows.map(function(row) {
      var reagents = (reagentsByRecipe[row.recipe_id] || []).map(function(rg) {
        var variants  = rg.icon ? (variantsByIcon[rg.icon] || []) : [];
        var bestPrice = variants.length ? variants[0].unit_price : (rg.unit_price || 0);
        rg.variants   = variants;
        rg.best_price = bestPrice;
        return rg;
      });
      var optimalCost = reagents.reduce(function(s, rg) { return s + rg.quantity * rg.best_price; }, 0);
      var sellTotal   = row.sell_price * row.crafted_quantity;
      row.reagents       = reagents;
      row.direct_profit  = sellTotal - row.direct_cost;
      row.optimal_cost   = optimalCost;
      row.optimal_profit = sellTotal - optimalCost;
      return row;
    });

    results.sort(function(a, b) { return b.optimal_profit - a.optimal_profit; });
    res.json(results);
  } catch (e) {
    console.error('[Crafting-Realm] Error:', e.message);
    res.status(500).json({ error: 'Failed to load realm crafting data: ' + e.message });
  }
});

module.exports = router;
