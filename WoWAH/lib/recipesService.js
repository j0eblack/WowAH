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
  // Midnight — profession tiers may be named after Quel'Thalas zones
  if (n.includes('midnight') || n.includes("quel'thalas") || n.includes('quelthalas') ||
      n.includes('quel thalas') || n.includes('silvermoon') || n.includes('sunstrider'))
                                                                                        return 'Midnight';
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

function upsertRecipe(r, profName, expansion, stmts, reagentsBySpell, spellToCraftedItemId, craftingDataById, modifiedCraftingQuantities) {
  var craftedItemId;
  var craftingDataQty = null;
  if (r.crafted_item) {
    craftedItemId = r.crafted_item.id;
  } else {
    // Priority: CraftingData (authoritative for processing recipes) > spell→item map > DB name
    var cd = craftingDataById && craftingDataById.get(r.id);
    if (cd && cd.itemId) {
      craftedItemId   = cd.itemId;
      craftingDataQty = cd.quantity; // average yield from CraftingData min/max
    } else {
      var wagoId = spellToCraftedItemId && spellToCraftedItemId.get(r.id);
      if (wagoId) {
        craftedItemId = wagoId;
      } else {
        // Fall back to DB name lookup (works for items already discovered via AH scan)
        var match = stmts.findItemByName.get(r.name);
        if (!match) {
          console.log('[RecipesService] Skipping recipe', r.id, '(' + r.name + ') — crafted item unknown');
          return null;
        }
        craftedItemId = match.id;
      }
    }
  }

  // crafted_quantity: prefer Blizzard API value; fall back to CraftingData average yield.
  var qty = r.crafted_quantity
    ? (r.crafted_quantity.value || r.crafted_quantity.minimum || 1)
    : (craftingDataQty || 1);

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
  // Quantities come from wago ModifiedCraftingSpellSlot (keyed by internal spell ID
  // looked up via recipe name). Falls back to 1 if no wago data available.
  var recipeSlotQtys = modifiedCraftingQuantities &&
    modifiedCraftingQuantities.get((r.name || '').toLowerCase());
  (r.modified_crafting_slots || []).forEach(function(slot) {
    var slotName   = (slot.slot_type && slot.slot_type.name) ||
                     (slot.reagent_slot_type && slot.reagent_slot_type.name);
    var slotTypeId = (slot.slot_type && slot.slot_type.id) ||
                     (slot.reagent_slot_type && slot.reagent_slot_type.id);
    if (!slotName) return;
    var itemRow = stmts.findItemByName.get(slotName);
    if (!itemRow) return;
    var alreadyPresent = reagents.find(function(x) { return x.reagent.id === itemRow.id; });
    if (!alreadyPresent) {
      var qty = (recipeSlotQtys && slotTypeId && recipeSlotQtys.get(slotTypeId)) || 1;
      reagents.push({ reagent: { id: itemRow.id }, quantity: qty });
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

// Categories treated as "processing" — included regardless of expansion so
// that Prospecting / Milling / Crushing recipes are always in the DB and
// reachable by the sub-craft BFS chain even when the main crafting list
// is filtered to a single expansion.
var PROCESSING_CATEGORIES = ['prospecting', 'milling', 'crushing', 'disenchanting', 'smelting'];

function isProcessingCategory(categoryName) {
  var n = (categoryName || '').toLowerCase();
  return PROCESSING_CATEGORIES.some(function(p) { return n.includes(p); });
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
        var catName = (categories[ci].name || '');
        var recipes = categories[ci].recipes || [];
        for (var ri = 0; ri < recipes.length; ri++) {
          refs.push({ id: recipes[ri].id, profName: prof.name, expansion: expansion, category: catName });
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
// reagentsBySpell:  Map<spellId, [{itemId, count}]>  from wago.tools SpellReagents.
// craftingDataById: Map<spellId, {itemId, quantity}> from wago.tools CraftingData.
// When a spell has wago reagent data it takes precedence over the Blizzard API list.
function upsertAllRecipes(rawRecipes, stmts, reagentsBySpell, spellToCraftedItemId, craftingDataById, modifiedCraftingQuantities) {
  var newCount = 0;
  rawRecipes.forEach(function(r) {
    var isNew = upsertRecipe(r.data, r.profName, r.expansion, stmts, reagentsBySpell, spellToCraftedItemId, craftingDataById, modifiedCraftingQuantities);
    if (isNew === null) return; // crafted item unknown — skipped
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

  // ── Phase 1: fetch SpellReagents + CraftingData + slot quantities from wago.tools ──
  var reagentsBySpell           = await wagoService.fetchSpellReagents();
  var craftingDataById          = await wagoService.fetchCraftingData(); // SpellID → { itemId, quantity }
  var modifiedCraftingQuantities = await wagoService.fetchModifiedCraftingQuantities(); // name → slotTypeId → qty

  // ── Phase 2: collect recipe refs from the profession index ────
  var refs = await collectRecipeRefs(base, ns, locale, token);
  // Keep Midnight crafting recipes AND processing recipes from any expansion
  // (Prospecting, Milling, Crushing, etc.) so the sub-craft chain can follow them.
  refs = refs.filter(function(r) {
    return r.expansion === 'Midnight' || isProcessingCategory(r.category);
  });
  console.log('[RecipesService] Filtered refs: ' + refs.length +
    ' (' + refs.filter(function(r){return r.expansion==='Midnight';}).length + ' Midnight + ' +
    refs.filter(function(r){return isProcessingCategory(r.category);}).length + ' processing)');

  // ── Phase 3: download all recipe details from Blizzard ───────
  var rawRecipes = await downloadRecipes(refs, base, ns, locale, token);

  // ── Phase 4: collect ALL item IDs across all fetched recipes ────
  // Use wago reagents where available; fall back to Blizzard API reagents.
  // modified_crafting_slots are resolved by name at upsert time.
  // craftedByName: lowercase recipe names whose crafted_item is absent from the
  // Blizzard API (common in alpha/beta).  We use the recipe name to find the
  // crafted item in wago.tools ItemSparse (recipe name == item name in WoW).
  var allItemIds    = new Set();
  var craftedByName = new Set(); // names resolved via wago ItemSparse (crafted items + slot-type reagents)
  rawRecipes.forEach(function(r) {
    if (r.data.crafted_item && r.data.crafted_item.id) {
      allItemIds.add(r.data.crafted_item.id);
    } else {
      // For processing recipes (Prospecting/Milling/Crushing) the Blizzard API
      // often omits crafted_item in alpha/beta — use CraftingData as primary source.
      var cd = craftingDataById.get(r.data.id);
      if (cd && cd.itemId) {
        allItemIds.add(cd.itemId);
      } else if (r.data.name) {
        craftedByName.add(r.data.name.toLowerCase());
      }
    }
    var wagoReagents = reagentsBySpell.get(r.data.id);
    if (wagoReagents && wagoReagents.length) {
      wagoReagents.forEach(function(rg) { allItemIds.add(rg.itemId); });
    } else {
      (r.data.reagents || []).forEach(function(rg) {
        if (rg.reagent && rg.reagent.id) allItemIds.add(rg.reagent.id);
      });
    }
    // modified_crafting_slots: collect slot-type names so wago can resolve their IDs.
    (r.data.modified_crafting_slots || []).forEach(function(slot) {
      var name = (slot.slot_type && slot.slot_type.name) ||
                 (slot.reagent_slot_type && slot.reagent_slot_type.name);
      if (name) craftedByName.add(name.toLowerCase());
    });
  });

  // ── Phase 5: stream ItemSparse from wago.tools ───────────────
  // Pass both known IDs and recipe names so that crafted items with no
  // crafted_item field in the Blizzard API are resolved by name.
  var wagoItemsMap = await wagoService.streamItemSparse(allItemIds, craftedByName);

  // ── Phase 5b: build name→ID and spell→craftedItemId maps ─────
  // Invert wagoItemsMap to get a name-based lookup.
  var nameToItemId = new Map();
  wagoItemsMap.forEach(function(data, id) {
    if (data.name) nameToItemId.set(data.name.toLowerCase(), id);
  });

  // Map spell ID → crafted item ID for recipes that lack crafted_item.
  // Priority: CraftingData wago table > ItemSparse name match.
  // CraftingData is the authoritative source for processing recipes
  // (Prospecting, Milling, Crushing) where Blizzard often omits crafted_item.
  var spellToCraftedItemId = new Map();
  rawRecipes.forEach(function(r) {
    if (!r.data.crafted_item || !r.data.crafted_item.id) {
      var cd     = craftingDataById.get(r.data.id);
      var itemId = (cd && cd.itemId) || nameToItemId.get((r.data.name || '').toLowerCase());
      if (itemId) {
        spellToCraftedItemId.set(r.data.id, itemId);
        allItemIds.add(itemId); // ensure icon is fetched later
      }
    }
  });

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
      } else {
        var cd     = craftingDataById.get(r.data.id);
        var nameId = (cd && cd.itemId) || spellToCraftedItemId.get(r.data.id);
        if (nameId) recipeItemIds.add(nameId);
      }
      var wagoReagents = reagentsBySpell.get(r.data.id);
      if (wagoReagents && wagoReagents.length) {
        wagoReagents.forEach(function(rg) { recipeItemIds.add(rg.itemId); });
      } else {
        (r.data.reagents || []).forEach(function(rg) {
          if (rg.reagent && rg.reagent.id) recipeItemIds.add(rg.reagent.id);
        });
      }
      // modified_crafting_slots: resolve slot-type names to item IDs via wago.
      (r.data.modified_crafting_slots || []).forEach(function(slot) {
        var name = (slot.slot_type && slot.slot_type.name) ||
                   (slot.reagent_slot_type && slot.reagent_slot_type.name);
        if (!name) return;
        var itemId = nameToItemId.get(name.toLowerCase());
        if (itemId) recipeItemIds.add(itemId);
      });
    });

    var entries = Array.from(recipeItemIds).map(function(id) {
      return { id: id, quality: 0, bonus_list: '' };
    });

    console.log('[RecipesService] Storing ' + entries.length + ' items for this expansion…');

    // Items first: store structure from wago data, then fill icons from Blizzard.
    // fetchNewItemsFromWago stores name/level/class but icon=''. fetchItemBatch
    // then refetches any item missing an icon (see fetchNewItems known-set logic).
    await itemsService.fetchNewItemsFromWago(entries, wagoItemsMap);
    await itemsService.fetchItemBatch(Array.from(recipeItemIds));

    // Recipes second: upsert recipes + reagents.
    // findItemByName lookups for modified_crafting_slots now succeed because
    // those items were stored in the step above.
    var newCount = upsertAllRecipes(expansionRecipes, stmts, reagentsBySpell, spellToCraftedItemId, craftingDataById, modifiedCraftingQuantities);
    totalNew += newCount;
    console.log('[RecipesService] ' + (expansion || 'Unknown') + ' done — ' + newCount + ' new recipes.');
  }

  var total = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  console.log('[RecipesService] All expansions done. Total recipes in DB: ' + total + ' (' + totalNew + ' new)');
  return { total, newCount: totalNew };
}

module.exports = { run };
