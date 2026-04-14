const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const blizzard = require('../lib/blizzard');

var PROFILE_NS = {
  eu: 'profile-eu',
  us: 'profile-us',
  kr: 'profile-kr',
  tw: 'profile-tw',
};

// Blizzard equipment stat type → our key
var CRAFTING_STAT_MAP = {
  MULTICRAFT_RATING:      'multicraft_rating',
  RESOURCEFULNESS_RATING: 'resourcefulness_rating',
  INSPIRATION_RATING:     'inspiration_rating',
  CRAFTING_SPEED_RATING:  'speed_rating',
};

function tierNameToExpansion(tierName) {
  var n = (tierName || '').toLowerCase();
  if (n.includes('midnight'))                                                      return 'Midnight';
  if (n.includes('khaz algar') || n.includes('war within') || n.includes('home')) return 'The War Within';
  if (n.includes('dragon isle') || n.includes('dragonflight'))                    return 'Dragonflight';
  if (n.includes('shadowland') || n.includes('zereth'))                           return 'Shadowlands';
  if (n.includes('kul tiran') || n.includes('zandalari'))                         return 'Battle for Azeroth';
  if (n.includes('legion'))                                                        return 'Legion';
  if (n.includes('draenor'))                                                       return 'Warlords of Draenor';
  if (n.includes('pandaria'))                                                      return 'Mists of Pandaria';
  if (n.includes('cataclysm'))                                                     return 'Cataclysm';
  if (n.includes('northrend'))                                                     return 'Wrath of the Lich King';
  if (n.includes('outland'))                                                       return 'The Burning Crusade';
  if (n.includes('classic'))                                                       return 'Classic';
  return tierName || null;
}

// Diminishing-returns formula used by WoW for secondary stats.
// At level 80 the half-point (50%) sits around 1800 rating.
function ratingToPct(rating) {
  if (!rating || rating <= 0) return 0;
  return Math.round((rating / (rating + 1800)) * 1000) / 10; // one decimal place
}

async function blizzardGet(url, params, token) {
  return axios.get(url, {
    params,
    headers: { Authorization: 'Bearer ' + token },
    timeout: 10000,
  });
}

// GET /api/character?region=eu&realm=Silvermoon&name=Arthas
router.get('/character', async function(req, res) {
  var regionKey = (req.query.region || 'eu').toLowerCase();
  var realmRaw  = (req.query.realm  || '').trim();
  var nameRaw   = (req.query.name   || '').trim();

  if (!realmRaw || !nameRaw) {
    return res.status(400).json({ error: 'realm and name are required.' });
  }

  var region = blizzard.REGIONS[regionKey];
  if (!region) return res.status(400).json({ error: 'Unknown region.' });

  var realmSlug = realmRaw.toLowerCase().replace(/'/g, '').replace(/\s+/g, '-');
  var charSlug  = nameRaw.toLowerCase();
  var ns        = PROFILE_NS[regionKey];
  var base      = region.host;
  var params    = { namespace: ns, locale: region.locale };

  try {
    var token = await blizzard.getToken();

    // Fetch professions + equipment in parallel
    var [profRes, equipRes] = await Promise.all([
      blizzardGet(base + '/profile/wow/character/' + realmSlug + '/' + charSlug + '/professions', params, token),
      blizzardGet(base + '/profile/wow/character/' + realmSlug + '/' + charSlug + '/equipment',   params, token)
        .catch(function() { return null; }), // equipment is non-critical
    ]);

    // ── Professions ──────────────────────────────────────────────
    var profData  = profRes.data;
    var allProfs  = (profData.primaries || []).concat(profData.secondaries || []);

    var professions = allProfs
      .filter(function(p) { return p.profession && p.tiers && p.tiers.length; })
      .map(function(p) {
        var tiers = p.tiers.map(function(t) {
          return {
            expansion:        tierNameToExpansion(t.tier && t.tier.name),
            tier_name:        t.tier && t.tier.name,
            skill:            t.skill_points,
            max_skill:        t.max_skill_points,
            known_recipe_ids: (t.known_recipes || []).map(function(r) { return r.id; }),
          };
        });

        // Concentration info (TWW+, may not exist on older professions)
        var concInfo = p.concentration_info || null;

        return {
          id:                   p.profession.id,
          name:                 p.profession.name,
          tiers:                tiers,
          all_known_recipe_ids: tiers.reduce(function(acc, t) { return acc.concat(t.known_recipe_ids); }, []),
          concentration:        concInfo ? {
            remaining: concInfo.remaining_concentration,
            maximum:   concInfo.maximum_concentration,
            recharge_seconds: concInfo.recharge_rate_seconds || 3600,
          } : null,
        };
      });

    // ── Equipment → crafting stat ratings ────────────────────────
    var ratings = { multicraft_rating: 0, resourcefulness_rating: 0, inspiration_rating: 0, speed_rating: 0 };

    if (equipRes) {
      (equipRes.data.equipped_items || []).forEach(function(item) {
        (item.stats || []).forEach(function(stat) {
          var key = CRAFTING_STAT_MAP[stat.type && stat.type.type];
          if (key) ratings[key] += (stat.value || 0);
        });
      });
    }

    var crafting_stats = {
      multicraft_rating:      ratings.multicraft_rating,
      resourcefulness_rating: ratings.resourcefulness_rating,
      inspiration_rating:     ratings.inspiration_rating,
      speed_rating:           ratings.speed_rating,
      // Approximate % conversions (user can override in the UI)
      multicraft_pct:      ratingToPct(ratings.multicraft_rating),
      resourcefulness_pct: ratingToPct(ratings.resourcefulness_rating),
      inspiration_pct:     ratingToPct(ratings.inspiration_rating),
    };

    res.json({
      name:          profData.character && profData.character.name,
      realm:         realmRaw,
      professions:   professions,
      crafting_stats: crafting_stats,
    });

  } catch (e) {
    var status = e.response && e.response.status;
    if (status === 404) return res.status(404).json({ error: 'Character not found. Check the name and realm.' });
    if (status === 403) return res.status(403).json({ error: 'Character profile is private.' });
    if (status === 401) { blizzard.invalidateToken(); return res.status(401).json({ error: 'Blizzard token error, please retry.' }); }
    console.error('[Character] Error:', e.message);
    res.status(500).json({ error: 'Failed to fetch character data.' });
  }
});

module.exports = router;
