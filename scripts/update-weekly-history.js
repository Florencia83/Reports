// Daily refresh of the Weekly Update report's data:
// - Per-week file (data/weekly-{monday}.json): Top 10 Work Orders, By Technician, Ramp
//   Purchases Over $300 (with meld ref + property), Operational Expenses by category
//   (this week, maintenance + grounds team), KPIs.
// - Month-to-date file (data/weekly-mtd.json): Monthly Budget (Labor/Materials/Total
//   Actual/Variance vs AppFolio's "R&M - Repairs" budget), Cost by Property (MTD,
//   over-budget-only, vs each property's own AppFolio R&M - Repairs budget).
//
// Cost = Ramp materials (matched to a meld by its reference ID in the Customer/Job
// accounting category) + QBT labor (hours x wage, matched to a meld by the leaf jobcode
// name in its hierarchy path). Both conventions confirmed against LeeRoy's existing
// pipeline for the same portfolio/team.
//
// The 6 legacy KPIs (Emergency WO Completion Time, etc.) live in Property Meld's
// Insights tab, a Sigma Computing embedded dashboard -- not reachable via this API.
// Those, and Florencia's narrative write-up, stay manual. "Average Work Order Cost"
// (first KPI row) is automated for Last 30/Last 7 Days; Q1/Q2 averages are manual for
// now (to be automated later once historical Jan-Jun data is backfilled).
//
// Required env vars: PROPERTYMELD_EMAIL, PROPERTYMELD_PASSWORD, QBT_TOKEN,
// RAMP_CLIENT_ID, RAMP_CLIENT_SECRET, APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET

const fs = require('fs');
const path = require('path');
const https = require('https');
const DATA_DIR = path.join(__dirname, '..', 'data');
const APPFOLIO_SUBDOMAIN = 'mckay';

// PM agent id + QBT user id + hourly wage.
const TECHS = [
  { name: 'Jonas Hoard',      pmId: 59983, qbtId: 7623296, wage: 27.00 },
  { name: 'Wade Hippen',      pmId: 48355, qbtId: 36898,   wage: 28.44 },
  { name: 'Justin Gutierrez', pmId: 59624, qbtId: 7564674, wage: 25.00 },
  { name: 'Jared Miller',     pmId: 48347, qbtId: 36902,   wage: 28.09 },
  { name: 'Jaxson Lakins',    pmId: 51579, qbtId: 6010510, wage: 24.00 },
  { name: 'Isaac Chavez',     pmId: 51605, qbtId: 6010506, wage: 27.00 },
];
const pmIdToTech = {}; TECHS.forEach(t => pmIdToTech[t.pmId] = t);
const qbtIdToTech = {}; TECHS.forEach(t => qbtIdToTech[t.qbtId] = t);

// Same R&M team roster used by update-ramp-appliances.js, for the >$300 purchases list
// and the Monthly Budget Labor/Materials totals -- repair techs only (Wade resigned).
const RM_TEAM = ['Justin Gutierrez', 'Wade Hippen', 'Isaac Chavez', 'Jaxson Lakins', 'Jared Miller', 'Jonas Hoard'];

// Wider roster for Operational Expenses -- maintenance (repair) + grounds team, since
// that section covers team card spend broadly, not just repair work orders.
const OPEX_TEAM = ['Justin Gutierrez', 'Jared Miller', 'Jaxson Lakins', 'Jonas Hoard', 'Isaac Chavez',
  'Reynaldo Leonides', 'Hannah Deckard', 'David Sanchez', 'Alexander Overall', 'Florencia Sola'];
// Every real transaction from this team carries QuickbooksClass "r203" (Ridgeview
// Repairs & Renewals LLC) or a "r203:<sub-class>" child of it -- confirmed live
// 2026-07-19 against a full week, then against team spend since April (1166 txns).
// Used as the scope check for Operational Expenses; r202 (a different corp entity) and
// anything unrelated is excluded.
const OPEX_CLASS = 'r203';

// GL account is the reliably-populated field on every transaction. QuickbooksClass
// sub-values (e.g. "r203:Grounds", "r203:R&M-Hardware") exist but aren't consistently
// filled in -- confirmed live 2026-07-19: real Grounds/R&M-Material transactions this
// week all carried a bare "r203" class, no sub-class at all. So Grounds/Maintenance/
// Appliances match on EITHER signal, whichever is actually present, instead of relying
// on Class alone (same class taxonomy LeeRoy's reports repo uses in
// buildAppliances/buildToolsSupplies, scripts/fetch-data.js, extended with a GL
// fallback since Class coverage is incomplete for this portfolio).
const GL_BUCKETS = {
  Auto: ['59100'],
  'Supplies and Tools': ['67800'],
  Appliances: ['59000', '59002'],
  Grounds: ['54002'],
  Maintenance: ['52002'],
};
// Appliances = CapEx-Appliance specifically (an asset purchase), not any R&M-Material
// repair that happens to mention an appliance in its memo (e.g. a $65 dryer belt is a
// repair part, correctly GL-coded as R&M - Material -- confirmed with Florencia
// 2026-07-19 that those belong in Maintenance, not Appliances; no keyword fallback).
const APPLIANCE_CLASSES = ['r203:capex appliances'];
const GROUNDS_CLASS = 'r203:grounds';
const RM_CLASS_PREFIX = 'r203:r&m-'; // Maintenance = every R&M-* sub-class (including R&M-Appliance)
// "Materials" in the Monthly Budget stat card = R&M Material/Contractor + Supplies and
// Tools, matching LeeRoy's rm_report.html GL set for the same team.
const MATERIALS_GL_IDS = ['52002', '52003', '67800'];

