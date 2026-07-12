// Daily refresh of the per-week history for the Weekly Update report:
// - Top 10 Work Orders by cost (last completed melds this week)
// - Per-technician breakdown (avg cost/WO, total labor cost, avg resident rating, comments)
//
// Runs daily. Always targets the CURRENT week (Monday through today) so that by the
// time a week ends (Sunday), its file is already complete -- Monday morning it's ready
// to read, and a new week's file starts automatically.
//
// Cost = Ramp materials (matched to a meld by its reference ID in the Customer/Job
// accounting category) + QBT labor (hours x wage, matched to a meld by the leaf
// jobcode name in its hierarchy path). Both conventions confirmed against LeeRoy's
// existing pipeline for the same portfolio/team.
//
// The 6 legacy KPIs (Emergency WO Completion Time, etc.) live in Property Meld's
// Insights tab, which is a Sigma Computing embedded dashboard -- not reachable via
// this API. Those, and Florencia's narrative write-up, are entered manually and
// preserved across automated runs (same pattern as P&L's narrative_repairs).
//
// Required env vars: PROPERTYMELD_EMAIL, PROPERTYMELD_PASSWORD, QBT_TOKEN,
// RAMP_CLIENT_ID, RAMP_CLIENT_SECRET

const fs = require('fs');
const path = require('path');
const https = require('https');
const DATA_DIR = path.join(__dirname, '..', 'data');

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
  console.log(`DEBUG: PROPERTYMELD_EMAIL length=${pmEmail.length} starts='${pmEmail.slice(0,2)}' ends='${pmEmail.slice(-2)}'`);
  console.log(`DEBUG: PROPERTYMELD_PASSWORD length=${pmPassword.length}`);
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

function firstApptCreated(m) {
  const appts = (m.managementappointment || []).filter(a => a.created);
  if (!appts.length) return null;
  return appts.sort((a, b) => a.created.localeCompare(b.created))[0].created;
}

async function fetchPmCompletedMelds(weekStart, weekEnd) {
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
      if (cd < weekStart) { stop = true; continue; }
      if (cd > weekEnd) continue;
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

async function fetchQbtLabor(weekStart, weekEnd) {
  const headers = { Authorization: `Bearer ${process.env.QBT_TOKEN}` };
  const jobcodes = {};
  let jcPage = 1;
  while (true) {
    const res = await fetch(`https://rest.tsheets.com/api/v1/jobcodes?active=both&supplemental_data=no&page=${jcPage}`, { headers });
    const j = await res.json();
    const rows = Object.values(j.results?.jobcodes || {});
    if (!rows.length) break;
    rows.forEach(jc => { jobcodes[jc.id] = jc; });
    if (!j.more) break;
    jcPage++;
  }

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
    const res = await fetch(`https://rest.tsheets.com/api/v1/timesheets?start_date=${weekStart}&end_date=${weekEnd}&page=${page}`, { headers });
    const j = await res.json();
    const rows = Object.values(j.results?.timesheets || {});
    if (!rows.length) break;
    timesheets.push(...rows);
    if (!j.more) break;
    page++;
  }

  const laborByRef = {};
  const jcCache = {};
  for (const ts of timesheets) {
    if (ts.type !== 'regular') continue;
    const tech = qbtIdToTech[ts.user_id];
    if (!tech) continue;
    const cls = (ts.customfields && ts.customfields['25056']) || '';
    if (!/r&m|repair|maintenance/i.test(cls)) continue;
    const p = jcPath(ts.jobcode_id, jcCache);
    const ref = p.length ? p[p.length - 1] : null;
    if (!ref || !/^T[A-Z0-9]{5,}/i.test(ref)) continue;
    const hrs = ts.duration / 3600;
    if (!laborByRef[ref]) laborByRef[ref] = { hours: 0, cost: 0 };
    laborByRef[ref].hours += hrs;
    laborByRef[ref].cost += hrs * tech.wage;
  }
  return laborByRef;
}

async function fetchRampMaterials(weekStart, weekEnd) {
  const auth = Buffer.from(`${process.env.RAMP_CLIENT_ID}:${process.env.RAMP_CLIENT_SECRET}`).toString('base64');
  const tokRes = await fetch('https://api.ramp.com/developer/v1/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=transactions:read',
  });
  if (!tokRes.ok) throw new Error(`Ramp token failed: ${tokRes.status} ${await tokRes.text()}`);
  const token = (await tokRes.json()).access_token;

  const from = `${weekStart}T00:00:00Z`;
  const toTime = new Date(`${weekEnd}T23:59:59Z`).getTime();
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

  const materialsByRef = {};
  for (const t of inWindow) {
    const dept = (t.accounting_categories || []).find(c => c.tracking_category_remote_id === 'QuickbooksCustomer');
    if (!dept || !dept.category_name) continue;
    const parts = dept.category_name.split(':');
    const ref = parts[parts.length - 1].trim();
    if (!/^T[A-Z0-9]{5,}/i.test(ref)) continue;
    materialsByRef[ref] = (materialsByRef[ref] || 0) + t.amount / (t.minor_unit_conversion_rate || 100);
  }
  return materialsByRef;
}

