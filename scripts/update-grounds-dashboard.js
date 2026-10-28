// Builds data/grounds-dashboard.json for grounds.html (Florencia's own Grounds dashboard, 2026-10-28).
//
// Sources:
//  - Property Meld: every ACTIVE recurring meld. Grounds = title starts with "G - " (Florencia's rule,
//    all 103 grounds series renamed 2026-10-28). Everything else is listed under "Other Recurring".
//    Assignees are read live from each series, so new people / new series show up with no setup.
//  - AppFolio (Accrual): budget v actual on GL 52003 R&M - Grounds per property per month, and the
//    52003 ledger lines (qbt = team labor, bill = vendor bills, ramp = card spend).
// Turns are never included.
const https = require('https');
const fs = require('fs');
const path = require('path');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#') && !process.env[line.slice(0, i).trim()]) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} catch (e) {}

const OUT = path.join(__dirname, '..', 'data', 'grounds-dashboard.json');
const PM_BASE = 'https://app.propertymeld.com', MGMT = '2975';
const AF_BASE = 'https://mckay.appfolio.com/api/v2/reports';
const GROUNDS_ACCOUNT = '52003', GROUNDS_GL_ID = '183';
const MONTHS_BACK = 6;            // trend window, current month included
const G_RE = /^\s*G\s*-\s*/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- dates (Pacific) ----------
const pacDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d); // YYYY-MM-DD
const TODAY = pacDate(new Date());
const ym = s => s.slice(0, 7);
function monthList() {
  const [y, m] = TODAY.split('-').map(Number);
  const out = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) { const d = new Date(Date.UTC(y, m - 1 - i, 1)); out.push(d.toISOString().slice(0, 7)); }
  return out;
}
const MONTHS = monthList();
const CUR = ym(TODAY);
const daysIn = mo => new Date(Date.UTC(+mo.slice(0, 4), +mo.slice(5, 7), 0)).getUTCDate();
const monthFrac = mo => mo === CUR ? +TODAY.slice(8, 10) / daysIn(mo) : 1;
const quarterOf = mo => Math.floor((+mo.slice(5, 7) - 1) / 3);
const Q_MONTHS = MONTHS.filter(mo => mo.slice(0, 4) === CUR.slice(0, 4) && quarterOf(mo) === quarterOf(CUR));
const Q_LABEL = `Q${quarterOf(CUR) + 1} ${CUR.slice(0, 4)}`;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const areaOf = city => /kennewick|pasco|richland/i.test(city || '') ? 'Tri-Cities' : /tacoma|lakewood/i.test(city || '') ? 'Tacoma' : 'Spokane';
const codeOf = name => ((String(name || '').trim().match(/^[a-z]+\d+/i) || [String(name || '').trim()])[0]).toLowerCase();

