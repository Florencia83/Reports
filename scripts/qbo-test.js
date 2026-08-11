// Steps 3 & 4: call the sandbox QBO APIs with the saved tokens, refreshing first if the
// access token is expired. Demonstrates company info + user info (per Intuit's own
// quick-start template) plus a Bill query (the actual data this project ultimately
// wants). Skips the "create a test charge" Payments example from the template --
// creating a transaction isn't something this project needs, even in sandbox.
//
// Run: node scripts/qbo-test.js

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

const tokensPath = path.join(__dirname, '..', 'qbo-tokens.json');
const clientId = process.env.QBO_CLIENT_ID;
const clientSecret = process.env.QBO_CLIENT_SECRET;

function loadTokens() {
  if (!fs.existsSync(tokensPath)) {
    console.error('No qbo-tokens.json found -- run qbo-authorize.js then qbo-exchange-token.js first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
}

// Step 4: refresh the access token. QBO access tokens last ~1 hour, refresh tokens
// ~100 days -- always refresh right before use rather than tracking expiry precisely.
async function refresh(tokens) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Refresh failed: ' + res.status + ' ' + JSON.stringify(json));
  const updated = {
    ...tokens,
    access_token: json.access_token,
    refresh_token: json.refresh_token, // QBO rotates the refresh token on every use -- always save the new one
    obtained_at: new Date().toISOString(),
    expires_in: json.expires_in,
    x_refresh_token_expires_in: json.x_refresh_token_expires_in,
  };
  fs.writeFileSync(tokensPath, JSON.stringify(updated, null, 2));
  return updated;
}

async function callApi(tokens, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = text; }
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  let tokens = loadTokens();
  const base = tokens.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';

  console.log('Refreshing access token...');
  tokens = await refresh(tokens);
  console.log('OK, new access token obtained.\n');

  console.log('--- Company Info ---');
  let r = await callApi(tokens, `${base}/v3/company/${tokens.realmId}/companyinfo/${tokens.realmId}`);
  console.log(r.status, JSON.stringify(r.json, null, 1).slice(0, 800));

  console.log('\n--- User Info (OpenID) ---');
  const userInfoBase = tokens.environment === 'production'
    ? 'https://accounts.platform.intuit.com'
    : 'https://sandbox-accounts.platform.intuit.com';
  r = await callApi(tokens, `${userInfoBase}/v1/openid_connect/userinfo`);
  console.log(r.status, JSON.stringify(r.json, null, 1));

  console.log('\n--- Bills (the actual data this project wants) ---');
  r = await callApi(tokens, `${base}/v3/company/${tokens.realmId}/query?query=${encodeURIComponent('select * from Bill maxresults 5')}`);
  console.log(r.status, JSON.stringify(r.json, null, 1).slice(0, 1500));
}

main().catch(err => { console.error(err); process.exit(1); });
