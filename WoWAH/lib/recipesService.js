// Crawls the Blizzard profession API and upserts recipes + reagents.
// Uses INSERT OR REPLACE — never wipes the tables.
// Returns { total, newCount } so the caller can decide whether to trigger an items sync.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios    = require('axios');
const db       = require('../db');
const blizzard = require('./blizzard');

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

function upsertRecipe(r, profName, expansion, stmts) {
  var craftedItemId;
  if (r.crafted_item) {
    craftedItemId = r.crafted_item.id;
  } else {
    var match = stmts.findItemByName.get(r.name);
    craftedItemId = match ? match.id : r.id;
  }

  var qty = r.crafted_quantity
    ? (r.crafted_quantity.value || r.crafted_quantity.minimum || 1) : 1;

  var reagents = (r.reagents || []).slice();

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

async function fetchAndUpsertRecipes(refs, base, ns, locale, token, stmts) {
  console.log('[RecipesService] Upserting ' + refs.length + ' recipes with ' + CONCURRENCY + ' parallel workers…');

  var index    = 0;
  var total    = refs.length;
  var newCount = 0;

  async function worker() {
    while (index < total) {
      var ref = refs[index++];
      var rd  = await blizzardGet(base + '/data/wow/recipe/' + ref.id, { namespace: ns, locale }, token);
      var isNew = upsertRecipe(rd.data, ref.profName, ref.expansion, stmts);
      if (isNew) {
        newCount++;
        process.stdout.write('[RecipesService] + ' + rd.data.name + '\n');
      }
    }
  }

  var workers = [];
  for (var i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return newCount;
}

async function run() {
  var token  = await blizzard.getToken();
  var region = blizzard.REGIONS['eu'];
  var base   = region.host;
  var ns     = region.staticNamespace;
  var locale = region.locale;

  var stmts = {
    findItemByName: db.prepare('SELECT id FROM items WHERE name = ? LIMIT 1'),
    findRecipe:     db.prepare('SELECT id FROM recipes WHERE id = ?'),
    insertRecipe:   db.prepare("INSERT OR REPLACE INTO recipes (id, name, crafted_item_id, crafted_quantity, profession, expansion, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"),
    insertReagent:  db.prepare('INSERT OR REPLACE INTO reagents (recipe_id, item_id, quantity) VALUES (?, ?, ?)'),
  };

  var refs     = await collectRecipeRefs(base, ns, locale, token);
  var newCount = await fetchAndUpsertRecipes(refs, base, ns, locale, token, stmts);
  var total    = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;

  console.log('[RecipesService] Done. Total recipes in DB: ' + total + ' (' + newCount + ' new)');
  return { total, newCount };
}

module.exports = { run };
