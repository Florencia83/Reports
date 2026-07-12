// Pulls Ramp transactions for the target month from known R&M team cardholders,
// filters to appliance-related purchases, and writes data/pl-appliances-{month}.json.
//
// Required env vars: RAMP_CLIENT_ID, RAMP_CLIENT_SECRET
// Optional: TARGET_MONTH (YYYY-MM) — defaults to last month relative to today.
//
// NOTE: appliance detection is a heuristic (keyword match on merchant/memo/accounting
// category), not a clean Ramp category filter — Ramp has no single "Appliances" category.
// Spot-check the output against Ramp directly if a month looks off.
//
// Property/unit comes from the QuickBooks "Property" field synced into Ramp as an
// accounting_categories entry with tracking_category_remote_id "QuickbooksDepartment"
// (Ramp's own field name for it is "Department" — QuickBooks calls it "Property").
// category_name format: "kn47 (245):kn47-k1-D101" (prop:unit) or "m405 (26)" (prop only,
// no unit set). Not every transaction has one (e.g. postage/non-property expenses).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const RM_TEAM = ['Justin Gutierrez', 'Wade Hippen', 'Isaac Chavez', 'Jaxson Lakins', 'Jared Miller'];
const APPLIANCE_KEYWORDS = /fridge|refrigerator|washer|dryer|dishwasher|oven|range|stove|dehumidifier|ptac|air condition|\bac\b|microwave|freezer/i;

function targetMonth() {
  if (process.env.TARGET_MONTH) return process.env.TARGET_MONTH;
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}T23:59:59Z`;
  return { from, to };
}

async function getToken() {
  const cid = process.env.RAMP_CLIENT_ID;
  const secret = process.env.RAMP_CLIENT_SECRET;
  const auth = Buffer.from(`${cid}:${secret}`).toString('base64');
  const res = await fetch('https://api.ramp.com/developer/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=transactions:read',
  });
  if (!res.ok) throw new Error(`Ramp token request failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

async function fetchAllTransactions(token, from, to) {
  const all = [];
  let start = null;
  do {
    const url = new URL('https://api.ramp.com/developer/v1/transactions');
    url.searchParams.set('from_date', from);
    url.searchParams.set('page_size', '100');
    if (start) url.searchParams.set('start', start);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Ramp transactions request failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    all.push(...(json.data || []));
    start = json.page && json.page.next ? new URL(json.page.next).searchParams.get('start') : null;
  } while (start);
  // to_date is unreliable per Ramp — filter client-side on the real field
  const toTime = new Date(to).getTime();
  return all.filter(t => new Date(t.user_transaction_time).getTime() <= toTime);
}

function extractPropUnit(categories) {
  const dept = (categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksDepartment');
  if (!dept || !dept.category_name) return { prop: null, unit: null };
  const [propPart, unitPart] = dept.category_name.split(':');
  const propMatch = propPart.match(/^([a-z0-9-]+)\s*\(/i);
  const prop = (propMatch ? propMatch[1] : propPart).trim().toLowerCase();
  return { prop, unit: unitPart ? unitPart.trim() : null };
}

// Property code prefixes map to physical area — RL/PS/KN = Richland/Pasco/Kennewick
// (Tri-Cities), TC = Tacoma, everything else is Spokane.
function areaForProp(prop) {
  if (!prop) return 'Unassigned';
  if (/^(rl|ps|kn)/.test(prop)) return 'Tri-Cities';
  if (/^tc/.test(prop)) return 'Tacoma';
  return 'Spokane';
}

async function main() {
  const month = targetMonth();
  const { from, to } = monthRange(month);
  console.log('Pulling Ramp transactions for', month, from, '-', to);

  const token = await getToken();
  const all = await fetchAllTransactions(token, from, to);
  console.log('Total transactions in range:', all.length);

  // A whole month with zero Ramp transactions company-wide is implausible —
  // treat it as an upstream failure rather than silently writing an empty file.
  if (all.length === 0) {
    throw new Error('Fetched zero transactions for the month — likely an API/auth issue, not truly zero spend. Refusing to write.');
  }

  const items = all.filter(t => {
    // Some Ramp card_holder names carry stray whitespace (e.g. trailing/double spaces)
    // that breaks exact-string roster matching -- collapse/trim (found 2026-07-19).
    const holderName = t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}`.trim().replace(/\s+/g, ' ') : '';
    if (!RM_TEAM.some(name => holderName.toLowerCase() === name.toLowerCase())) return false;
    const categoryNames = (t.accounting_categories || []).map(c => c.category_name || '').join(' ');
    const haystack = `${t.merchant_name || ''} ${t.memo || ''} ${categoryNames}`;
    return APPLIANCE_KEYWORDS.test(haystack);
  }).map(t => {
    const { prop, unit } = extractPropUnit(t.accounting_categories);
    return {
      prop, unit,
      area: areaForProp(prop),
      // t.amount is already in dollars -- do not divide by minor_unit_conversion_rate
      // (that field applies to the nested line_items[].amount, not the top-level amount;
      // confirmed live 2026-07-19, this was double-converting every figure by 100x).
      amount: Math.round(t.amount * 100) / 100,
      cardholder: t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}` : null,
      merchant: t.merchant_name || '',
      appliance: t.memo || t.merchant_name,
    };
  });

  const json = {
    month, label: monthLabel(month),
    generated_at: todayStr(),
    source: 'Ramp (heuristic keyword match on R&M team cardholder transactions; property/unit from QuickBooks-synced Department field) — automated',
    items,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `pl-appliances-${month}.json`), JSON.stringify(json, null, 2));
  console.log('Wrote pl-appliances-' + month + '.json with', items.length, 'items');
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[m - 1] + ' ' + y;
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

main().catch(err => { console.error(err); process.exit(1); });
