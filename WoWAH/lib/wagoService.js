// Fetches World of Warcraft game data from wago.tools DB2 exports.
// Used as the authoritative source for recipe reagents and item metadata,
// replacing per-item Blizzard API calls with a single bulk download.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');

const WAGO_BASE   = 'https://wago.tools/db2/';
const RETRY_DELAY = 5000;

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── CSV helpers ────────────────────────────────────────────────────
function splitCSVLine(line) {
  var fields = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  var lines = text.split('\n');
  if (!lines.length) return [];
  var headers = splitCSVLine(lines[0]);
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var vals = splitCSVLine(line);
    var row = {};
    headers.forEach(function(h, j) { row[h] = vals[j] !== undefined ? vals[j] : ''; });
    rows.push(row);
  }
  return rows;
}

// ── Generic full-table download ────────────────────────────────────
async function fetchDB2(table) {
  var url = WAGO_BASE + table + '/csv';
  console.log('[WagoService] Downloading', table, '…');
  for (;;) {
    try {
      var res = await axios.get(url, {
        timeout: 120000,
        responseType: 'text',
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      });
      var rows = parseCSV(typeof res.data === 'string' ? res.data : String(res.data));
      console.log('[WagoService]   ' + rows.length + ' rows');
      return rows;
    } catch (e) {
      if (e.response && e.response.status === 404) {
        console.warn('[WagoService] Table not found:', table);
        return [];
      }
      console.warn('[WagoService] Request failed (' + table + '):', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

// ── SpellReagents ──────────────────────────────────────────────────
// Returns Map<spellId, Array<{ itemId, count }>>
// Each row has: SpellID, Reagent_0..7, ReagentCount_0..7
async function fetchSpellReagents() {
  var rows = await fetchDB2('SpellReagents');

  var bySpell = new Map();
  rows.forEach(function(row) {
    var spellId = parseInt(row.SpellID || 0);
    if (!spellId) return;

    var reagents = [];
    for (var i = 0; i <= 7; i++) {
      var itemId = parseInt(row['Reagent_' + i] || 0);
      var count  = parseInt(row['ReagentCount_' + i] || 0);
      if (itemId && count) reagents.push({ itemId: itemId, count: count });
    }
    if (reagents.length) bySpell.set(spellId, reagents);
  });

  console.log('[WagoService] SpellReagents: ' + bySpell.size + ' spells have reagent data.');
  return bySpell;
}

// ── ItemSparse (streamed) ──────────────────────────────────────────
// Streams the large ItemSparse table, keeping only rows whose ID is in
// the provided itemIds Set.  Returns Map<itemId, { name, itemLevel, quality, classId, subclassId }>
//
// Column name fallbacks handle minor variations between wago.tools builds:
//   name      → Display_lang | Display | Name_lang | Name
//   itemLevel → ItemLevel | iLvl
//   quality   → OverallQualityID | Quality
//   classId   → ClassID | Class
//   subclassId→ SubclassID | Subclass
async function streamItemSparse(itemIds) {
  var url = WAGO_BASE + 'ItemSparse/csv';
  console.log('[WagoService] Streaming ItemSparse for ' + (itemIds ? itemIds.size : 'all') + ' item IDs…');

  for (;;) {
    try {
      var res = await axios.get(url, {
        responseType: 'stream',
        timeout: 300000, // 5 min — table is large
        headers: { 'Accept-Encoding': 'gzip, deflate' },
      });

      return await new Promise(function(resolve, reject) {
        var headers = null;
        var buffer  = '';
        var result  = new Map();

        res.data.on('data', function(chunk) {
          buffer += chunk.toString();
          var lines = buffer.split('\n');
          buffer = lines.pop(); // keep the incomplete trailing line

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (!headers) {
              headers = splitCSVLine(line);
              continue;
            }

            var vals = splitCSVLine(line);
            var id   = parseInt(vals[headers.indexOf('ID')] || 0);
            if (!id) continue;
            if (itemIds && itemIds.size && !itemIds.has(id)) continue;

            var row = {};
            headers.forEach(function(h, j) { row[h] = vals[j] || ''; });

            result.set(id, {
              name:       row.Display_lang || row.Display || row.Name_lang || row.Name || '',
              itemLevel:  parseInt(row.ItemLevel || row.iLvl || 0),
              quality:    parseInt(row.OverallQualityID || row.Quality || 0),
              classId:    parseInt(row.ClassID || row.Class || 0) || null,
              subclassId: parseInt(row.SubclassID || row.Subclass || 0) || null,
            });

            if (result.size % 500 === 0) {
              process.stdout.write('[WagoService] ItemSparse: ' + result.size + ' matching items…\r');
            }
          }
        });

        res.data.on('end', function() {
          process.stdout.write('\n');
          console.log('[WagoService] ItemSparse: ' + result.size + ' items collected.');
          resolve(result);
        });

        res.data.on('error', reject);
      });

    } catch (e) {
      console.warn('[WagoService] ItemSparse stream failed:', e.message, '— retrying in 5 s…');
      await sleep(RETRY_DELAY);
    }
  }
}

module.exports = { fetchSpellReagents, streamItemSparse };
