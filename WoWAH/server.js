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
