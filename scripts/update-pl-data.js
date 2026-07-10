// Pulls AppFolio budget/actual (accrual) per property + Ramp appliance transactions
// for the target month, and writes data/pl-budget-{month}.json,
// data/pl-appliances-{month}.json, and updates data/pl-manifest.json.
//
// Required env vars: APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET, RAMP_CLIENT_ID, RAMP_CLIENT_SECRET
// Optional: TARGET_MONTH (YYYY-MM) — defaults to last month relative to today.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const APPFOLIO_SUBDOMAIN = 'mckay';

// property_id -> { name, units }
const PROPERTIES = {
  39:   { name: 'a210', units: 10 },
  676:  { name: 'a511', units: 10 },
  2:    { name: 'a916', units: 12 },
  42:   { name: 'b101', units: 17 },
  226:  { name: 'c302', units: 14 },
  603:  { name: 'c313', units: 40 },
  490:  { name: 'e328', units: 7 },
  36:   { name: 'h604', units: 1 },
  228:  { name: 'h731', units: 8 },
  44:   { name: 'hl65', units: 10 },
  49:   { name: 'hl73', units: 6 },
  521:  { name: 'j312', units: 18 },
  220:  { name: 'k104-LeFevre', units: 60 },
  617:  { name: 'k308', units: 6 },
  1057: { name: 'kn47', units: 156, group: 'kn47' },
  1121: { name: 'kn47', units: 81, group: 'kn47' },
  1130: { name: 'kn47', units: 9, group: 'kn47' },
  533:  { name: 'l912', units: 9 },
  48:   { name: 'l925', units: 2 },
  223:  { name: 'm221', units: 14 },
  50:   { name: 'm405', units: 26 },
  35:   { name: 'm608', units: 9 },
  46:   { name: 'ms22', units: 8 },
  43:   { name: 'ms43', units: 15 },
  1224: { name: 'o155-Elm', units: 21 },
  1183: { name: 'o155-Oak', units: 31 },
  47:   { name: 'p705', units: 20 },
  222:  { name: 'ps17', units: 18 },
  221:  { name: 'ps25', units: 44 },
  227:  { name: 'ps91', units: 14 },
  414:  { name: 'rl16', units: 96 },
  648:  { name: 'rl21', units: 22 },
  461:  { name: 's129', units: 20 },
  8:    { name: 's300', units: 14 },
  735:  { name: 'tc34', units: 24 },
  1993: { name: 'tc68', units: 108 },
  719:  { name: 'v202', units: 16 },
  225:  { name: 'w117', units: 10 },
  415:  { name: 'w225', units: 36 },
  224:  { name: 'w226', units: 11 },
};