function mondayOf(d) {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  return m;
}
function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function monthName(m) { return ['January','February','March','April','May','June','July','August','September','October','November','December'][m]; }
function weekLabel(startD, endD) {
  const sameMonth = startD.getMonth() === endD.getMonth();
  const startStr = monthName(startD.getMonth()) + ' ' + startD.getDate();
  const endStr = (sameMonth ? '' : monthName(endD.getMonth()) + ' ') + endD.getDate();
  return `${startStr} – ${endStr}, ${endD.getFullYear()}`;
}

async function main() {
  const today = new Date();
  const monday = mondayOf(today);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const weekStart = dstr(monday);
  const weekEnd = dstr(today) < dstr(sunday) ? dstr(today) : dstr(sunday);
  console.log('Refreshing weekly history for', weekStart, 'to', weekEnd);

  const [melds, labor, materials] = await Promise.all([
    fetchPmCompletedMelds(weekStart, weekEnd),
    fetchQbtLabor(weekStart, weekEnd),
    fetchRampMaterials(weekStart, weekEnd),
  ]);
  console.log('PM completed melds:', melds.length, '| QBT labor refs:', Object.keys(labor).length, '| Ramp material refs:', Object.keys(materials).length);

  const rows = melds.map(m => {
    const lab = labor[m.ref] || { hours: 0, cost: 0 };
    const mat = materials[m.ref] || 0;
    return { ...m, laborCost: lab.cost, materialsCost: mat, totalCost: lab.cost + mat };
  });

  const topWorkOrders = [...rows].sort((a, b) => b.totalCost - a.totalCost).slice(0, 10)
    .map(r => ({ ref: r.ref, brief: r.brief, cost: Math.round(r.totalCost * 100) / 100 }));

  const byTechMap = {};
  rows.forEach(r => { if (r.tech) (byTechMap[r.tech] = byTechMap[r.tech] || []).push(r); });
  const byTechnician = Object.entries(byTechMap).map(([name, list]) => {
    const totalLabor = list.reduce((s, r) => s + r.laborCost, 0);
    const totalCost = list.reduce((s, r) => s + r.totalCost, 0);
    const rated = list.filter(r => r.rating != null);
    const avgRating = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : null;
    return {
      name,
      wo_count: list.length,
      avg_cost_per_wo: Math.round((totalCost / list.length) * 100) / 100,
      total_labor_cost: Math.round(totalLabor * 100) / 100,
      avg_resident_rating: avgRating != null ? Math.round(avgRating * 100) / 100 : null,
      comments: list.filter(r => r.review).map(r => ({ ref: r.ref, text: r.review })),
    };
  }).sort((a, b) => b.wo_count - a.wo_count);

  const outPath = path.join(DATA_DIR, `weekly-${weekStart}.json`);
  let priorKpis = null, priorNarrative = null;
  if (fs.existsSync(outPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      priorKpis = prior.kpis || null;
      priorNarrative = prior.narrative || null;
    } catch (e) { /* ignore unparseable prior file */ }
  }

  const json = {
    week_start: weekStart,
    week_end: dstr(sunday),
    label: weekLabel(monday, sunday),
    generated_at: dstr(today),
    complete: weekEnd === dstr(sunday),
    source: 'Property Meld (completed melds) + Ramp (materials) + QBT (labor) — automated. KPIs and narrative are authored by Florencia, never generated here.',
    top_work_orders: topWorkOrders,
    by_technician: byTechnician,
    // Never generated automatically -- carried forward so this script can't erase them.
    kpis: priorKpis,
    narrative: priorNarrative,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
  console.log('Wrote weekly-' + weekStart + '.json');

  const manifestPath = path.join(DATA_DIR, 'weekly-manifest.json');
  let manifest = { weeks: [] };
  if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.generated_at = dstr(today);
  const existing = manifest.weeks.find(w => w.key === weekStart);
  if (existing) { existing.label = json.label; }
  else { manifest.weeks.unshift({ key: weekStart, label: json.label }); }
  manifest.weeks.sort((a, b) => b.key.localeCompare(a.key));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('Updated weekly-manifest.json');
}

main().catch(err => { console.error(err); process.exit(1); });
