// Daily refresh of the standalone Itemized Detail report's data:
// per-property itemized Ramp transactions + QBT labor entries, split into R&M Repairs
// and Grounds, for a given month -- data/itemized-{YYYY-MM}.json.
//
// Unlike Financial Detail (report-financial-detail.html), this report is NOT curated to
// a handful of over-average properties -- it lists every property with any real R&M or
// Grounds spend that month, so it can serve as a raw drill-down/audit tool. The report
// page itself lets Florencia pick month + year (which JSON file loads) and further
// narrow to a specific day range within that month (client-side filter over the
// itemized entries) -- the AppFolio actual figure stays month-level since AppFolio's
// budget_comparative report has no finer granularity than a full accounting period.
//
// Required env vars: QBT_TOKEN, RAMP_CLIENT_ID, RAMP_CLIENT_SECRET,
// APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET
// Optional: TARGET_MONTH (YYYY-MM) to backfill/regenerate a specific past month.

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const APPFOLIO_SUBDOMAIN = 'mckay';

// Labor cost = QBT base wage x 1.5, matching the convention already used in Financial
// Detail (report-financial-detail.html) -- confirmed with Florencia 2026-07-16. The
// wage shown in this report's Labor tables is the effective (already-multiplied) rate,
// not the raw QBT wage -- labeled as such in the report itself so it isn't mistaken for
// a straight hours x QBT-wage figure.
const LABOR_RATE_MULTIPLIER = 1.5;

// QBT user id + BASE hourly wage (as it exists in QBT, before the 1.5x above), for
// every person whose timesheets can land in either division. Division itself comes
// from the QBT custom field 25056 (Class) on each timesheet entry, not from which list
// a person is in -- someone can log hours to either bucket depending on the job.
const TEAM = [
  { name: 'Jonas Hoard', qbtId: 7623296, wage: 27.00 },
  { name: 'Wade Hippen', qbtId: 36898, wage: 28.44 },
  { name: 'Justin Gutierrez', qbtId: 7564674, wage: 25.00 },
  { name: 'Jared Miller', qbtId: 36902, wage: 28.09 },
  { name: 'Jaxson Lakins', qbtId: 6010510, wage: 24.00 },
  { name: 'Isaac Chavez', qbtId: 6010506, wage: 27.00 },
  { name: 'Reynaldo Leonides', qbtId: 7653196, wage: 25.00 },
  { name: 'Hannah Deckard', qbtId: 6346740, wage: 22.00 },
  { name: 'David Sanchez', qbtId: 6175154, wage: 25.50 },
  { name: 'Alexander Overall', qbtId: 7842488, wage: 24.00 },
  { name: 'Margarito Saldana', qbtId: 5210688, wage: 28.40 },
  { name: 'James Dunlap', qbtId: 6832702, wage: 23.00 },
  { name: 'Maria Florencia Sola', qbtId: 8746168, wage: 10.00 },
  { name: 'Outright Clean LLC', qbtId: 5249464, wage: 50.00 },
  { name: 'Juan Valenciano', qbtId: 7307662, wage: 12.50 },
];
const qbtIdToPerson = {}; TEAM.forEach(t => qbtIdToPerson[t.qbtId] = t);

// AppFolio property_id(s) per property-code prefix -- same roster as
// update-weekly-history.js/update-ramp-appliances.js for this portfolio.
const PROPERTY_IDS = {
  a210: [39], a511: [676], a916: [2], b101: [42], c302: [226], c313: [603], c616: [45],
  e328: [490], h604: [36], h731: [228], hl65: [44], hl73: [49], j312: [521], k104: [220],
  k308: [617], kn47: [1057, 1121, 1130], l912: [1132, 533], l925: [48], m221: [223],
  m405: [50], m608: [35], ms22: [46], ms43: [43], o155: [1224, 1183], p705: [47],
  ps17: [222], ps25: [221], ps91: [227], rl16: [414], rl21: [648], s129: [461], s300: [8],
  sf21: [604], tc34: [735], tc68: [1993], v202: [719], w117: [225], w225: [415], w226: [224],
};

