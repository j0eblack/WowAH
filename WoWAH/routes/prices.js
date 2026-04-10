const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/prices/history/:itemId?region=eu&days=7
// Raw price history for charting.
router.get('/prices/history/:itemId', function(req, res) {
  var days      = parseInt(req.query.days) || 7;
  var regionKey = (req.query.region || 'eu').toLowerCase();
  var rows = db.prepare(
    'SELECT unit_price, quantity, recorded_at ' +
    'FROM price_history ' +
    "WHERE item_id = ? AND region = ? AND recorded_at > datetime('now', '-' || ? || ' days') " +
    'ORDER BY recorded_at ASC'
  ).all(req.params.itemId, regionKey, days);
  res.json(rows);
});

// GET /api/prices/analysis/:itemId?region=eu&days=7
// Summary statistics + buy/sell signals.
router.get('/prices/analysis/:itemId', function(req, res) {
  var itemId    = req.params.itemId;
  var days      = parseInt(req.query.days) || 7;
  var regionKey = (req.query.region || 'eu').toLowerCase();

  var stats = db.prepare(
    'SELECT ' +
    '  ROUND(AVG(unit_price)) AS avg_price, ' +
    '  MIN(unit_price)        AS min_price, ' +
    '  MAX(unit_price)        AS max_price, ' +
    '  COUNT(*)               AS data_points ' +
    'FROM price_history ' +
    "WHERE item_id = ? AND region = ? AND recorded_at > datetime('now', '-' || ? || ' days')"
  ).get(itemId, regionKey, days);

  var latest = db.prepare(
    'SELECT unit_price, recorded_at FROM price_history WHERE item_id = ? AND region = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(itemId, regionKey);

  // Trend: compare the most recent half of data points to the older half
  var recent = db.prepare(
    'SELECT unit_price FROM price_history WHERE item_id = ? AND region = ? ORDER BY recorded_at DESC LIMIT 48'
  ).all(itemId, regionKey);

  var trend = 'stable';
  if (recent.length >= 4) {
    var half      = Math.floor(recent.length / 2);
    var newAvg    = 0;
    var oldAvg    = 0;
    for (var i = 0; i < half; i++) newAvg += recent[i].unit_price;
    for (var i = half; i < recent.length; i++) oldAvg += recent[i].unit_price;
    newAvg /= half;
    oldAvg /= (recent.length - half);

    if (newAvg > oldAvg * 1.05)      trend = 'rising';
    else if (newAvg < oldAvg * 0.95) trend = 'falling';
  }

  var currentPrice = latest ? latest.unit_price : null;
  var avgPrice     = stats.avg_price;

  // Buy signal: current price is 10%+ below the period average (cheap to buy)
  var buySignal  = currentPrice && avgPrice && currentPrice < avgPrice * 0.90;
  // Sell signal: current price is 10%+ above the period average (good time to sell)
  var sellSignal = currentPrice && avgPrice && currentPrice > avgPrice * 1.10;

  res.json({
    item_id:      parseInt(itemId),
    current_price: currentPrice,
    avg_price:    avgPrice,
    min_price:    stats.min_price,
    max_price:    stats.max_price,
    data_points:  stats.data_points,
    trend:        trend,
    buy_signal:   buySignal  ? true : false,
    sell_signal:  sellSignal ? true : false,
    last_recorded: latest ? latest.recorded_at : null,
  });
});

// GET /api/prices/status?region=eu — last fetch time and data point count for a region
router.get('/prices/status', function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();
  var latest = db.prepare(
    'SELECT recorded_at FROM price_history WHERE region = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(regionKey);
  var total = db.prepare('SELECT COUNT(*) as n FROM price_history WHERE region = ?').get(regionKey).n;
  res.json({ last_fetch: latest ? latest.recorded_at : null, region: regionKey, total_data_points: total });
});

module.exports = router;
