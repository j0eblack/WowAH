#!/usr/bin/env node
// Populates / updates the items table from EU auction data.
// Run manually with: node scripts/buildItems.js
// Normally executed automatically by the weekly scheduler in server.js.

var itemsService = require('../lib/itemsService');

itemsService.run().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
