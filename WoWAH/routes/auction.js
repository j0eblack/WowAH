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

module.exports = router;