const REPAIRS_ACCOUNT = '52001';
const GROUNDS_ACCOUNT = '52003';

// Real property codes in this portfolio are 1-2 letters + 2-3 digits (kn47, rl16, tc68...).
// Ramp/QBT "property" fields sometimes resolve to a fund or corporate entity instead when
// a charge isn't tied to a specific property -- exclude those.
const PROPERTY_CODE_RE = /^[a-z]{1,2}\d{2,3}/i;

async function qbtFetchWithRetry(url, headers, attempt = 1) {
  // A bare fetch() has no default timeout -- a stalled connection (seen intermittently
  // against this API) hangs the whole script forever instead of failing. 20s + retry
  // (same backoff as 429/5xx) turns that into a bounded, self-healing wait.
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (attempt <= 4) {
      const backoff = 2000 * attempt;
      console.log(`QBT request timed out/errored on ${url} (${e.message}), retrying in ${backoff}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, backoff));
      return qbtFetchWithRetry(url, headers, attempt + 1);
    }
    throw e;
  }
  if (!res.ok && attempt <= 4 && (res.status === 429 || res.status >= 500)) {
    const backoff = 2000 * attempt;
    console.log(`QBT ${res.status} on ${url}, retrying in ${backoff}ms (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, backoff));
    return qbtFetchWithRetry(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`QBT request failed: ${res.status} ${await res.text()} (${url})`);
  return res.json();
}

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

// Returns raw per-timesheet-entry records for the whole TEAM roster, tagged with
// division ('repairs' | 'grounds' | null) from the Class custom field -- entries that
// match neither pattern are kept with division null and simply excluded downstream,
// rather than silently dropped here, so the "how much fell outside both buckets" count
// is checkable if this ever needs auditing.
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
    const person = qbtIdToPerson[ts.user_id];
    if (!person) continue;
    const cls = (ts.customfields && ts.customfields['25056']) || '';
    let division = null;
    if (/r&m|repair|maintenance/i.test(cls)) division = 'repairs';
    else if (/ground/i.test(cls)) division = 'grounds';
    if (!division) continue;
    const p = jcPath(ts.jobcode_id, jcCache);
    const propIdx = p.findIndex(seg => PROPERTY_CODE_RE.test(seg));
    // Jobcode segments for multi-building properties look like "kn47 K1", "kn47-k3" --
    // normalize to just the bare code (matching PROPERTY_IDS and the Ramp-side
    // extraction below) so K1/K2/k3 all roll up under "kn47" instead of becoming three
    // separate untracked properties.
    let prop = propIdx !== -1 ? p[propIdx].match(PROPERTY_CODE_RE)[0].toLowerCase() : null;
    if (!prop) {
      // Fallback: some timesheets (e.g. admin/scheduling entries logged under a generic
      // top-level jobcode like "Palouse Homes" with no property anywhere in its ancestry)
      // still carry the real property in the Property custom field (25068, e.g.
      // "kn47 (245)") on the timesheet itself. Without this fallback these hours were
      // silently dropped entirely -- found 2026-07-21 via Isaac Chavez's admin/scheduling
      // hours (class "R&M - Admin") being real in QBT but missing from Itemized Detail's
      // Team member view.
      const m = ((ts.customfields && ts.customfields['25068']) || '').match(PROPERTY_CODE_RE);
      prop = m ? m[0].toLowerCase() : null;
    }
    if (!prop) continue;
    const hrs = ts.duration / 3600;
    const effectiveWage = person.wage * LABOR_RATE_MULTIPLIER;
    records.push({ date: ts.date, property: prop, division, name: person.name, hours: hrs, wage: effectiveWage, cost: hrs * effectiveWage });
  }
  return records;
}

