// Daily refresh of the automatable slice of the Weekly Update report:
// - Monthly Budget vs Spent MTD (AppFolio, accrual, current month to date)
// - Operational Expenses by category MTD (Ramp, R&M team cardholders)
//
// KPIs (completion time, resident satisfaction, etc.) and narrative sections are
// NOT covered here — those come from PropertyMeld and Florencia's own write-up,
// which this automation doesn't have access to. Writes data/weekly-mtd.json.
//
// Required env vars: APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET, RAMP_CLIENT_ID, RAMP_CLIENT_SECRET

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const APPFOLIO_SUBDOMAIN = 'mckay';
const RM_TEAM = ['Justin Gutierrez', 'Wade Hippen', 'Isaac Chavez', 'Jaxson Lakins', 'Jared Miller'];

function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function monthStartEnd(month) {
  const [y, m] = month.split('-').map(Number);
  const from = `${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`;
  const to = todayStr() + 'T23:59:59Z';
  return { from, to };
}

async function appfolioPortfolioMTD(month) {
  const cid = process.env.APPFOLIO_CLIENT_ID;
  const secret = process.env.APPFOLIO_CLIENT_SECRET;
  const auth = Buffer.from(`${cid}:${secret}`).toString('base64');
  const body = {
    period_from: month, period_to: month,
    comparison_period_from: month, comparison_period_to: month,
    accounting_basis: 'Accrual',
    level_of_detail: 'summary_view',
  };
  const res = await fetch(`https://${APPFOLIO_SUBDOMAIN}.appfolio.com/api/v2/reports/budget_comparative.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AppFolio portfolio MTD failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const totalExpense = rows.find(r => r.account_name === 'Total Budgeted Operating Expense');
  return {
    budget: totalExpense ? parseFloat(totalExpense.period_budget) : null,
    actual: totalExpense ? parseFloat(totalExpense.period_actual) : null,
  };
}

async function rampToken() {
  const cid = process.env.RAMP_CLIENT_ID;
  const secret = process.env.RAMP_CLIENT_SECRET;
  const auth = Buffer.from(`${cid}:${secret}`).toString('base64');
  const res = await fetch('https://api.ramp.com/developer/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=transactions:read',
  });
  if (!res.ok) throw new Error(`Ramp token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function rampOpexMTD(token, from, to) {
  const all = [];
  let start = null;
  do {
    const url = new URL('https://api.ramp.com/developer/v1/transactions');
    url.searchParams.set('from_date', from);
    url.searchParams.set('page_size', '100');
    if (start) url.searchParams.set('start', start);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Ramp transactions failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    all.push(...(json.data || []));
    start = json.page && json.page.next ? new URL(json.page.next).searchParams.get('start') : null;
  } while (start);

  // to_date is unreliable per Ramp — filter client-side on the real field
  const toTime = new Date(to).getTime();
  const inRange = all.filter(t => new Date(t.user_transaction_time).getTime() <= toTime);

  const rmOnly = inRange.filter(t => {
    const holder = t.card_holder ? `${t.card_holder.first_name} ${t.card_holder.last_name}` : '';
    return RM_TEAM.some(n => n.toLowerCase() === holder.toLowerCase());
  });

  const byCategory = {};
  rmOnly.forEach(t => {
    const cat = (t.accounting_categories || []).find(c => c.type === 'GL_ACCOUNT');
    const name = cat ? cat.name : (t.sk_category_name || 'Uncategorized');
    const amt = t.amount / (t.minor_unit_conversion_rate || 100);
    byCategory[name] = (byCategory[name] || 0) + amt;
  });

  return Object.entries(byCategory).map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }));
}

async function main() {
  const month = currentMonth();
  const { from, to } = monthStartEnd(month);
  console.log('Refreshing weekly MTD data for', month, from, '-', to);

  const [portfolio, token] = await Promise.all([
    appfolioPortfolioMTD(month),
    rampToken(),
  ]);
  const opex = await rampOpexMTD(token, from, to);

  if (!portfolio.budget && !portfolio.actual && opex.length === 0) {
    throw new Error('AppFolio and Ramp both returned nothing — likely an upstream failure, refusing to write.');
  }

  const pct = portfolio.budget ? Math.round((portfolio.actual / portfolio.budget) * 1000) / 10 : null;

  const json = {
    month, generated_at: todayStr(),
    source: 'AppFolio (budget/actual MTD, accrual) + Ramp (opex by category, R&M team) — automated',
    budget_vs_spent_mtd: { budget: portfolio.budget, actual: portfolio.actual, pct_spent: pct },
    operational_expenses: opex,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'weekly-mtd.json'), JSON.stringify(json, null, 2));
  console.log('Wrote weekly-mtd.json');
}

main().catch(err => { console.error(err); process.exit(1); });
