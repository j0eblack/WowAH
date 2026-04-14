const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Routes ────────────────────────────────────────────────────

// GET /api/recipes/crafting?region=eu
// All craftable items with a known sell price and fully-priced reagents.
// Commodity items: sell_price from the global commodity market.
// Realm items: sell_price = MAX price across all realms (best-case for seller); top-3 sell
//   realms are attached separately so the frontend can show where to sell.
// Reagent cost: commodity preferred, cheapest realm price as fallback.
// Optimal cost (cheapest quality variant per reagent) is computed in JS via icon matching.
var CRAFTING_SQL =
  'WITH ' +
  // ── Commodity sell prices (global, region-wide) ───────────────
  'sell_commodity AS (' +
  '  SELECT item_id, unit_price FROM current_prices' +
  '    WHERE region=? AND quality=0 AND bonus_list=\'\''+
  '),' +
  // ── Realm sell prices: MAX per item (highest floor = best for seller) ─────
  'sell_realm AS (' +
  '  SELECT item_id, MAX(unit_price) AS unit_price FROM current_realm_prices' +
  '    WHERE region=? AND quality=0 AND bonus_list=\'\' GROUP BY item_id' +
  '),' +
  // Commodity wins when present; realm-only items use their best realm price
  'best_sell AS (' +
  '  SELECT item_id, unit_price FROM sell_commodity' +
  '  UNION ALL' +
  '  SELECT sr.item_id, sr.unit_price FROM sell_realm sr' +
  '    WHERE NOT EXISTS (SELECT 1 FROM sell_commodity sc WHERE sc.item_id=sr.item_id)' +
  '),' +
  // ── Reagent prices: commodity first, cheapest realm as fallback ──
  'rg_src AS (' +
  '  SELECT item_id, quality, bonus_list, unit_price FROM current_prices WHERE region=?' +
  '  UNION ALL' +
  '  SELECT item_id, quality, bonus_list, MIN(unit_price) AS unit_price' +
  '    FROM current_realm_prices WHERE region=? GROUP BY item_id, quality, bonus_list' +
  '),' +
  'best_rg AS (SELECT item_id, MIN(unit_price) AS unit_price FROM rg_src GROUP BY item_id) ' +
  'SELECT' +
  '  r.crafted_item_id AS item_id,' +
  '  i.name            AS item_name,' +
  '  i.icon            AS item_icon,' +
  '  bs.unit_price     AS sell_price,' +
  '  CASE WHEN sc.item_id IS NULL THEN 1 ELSE 0 END AS is_realm_item,' +
  '  r.id              AS recipe_id,' +
  '  r.name            AS recipe_name,' +
  '  r.profession,' +
  '  r.expansion,' +
  '  r.crafted_quantity,' +
  '  SUM(rg.quantity * br.unit_price) AS direct_cost ' +
  'FROM recipes r ' +
  'JOIN items         i   ON i.id = r.crafted_item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
  'JOIN best_sell     bs  ON bs.item_id = r.crafted_item_id ' +
  'JOIN reagents      rg  ON rg.recipe_id = r.id ' +
  'JOIN best_rg       br  ON br.item_id = rg.item_id ' +
  'LEFT JOIN sell_commodity sc ON sc.item_id = r.crafted_item_id ' +
  'GROUP BY r.crafted_item_id, r.id ' +
  'ORDER BY (bs.unit_price * r.crafted_quantity - SUM(rg.quantity * br.unit_price)) DESC';