// Returns raw per-transaction records with property + GL/Class info, same convention as
// update-weekly-history.js's fetchRampTransactions (amount is already dollars, NOT minor
// units -- do not divide by minor_unit_conversion_rate).
async function fetchRampTransactions(fromStr, toStr) {
  const auth = Buffer.from(`${process.env.RAMP_CLIENT_ID}:${process.env.RAMP_CLIENT_SECRET}`).toString('base64');
  const tokRes = await fetch('https://api.ramp.com/developer/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=transactions:read',
    signal: AbortSignal.timeout(20000),
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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Ramp transactions failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    all.push(...(j.data || []));
    start = j.page && j.page.next ? new URL(j.page.next).searchParams.get('start') : null;
  } while (start);
  const inWindow = all.filter(t => new Date(t.user_transaction_time).getTime() <= toTime);

  const records = [];
  for (const t of inWindow) {
    const amount = t.amount;
    const date = t.user_transaction_time.slice(0, 10);

    let property = null;
    const propDept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksDepartment');
    if (propDept && propDept.category_name) {
      const propPart = propDept.category_name.split(':')[0];
      const m = propPart.match(/^([a-z0-9-]+)\s*\(/i);
      const cand = (m ? m[1] : propPart).trim().toLowerCase();
      if (PROPERTY_CODE_RE.test(cand)) property = cand;
    }
    if (!property) continue; // untagged spend has nowhere to itemize under in this report

    // The QuickbooksClass field is unreliable on Ramp transactions -- real R&M and
    // Grounds spend both sometimes carry a bare "r203" class with no sub-value
    // (confirmed in update-weekly-history.js). The GL account category name is the
    // reliable signal instead: every transaction lands under a specific category like
    // "Repair and Maintenance:R&M - Material" or "Grounds:Grounds - Contractor".
    const glCat = (t.accounting_categories || []).find(c => c.tracking_category_remote_type === 'GL_ACCOUNT');
    const glName = glCat && glCat.category_name ? glCat.category_name.toLowerCase() : '';
    let division = null;
    if (glName.startsWith('repair and maintenance')) division = 'repairs';
    else if (glName.startsWith('grounds')) division = 'grounds';
    if (!division) continue;

    // Cardholder name, same field used for the RM_TEAM matching in update-weekly-history.js
    // and update-ramp-appliances.js -- needed here so the Team member picker can show a
    // person's Ramp purchases, not just their QBT labor hours.
    const cardholder = t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}`.trim().replace(/\s+/g, ' ') : null;

    records.push({ date, property, division, merchant: t.merchant_name, amount, memo: t.memo || '', cardholder });
  }
  return records;
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
    properties: { properties_ids: propertiesIds },
  };
  const res = await fetch(`https://${APPFOLIO_SUBDOMAIN}.appfolio.com/api/v2/reports/budget_comparative.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`AppFolio budget_comparative failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function appfolioActuals(props, month) {
  const out = {};
  for (const prop of props) {
    const ids = PROPERTY_IDS[prop];
    if (!ids) continue;
    try {
      const rows = await appfolioBudgetComparative(month, ids);
      const repairsRow = rows.find(r => r.account_number === REPAIRS_ACCOUNT);
      const groundsRow = rows.find(r => r.account_number === GROUNDS_ACCOUNT);
      out[prop] = {
        repairs: repairsRow ? parseFloat(repairsRow.period_actual) || 0 : null,
        grounds: groundsRow ? parseFloat(groundsRow.period_actual) || 0 : null,
      };
    } catch (e) {
      console.log('AppFolio actuals failed for', prop, '-', e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }

function buildDivision(rampRecords, laborRecords, division, appfolioByProp, appfolioKey) {
  const props = new Set([
    ...rampRecords.filter(r => r.division === division).map(r => r.property),
    ...laborRecords.filter(r => r.division === division).map(r => r.property),
  ]);
  const out = [];
  for (const prop of props) {
    const rampItems = rampRecords.filter(r => r.division === division && r.property === prop)
      .map(r => ({ date: r.date, merchant: r.merchant, amount: round2(r.amount), memo: r.memo, cardholder: r.cardholder }))
      .sort((a, b) => a.date.localeCompare(b.date));
    // Grouped by date+name (not collapsed to one row per person for the whole month)
    // so the report's date-range picker can filter labor the same way it filters Ramp
    // transactions -- a person with entries on several days shows several rows.
    const laborByDayPerson = {};
    laborRecords.filter(r => r.division === division && r.property === prop).forEach(r => {
      const key = r.date + '|' + r.name;
      if (!laborByDayPerson[key]) laborByDayPerson[key] = { date: r.date, name: r.name, hours: 0, wage: r.wage, cost: 0 };
      laborByDayPerson[key].hours += r.hours;
      laborByDayPerson[key].cost += r.cost;
    });
    const laborItems = Object.values(laborByDayPerson).map(p => ({ date: p.date, name: p.name, hours: round2(p.hours), wage: p.wage, cost: round2(p.cost) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    const rampTotal = round2(rampItems.reduce((s, r) => s + r.amount, 0));
    const laborTotal = round2(laborItems.reduce((s, l) => s + l.cost, 0));
    const appfolioActual = appfolioByProp[prop] ? appfolioByProp[prop][appfolioKey] : null;
    out.push({
      property: prop.toUpperCase(), code: prop,
      appfolio_actual: appfolioActual, ramp_total: rampTotal, labor_total: laborTotal,
      ramp_items: rampItems, labor_items: laborItems,
    });
  }
  out.sort((a, b) => (b.appfolio_actual || 0) - (a.appfolio_actual || 0));
  return out;
}

function monthName(m) { return ['January','February','March','April','May','June','July','August','September','October','November','December'][m]; }
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

async function main() {
  const today = new Date();
  const todayStr = dstr(today);

  // TARGET_MONTH (YYYY-MM) lets this backfill/regenerate a specific past month on
  // demand -- normally unset, and the script just targets the current month.
  const month = process.env.TARGET_MONTH || todayStr.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const monthStart = `${month}-01`;
  const isCurrentMonth = month === todayStr.slice(0, 7);
  const monthEnd = isCurrentMonth ? todayStr : `${month}-${String(daysInMonth(y, m - 1)).padStart(2, '0')}`;

  console.log('Refreshing itemized detail for', month, '(', monthStart, 'to', monthEnd, ')');

  const jobcodes = await fetchQbtJobcodes();
  const [laborRecords, rampRecords] = await Promise.all([
    fetchQbtLaborForRange(jobcodes, monthStart, monthEnd),
    fetchRampTransactions(monthStart, monthEnd),
  ]);
  console.log('QBT labor records:', laborRecords.length, '| Ramp records:', rampRecords.length);

  const props = new Set([
    ...rampRecords.map(r => r.property), ...laborRecords.map(r => r.property),
  ]);
  const appfolioByProp = await appfolioActuals([...props], month);

  const repairs = buildDivision(rampRecords, laborRecords, 'repairs', appfolioByProp, 'repairs');
  const grounds = buildDivision(rampRecords, laborRecords, 'grounds', appfolioByProp, 'grounds');

  // A whole month with zero repairs AND zero grounds spend across the entire portfolio
  // is implausible -- treat it as an upstream failure (auth/outage) rather than
  // silently overwriting the last good file with an empty one.
  if (!repairs.length && !grounds.length) {
    throw new Error('No repairs or grounds records found for the whole portfolio this month -- likely an upstream failure, refusing to write.');
  }

  const outJson = {
    month,
    label: monthName(m - 1) + ' ' + y,
    generated_at: todayStr,
    complete: monthEnd === `${month}-${String(daysInMonth(y, m - 1)).padStart(2, '0')}`,
    source: 'Ramp (card transactions) + QBT (labor hours, wage x 1.5) itemized per property, vs. AppFolio\'s actual (accrual) R&M - Repairs / Grounds account totals for the month.',
    labor_rate_multiplier: LABOR_RATE_MULTIPLIER,
    repairs, grounds,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `itemized-${month}.json`), JSON.stringify(outJson, null, 2));
  console.log('Wrote itemized-' + month + '.json —', repairs.length, 'repairs properties,', grounds.length, 'grounds properties');

  const manifestPath = path.join(DATA_DIR, 'itemized-manifest.json');
  let manifest = { months: [] };
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const existing = manifest.months.find(mo => mo.key === month);
  if (existing) existing.label = outJson.label;
  else manifest.months.unshift({ key: month, label: outJson.label });
  manifest.months.sort((a, b) => b.key.localeCompare(a.key));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Updated itemized-manifest.json');
}

main().catch(err => { console.error(err); process.exit(1); });
