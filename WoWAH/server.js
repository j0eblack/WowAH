require('dotenv').config();
const express = require('express');
const session = require('express-session');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');

require('./db'); // initializes tables on first run
const app = express();

const HTTP_PORT  = process.env.HTTP_PORT  || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true, // only sent over HTTPS
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/auction'));
app.use('/api', require('./routes/recipes'));
app.use('/api', require('./routes/prices'));
app.use('/api', require('./routes/character'));

app.get('/', function(req, res) {
  res.redirect('/dashboard.html');
});

// ── Hourly auto-fetch (all regions, restart-safe) ────────────
var auctionService = require('./lib/auctionService');
var blizzard       = require('./lib/blizzard');
var db             = require('./db');
var FETCH_INTERVAL = 60 * 60 * 1000; // 1 hour
var REGION_DELAY   = 30 * 1000;      // 30 s between regions

// Returns milliseconds until the next fetch is due for a region.
// If it was last fetched < 1 hour ago, wait out the remainder.
// If never fetched or >= 1 hour ago, return 0 (run immediately).
function msUntilNextFetch(regionKey) {
  var row = db.prepare(
    'SELECT recorded_at FROM price_history WHERE region = ? ORDER BY recorded_at DESC LIMIT 1'
  ).get(regionKey);

  if (!row) return 0;

  var lastFetch = new Date(row.recorded_at + ' UTC').getTime();
  var elapsed   = Date.now() - lastFetch;
  var remaining = FETCH_INTERVAL - elapsed;
  return remaining > 0 ? remaining : 0;
}

function fetchRegion(regionKey, index, resolve) {
  var wait = index === 0 ? 0 : REGION_DELAY;
  setTimeout(function() {
    console.log('[Scheduler] Fetching', regionKey.toUpperCase());
    auctionService.fetchAndSave(regionKey)
      .then(function(r) { console.log('[Scheduler]', regionKey.toUpperCase(), '— done,', r.count, 'items.'); })
      .catch(function(e) { console.error('[Scheduler]', regionKey.toUpperCase(), '— failed:', e.message); })
      .finally(resolve);
  }, wait);
}

function scheduleRegion(regionKey, index) {
  var due = msUntilNextFetch(regionKey);

  if (due > 0) {
    var mins = Math.round(due / 60000);
    console.log('[Scheduler]', regionKey.toUpperCase(), '— last fetch was recent, next run in', mins, 'min.');
  }

  setTimeout(function() {
    new Promise(function(resolve) {
      fetchRegion(regionKey, index, resolve);
    }).finally(function() {
      // Schedule next run exactly 1 hour from now
      setTimeout(function() { scheduleRegion(regionKey, 0); }, FETCH_INTERVAL);
    });
  }, due);
}

// Each region runs on its own independent 1-hour cycle,
// offset by REGION_DELAY so they don't all hit the API simultaneously.
Object.keys(blizzard.REGIONS).forEach(function(regionKey, index) {
  var startDelay = 10000 + index * REGION_DELAY;
  setTimeout(function() { scheduleRegion(regionKey, 0); }, startDelay);
});


// ── Realms sync (every start + every month) ───────────────────
var realmsService  = require('./lib/realmsService');
var recipesService = require('./lib/recipesService');
var MONTH_INTERVAL = 30 * 24 * 60 * 60 * 1000;

// Node's setTimeout silently overflows at 2^31-1 ms (~24.8 days).
// Values above that are coerced to 1 ms, causing immediate re-fires.
// This wrapper chains timeouts to handle arbitrarily large delays.
var MAX_TIMEOUT_MS = 2147483647;
function safeLargeTimeout(fn, ms) {
  if (ms <= MAX_TIMEOUT_MS) {
    setTimeout(fn, ms);
  } else {
    setTimeout(function() { safeLargeTimeout(fn, ms - MAX_TIMEOUT_MS); }, MAX_TIMEOUT_MS);
  }
}

function msUntilNext(tableQuery, interval) {
  var row = db.prepare(tableQuery).get();
  if (!row || !row.ts) return 0;
  var remaining = interval - (Date.now() - new Date(row.ts + ' UTC').getTime());
  return remaining > 0 ? remaining : 0;
}

// onDone is called once the run finishes (success or failure), used by scheduleRealmsSync
// to signal the startup chain. Omitted for subsequent monthly runs.
function runRealmsSync(onDone) {
  console.log('[RealmsScheduler] Starting realms sync…');
  realmsService.run()
    .then(function() {
      db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('realms_synced_at', datetime('now'))").run();
      console.log('[RealmsScheduler] Done.');
    })
    .catch(function(e){ console.error('[RealmsScheduler] Failed:', e.message); })
    .finally(function() {
      if (onDone) onDone();
      safeLargeTimeout(runRealmsSync, MONTH_INTERVAL);
    });
}

