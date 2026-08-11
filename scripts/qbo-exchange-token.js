// Step 2 of the QBO OAuth 2.0 authorization_code flow.
// Takes the `code` and `realmId` you copied from the redirect after authorizing
// (see qbo-authorize.js), exchanges the code for an access_token + refresh_token, and
// saves them to qbo-tokens.json (gitignored -- these are live credentials, never commit).
//
// Run: node scripts/qbo-exchange-token.js <code> <realmId>

const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

const [, , code, realmId] = process.argv;
if (!code || !realmId) {
  console.error('Usage: node scripts/qbo-exchange-token.js <code> <realmId>');
  process.exit(1);
}

const clientId = process.env.QBO_CLIENT_ID;
const clientSecret = process.env.QBO_CLIENT_SECRET;
const redirectUri = process.env.QBO_REDIRECT_URI;
if (!clientId || !clientSecret || clientSecret === 'paste-your-client-secret-here') {
  console.error('QBO_CLIENT_ID/QBO_CLIENT_SECRET missing or not filled in -- edit .env first (copy the secret from the app\'s Keys & OAuth page, never commit it).');
  process.exit(1);
}

async function main() {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error('Token exchange failed:', res.status, JSON.stringify(json));
    process.exit(1);
  }

  const tokens = {
    realmId,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    obtained_at: new Date().toISOString(),
    expires_in: json.expires_in,
    x_refresh_token_expires_in: json.x_refresh_token_expires_in,
  };
  const outPath = path.join(__dirname, '..', 'qbo-tokens.json');
  fs.writeFileSync(outPath, JSON.stringify(tokens, null, 2));
  console.log('Saved tokens to', outPath);
  console.log('realmId:', realmId);
  console.log('access_token expires in', json.expires_in, 'seconds');
  console.log('refresh_token expires in', json.x_refresh_token_expires_in, 'seconds (~100 days) -- refresh before then, see qbo-test.js');
  console.log('\nNext: node scripts/qbo-test.js');
}

main().catch(err => { console.error(err); process.exit(1); });
