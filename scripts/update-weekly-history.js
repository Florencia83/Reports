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
  'Reynaldo Leonides', 'Hannah Deckard', 'David Sanchez', 'Alexander Overall'];
// Every real transaction from this team carries QuickbooksClass "r203" (Ridgeview
// Repairs & Renewals LLC) -- confirmed live 2026-07-19, 100% match across a week of
// team spend. Used as a belt-and-suspenders scope check for Operational Expenses.
const OPEX_CLASS = 'r203';

// Ramp's own chart-of-accounts GL category_id per bucket (confirmed live 2026-07-12
// against real RM_TEAM transactions -- accounting_categories[] entries where
// tracking_category_remote_type === 'GL_ACCOUNT'). Grounds/Maintenance are Material
// only -- Contractor invoices are excluded from Operational Expenses on purpose.
const GL_BUCKETS = {
  Auto: ['59100'],
  'Supplies and Tools': ['67800'],
  Appliances: ['59000', '59002'],
  Grounds: ['54002'],
  Maintenance: ['52002'],
};
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

// Returns raw per-timesheet-entry records (not pre-aggregated) so callers can slice by
// any date sub-range (this week / month-to-date / last 7 / last 30) without refetching.
async function fetchQbtLabor(fromStr, toStr) {
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
    const amount = t.amount / (t.minor_unit_conversion_rate || 100);
    const date = t.user_transaction_time.slice(0, 10);
    const holderName = t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}` : '';
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
function materialsByProperty(records) {
  const out = {};
  records.forEach(r => { if (!r.property) return; out[r.property] = (out[r.property] || 0) + r.amount; });
  return out;
}
function over300List(records) {
  return records.filter(r => r.amount > 300 && r.isRmTeam)
    .map(r => ({ date: r.date, ref: r.ref, property: r.property ? r.property.toUpperCase() : null, cardholder: r.cardholder, amount: Math.round(r.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
}
function opexByCategory(records) {
  const scoped = records.filter(r => r.isOpexTeam && r.glId && r.classCode === OPEX_CLASS);
  return Object.entries(GL_BUCKETS).map(([category, ids]) => ({
    category,
    amount: Math.round(scoped.filter(r => ids.includes(r.glId)).reduce((s, r) => s + r.amount, 0) * 100) / 100,
  }));
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

  // One fetch pass wide enough to cover the current week, month-to-date, and the last
  // 30/7 day rolling windows -- everything below just slices this in memory.
  const [melds, laborRecords, rampRecords] = await Promise.all([
    fetchPmCompletedMelds(broadStart, todayStr),
    fetchQbtLabor(broadStart, todayStr),
    fetchRampTransactions(broadStart, todayStr),
  ]);
  console.log('PM completed melds:', melds.length, '| QBT labor records:', laborRecords.length, '| Ramp records:', rampRecords.length);

  // ---- Per-week file ----
  const weekMelds = melds.filter(m => m.completion_date >= weekStart && m.completion_date <= weekEnd);
  const weekLaborByRef = sumByRef(inRange(laborRecords, weekStart, weekEnd));
  const weekMaterialsByRef = materialsByRef(inRange(rampRecords, weekStart, weekEnd));

  const rows = weekMelds.map(m => {
    const lab = weekLaborByRef[m.ref] || { hours: 0, cost: 0 };
    const mat = weekMaterialsByRef[m.ref] || 0;
    return { ...m, laborCost: lab.cost, materialsCost: mat, totalCost: lab.cost + mat };
  });

  const topWorkOrders = [...rows].sort((a, b) => b.totalCost - a.totalCost).slice(0, 10)
    .map(r => ({ ref: r.ref, brief: r.brief, cost: Math.round(r.totalCost * 100) / 100 }));

  const byTechMap = {};
  rows.forEach(r => { if (r.tech) (byTechMap[r.tech] = byTechMap[r.tech] || []).push(r); });
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
      comments: list.filter(r => r.review).map(r => ({ ref: r.ref, text: r.review })),
    };
  }).sort((a, b) => b.wo_count - a.wo_count);

  const weekOver300 = over300List(inRange(rampRecords, weekStart, weekEnd));
  const weekOperationalExpenses = opexByCategory(inRange(rampRecords, weekStart, weekEnd));

  const outPath = path.join(DATA_DIR, `weekly-${weekStart}.json`);
  let priorKpis = null, priorNarrative = null, priorPriorities = null;
  if (fs.existsSync(outPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      priorKpis = prior.kpis || null;
      priorNarrative = prior.narrative || null;
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

  function avgWoCost(fromStr, toStr) {
    const inR = melds.filter(m => m.completion_date >= fromStr && m.completion_date <= toStr);
    if (!inR.length) return null;
    const labByRef = sumByRef(inRange(laborRecords, fromStr, toStr));
    const matByRef = materialsByRef(inRange(rampRecords, fromStr, toStr));
    const total = inR.reduce((s, m) => s + (labByRef[m.ref] ? labByRef[m.ref].cost : 0) + (matByRef[m.ref] || 0), 0);
    return Math.round((total / inR.length) * 100) / 100;
  }
  kpis[0].last_30 = avgWoCost(last30Start, todayStr);
  kpis[0].last_7 = avgWoCost(last7Start, todayStr);

  const weekJson = {
    week_start: weekStart,
    week_end: dstr(sunday),
    label: weekLabel(monday, sunday),
    generated_at: todayStr,
    complete: weekEnd === dstr(sunday),
    source: 'Property Meld (completed melds) + Ramp (materials/purchases) + QBT (labor) — automated. KPIs and narrative are authored by Florencia, never generated here.',
    kpis,
    top_work_orders: topWorkOrders,
    by_technician: byTechnician,
    ramp_purchases_over_300: weekOver300,
    operational_expenses: weekOperationalExpenses,
    narrative: priorNarrative,
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
  const monthLaborRecords = inRange(laborRecords, monthStart, todayStr);
  const monthRampRecords = inRange(rampRecords, monthStart, todayStr);

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