// ---------- Property Meld ----------
function httpreq(method, urlStr, headers, bodyStr) {
  return new Promise((res, rej) => {
    const u = new URL(urlStr);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: headers || {} }, resp => {
      let b = ''; resp.on('data', d => b += d); resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: b }));
    }).on('error', rej);
    if (bodyStr) r.write(bodyStr); r.end();
  });
}
async function pmLogin() {
  const jar = {};
  const add = h => { if (!h || !h['set-cookie']) return; h['set-cookie'].forEach(c => { const kv = c.split(';')[0]; const eq = kv.indexOf('='); if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1); }); };
  const sc = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  const r1 = await httpreq('GET', PM_BASE + '/login/?next=/', { 'User-Agent': 'Mozilla/5.0' }); add(r1.headers);
  const csrf1 = (r1.body.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/) || [])[1];
  const bd = new URLSearchParams({ csrfmiddlewaretoken: csrf1, email: process.env.PROPERTYMELD_EMAIL, password: process.env.PROPERTYMELD_PASSWORD }).toString();
  const r2 = await httpreq('POST', PM_BASE + '/login/?next=/', { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(bd), Referer: PM_BASE + '/login/?next=/', Cookie: sc() }, bd); add(r2.headers);
  if (/Invalid username\/password/.test(r2.body || '')) throw new Error('PropertyMeld login rejected');
  const r3 = await httpreq('GET', `${PM_BASE}/${MGMT}/m/${MGMT}/dashboard/`, { 'User-Agent': 'Mozilla/5.0', Cookie: sc() }); add(r3.headers);
  const csrf = (r3.body.match(/window\.PM\.csrf_token\s*=\s*"([^"]+)"/) || [])[1] || '';
  return { sc, csrf };
}
async function pmGet(p, s) {
  for (let i = 0; i < 4; i++) {
    const r = await httpreq('GET', `${PM_BASE}/${MGMT}/m/${MGMT}${p}`, { 'User-Agent': 'Mozilla/5.0', Cookie: s.sc(), 'X-CSRFToken': s.csrf, Accept: 'application/json', Referer: `${PM_BASE}/${MGMT}/m/${MGMT}/` });
    if (r.status < 400 && /^\s*[[{]/.test(r.body)) return JSON.parse(r.body);
    await sleep(800 * (i + 1));
  }
  throw new Error('PM GET failed: ' + p);
}

const cadenceOf = rr => {
  const f = rr && rr.freq, i = (rr && rr.interval) || 1;
  if (f === 'DAILY') return i === 1 ? 'Daily' : i === 7 ? 'Weekly' : i === 14 ? 'Bi-Weekly' : `Every ${i} days`;
  if (f === 'WEEKLY') return i === 1 ? 'Weekly' : i === 2 ? 'Bi-Weekly' : `Every ${i} weeks`;
  if (f === 'MONTHLY') return i === 1 ? 'Monthly' : i === 3 ? 'Quarterly' : i === 6 ? 'Bi-Annual' : i === 12 ? 'Annual' : `Every ${i} months`;
  if (f === 'YEARLY') return 'Annual';
  return '';
};
const personName = m => (m.type && m.type !== 'ManagementAgent') ? `${m.name} (vendor)` : m.name;

async function pullRecurring(s) {
  let list = [], off = 0;
  for (;;) {
    const d = await pmGet(`/api/melds/recurring/?limit=200&offset=${off}`, s);
    const res = d.results || d; list = list.concat(res);
    if (!d.next || !res.length) break; off += 200;
  }
  const series = [];
  for (const x of list) {
    const d = await pmGet(`/api/melds/recurring/${x.id}/`, s);
    if (!d.is_active) continue;
    const title = String(d.brief_description || '').trim().replace(/\s+/g, ' ');
    series.push({
      id: d.id, title, g: G_RE.test(title),
      prop: String((d.prop && d.prop.property_name) || '').trim(),
      area: areaOf(d.prop && d.prop.city),
      cadence: cadenceOf(d.event && d.event.rrule),
      who: (d.maintenance || []).map(personName).join(' + '),
      created: String(d.created || '').slice(0, 10)
    });
    await sleep(60);
  }
  return series;
}

const STATUSES = ['COMPLETED', 'MANAGER_CANCELED', 'TENANT_CANCELED', 'VENDOR_COULD_NOT_COMPLETE', 'MAINTENANCE_COULD_NOT_COMPLETE',
  'PENDING_ASSIGNMENT', 'PENDING_MORE_MANAGEMENT_AVAILABILITY', 'PENDING_TENANT_AVAILABILITY', 'PENDING_COMPLETION', 'PENDING_VENDOR',
  'PENDING_MORE_VENDOR_AVAILABILITY'];
async function pullOccurrences(s, gIds, fromDate) {
  const out = [];
  for (const st of STATUSES) {
    let off = 0;
    for (;;) {
      let d;
      try { d = await pmGet(`/api/melds/?limit=200&offset=${off}&status=${st}&ordering=-created`, s); } catch (e) { console.log('  skip', st, e.message); break; }
      const res = d.results || d;
      for (const m of res) {
        if (!m.recurring_meld || !gIds.has(m.recurring_meld)) continue;
        const appts = (m.managementappointment || [])
          .filter(a => !/cancel/i.test(a.status || '') && a.availability_segment && a.availability_segment.event && a.availability_segment.event.dtstart)
          .map(a => a.availability_segment.event.dtstart).sort();
        const when = appts.length ? appts[appts.length - 1] : (m.completion_date || m.created);
        out.push({ id: m.id, ref: m.reference_id, series: m.recurring_meld, status: m.status, date: pacDate(new Date(when)), scheduled: appts.length > 0 });
      }
      const last = res[res.length - 1];
      if (!d.next || !res.length || (last && String(last.created).slice(0, 10) < fromDate)) break;
      off += 200;
    }
  }
  return out.filter(o => o.date >= fromDate);
}
// An open meld with no appointment is dated by its creation, and PM generates a recurring instance
// about a week ahead - so it is "Not scheduled" (not counted) until it has sat a week unplaced.
function labelOf(o) {
  if (o.status === 'COMPLETED') return 'Completed';
  if (/CANCELED/.test(o.status)) return 'Canceled';
  if (/COULD_NOT_COMPLETE/.test(o.status)) return 'Could not complete';
  if (!o.scheduled) return o.date < addDays(TODAY, -7) ? 'Overdue' : 'Not scheduled';
  return o.date < TODAY ? 'Overdue' : 'Scheduled';
}
const scoreOf = l => l === 'Completed' ? 1 : l === 'Scheduled' ? 0.25 : 0;
const counts = l => l !== 'Not scheduled' && l !== 'Canceled'; // canceled = neither done nor missed (Florencia 2026-10-28)
// Series assigned to these people are office placeholders for vendor bills, not grounds-team work:
// listed, but never counted in completion or overdue (Florencia 2026-10-28).
const NOT_COUNTED_WHO = ['Florencia Sola'];
const isCounted = x => !NOT_COUNTED_WHO.some(n => String(x.who || '').includes(n));

// ---------- AppFolio ----------
const afAuth = () => 'Basic ' + Buffer.from(`${(process.env.APPFOLIO_CLIENT_ID || '').trim()}:${(process.env.APPFOLIO_CLIENT_SECRET || '').trim()}`).toString('base64');
async function afFetch(url, body, attempt = 1) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: afAuth() }, body: JSON.stringify(body) } : { headers: { Authorization: afAuth() } });
  if (res.status === 429 && attempt <= 5) { await sleep(3000 * attempt); return afFetch(url, body, attempt + 1); }
  if (!res.ok) throw new Error(`AppFolio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function afReport(name, body) {
  let j = await afFetch(`${AF_BASE}/${name}.json`, body);
  let rows = Array.isArray(j) ? j : (j.results || []);
  // Relative next_page_url (work_order report) only answers to POST; absolute ones (general_ledger) to GET.
  while (j && j.next_page_url) { j = await afFetch(new URL(j.next_page_url, AF_BASE).href, j.next_page_url.startsWith('/') ? {} : undefined); rows = rows.concat(j.results || []); }
  return rows;
}

async function pullBudget() {
  const props = (await afReport('property_directory', {})).filter(p => p.visibility === 'Active');
  const byCode = {};
  for (const p of props) {
    const code = codeOf(p.property_name);
    byCode[code] = byCode[code] || { code, area: areaOf(p.property_city), months: {} };
    for (const mo of MONTHS) {
      let rows = [];
      try {
        rows = await afReport('budget_comparative', { period_from: mo, period_to: mo, comparison_period_from: mo, comparison_period_to: mo, accounting_basis: 'Accrual', properties: { properties_ids: [String(p.property_id)] } });
      } catch (e) { console.log('  budget fail', p.property_name, mo, e.message); }
      const r = rows.find(x => x.account_number === GROUNDS_ACCOUNT);
      const cell = byCode[code].months[mo] = byCode[code].months[mo] || { budget: 0, actual: 0 };
      if (r) { cell.budget += parseFloat(r.period_budget) || 0; cell.actual += parseFloat(r.period_actual) || 0; }
      await sleep(200);
    }
  }
  return Object.values(byCode).filter(p => MONTHS.some(mo => p.months[mo].budget || p.months[mo].actual));
}

async function pullLedger() {
  const rows = await afReport('general_ledger', { posted_on_from: MONTHS[0] + '-01', posted_on_to: TODAY, accounting_basis: 'Accrual', gl_account_ids: GROUNDS_GL_ID });
  return rows.filter(r => String(r.account_name || '').startsWith(GROUNDS_ACCOUNT)).map(r => {
    const ref = String(r.reference || '');
    const src = ref.startsWith('qbt:') ? 'Team labor' : ref.startsWith('bill:') ? 'Vendor bill' : ref.startsWith('ramp:') ? 'Ramp' : r.party_type === 'Occupancy' ? 'Resident credit' : 'Journal entry';
    // Public page: no resident names, and no free-text tech notes (they can mention residents).
    const memo = src === 'Vendor bill' || src === 'Ramp' ? String(r.description || '').slice(0, 140) : src === 'Resident credit' ? 'Resident credit for grounds work' : src === 'Team labor' ? 'QBT time' : String(r.description || '').slice(0, 80);
    return { date: r.post_date, month: ym(r.post_date || ''), prop: codeOf(r.property_name), src, memo, amount: Math.round(((parseFloat(r.debit) || 0) - (parseFloat(r.credit) || 0)) * 100) / 100 };
  });
}

// Every bill line on GL 52003 carries the AppFolio work order it is charged to; the work order's
// description ends with the Property Meld reference ("Title - TMTVL0V").
async function pullWoCharges() {
  const lines = await afReport('bill_detail', { occurred_on_from: MONTHS[0] + '-01', occurred_on_to: TODAY, gl_account_ids: GROUNDS_GL_ID });
  const wos = await afReport('work_order', { property_visibility: 'all', work_order_statuses: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] });
  const woById = Object.fromEntries(wos.map(w => [w.work_order_id, w]));
  const byWo = {};
  for (const l of lines) {
    if (String(l.account_number) !== GROUNDS_ACCOUNT) continue;
    const amount = Math.round(((parseFloat(l.paid) || 0) + (parseFloat(l.unpaid) || 0)) * 100) / 100;
    if (!amount) continue;
    const ref = String(l.reference_number || '');
    const src = ref.startsWith('qbt:') ? 'Time entry' : ref.startsWith('ramp:') ? 'Ramp' : 'Vendor bill';
    // Public page: no free-text tech notes on time entries.
    const desc = src === 'Time entry' ? 'QBT time' : src === 'Vendor bill' ? [l.payee_name, l.description].filter(Boolean).join(' - ').slice(0, 140) : String(l.description || '').slice(0, 140);
    const key = l.work_order_id || 'none';
    if (!byWo[key]) {
      const w = woById[l.work_order_id] || {};
      const first = String(w.service_request_description || w.job_description || '').split('\n')[0].trim();
      const m = first.match(/^(.*?)\s+-\s+([A-Z0-9]{7,8})$/);
      byWo[key] = { wo: l.work_order || '', prop: codeOf(l.property_name), area: areaOf(l.property_city), title: m ? m[1] : first.slice(0, 120), ref: m ? m[2] : '', status: w.status || '', lines: [] };
    }
    byWo[key].lines.push({ date: l.posting_date || l.bill_date, month: ym(l.posting_date || l.bill_date || ''), src, desc, amount });
  }
  return Object.values(byWo);
}

// ---------- build ----------
async function main() {
  console.log('Today', TODAY, 'months', MONTHS.join(','));
  const s = await pmLogin();
  const series = await pullRecurring(s);
  const gSeries = series.filter(x => x.g);
  console.log('active recurring', series.length, 'G', gSeries.length);
  const occ = await pullOccurrences(s, new Set(gSeries.map(x => x.id)), MONTHS[0] + '-01');
  console.log('G occurrences since', MONTHS[0], occ.length);
  occ.forEach(o => { o.label = labelOf(o); });

  const budget = await pullBudget();
  console.log('properties with grounds budget/actual', budget.length);
  const gl = await pullLedger();
  console.log('ledger lines', gl.length);
  const woCharges = await pullWoCharges();
  console.log('work orders with grounds charges', woCharges.length);

  const seriesById = Object.fromEntries(series.map(x => [x.id, x]));
  const rate = list => { const l = list.filter(o => counts(o.label)); const sc = l.reduce((a, o) => a + scoreOf(o.label), 0); return l.length ? Math.round(sc / l.length * 1000) / 10 : null; };
  const countedIds = new Set(gSeries.filter(isCounted).map(x => x.id));
  const past = occ.filter(o => o.date <= TODAY && countedIds.has(o.series));

  // Overview: KPIs
  const qBudget = Q_MONTHS.reduce((a, mo) => a + budget.reduce((b, p) => b + p.months[mo].budget * monthFrac(mo), 0), 0);
  const qActual = Q_MONTHS.reduce((a, mo) => a + budget.reduce((b, p) => b + p.months[mo].actual, 0), 0);
  const qGl = gl.filter(r => Q_MONTHS.includes(r.month));
  const qTotal = qGl.reduce((a, r) => a + r.amount, 0), qBills = qGl.filter(r => r.src === 'Vendor bill').reduce((a, r) => a + r.amount, 0);
  const qOcc = past.filter(o => Q_MONTHS.includes(ym(o.date)));
  const overdue = occ.filter(o => o.label === 'Overdue' && countedIds.has(o.series));
  const overdueByArea = {};
  overdue.forEach(o => { const a = (seriesById[o.series] || {}).area || 'Spokane'; overdueByArea[a] = (overdueByArea[a] || 0) + 1; });

  const trend = MONTHS.map(mo => {
    const b = budget.reduce((a, p) => a + p.months[mo].budget * monthFrac(mo), 0);
    const ac = budget.reduce((a, p) => a + p.months[mo].actual, 0);
    const mOcc = past.filter(o => ym(o.date) === mo);
    const mGl = gl.filter(r => r.month === mo), tot = mGl.reduce((a, r) => a + r.amount, 0);
    return { month: mo, current: mo === CUR, utilization: b ? Math.round(ac / b * 1000) / 10 : null, completion: rate(mOcc),
      vendorShare: tot ? Math.round(mGl.filter(r => r.src === 'Vendor bill').reduce((a, r) => a + r.amount, 0) / tot * 1000) / 10 : null };
  });

  const tableMonths = MONTHS.slice(-3);
  const properties = budget.map(p => {
    const pOcc = past.filter(o => tableMonths.includes(ym(o.date)) && codeOf((seriesById[o.series] || {}).prop) === p.code);
    return { code: p.code, area: p.area, months: tableMonths.map(mo => ({ month: mo, budget: Math.round(p.months[mo].budget * monthFrac(mo)), actual: Math.round(p.months[mo].actual) })), done: rate(pOcc) };
  }).sort((a, b) => a.code.localeCompare(b.code));

  // Recurring status: last 4 occurrences per series (up to a week ahead)
  const horizon = addDays(TODAY, 7);
  const since30 = addDays(TODAY, -30);
  const statusSeries = gSeries.map(x => {
    const mine = occ.filter(o => o.series === x.id && o.date <= horizon).sort((a, b) => a.date.localeCompare(b.date)).slice(-4);
    return { id: x.id, prop: x.prop, area: x.area, title: x.title, cadence: x.cadence, who: x.who || 'Unassigned', isNew: x.created >= since30, counted: isCounted(x),
      occ: mine.map(o => ({ date: o.date, label: o.label, ref: o.ref, meld: o.id })), done: isCounted(x) ? rate(mine.filter(o => o.date <= TODAY)) : null };
  });

  const otherSeries = series.filter(x => !x.g).map(x => ({ id: x.id, prop: x.prop, area: x.area, title: x.title, cadence: x.cadence, who: x.who || 'Unassigned', isNew: x.created >= since30 }));

  const workOrders = occ.filter(o => o.date >= since30 && o.date <= TODAY && countedIds.has(o.series)).sort((a, b) => b.date.localeCompare(a.date)).map(o => {
    const x = seriesById[o.series] || {};
    return { date: o.date, prop: x.prop, area: x.area, title: x.title, who: x.who || 'Unassigned', status: o.label, ref: o.ref, meld: o.id };
  });

  const transactions = gl.filter(r => r.month === CUR).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Link a work order to its meld when the meld is one of the G occurrences we already pulled.
  const meldByRef = Object.fromEntries(occ.map(o => [o.ref, o.id]));
  woCharges.forEach(w => { if (meldByRef[w.ref]) w.meld = meldByRef[w.ref]; });

  const out = {
    generated_at: new Date().toISOString(), today: TODAY, quarter: Q_LABEL, months: MONTHS, table_months: tableMonths, current_month: CUR,
    kpis: {
      utilization: { value: qBudget ? Math.round(qActual / qBudget * 1000) / 10 : null, goal: 90, actual: Math.round(qActual), budget: Math.round(qBudget) },
      completion: { value: rate(qOcc), goal: 90, completed: qOcc.filter(o => o.label === 'Completed').length, due: qOcc.filter(o => counts(o.label)).length },
      overdue: { value: overdue.length, goal: 0, byArea: overdueByArea },
      vendorShare: { value: qTotal ? Math.round(qBills / qTotal * 1000) / 10 : null, goal: 25, bills: Math.round(qBills), total: Math.round(qTotal) }
    },
    trend, properties, statusSeries, otherSeries, workOrders, transactions, woCharges
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('Wrote', OUT);
}

if (require.main === module) main().catch(e => { console.error('FATAL', e); process.exit(1); });
module.exports = { pmLogin, pullRecurring, pullOccurrences, labelOf, MONTHS };
