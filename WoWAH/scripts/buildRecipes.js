#!/usr/bin/env node
// Rebuilds the recipes and reagents tables from the Blizzard API.
// Run with: node scripts/buildRecipes.js
// The server does NOT need to be running. Just needs a valid .env with Blizzard credentials.
//
// Behaviour:
//   - Wipes recipes and reagents tables once at startup, then rebuilds from scratch.
//   - When a recipe has a crafted_item, its ID is used as crafted_item_id.
//   - When a recipe has no crafted_item, the recipe name is looked up in the items
//     table to find a matching item_id. Falls back to the recipe's own ID.
//
// Source: Profession index — all professions → skill tiers → recipes

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('../lib/blizzard');

var FETCH_DELAY  = 80;   // ms between profession/tier requests
var RETRY_DELAY  = 5000; // ms before retrying a failed request
var CONCURRENCY  = 5;   // parallel recipe detail fetches

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Helpers ───────────────────────────────────────────────────

function tierNameToExpansion(tierName) {
  var n = (tierName || '').toLowerCase();
  if (n.includes('midnight'))                                                           return 'Midnight';
  if (n.includes('khaz algar') || n.includes('war within') || n.includes('home'))      return 'The War Within';
  if (n.includes('dragon isle') || n.includes('dragonflight'))                         return 'Dragonflight';
  if (n.includes('shadowland') || n.includes('zereth'))                                return 'Shadowlands';
  if (n.includes('kul tiran') || n.includes('zandalari') || n.includes('tiragarde'))   return 'Battle for Azeroth';
  if (n.includes('legion'))                                                             return 'Legion';
  if (n.includes('draenor'))                                                            return 'Warlords of Draenor';
  if (n.includes('pandaria'))                                                           return 'Mists of Pandaria';
  if (n.includes('cataclysm'))                                                          return 'Cataclysm';
  if (n.includes('northrend'))                                                          return 'Wrath of the Lich King';
  if (n.includes('outland'))                                                            return 'The Burning Crusade';
  if (n.includes('classic'))                                                            return 'Classic';
  return null;
}

// Retries indefinitely every 5 s on any error.
async function blizzardGet(url, params, token) {
  for (;;) {
    try {
      return await axios.get(url, {
        params,
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 10000,
      });
    } catch (e) {
      console.warn('  Request failed (' + url + '):', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

// Inserts a single recipe + its reagents.
function insertRecipe(r, profName, expansion, stmts) {
  var craftedItemId;
  if (r.crafted_item) {
    craftedItemId = r.crafted_item.id;
  } else {
    // Try to find a matching item in the items table by name.
    var match = stmts.findItemByName.get(r.name);
    craftedItemId = match ? match.id : r.id;
  }

  var qty = r.crafted_quantity
    ? (r.crafted_quantity.value || r.crafted_quantity.minimum || 1) : 1;

  var reagents = r.reagents || [];

  // Pull reagents from modified_crafting_slots (TWW system).
  // These slots list items by name only — look them up in the items table to get an ID.
  (r.modified_crafting_slots || []).forEach(function(slot) {
    var slotName = slot.reagent_slot_type && slot.reagent_slot_type.name;
    if (!slotName) return;
    var itemRow = stmts.findItemByName.get(slotName);
    if (!itemRow) return; // item not in our database, skip
    var alreadyPresent = reagents.find(function(x) { return x.reagent.id === itemRow.id; });
    if (!alreadyPresent) {
      reagents.push({ reagent: { id: itemRow.id }, quantity: slot.quantity || 1 });
    }
  });

  db.transaction(function() {
    stmts.insertRecipe.run(r.id, r.name, craftedItemId, qty, profName, expansion);
    reagents.forEach(function(rg) {
      stmts.insertReagent.run(r.id, rg.reagent.id, rg.quantity);
    });
  })();
}

// ── Profession crawl ──────────────────────────────────────────

// Pass 1: walk profession → tier → category tree and collect all recipe refs.
async function collectRecipeRefs(base, ns, locale, token) {
  var profIndex  = await blizzardGet(base + '/data/wow/profession/index', { namespace: ns, locale }, token);
  var professions = profIndex.data.professions || [];
  var refs = []; // [{ id, profName, expansion }]

  for (var pi = 0; pi < professions.length; pi++) {
    var prof = professions[pi];
    await sleep(FETCH_DELAY);

    var profDetail = await blizzardGet(base + '/data/wow/profession/' + prof.id, { namespace: ns, locale }, token);
    console.log('\nProfession:', prof.name);

    var tiers = profDetail.data.skill_tiers || [];
    for (var ti = 0; ti < tiers.length; ti++) {
      var tier = tiers[ti];
      await sleep(FETCH_DELAY);

      var tierDetail = await blizzardGet(
        base + '/data/wow/profession/' + prof.id + '/skill-tier/' + tier.id,
        { namespace: ns, locale }, token
      );

      var expansion  = tierNameToExpansion(tierDetail.data.name);
      var categories = tierDetail.data.categories || [];
      console.log('  Tier:', tierDetail.data.name, expansion ? ('(' + expansion + ')') : '(unmapped)');

      for (var ci = 0; ci < categories.length; ci++) {
        var recipes = categories[ci].recipes || [];
        for (var ri = 0; ri < recipes.length; ri++) {
          refs.push({ id: recipes[ri].id, profName: prof.name, expansion: expansion });
        }
      }
    }
  }

  return refs;
}

// Pass 2: fetch recipe details in parallel and insert.
async function fetchAndInsertRecipes(refs, base, ns, locale, token, stmts, counts) {
  console.log('\nFetching', refs.length, 'recipes with', CONCURRENCY, 'parallel workers…');

  var index = 0;
  var total = refs.length;

  async function worker() {
    while (index < total) {
      var ref = refs[index++];
      var rd  = await blizzardGet(base + '/data/wow/recipe/' + ref.id, { namespace: ns, locale }, token);
      insertRecipe(rd.data, ref.profName, ref.expansion, stmts);
      counts.added++;
      process.stdout.write('  + ' + rd.data.name + '\n');
    }
  }

  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
}

// ── Entry point ───────────────────────────────────────────────

async function main() {
  var token = await blizzard.getToken();

  var region = blizzard.REGIONS['eu'];
  var base   = region.host;
  var ns     = region.staticNamespace;
  var locale = region.locale;

  // Wipe all three tables for a clean rebuild
  db.prepare('DELETE FROM reagents').run();
  db.prepare('DELETE FROM recipes').run();
  console.log('Tables cleared (items, recipes, reagents). Starting full recipe crawl…');

  var stmts = {
    findItemByName: db.prepare('SELECT id FROM items WHERE name = ? LIMIT 1'),
    insertRecipe:   db.prepare("INSERT OR REPLACE INTO recipes (id, name, crafted_item_id, crafted_quantity, profession, expansion, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"),
    insertReagent:  db.prepare('INSERT OR REPLACE INTO reagents (recipe_id, item_id, quantity) VALUES (?, ?, ?)'),
  };

  var counts = { added: 0 };

  var refs = await collectRecipeRefs(base, ns, locale, token);
  await fetchAndInsertRecipes(refs, base, ns, locale, token, stmts, counts);

  console.log('\nDone. Recipes stored:', counts.added);
  process.exit(0);
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