// AppFolio property_id(s) per property-code prefix, for per-property R&M - Repairs
// budget lookups. Same maintenance model as TECHS/RM_TEAM above -- refresh this if
// properties are added/removed (checked live 2026-07-12 against AppFolio's property
// list; a code can map to several AppFolio property records, e.g. kn47 K1/K2/k3).
const PROPERTY_IDS = {
  a210: [39], a511: [676], a916: [2], b101: [42], c302: [226], c313: [603], c616: [45],
  e328: [490], h604: [36], h731: [228], hl65: [44], hl73: [49], j312: [521], k104: [220],
  k308: [617], kn47: [1057, 1121, 1130], l912: [1132, 533], l925: [48], m221: [223],
  m405: [50], m608: [35], ms22: [46], ms43: [43], o155: [1224, 1183], p705: [47],
  ps17: [222], ps25: [221], ps91: [227], rl16: [414], rl21: [648], s129: [461], s300: [8],
  sf21: [604], tc34: [735], tc68: [1993], v202: [719], w117: [225], w225: [415], w226: [224],
};

// Real property codes in this portfolio are 1-2 letters + 2-3 digits (kn47, rl16, tc68,
// r203, hl65...). Ramp/QBT "property" fields sometimes resolve to a fund or corporate
// entity instead (e.g. "m5x2 Fund IV", "Escrow Checking Corp Prop") when a charge isn't
// tied to a specific property -- this pattern excludes those from every property table.
const PROPERTY_CODE_RE = /^[a-z]{1,2}\d{2,3}/i;

const PM_BASE = 'https://app.propertymeld.com', PM_MGMT = '2975';

function httpreq(method, urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: headers || {} }, resp => {
      let b = ''; resp.on('data', d => b += d);
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: b }));
    }).on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function pmLogin() {
  let jar = {};
  const add = h => { if (!h || !h['set-cookie']) return; h['set-cookie'].forEach(c => { const kv = c.split(';')[0]; const eq = kv.indexOf('='); if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1); }); };
  const sc = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const r1 = await httpreq('GET', PM_BASE + '/login/?next=/', { 'User-Agent': 'Mozilla/5.0' }); add(r1.headers);
  const csrf1 = (r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) || [])[1];
  const pmEmail = (process.env.PROPERTYMELD_EMAIL || '').trim();
  const pmPassword = (process.env.PROPERTYMELD_PASSWORD || '').trim();
  const bd = new URLSearchParams({ csrfmiddlewaretoken: csrf1, email: pmEmail, password: pmPassword }).toString();
  const r2 = await httpreq('POST', PM_BASE + '/login/?next=/', { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bd), 'Referer': PM_BASE + '/login/?next=/', 'Cookie': sc() }, bd); add(r2.headers);
  if (r2.body && /Invalid username\/password/.test(r2.body)) throw new Error('PropertyMeld login rejected — check PROPERTYMELD_EMAIL/PASSWORD secrets');
  const r3 = await httpreq('GET', PM_BASE + '/' + PM_MGMT + '/m/' + PM_MGMT + '/dashboard/', { 'User-Agent': 'Mozilla/5.0', 'Cookie': sc() }); add(r3.headers);
  const csrf = (r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/) || [])[1] || '';
  return { sc, csrf };
}
async function pmGet(p, sc, csrf) {
  return httpreq('GET', PM_BASE + '/' + PM_MGMT + '/m/' + PM_MGMT + p,
    { 'User-Agent': 'Mozilla/5.0', 'Cookie': sc(), 'X-CSRFToken': csrf, 'Accept': 'application/json', 'Referer': PM_BASE + '/' + PM_MGMT + '/m/' + PM_MGMT + '/' }, null);
}