router.get('/recipes/crafting', function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();

  try {
    // CTE uses 4 region params: sell_src×2, rg_src×2
    var rows = db.prepare(CRAFTING_SQL).all(regionKey, regionKey, regionKey, regionKey);
    if (!rows.length) return res.json([]);

    // ── Batch 1: all reagents for every recipe in one query ──────
    var recipeIds    = rows.map(function(r) { return r.recipe_id; });
    var rIdHoles     = recipeIds.map(function() { return '?'; }).join(',');
    var allReagents  = db.prepare(
      'SELECT rg.recipe_id, rg.item_id, rg.quantity, i.name, i.icon,' +
      '  COALESCE(cp.unit_price, crp_min.unit_price) AS unit_price ' +
      'FROM reagents rg ' +
      'LEFT JOIN items i ON i.id = rg.item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
      'LEFT JOIN current_prices cp ON cp.item_id = rg.item_id AND cp.region = ? ' +
      'LEFT JOIN (' +
      '  SELECT item_id, MIN(unit_price) AS unit_price FROM current_realm_prices WHERE region = ? GROUP BY item_id' +
      ') crp_min ON crp_min.item_id = rg.item_id ' +
      'WHERE rg.recipe_id IN (' + rIdHoles + ')'
    ).all([regionKey, regionKey].concat(recipeIds));

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

    // ── Batch 3: full recursive sub-craft chain ──────────────────
    var MAX_CHAIN_DEPTH = 6;

    // Collect unique top-level reagent item IDs
    var allReagentItemIds = [];
    var seenRgIds = {};
    allReagents.forEach(function(rg) {
      if (!seenRgIds[rg.item_id]) { seenRgIds[rg.item_id] = true; allReagentItemIds.push(rg.item_id); }
    });

    // Maps built during BFS
    var chainRecipesByItemId = {};  // item_id → [recipe, ...]  (may be multiple)
    var chainSubRgByRecipeId = {};  // recipe_id → [{item_id, quantity, name}]
    var chainNameById        = {};  // item_id → display name
    allReagents.forEach(function(rg) { if (rg.name) chainNameById[rg.item_id] = rg.name; });

    // BFS: discover the full crafting chain up to MAX_CHAIN_DEPTH levels
    var chainAllItemIds = new Set(allReagentItemIds);
    var bfsFrontier     = allReagentItemIds.slice();

    for (var bfsDepth = 0; bfsDepth < MAX_CHAIN_DEPTH && bfsFrontier.length > 0; bfsDepth++) {
      var bfsHoles     = bfsFrontier.map(function() { return '?'; }).join(',');
      var chainRecipes = db.prepare(
        'SELECT r.id AS recipe_id, r.crafted_item_id AS item_id, r.crafted_quantity, r.name AS recipe_name ' +
        'FROM recipes r WHERE r.crafted_item_id IN (' + bfsHoles + ')'
      ).all(bfsFrontier);

      if (!chainRecipes.length) break;

      chainRecipes.forEach(function(r) {
        if (!chainRecipesByItemId[r.item_id]) chainRecipesByItemId[r.item_id] = [];
        chainRecipesByItemId[r.item_id].push(r);
      });

      var chainRecipeIds = chainRecipes.map(function(r) { return r.recipe_id; });
      var crHoles        = chainRecipeIds.map(function() { return '?'; }).join(',');

      var chainSubRg = db.prepare(
        'SELECT rg.recipe_id, rg.item_id, rg.quantity, i.name ' +
        'FROM reagents rg ' +
        'LEFT JOIN items i ON i.id = rg.item_id AND i.quality = 0 AND i.bonus_list = \'\' ' +
        'WHERE rg.recipe_id IN (' + crHoles + ')'
      ).all(chainRecipeIds);

      chainSubRg.forEach(function(sr) {
        if (!chainSubRgByRecipeId[sr.recipe_id]) chainSubRgByRecipeId[sr.recipe_id] = [];
        chainSubRgByRecipeId[sr.recipe_id].push(sr);
        if (sr.name) chainNameById[sr.item_id] = sr.name;
      });

      var nextFrontier = [];
      chainSubRg.forEach(function(sr) {
        if (!chainAllItemIds.has(sr.item_id)) {
          chainAllItemIds.add(sr.item_id);
          nextFrontier.push(sr.item_id);
        }
      });
      bfsFrontier = nextFrontier;
    }

    // Fetch best market prices for every item in the chain in one query
    var chainItemArr = Array.from(chainAllItemIds);
    var chainPrices  = {};
    if (chainItemArr.length) {
      var cpHoles = chainItemArr.map(function() { return '?'; }).join(',');
      db.prepare(
        'SELECT t.item_id, MIN(t.unit_price) AS unit_price FROM (' +
        '  SELECT item_id, unit_price FROM current_prices WHERE region=? AND quality=0 AND bonus_list=\'\'' +
        '  UNION ALL' +
        '  SELECT item_id, MIN(unit_price) AS unit_price FROM current_realm_prices' +
        '    WHERE region=? AND quality=0 AND bonus_list=\'\' GROUP BY item_id' +
        ') t WHERE t.item_id IN (' + cpHoles + ') GROUP BY t.item_id'
      ).all([regionKey, regionKey].concat(chainItemArr)).forEach(function(p) {
        chainPrices[p.item_id] = p.unit_price;
      });
    }

    // Recursive cost resolver — memoized, cycle-safe via ancestor stack
    var resolvedCostCache = {};
    var resolveChainCost  = function(itemId, ancestors) {
      if (resolvedCostCache[itemId] !== undefined) return resolvedCostCache[itemId];
      var buyPrice = chainPrices[itemId] || 0;
      var recipes  = chainRecipesByItemId[itemId];
      if (!recipes || !recipes.length || ancestors.indexOf(itemId) !== -1) {
        resolvedCostCache[itemId] = buyPrice;
        return buyPrice;
      }
      ancestors.push(itemId);
      var bestPerUnit = Infinity;
      recipes.forEach(function(recipe) {
        var subs    = chainSubRgByRecipeId[recipe.recipe_id] || [];
        var cost    = subs.reduce(function(s, sr) { return s + sr.quantity * resolveChainCost(sr.item_id, ancestors); }, 0);
        var perUnit = recipe.crafted_quantity > 0 ? cost / recipe.crafted_quantity : cost;
        if (perUnit < bestPerUnit) bestPerUnit = perUnit;
      });
      ancestors.pop();
      var best = (buyPrice > 0 && buyPrice <= bestPerUnit) ? buyPrice :
                 (bestPerUnit < Infinity ? bestPerUnit : buyPrice);
      resolvedCostCache[itemId] = best;
      return best;
    };
    chainItemArr.forEach(function(id) { resolveChainCost(id, []); });

    // Build a display tree for a reagent recursively (picks cheapest recipe)
    var buildCraftNode = function(itemId, quantity, ancestors) {
      var marketPrice  = chainPrices[itemId] || 0;
      var resolvedCost = resolvedCostCache[itemId] !== undefined ? resolvedCostCache[itemId] : marketPrice;
      var recipes      = chainRecipesByItemId[itemId];
      var isCraftable  = !!(recipes && recipes.length && ancestors.indexOf(itemId) === -1);

      if (!isCraftable) {
        return { item_id: itemId, name: chainNameById[itemId] || null, quantity: quantity,
                 market_price: marketPrice, resolved_cost: resolvedCost, is_craftable: false };
      }

      var bestRecipe = null, bestPerUnit = Infinity;
      recipes.forEach(function(recipe) {
        var subs    = chainSubRgByRecipeId[recipe.recipe_id] || [];
        var cost    = subs.reduce(function(s, sr) { return s + sr.quantity * (resolvedCostCache[sr.item_id] || 0); }, 0);
        var perUnit = recipe.crafted_quantity > 0 ? cost / recipe.crafted_quantity : cost;
        if (perUnit < bestPerUnit) { bestPerUnit = perUnit; bestRecipe = recipe; }
      });

      ancestors.push(itemId);
      var subNodes = (chainSubRgByRecipeId[bestRecipe.recipe_id] || []).map(function(sr) {
        return buildCraftNode(sr.item_id, sr.quantity, ancestors.slice());
      });
      ancestors.pop();

      return {
        item_id:          itemId,
        name:             chainNameById[itemId] || null,
        quantity:         quantity,
        market_price:     marketPrice,
        resolved_cost:    resolvedCost,
        is_craftable:     true,
        recipe_id:        bestRecipe.recipe_id,
        recipe_name:      bestRecipe.recipe_name,
        crafted_quantity: bestRecipe.crafted_quantity,
        cost_per_unit:    bestPerUnit,
        sub_reagents:     subNodes,
      };
    };

    // Attach full craft tree to top-level reagents
    allReagents.forEach(function(rg) {
      if (chainRecipesByItemId[rg.item_id]) {
        rg.sub_craft = buildCraftNode(rg.item_id, rg.quantity, []);
      }
    });

    // ── Assemble ─────────────────────────────────────────────────
    var results = rows.map(function(row) {
      var reagents = (reagentsByRecipe[row.recipe_id] || []).map(function(rg) {
        var variants  = rg.icon ? (variantsByIcon[rg.icon] || []) : [];
        var bestPrice = variants.length ? variants[0].unit_price : (rg.unit_price || 0);
        rg.variants   = variants;
        rg.best_price = bestPrice;
        return rg;
      });

      var optimalCost = reagents.reduce(function(s, rg) { return s + rg.quantity * rg.best_price; }, 0);

      // Deep cost: for each reagent use min(quality-adjusted buy, full-chain resolved craft cost)
      var deepCost = reagents.reduce(function(s, rg) {
        var buyBest  = rg.best_price || 0;
        var resolved = resolvedCostCache[rg.item_id];
        var effective = (resolved !== undefined && resolved > 0 && resolved < buyBest) ? resolved : buyBest;
        return s + rg.quantity * effective;
      }, 0);

      var sellTotal   = row.sell_price * row.crafted_quantity;
      row.reagents       = reagents;
      row.direct_profit  = sellTotal - row.direct_cost;
      row.optimal_cost   = optimalCost;
      row.optimal_profit = sellTotal - optimalCost;
      row.deep_cost      = deepCost;
      row.deep_profit    = sellTotal - deepCost;
      row.has_sub_crafts = reagents.some(function(rg) {
        var resolved = resolvedCostCache[rg.item_id];
        return rg.sub_craft && resolved !== undefined && resolved < (rg.best_price || 0);
      });
      return row;
    });

    results.sort(function(a, b) { return b.optimal_profit - a.optimal_profit; });

    // ── Batch 4: top-3 sell realms for realm-specific items ──────
    var realmItemIds = results
      .filter(function(r) { return r.is_realm_item; })
      .map(function(r) { return r.item_id; });

    if (realmItemIds.length) {
      var ridHoles2 = realmItemIds.map(function() { return '?'; }).join(',');
      var realmSellPrices = db.prepare(
        'SELECT crp.item_id, crp.connected_realm_id, crp.unit_price, crp.quantity,' +
        '  GROUP_CONCAT(r.name, \' / \') AS realm_names ' +
        'FROM current_realm_prices crp ' +
        'JOIN realms r ON r.connected_realm_id = crp.connected_realm_id AND r.region = crp.region ' +
        'WHERE crp.region = ? AND crp.item_id IN (' + ridHoles2 + ')' +
        '  AND crp.quality = 0 AND crp.bonus_list = \'\' ' +
        'GROUP BY crp.item_id, crp.connected_realm_id ' +
        'ORDER BY crp.item_id, crp.unit_price DESC'
      ).all([regionKey].concat(realmItemIds));

      // Collect top-3 per item (already sorted DESC)
      var sellRealmsByItem = {};
      realmSellPrices.forEach(function(p) {
        if (!sellRealmsByItem[p.item_id]) sellRealmsByItem[p.item_id] = [];
        if (sellRealmsByItem[p.item_id].length < 3) sellRealmsByItem[p.item_id].push(p);
      });

      results.forEach(function(row) {
        if (row.is_realm_item) row.sell_realms = sellRealmsByItem[row.item_id] || [];
      });
    }

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
