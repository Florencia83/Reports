// Step 1 of the QBO OAuth 2.0 authorization_code flow.
// Prints the URL to open in a browser. After you log in and pick/confirm the company,
// Intuit redirects to QBO_REDIRECT_URI with ?code=...&realmId=...&state=... in the URL --
// since our redirect_uri is Intuit's own Quick Start page (not a server we run), the
// code/realmId show up right there on that page for you to copy.
//
// Run: node scripts/qbo-authorize.js

// No npm dependencies in this repo (matches the rest of scripts/) -- load .env by hand
// instead of requiring the `dotenv` package.
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}
const crypto = require('crypto');

const clientId = process.env.QBO_CLIENT_ID;
const redirectUri = process.env.QBO_REDIRECT_URI;
if (!clientId || !redirectUri) {
  console.error('Missing QBO_CLIENT_ID or QBO_REDIRECT_URI in .env');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const scope = 'com.intuit.quickbooks.accounting';

const url = new URL('https://appcenter.intuit.com/connect/oauth2');
url.searchParams.set('client_id', clientId);
url.searchParams.set('scope', scope);
url.searchParams.set('redirect_uri', redirectUri);
url.searchParams.set('response_type', 'code');
url.searchParams.set('state', state);

console.log('Open this URL in your browser, log in, and authorize the sandbox company:\n');
console.log(url.toString());
console.log('\nAfter authorizing, the page will show a URL with ?code=...&realmId=...&state=... in it.');
console.log('Copy the code and realmId values, then run:');
console.log('  node scripts/qbo-exchange-token.js <code> <realmId>');
console.log('\n(expected state for this run, to double-check the redirect matches):', state);
