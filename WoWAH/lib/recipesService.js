// Crawls the Blizzard profession API and upserts recipes + reagents.
// Uses INSERT OR REPLACE — never wipes the tables.
// Returns { total, newCount } so the caller can decide whether to trigger an items sync.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios        = require('axios');
const db           = require('../db');
const blizzard     = require('./blizzard');
var itemsService = require('./itemsService');
var wagoService  = require('./wagoService');

var FETCH_DELAY = 80;
var RETRY_DELAY = 5000;
var CONCURRENCY = 5;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

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

async function blizzardGet(url, params, token) {
  for (;;) {
    try {
      return await axios.get(url, {
        params,
        headers: { 'Authorization': 'Bearer ' + token },
        timeout: 10000,
      });
    } catch (e) {
      console.warn('[RecipesService] Request failed (' + url + '):', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

function upsertRecipe(r, profName, expansion, stmts, reagentsBySpell) {
  var craftedItemId;
  if (r.crafted_item) {
    craftedItemId = r.crafted_item.id;
  } else {
    var match = stmts.findItemByName.get(r.name);
    craftedItemId = match ? match.id : r.id;
  }

  var qty = r.crafted_quantity
    ? (r.crafted_quantity.value || r.crafted_quantity.minimum || 1) : 1;

  // Reagents: wago.tools SpellReagents is the primary source (complete list).
  // Fall back to Blizzard API reagents for spells not present in SpellReagents.
  var wagoReagents = reagentsBySpell && reagentsBySpell.get(r.id);
  var reagents;
  if (wagoReagents && wagoReagents.length) {
    reagents = wagoReagents.map(function(rg) {
      return { reagent: { id: rg.itemId }, quantity: rg.count };
    });
  } else {
    reagents = (r.reagents || []).slice();
  }

  // modified_crafting_slots: optional reagents resolved by slot-type name.
  (r.modified_crafting_slots || []).forEach(function(slot) {
    var slotName = slot.reagent_slot_type && slot.reagent_slot_type.name;
    if (!slotName) return;
    var itemRow = stmts.findItemByName.get(slotName);
    if (!itemRow) return;
    var alreadyPresent = reagents.find(function(x) { return x.reagent.id === itemRow.id; });
    if (!alreadyPresent) {
      reagents.push({ reagent: { id: itemRow.id }, quantity: slot.quantity || 1 });
    }
  });

  var isNew = !stmts.findRecipe.get(r.id);

  db.transaction(function() {
    stmts.insertRecipe.run(r.id, r.name, craftedItemId, qty, profName, expansion);
    reagents.forEach(function(rg) {
      stmts.insertReagent.run(r.id, rg.reagent.id, rg.quantity);
    });
  })();

  return isNew;
}

async function collectRecipeRefs(base, ns, locale, token) {
  var profIndex   = await blizzardGet(base + '/data/wow/profession/index', { namespace: ns, locale }, token);
  var professions = profIndex.data.professions || [];
  var refs = [];

  for (var pi = 0; pi < professions.length; pi++) {
    var prof = professions[pi];
    await sleep(FETCH_DELAY);

    var profDetail = await blizzardGet(base + '/data/wow/profession/' + prof.id, { namespace: ns, locale }, token);
    console.log('[RecipesService] Profession:', prof.name);

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
      console.log('[RecipesService]   Tier:', tierDetail.data.name, expansion ? ('(' + expansion + ')') : '(unmapped)');

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

// Phase 1: download all recipe details from Blizzard, return raw data.
async function downloadRecipes(refs, base, ns, locale, token) {
  console.log('[RecipesService] Downloading ' + refs.length + ' recipe details with ' + CONCURRENCY + ' parallel workers…');

  var results = new Array(refs.length);
  var index   = 0;
  var total   = refs.length;

  async function worker() {
    while (index < total) {
      var i   = index++;
      var ref = refs[i];
      var rd  = await blizzardGet(base + '/data/wow/recipe/' + ref.id, { namespace: ns, locale }, token);
      results[i] = { data: rd.data, profName: ref.profName, expansion: ref.expansion };
      if (i % 100 === 0) process.stdout.write('[RecipesService] Downloaded ' + (i + 1) + ' / ' + total + '\r');
    }
  }

  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  process.stdout.write('\n');

  return results;
}

// Phase 2: upsert pre-downloaded recipe data into the DB.
// reagentsBySpell: Map<spellId, [{itemId, count}]> from wago.tools SpellReagents.
// When a spell has wago reagent data it takes precedence over the Blizzard API list.
function upsertAllRecipes(rawRecipes, stmts, reagentsBySpell) {
  var newCount = 0;
  rawRecipes.forEach(function(r) {
    var isNew = upsertRecipe(r.data, r.profName, r.expansion, stmts, reagentsBySpell);
    if (isNew) {
      newCount++;
      process.stdout.write('[RecipesService] + ' + r.data.name + '\n');
    }
  });
  return newCount;
}

// Expansions in descending order (newest first).
var EXPANSION_ORDER = [
  'Midnight',
  'The War Within',
  'Dragonflight',
  'Shadowlands',
  'Battle for Azeroth',
  'Legion',
  'Warlords of Draenor',
  'Mists of Pandaria',
  'Cataclysm',
  'Wrath of the Lich King',
  'The Burning Crusade',
  'Classic',
  null, // unmapped tiers
];

async function run() {
  var token  = await blizzard.getToken();
  var region = blizzard.REGIONS['eu'];
  var base   = region.host;
  var ns     = region.staticNamespace;
  var locale = region.locale;

  // ── Phase 1: fetch SpellReagents from wago.tools ─────────────
  var reagentsBySpell = await wagoService.fetchSpellReagents();

  // ── Phase 2: collect recipe refs from the profession index ───
  var refs = await collectRecipeRefs(base, ns, locale, token);

  // ── Phase 3: download all recipe details from Blizzard ───────
  var rawRecipes = await downloadRecipes(refs, base, ns, locale, token);

  // ── Phase 4: collect ALL item IDs across all expansions ──────
  // Use wago reagents where available; fall back to Blizzard API reagents.
  // modified_crafting_slots are resolved by name at upsert time (after items
  // are stored), so they are not collected here.
  var allItemIds = new Set();
  rawRecipes.forEach(function(r) {
    if (r.data.crafted_item && r.data.crafted_item.id) {
      allItemIds.add(r.data.crafted_item.id);
    }
    var wagoReagents = reagentsBySpell.get(r.data.id);
    if (wagoReagents && wagoReagents.length) {
      wagoReagents.forEach(function(rg) { allItemIds.add(rg.itemId); });
    } else {
      (r.data.reagents || []).forEach(function(rg) {
        if (rg.reagent && rg.reagent.id) allItemIds.add(rg.reagent.id);
      });
    }
  });

  // ── Phase 5: stream ItemSparse from wago.tools ───────────────
  var wagoItemsMap = await wagoService.streamItemSparse(allItemIds);

  // ── Phase 6: group recipes by expansion ──────────────────────
  var byExpansion = {};
  rawRecipes.forEach(function(r) {
    var key = r.expansion !== null && r.expansion !== undefined ? r.expansion : '__null__';
    if (!byExpansion[key]) byExpansion[key] = [];
    byExpansion[key].push(r);
  });

  var stmts = {
    findItemByName: db.prepare('SELECT id FROM items WHERE name = ? LIMIT 1'),
    findRecipe:     db.prepare('SELECT id FROM recipes WHERE id = ?'),
    insertRecipe:   db.prepare("INSERT OR REPLACE INTO recipes (id, name, crafted_item_id, crafted_quantity, profession, expansion, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"),
    insertReagent:  db.prepare('INSERT OR REPLACE INTO reagents (recipe_id, item_id, quantity) VALUES (?, ?, ?)'),
  };

  var totalNew = 0;

  // ── Phase 7: per expansion (newest → oldest): items first, then recipes ─
  for (var ei = 0; ei < EXPANSION_ORDER.length; ei++) {
    var expansion = EXPANSION_ORDER[ei];
    var key = expansion !== null ? expansion : '__null__';
    var expansionRecipes = byExpansion[key] || [];
    if (!expansionRecipes.length) continue;

    console.log('[RecipesService] ══ ' + (expansion || 'Unknown') + ' (' + expansionRecipes.length + ' recipes) ══');

    // Collect item IDs for this expansion (crafted items + reagents).
    // modified_crafting_slots are resolved by name at upsert time.
    var recipeItemIds = new Set();
    expansionRecipes.forEach(function(r) {
      if (r.data.crafted_item && r.data.crafted_item.id) {
        recipeItemIds.add(r.data.crafted_item.id);
      }
      var wagoReagents = reagentsBySpell.get(r.data.id);
      if (wagoReagents && wagoReagents.length) {
        wagoReagents.forEach(function(rg) { recipeItemIds.add(rg.itemId); });
      } else {
        (r.data.reagents || []).forEach(function(rg) {
          if (rg.reagent && rg.reagent.id) recipeItemIds.add(rg.reagent.id);
        });
      }
    });

    var entries = Array.from(recipeItemIds).map(function(id) {
      return { id: id, quality: 0, bonus_list: '' };
    });

    console.log('[RecipesService] Storing ' + entries.length + ' items for this expansion…');

    // Items first: store all relevant items for this expansion from wago data.
    await itemsService.fetchNewItemsFromWago(entries, wagoItemsMap);

    // Recipes second: upsert recipes + reagents.
    // findItemByName lookups for modified_crafting_slots now succeed because
    // those items were stored in the step above.
    var newCount = upsertAllRecipes(expansionRecipes, stmts, reagentsBySpell);
    totalNew += newCount;
    console.log('[RecipesService] ' + (expansion || 'Unknown') + ' done — ' + newCount + ' new recipes.');
  }

  var total = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  console.log('[RecipesService] All expansions done. Total recipes in DB: ' + total + ' (' + totalNew + ' new)');
  return { total, newCount: totalNew };
}

module.exports = { run };