// Returns a Promise that resolves when realms are ready:
//   - immediately if data is fresh (schedules future sync in background)
//   - after the sync completes if data is missing/stale
function scheduleRealmsSync() {
  var count = db.prepare('SELECT COUNT(*) AS n FROM realms').get().n;
  var due = count === 0 ? 0 : msUntilNext(
    "SELECT (SELECT value FROM sync_meta WHERE key = 'realms_synced_at') AS ts",
    MONTH_INTERVAL
  );
  if (due > 0) {
    console.log('[RealmsScheduler] Data is fresh, next sync in', Math.round(due / 86400000), 'd.');
    safeLargeTimeout(runRealmsSync, due);
    return Promise.resolve();
  }
  return new Promise(function(resolve) { runRealmsSync(resolve); });
}

function runRecipesSync() {
  console.log('[RecipesScheduler] Starting recipes + items sync…');
  recipesService.run()
    .then(function(result) {
      db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('recipes_synced_at', datetime('now'))").run();
      console.log('[RecipesScheduler] Done. New recipes:', result.newCount);
    })
    .catch(function(e){ console.error('[RecipesScheduler] Failed:', e.message); })
    .finally(function(){ safeLargeTimeout(runRecipesSync, MONTH_INTERVAL); });
}

// Recipes: at startup, skip if synced within the last month. Then run on a fixed monthly loop.
// recipesService.run() now handles item fetching internally (on demand, targeted).
function scheduleRecipesSync() {
  var count = db.prepare('SELECT COUNT(*) AS n FROM recipes').get().n;
  var due = count === 0 ? 0 : msUntilNext(
    "SELECT (SELECT value FROM sync_meta WHERE key = 'recipes_synced_at') AS ts",
    MONTH_INTERVAL
  );
  if (due > 0) {
    console.log('[RecipesScheduler] Data is fresh, next sync in', Math.round(due / 86400000), 'd.');
  }
  safeLargeTimeout(runRecipesSync, due);
}

// Startup chain: realms → recipes+items (recipes now fetches its own item data on demand).
scheduleRealmsSync().then(function() {
  scheduleRecipesSync();
});

// ── Realm auction scheduler (every 2 hours, staggered) ───────
var REALM_INTERVAL = 2 * 60 * 60 * 1000;
var REALM_STARTUP_DELAY = 5 * 60 * 1000; // 5 min after start (after commodities)

function scheduleRealmRegion(regionKey, delay) {
  setTimeout(function() {
    console.log('[Scheduler] Fetching realm auctions for', regionKey.toUpperCase());
    auctionService.fetchRealmAuctions(regionKey)
      .then(function(r) { console.log('[Scheduler] Realm', regionKey.toUpperCase(), '— done,', r.count, 'snapshots.'); })
      .catch(function(e) { console.error('[Scheduler] Realm', regionKey.toUpperCase(), '— failed:', e.message); })
      .finally(function() { scheduleRealmRegion(regionKey, REALM_INTERVAL); });
  }, delay);
}

Object.keys(blizzard.REGIONS).forEach(function(regionKey, index) {
  var startDelay = REALM_STARTUP_DELAY + index * 10 * 60 * 1000; // stagger by 10 min per region
  scheduleRealmRegion(regionKey, startDelay);
});

// ── SSL certificate ───────────────────────────────────────────
var sslOptions;

if (process.env.SSL_CERT && process.env.SSL_KEY) {
  // Production: use real cert files (e.g. from Let's Encrypt / certbot)
  sslOptions = {
    cert: fs.readFileSync(process.env.SSL_CERT),
    key:  fs.readFileSync(process.env.SSL_KEY),
  };
  console.log('SSL: using certificate from', process.env.SSL_CERT);
} else {
  // Development: auto-generate a self-signed certificate
  var selfsigned = require('selfsigned');
  var pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    { days: 365, algorithm: 'sha256' }
  );
  sslOptions = { cert: pems.cert, key: pems.private };
  console.log('SSL: no cert configured — using auto-generated self-signed certificate');
  console.log('     Your browser will show a security warning; click "Advanced > Proceed" to continue.');
}

// ── HTTP → HTTPS redirect ─────────────────────────────────────
http.createServer(function(req, res) {
  var host = (req.headers.host || 'localhost').replace(':' + HTTP_PORT, '');
  var target = 'https://' + host + ':' + HTTPS_PORT + req.url;
  res.writeHead(301, { 'Location': target });
  res.end();
}).listen(HTTP_PORT, function() {
  console.log('HTTP  → redirecting to HTTPS on port ' + HTTP_PORT);
});

// ── HTTPS server ──────────────────────────────────────────────
https.createServer(sslOptions, app).listen(HTTPS_PORT, function() {
  console.log('HTTPS → https://localhost:' + HTTPS_PORT);
});
