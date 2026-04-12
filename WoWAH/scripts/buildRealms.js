#!/usr/bin/env node
// Populates / updates the realms table for all regions.
// Run manually with: node scripts/buildRealms.js
// Normally executed automatically by the monthly scheduler in server.js.

var realmsService = require('../lib/realmsService');

realmsService.run().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
