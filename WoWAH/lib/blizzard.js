const axios = require('axios');

var REGIONS = {
  eu: { host: 'https://eu.api.blizzard.com', namespace: 'dynamic-eu', staticNamespace: 'static-eu', locale: 'en_GB' },
  us: { host: 'https://us.api.blizzard.com', namespace: 'dynamic-us', staticNamespace: 'static-us', locale: 'en_US' },
  kr: { host: 'https://kr.api.blizzard.com', namespace: 'dynamic-kr', staticNamespace: 'static-kr', locale: 'ko_KR' },
  tw: { host: 'https://tw.api.blizzard.com', namespace: 'dynamic-tw', staticNamespace: 'static-tw', locale: 'zh_TW' },
};

var cachedToken = null;
var tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  var clientId     = process.env.BLIZZARD_CLIENT_ID;
  var clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET must be set in .env');
  }

  var response = await axios.post(
    'https://oauth.battle.net/token',
    'grant_type=client_credentials',
    {
      auth: { username: clientId, password: clientSecret },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  cachedToken    = response.data.access_token;
  tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;

  console.log('Blizzard OAuth token refreshed, expires in', response.data.expires_in, 'seconds');
  return cachedToken;
}

function invalidateToken() {
  cachedToken = null;
}

module.exports = { REGIONS, getToken, invalidateToken };
