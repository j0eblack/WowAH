#!/usr/bin/env node
// Rebuilds the recipes and reagents tables from the Blizzard API.
// Run manually with: node scripts/buildRecipes.js
// Normally executed automatically by the monthly scheduler in server.js.

var recipesService = require('../lib/recipesService');

recipesService.run().then(function() {
  process.exit(0);
}).catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