async function fetchPmCompletedMelds(fromStr, toStr) {
  const { sc, csrf } = await pmLogin();
  const melds = [];
  let offset = 0;
  while (true) {
    const r = await pmGet(`/api/melds/?status=COMPLETED&limit=100&offset=${offset}`, sc, csrf);
    const j = JSON.parse(r.body);
    const rows = j.results || [];
    if (!rows.length) break;
    let stop = false;
    for (const m of rows) {
      const cd = (m.completion_date || '').slice(0, 10);
      if (!cd) continue;
      if (cd < fromStr) { stop = true; continue; }
      if (cd > toStr) continue;
      const servicer = (m.in_house_servicers || []).find(s => s.agent && pmIdToTech[s.agent.id]);
      melds.push({
        ref: m.reference_id,
        brief: (m.brief_description || '').slice(0, 90),
        tech: servicer ? pmIdToTech[servicer.agent.id].name : null,
        rating: m.tenant_rating != null ? +m.tenant_rating : null,
        review: (m.tenant_review || '').trim() || null,
        completion_date: cd,
      });
    }
    if (rows.length < 100 || stop) break;
    offset += 100;
    await new Promise(res => setTimeout(res, 100));
  }
  return melds;
}

async function qbtFetchWithRetry(url, headers, attempt = 1) {
  const res = await fetch(url, { headers });
  if (!res.ok && attempt <= 4 && (res.status === 429 || res.status >= 500)) {
    const backoff = 2000 * attempt;
    console.log(`QBT ${res.status} on ${url}, retrying in ${backoff}ms (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, backoff));
    return qbtFetchWithRetry(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`QBT request failed: ${res.status} ${await res.text()} (${url})`);
  return res.json();
}

// Jobcodes have no date range of their own (they're the hierarchy, not the time
// entries), so fetch them exactly once per run and hand the cache to every call of
// fetchQbtLaborForRange below -- avoids re-paging all ~15k jobcodes per date window.
async function fetchQbtJobcodes() {
  const headers = { Authorization: `Bearer ${process.env.QBT_TOKEN}` };
  const jobcodes = {};
  let jcPage = 1;
  while (true) {
    const j = await qbtFetchWithRetry(`https://rest.tsheets.com/api/v1/jobcodes?active=both&supplemental_data=no&page=${jcPage}`, headers);
    const rows = Object.values(j.results?.jobcodes || {});
    if (!rows.length) break;
    rows.forEach(jc => { jobcodes[jc.id] = jc; });
    if (!j.more) break;
    jcPage++;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log('QBT jobcodes fetched:', Object.keys(jobcodes).length);
  return jobcodes;
}

// Returns raw per-timesheet-entry records (not pre-aggregated) so callers can slice by
// any date sub-range (this week / month-to-date / last 7 / last 30) without refetching.
async function fetchQbtLaborForRange(jobcodes, fromStr, toStr) {
  const headers = { Authorization: `Bearer ${process.env.QBT_TOKEN}` };

  function jcPath(id, cache) {
    if (cache[id]) return cache[id];
    const j = jobcodes[id];
    if (!j) return [];
    if (!j.parent_id) return (cache[id] = [j.name]);
    return (cache[id] = [...jcPath(j.parent_id, cache), j.name]);
  }

  const timesheets = [];
  let page = 1;
  while (true) {
    const j = await qbtFetchWithRetry(`https://rest.tsheets.com/api/v1/timesheets?start_date=${fromStr}&end_date=${toStr}&page=${page}`, headers);
    const rows = Object.values(j.results?.timesheets || {});
    if (!rows.length) break;
    timesheets.push(...rows);
    if (!j.more) break;
    page++;
  }

  const jcCache = {};
  const records = [];
  for (const ts of timesheets) {
    if (ts.type !== 'regular') continue;
    const tech = qbtIdToTech[ts.user_id];
    if (!tech) continue;
    const cls = (ts.customfields && ts.customfields['25056']) || '';
    if (!/r&m|repair|maintenance/i.test(cls)) continue;
    const p = jcPath(ts.jobcode_id, jcCache);
    if (!p.length) continue;
    // Jobcode hierarchy is Fund -> Property -> Ref (e.g. "m5x2 Fund IV" -> "o155-Elm" ->
    // "TGFYDPW"), not just Property -> Ref -- find the segment that actually looks like
    // a property code rather than assuming a fixed depth, so Funds never get counted as
    // a property.
    const propIdx = p.findIndex(seg => PROPERTY_CODE_RE.test(seg));
    if (propIdx === -1) continue;
    const prop = p[propIdx].toLowerCase();
    const leafRef = p[p.length - 1];
    const ref = /^T[A-Z0-9]{5,}/i.test(leafRef) ? leafRef : null;
    const hrs = ts.duration / 3600;
    records.push({ date: ts.date, ref, property: prop, hours: hrs, cost: hrs * tech.wage });
  }
  return records;
}

// Returns raw per-transaction records (not pre-aggregated), same reasoning as above.
async function fetchRampTransactions(fromStr, toStr) {
  const auth = Buffer.from(`${process.env.RAMP_CLIENT_ID}:${process.env.RAMP_CLIENT_SECRET}`).toString('base64');
  const tokRes = await fetch('https://api.ramp.com/developer/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=transactions:read',
  });
  if (!tokRes.ok) throw new Error(`Ramp token failed: ${tokRes.status} ${await tokRes.text()}`);
  const token = (await tokRes.json()).access_token;

  const from = `${fromStr}T00:00:00Z`;
  const toTime = new Date(`${toStr}T23:59:59Z`).getTime();
  const all = [];
  let start = null;
  do {
    const url = new URL('https://api.ramp.com/developer/v1/transactions');
    url.searchParams.set('from_date', from);
    url.searchParams.set('page_size', '100');
    if (start) url.searchParams.set('start', start);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Ramp transactions failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    all.push(...(j.data || []));
    start = j.page && j.page.next ? new URL(j.page.next).searchParams.get('start') : null;
  } while (start);
  const inWindow = all.filter(t => new Date(t.user_transaction_time).getTime() <= toTime);

  const records = [];
  for (const t of inWindow) {
    // t.amount is already in dollars (decimal, e.g. 6.5) -- NOT minor units. Dividing by
    // minor_unit_conversion_rate here would double-convert (confirmed live 2026-07-19
    // against a real Home Depot receipt: top-level amount 6.5, vs the nested
    // line_items[].amount.amount 650 + minor_unit_conversion_rate 100, which IS the
    // cents/rate pair meant to be divided). This bug made every Ramp dollar figure in
    // this script 100x too small.
    const amount = t.amount;
    const date = t.user_transaction_time.slice(0, 10);
    // Some Ramp card_holder names carry stray whitespace (e.g. "Jaxson Lakins " with a
    // trailing space, "Justin  Gutierrez " with a double space) that breaks exact-string
    // roster matching below -- collapse/trim so those still match (found 2026-07-19,
    // was silently dropping real transactions from Operational Expenses).
    const holderName = t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}`.trim().replace(/\s+/g, ' ') : '';
    const isRmTeam = RM_TEAM.some(n => n.toLowerCase() === holderName.toLowerCase());

    let ref = null;
    const custDept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksCustomer');
    if (custDept && custDept.category_name) {
      const parts = custDept.category_name.split(':');
      const cand = parts[parts.length - 1].trim();
      if (/^T[A-Z0-9]{5,}/i.test(cand)) ref = cand;
    }

    // Property comes from the QuickBooks "Property" field synced as QuickbooksDepartment
    // (same convention as update-ramp-appliances.js): "propcode (id):propcode-unit".
    let property = null;
    const propDept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksDepartment');
    if (propDept && propDept.category_name) {
      const propPart = propDept.category_name.split(':')[0];
      const m = propPart.match(/^([a-z0-9-]+)\s*\(/i);
      const cand = (m ? m[1] : propPart).trim().toLowerCase();
      if (PROPERTY_CODE_RE.test(cand)) property = cand; // drop Funds/corp entries
    }

    const glCat = (t.accounting_categories || []).find(c => c.tracking_category_remote_type === 'GL_ACCOUNT');
    const classCat = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksClass');
    const isOpexTeam = OPEX_TEAM.some(n => n.toLowerCase() === holderName.toLowerCase());

    records.push({
      date, ref, property, amount, cardholder: holderName, isRmTeam, isOpexTeam,
      glId: glCat ? glCat.category_id : null,
      classCode: classCat && classCat.category_name ? classCat.category_name.toLowerCase() : null,
    });
  }
  return records;
}

function inRange(records, fromStr, toStr) { return records.filter(r => r.date >= fromStr && r.date <= toStr); }

function sumByRef(records) {
  const out = {};
  records.forEach(r => { if (!r.ref) return; if (!out[r.ref]) out[r.ref] = { hours: 0, cost: 0 }; out[r.ref].hours += r.hours; out[r.ref].cost += r.cost; });
  return out;
}
function sumByProperty(records) {
  const out = {};
  records.forEach(r => { if (!out[r.property]) out[r.property] = { hours: 0, cost: 0 }; out[r.property].hours += r.hours; out[r.property].cost += r.cost; });
  return out;
}
function totalCost(records) { return records.reduce((s, r) => s + r.cost, 0); }

function materialsByRef(records) {
  const out = {};
  records.forEach(r => { if (!r.ref) return; out[r.ref] = (out[r.ref] || 0) + r.amount; });
  return out;
}
// Either source can carry a ref's property (QBT jobcode path or Ramp QuickbooksDepartment) --
// take whichever is found first, labor checked first since it's the more complete source
// (every completed meld gets a timesheet, not every meld has a Ramp purchase).
function propertyByRef(laborRecords, rampRecords) {
  const out = {};
  laborRecords.forEach(r => { if (r.ref && r.property && !out[r.ref]) out[r.ref] = r.property; });
  rampRecords.forEach(r => { if (r.ref && r.property && !out[r.ref]) out[r.ref] = r.property; });
  return out;
}
// Only R&M-Material/Contractor + Supplies and Tools count toward a property's R&M -
// Repairs budget comparison -- Turn/CapEx/Grounds spend on that property is a different
// budget line entirely. Same GL scope as materialsBudgetTotal (and matches LeeRoy's
// RM_GLS in his equivalent report). Missing this filter is why Cost by Property showed
// properties as wildly over budget when a Turn-Material purchase happened to share
// their Department code (found 2026-07-19, e.g. a $557.85 Home Depot Turn charge
// coded to j312's Department).
function materialsByProperty(records) {
  const out = {};
  records.forEach(r => {
    if (!r.property || !MATERIALS_GL_IDS.includes(r.glId)) return;
    out[r.property] = (out[r.property] || 0) + r.amount;
  });
  return out;
}
function over300List(records) {
  // Same roster as Operational Expenses (OPEX_TEAM), not the narrower repair-only
  // RM_TEAM -- otherwise a real >$300 purchase by grounds staff or Florencia herself
  // (e.g. her $868.99 stove) silently drops off this table even though it counts
  // toward Operational Expenses (found 2026-07-19).
  return records.filter(r => r.amount > 300 && r.isOpexTeam)
    .map(r => ({ date: r.date, ref: r.ref, property: r.property ? r.property.toUpperCase() : null, cardholder: r.cardholder, amount: Math.round(r.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
}
// Returns both the 5 named buckets AND a scoped/uncategorized total, so callers can log
// how much of the team's real r203 spend falls outside the 5 buckets on purpose (Turn,
// CapEx Discretionary, etc. -- confirmed live 2026-07-19, ~12% most weeks) vs silently
// growing because a real category got missed.
function opexByCategory(records) {
  const scoped = records.filter(r => r.isOpexTeam && r.classCode &&
    (r.classCode === OPEX_CLASS || r.classCode.startsWith(OPEX_CLASS + ':')));
  const sum = list => Math.round(list.reduce((s, r) => s + r.amount, 0) * 100) / 100;

  const matchers = {
    Auto: r => GL_BUCKETS.Auto.includes(r.glId),
    'Supplies and Tools': r => GL_BUCKETS['Supplies and Tools'].includes(r.glId),
    Appliances: r => GL_BUCKETS.Appliances.includes(r.glId) || APPLIANCE_CLASSES.includes(r.classCode),
    Grounds: r => GL_BUCKETS.Grounds.includes(r.glId) || r.classCode === GROUNDS_CLASS,
    Maintenance: r => GL_BUCKETS.Maintenance.includes(r.glId) || r.classCode.startsWith(RM_CLASS_PREFIX),
  };

  const buckets = Object.entries(matchers).map(([category, matches]) => ({
    category, amount: sum(scoped.filter(matches)),
  }));
  const scopedTotal = sum(scoped);
  const bucketedTotal = Math.round(buckets.reduce((s, b) => s + b.amount, 0) * 100) / 100;
  return { buckets, scopedTotal, uncategorized: Math.round((scopedTotal - bucketedTotal) * 100) / 100 };
}
function materialsBudgetTotal(records) {
  return records.filter(r => r.isRmTeam && MATERIALS_GL_IDS.includes(r.glId)).reduce((s, r) => s + r.amount, 0);
}

async function appfolioBudgetComparative(month, propertiesIds) {
  const cid = (process.env.APPFOLIO_CLIENT_ID || '').trim();
  const secret = (process.env.APPFOLIO_CLIENT_SECRET || '').trim();
  const auth = Buffer.from(`${cid}:${secret}`).toString('base64');
  const body = {
    period_from: month, period_to: month,
    comparison_period_from: month, comparison_period_to: month,
    accounting_basis: 'Accrual',
    level_of_detail: 'detail_view',
  };
  if (propertiesIds) body.properties = { properties_ids: propertiesIds };
  const res = await fetch(`https://${APPFOLIO_SUBDOMAIN}.appfolio.com/api/v2/reports/budget_comparative.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AppFolio budget_comparative failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function appfolioRMRepairsBudget(month) {
  const rows = await appfolioBudgetComparative(month, null);
  const row = rows.find(r => r.account_name === 'R&M - Repairs');
  return row ? parseFloat(row.period_budget) : null;
}

// Per-property R&M - Repairs budget for the month, keyed by property-code prefix.
// Unknown prefixes (not in PROPERTY_IDS) or a failed lookup are simply omitted --
// callers treat "no budget" as "can't tell if it's over budget", not as zero.
async function appfolioPropertyBudgets(props, month) {
  const out = {};
  for (const prop of props) {
    const ids = PROPERTY_IDS[prop];
    if (!ids) continue;
    try {
      const rows = await appfolioBudgetComparative(month, ids);
      const row = rows.find(r => r.account_name === 'R&M - Repairs');
      out[prop] = row ? parseFloat(row.period_budget) : null;
    } catch (e) {
      console.log('AppFolio per-property budget failed for', prop, '-', e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

function mondayOf(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  return m;
}
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function monthName(m) { return ['January','February','March','April','May','June','July','August','September','October','November','December'][m]; }
function weekLabel(startD, endD) {
  const sameMonth = startD.getMonth() === endD.getMonth();
  const startStr = monthName(startD.getMonth()) + ' ' + startD.getDate();
  const endStr = (sameMonth ? '' : monthName(endD.getMonth()) + ' ') + endD.getDate();
  return `${startStr} – ${endStr}, ${endD.getFullYear()}`;
}

async function main() {
  const today = new Date();
  const todayStr = dstr(today);

  // TARGET_WEEK_START (YYYY-MM-DD, must be a Monday) lets this backfill a past week
  // on demand -- normally unset, and the script just targets the current week.
  const monday = process.env.TARGET_WEEK_START ? new Date(process.env.TARGET_WEEK_START + 'T00:00:00') : mondayOf(today);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const weekStart = dstr(monday);
  const weekEnd = dstr(today) < dstr(sunday) ? todayStr : dstr(sunday);

  const monthStart = todayStr.slice(0, 7) + '-01';
  const last30Start = dstr(daysAgo(29));
  const last7Start = dstr(daysAgo(6));
  const broadStart = [monthStart, last30Start, weekStart].sort()[0];
  console.log('Refreshing weekly history for', weekStart, 'to', weekEnd, '| broad fetch from', broadStart, 'to', todayStr);

  // Jobcodes have no date range -- fetch once, reuse for every QBT labor pull below
  // (broad window here, plus the Q1/Q2 backfill windows further down if needed).
  const jobcodes = await fetchQbtJobcodes();

  // One fetch pass wide enough to cover the current week, month-to-date, and the last
  // 30/7 day rolling windows -- everything below just slices this in memory.
  const [melds, laborRecords, rampRecords] = await Promise.all([
    fetchPmCompletedMelds(broadStart, todayStr),
    fetchQbtLaborForRange(jobcodes, broadStart, todayStr),
    fetchRampTransactions(broadStart, todayStr),
  ]);
  console.log('PM completed melds:', melds.length, '| QBT labor records:', laborRecords.length, '| Ramp records:', rampRecords.length);

  // Month-to-date records, computed once here and reused below both for Top 10 Work
  // Orders and for the Monthly Budget/Cost by Property section further down.
  const monthLaborRecords = inRange(laborRecords, monthStart, todayStr);
  const monthRampRecords = inRange(rampRecords, monthStart, todayStr);

  // Top 10 Work Orders and Maintenance Team KPI's are both month-to-date, not just
  // this week -- a job completed earlier in the month should still show up (Florencia
  // asked for this 2026-07-19 after a real repair completed July 2 was invisible in a
  // week-scoped view).
  const monthMelds = melds.filter(m => m.completion_date >= monthStart && m.completion_date <= todayStr);
  const monthLaborByRef = sumByRef(monthLaborRecords);
  const monthMaterialsByRef = materialsByRef(monthRampRecords);
  const monthPropertyByRef = propertyByRef(monthLaborRecords, monthRampRecords);
  const monthRows = monthMelds.map(m => {
    const lab = monthLaborByRef[m.ref] || { hours: 0, cost: 0 };
    const mat = monthMaterialsByRef[m.ref] || 0;
    return { ...m, laborCost: lab.cost, materialsCost: mat, totalCost: lab.cost + mat };
  });

  const topWorkOrders = [...monthRows].sort((a, b) => b.totalCost - a.totalCost).slice(0, 10)
    .map(r => ({
      ref: r.ref, property: monthPropertyByRef[r.ref] || null, brief: r.brief,
      labor: Math.round(r.laborCost * 100) / 100,
      materials: Math.round(r.materialsCost * 100) / 100,
      cost: Math.round(r.totalCost * 100) / 100,
    }));

  const byTechMap = {};
  monthRows.forEach(r => { if (r.tech) (byTechMap[r.tech] = byTechMap[r.tech] || []).push(r); });
  const byTechnician = Object.entries(byTechMap).map(([name, list]) => {
    const totalLabor = list.reduce((s, r) => s + r.laborCost, 0);
    const totalCostSum = list.reduce((s, r) => s + r.totalCost, 0);
    const rated = list.filter(r => r.rating != null);
    const avgRating = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
    return {
      name,
      wo_count: list.length,
      avg_cost_per_wo: Math.round((totalCostSum / list.length) * 100) / 100,
      total_labor_cost: Math.round(totalLabor * 100) / 100,
      avg_resident_rating: avgRating != null ? Math.round(avgRating * 100) / 100 : null,
      // Every rated meld, not just ones with a written comment -- a tenant can leave a
      // star rating alone with no text (Florencia asked to see those too, 2026-07-19).
      reviews: rated.map(r => ({ ref: r.ref, rating: r.rating, text: r.review || null })),
    };
  }).sort((a, b) => b.wo_count - a.wo_count);

  const weekOver300 = over300List(inRange(rampRecords, weekStart, weekEnd));
  const opex = opexByCategory(inRange(rampRecords, weekStart, weekEnd));
  console.log('Opex (team + r203) scoped total:', opex.scopedTotal, '| in the 5 buckets:', opex.buckets.reduce((s, b) => s + b.amount, 0).toFixed(2), '| uncategorized (Turn/CapEx/etc, expected):', opex.uncategorized);

  const outPath = path.join(DATA_DIR, `weekly-${weekStart}.json`);
  let priorKpis = null, priorNarrative = null, priorNarrative2 = null, priorPriorities = null;
  if (fs.existsSync(outPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      priorKpis = prior.kpis || null;
      priorNarrative = prior.narrative || null;
      priorNarrative2 = prior.narrative_2 || null;
      priorPriorities = prior.priorities_next_week || null;
    } catch (e) { /* ignore unparseable prior file */ }
  }

  // Row 0 (Average Work Order Cost) is computed below; the other 6 stay fully manual
  // -- Florencia pastes them in from Property Meld's Sigma-powered Insights tab.
  const KPI_METRICS = [
    'Average Work Order Cost',
    'Emergency Work Order Completion Time',
    'Work Order Resident Satisfaction',
    'Avg Vendor Completion Time',
    'Avg Speed of Repair',
    'Time to Assignment',
    'Time to Schedule',
  ];
  const kpis = (priorKpis && priorKpis.length === KPI_METRICS.length)
    ? priorKpis
    : KPI_METRICS.map(metric => ({ metric, q1: null, q2: null, last_30: null, last_7: null }));

  // Average Work Order Cost = (sum of QBT labor cost + Ramp materials cost, matched to
  // each meld by its reference ID) / (number of melds completed in the window). Logs
  // its inputs so the result is checkable against PM/QBT/Ramp directly, not just trusted.
  function avgWoCostFor(melds, laborRecords, rampRecords, fromStr, toStr, label) {
    const inR = melds.filter(m => m.completion_date >= fromStr && m.completion_date <= toStr);
    if (!inR.length) { console.log(`avgWoCost[${label}]: 0 melds completed ${fromStr}..${toStr} -- null`); return null; }
    const labByRef = sumByRef(inRange(laborRecords, fromStr, toStr));
    const matByRef = materialsByRef(inRange(rampRecords, fromStr, toStr));
    const totalLabor = inR.reduce((s, m) => s + (labByRef[m.ref] ? labByRef[m.ref].cost : 0), 0);
    const totalMaterials = inR.reduce((s, m) => s + (matByRef[m.ref] || 0), 0);
    // A real week/quarter with real completed melds never has $0 labor AND $0
    // materials -- that combination means an upstream fetch silently came back
    // empty (same failure mode as the weekly-mtd.json guard below), not a real
    // average of zero. Refuse to report it rather than write a false $0.
    if (totalLabor === 0 && totalMaterials === 0) {
      console.log(`avgWoCost[${label}]: WARNING -- ${inR.length} melds completed but $0 labor and $0 materials matched (${laborRecords.length} labor records, ${rampRecords.length} ramp records fetched for this window) -- treating as a failed fetch, not writing a false $0 average`);
      return null;
    }
    const avg = Math.round(((totalLabor + totalMaterials) / inR.length) * 100) / 100;
    console.log(`avgWoCost[${label}]: ${inR.length} melds, labor $${totalLabor.toFixed(2)} + materials $${totalMaterials.toFixed(2)} = $${(totalLabor + totalMaterials).toFixed(2)} total -> avg $${avg}`);
    return avg;
  }
  kpis[0].last_30 = avgWoCostFor(melds, laborRecords, rampRecords, last30Start, todayStr, 'last_30');
  kpis[0].last_7 = avgWoCostFor(melds, laborRecords, rampRecords, last7Start, todayStr, 'last_7');

  // Q1/Q2 (calendar quarters, matching the other 6 manually-pasted KPIs) are closed,
  // immutable history once the quarter ends -- compute once and never touch again
  // (kpis[0].q1/q2 come from priorKpis above, so a non-null value here means an
  // earlier run already did this and it's just being carried forward untouched).
  if (kpis[0].q1 == null) {
    console.log('Backfilling Average Work Order Cost Q1 2026 (Jan-Mar)...');
    const [q1Melds, q1Labor, q1Ramp] = await Promise.all([
      fetchPmCompletedMelds('2026-01-01', '2026-03-31'),
      fetchQbtLaborForRange(jobcodes, '2026-01-01', '2026-03-31'),
      fetchRampTransactions('2026-01-01', '2026-03-31'),
    ]);
    console.log('Q1 raw fetch: melds', q1Melds.length, '| labor records', q1Labor.length, '| ramp records', q1Ramp.length);
    kpis[0].q1 = avgWoCostFor(q1Melds, q1Labor, q1Ramp, '2026-01-01', '2026-03-31', 'q1');
  }
  if (kpis[0].q2 == null) {
    console.log('Backfilling Average Work Order Cost Q2 2026 (Apr-Jun)...');
    const [q2Melds, q2Labor, q2Ramp] = await Promise.all([
      fetchPmCompletedMelds('2026-04-01', '2026-06-30'),
      fetchQbtLaborForRange(jobcodes, '2026-04-01', '2026-06-30'),
      fetchRampTransactions('2026-04-01', '2026-06-30'),
    ]);
    console.log('Q2 raw fetch: melds', q2Melds.length, '| labor records', q2Labor.length, '| ramp records', q2Ramp.length);
    kpis[0].q2 = avgWoCostFor(q2Melds, q2Labor, q2Ramp, '2026-04-01', '2026-06-30', 'q2');
  }

  const weekJson = {
    week_start: weekStart,
    week_end: dstr(sunday),
    label: weekLabel(monday, sunday),
    month_label: monthName(today.getMonth()) + ' ' + today.getFullYear(),
    generated_at: todayStr,
    complete: weekEnd === dstr(sunday),
    source: 'Property Meld (completed melds) + Ramp (materials/purchases) + QBT (labor) — automated. KPIs and narrative are authored by Florencia, never generated here.',
    kpis,
    top_work_orders: topWorkOrders,
    by_technician: byTechnician,
    ramp_purchases_over_300: weekOver300,
    operational_expenses: opex.buckets,
    narrative: priorNarrative,
    narrative_2: priorNarrative2,
    priorities_next_week: priorPriorities,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(weekJson, null, 2));
  console.log('Wrote weekly-' + weekStart + '.json');

  const manifestPath = path.join(DATA_DIR, 'weekly-manifest.json');
  let manifest = { weeks: [] };
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.generated_at = todayStr;
  const existing = manifest.weeks.find(w => w.key === weekStart);
  if (existing) { existing.label = weekJson.label; }
  else { manifest.weeks.unshift({ key: weekStart, label: weekJson.label }); }
  manifest.weeks.sort((a, b) => b.key.localeCompare(a.key));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Updated weekly-manifest.json');

  // ---- Month-to-date file: Monthly Budget + Cost by Property ----
  const month = todayStr.slice(0, 7);
  const laborMTD = totalCost(monthLaborRecords);
  const materialsMTD = materialsBudgetTotal(monthRampRecords);
  const totalActual = laborMTD + materialsMTD;
  const rmRepairsBudget = await appfolioRMRepairsBudget(month);
  const monthlyBudget = {
    budget: rmRepairsBudget,
    labor: Math.round(laborMTD * 100) / 100,
    materials: Math.round(materialsMTD * 100) / 100,
    total_actual: Math.round(totalActual * 100) / 100,
    variance: rmRepairsBudget != null ? Math.round((rmRepairsBudget - totalActual) * 100) / 100 : null,
  };

  const laborByPropMTD = sumByProperty(monthLaborRecords);
  const materialsByPropMTD = materialsByProperty(monthRampRecords);
  const propKeys = new Set([...Object.keys(laborByPropMTD), ...Object.keys(materialsByPropMTD)]);
  const propTotals = [...propKeys].map(prop => {
    const lab = laborByPropMTD[prop] ? laborByPropMTD[prop].cost : 0;
    const mat = materialsByPropMTD[prop] || 0;
    return { prop, labor: Math.round(lab * 100) / 100, materials: Math.round(mat * 100) / 100, total: Math.round((lab + mat) * 100) / 100 };
  }).filter(p => p.total > 0);

  const propBudgets = await appfolioPropertyBudgets(propTotals.map(p => p.prop), month);
  const costByProperty = propTotals.map(p => {
    const budget = propBudgets[p.prop] != null ? propBudgets[p.prop] : null;
    return {
      property: p.prop.toUpperCase(),
      labor: p.labor,
      materials: p.materials,
      cost: p.total,
      budget,
      pct_over_budget: budget ? Math.round(((p.total - budget) / budget) * 1000) / 10 : null,
    };
  }).filter(p => p.budget != null && p.cost > p.budget)
    .sort((a, b) => b.pct_over_budget - a.pct_over_budget);

  // A whole month with zero budget data AND zero R&M spend is implausible -- treat it
  // as an upstream failure (AppFolio/Ramp/QBT auth or outage) rather than silently
  // overwriting the last good weekly-mtd.json with empty figures.
  if (rmRepairsBudget == null && totalActual === 0) {
    throw new Error('AppFolio, QBT, and Ramp all returned nothing for the month — likely an upstream failure, refusing to write weekly-mtd.json.');
  }

  const mtdJson = {
    month,
    generated_at: todayStr,
    source: 'AppFolio (R&M - Repairs budget, monthly + per-property) + QBT (labor + Ramp materials) — automated',
    monthly_budget: monthlyBudget,
    cost_by_property: costByProperty,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'weekly-mtd.json'), JSON.stringify(mtdJson, null, 2));
  console.log('Wrote weekly-mtd.json —', costByProperty.length, 'properties over budget this month');
}

main().catch(err => { console.error(err); process.exit(1); });