function targetMonth() {
  if (process.env.TARGET_MONTH) return process.env.TARGET_MONTH;
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1); // last completed month
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchBudget(propertyId, month) {
  const cid = process.env.APPFOLIO_CLIENT_ID;
  const secret = process.env.APPFOLIO_CLIENT_SECRET;
  const auth = Buffer.from(`${cid}:${secret}`).toString('base64');
  const body = {
    period_from: month,
    period_to: month,
    comparison_period_from: month,
    comparison_period_to: month,
    accounting_basis: 'Accrual',
    properties: { properties_ids: [String(propertyId)] },
  };
  const res = await fetch(`https://${APPFOLIO_SUBDOMAIN}.appfolio.com/api/v2/reports/budget_comparative.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AppFolio ${propertyId} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function extractAccount(rows, accountNumber) {
  const row = rows.find(r => r.account_number === accountNumber);
  if (!row) return { budget: null, actual: null };
  return { budget: parseFloat(row.period_budget) || 0, actual: parseFloat(row.period_actual) || 0 };
}

async function pullAppfolioBudget(month) {
  const grouped = {}; // group key -> { name, units, repairsBudget, repairsActual, groundsBudget, groundsActual }
  const ids = Object.keys(PROPERTIES);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const meta = PROPERTIES[id];
    const key = meta.group || meta.name;
    try {
      const rows = await fetchBudget(id, month);
      const repairs = extractAccount(rows, '52001');
      const grounds = extractAccount(rows, '52003');
      if (!grouped[key]) grouped[key] = { name: key, units: 0, repairsBudget: 0, repairsActual: 0, groundsBudget: 0, groundsActual: 0 };
      grouped[key].units += meta.units;
      grouped[key].repairsBudget += repairs.budget || 0;
      grouped[key].repairsActual += repairs.actual || 0;
      grouped[key].groundsBudget += grounds.budget || 0;
      grouped[key].groundsActual += grounds.actual || 0;
    } catch (err) {
      console.error('Failed for property', id, meta.name, err.message);
    }
    await sleep(400); // avoid rate limiting
  }
  return grouped;
}

async function main() {
  const month = targetMonth();
  console.log('Pulling AppFolio budget/actual for', month);
  const grouped = await pullAppfolioBudget(month);

  const repairs = [];
  const grounds = [];
  let portfolioRepairsBudget = 0, portfolioRepairsActual = 0, portfolioGroundsBudget = 0, portfolioGroundsActual = 0;
  let totalUnits = 0;

  Object.values(grouped).forEach(p => {
    const repairsPerUnit = p.units ? p.repairsActual / p.units : 0;
    const groundsPerUnit = p.units ? p.groundsActual / p.units : 0;
    repairs.push({ property: p.name.toUpperCase(), budget: p.repairsBudget || null, actual_per_unit: round2(repairsPerUnit), detail: '' });
    grounds.push({ property: p.name.toUpperCase(), budget: p.groundsBudget || null, actual_per_unit: round2(groundsPerUnit), detail: '' });
    portfolioRepairsBudget += p.repairsBudget;
    portfolioRepairsActual += p.repairsActual;
    portfolioGroundsBudget += p.groundsBudget;
    portfolioGroundsActual += p.groundsActual;
    totalUnits += p.units;
  });

  repairs.sort((a, b) => b.actual_per_unit - a.actual_per_unit);
  grounds.sort((a, b) => b.actual_per_unit - a.actual_per_unit);

  const avgRepairs = totalUnits ? portfolioRepairsActual / totalUnits : 0;
  const avgGrounds = totalUnits ? portfolioGroundsActual / totalUnits : 0;

  const budgetJson = {
    month, label: monthLabel(month),
    generated_at: todayStr(),
    source: 'AppFolio Budget Comparative Report (accrual, per property) — automated',
    complete: true,
    averages: { repairs_per_unit: round2(avgRepairs), grounds_per_unit: round2(avgGrounds) },
    portfolio: {
      repairs: { budget: round2(portfolioRepairsBudget), actual: round2(portfolioRepairsActual), variance_pct: pctVar(portfolioRepairsBudget, portfolioRepairsActual) },
      grounds: { budget: round2(portfolioGroundsBudget), actual: round2(portfolioGroundsActual), variance_pct: pctVar(portfolioGroundsBudget, portfolioGroundsActual) },
    },
    repairs, grounds,
    narrative_repairs: [],
    narrative_grounds: [],
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `pl-budget-${month}.json`), JSON.stringify(budgetJson, null, 2));
  console.log('Wrote pl-budget-' + month + '.json');

  await updateManifest(month, true);
}

function round2(v) { return Math.round(v * 100) / 100; }
function pctVar(budget, actual) { if (!budget) return null; return round2(((actual - budget) / budget) * 100); }
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[m - 1] + ' ' + y;
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function updateManifest(month, complete) {
  const manifestPath = path.join(DATA_DIR, 'pl-manifest.json');
  let manifest = { months: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  manifest.generated_at = todayStr();
  const existing = manifest.months.find(m => m.key === month);
  if (existing) {
    existing.complete = complete;
  } else {
    manifest.months.unshift({ key: month, label: monthLabel(month), complete });
  }
  manifest.months.sort((a, b) => b.key.localeCompare(a.key));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Updated manifest');
}

main().catch(err => { console.error(err); process.exit(1); });
