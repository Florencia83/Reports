// Refreshes the Grounds report's data: for every known Grounds recurring meld series
// (lawn/landscaping/grounds-cleaning/irrigation/pool, per area), shows the last 4 real
// occurrences (not calendar weeks -- cadences vary from every-3-days to annual) with
// status (Completed/Scheduled/Canceled/Pending) and the assigned employee or vendor.
//
// Recurring meld ID registry below was reconciled 2026-07-14 against Florencia's manual
// tracking sheet (https://docs.google.com/spreadsheets/d/1_BYqgShTbeD6oxpXSd5yugshLOpPCHIziZW-s0HYjJg)
// -- her sheet has the authoritative list including low-cadence (quarterly/annual) series
// that a live PM pull can miss entirely if nothing is currently due. Confirmed exclusions:
// Quarterly/safety inspections (Isaac Chavez's supervisor role, not grounds crew). Confirmed
// inclusion (2026-07-14, Florencia): Jared Miller's "Daily Pool Maintenance" at kn47/ps25/rl16.
//
// Required env vars: PROPERTYMELD_EMAIL, PROPERTYMELD_PASSWORD

const fs = require('fs');
const path = require('path');
const https = require('https');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PM_BASE = 'https://app.propertymeld.com', PM_MGMT = '2975';

// Cadence sort order, most-frequent first -- matches Florencia's requested row order
// (2026-07-14): weekly first, then bi-weekly, monthly, quarterly, bi-annual, annual.
const CADENCE_ORDER = ['Daily', 'Every 3 days', 'Weekly', 'Bi-Weekly', 'Monthly', 'Quarterly', 'Bi-Annual', 'Annual'];

// recurring_meld id -> { area, property, title, cadence, vendor (literal name if a known
// vendor company, else null -- PM shows no in_house_servicer for these) }
const GROUNDS_REGISTRY = {
  // ---- Tri-Cities: KN47 K1 (Rey=lawn, Hannah=grounds, Jared=pool) ----
  153787: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Lawn mowing & edging / exterior landscaping', cadence: 'Weekly' },
  151568: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Pet waste removal', cadence: 'Weekly' },
  123679: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Open dumpsters for pickup / area cleanup', cadence: 'Weekly' },
  151569: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Internal Office / Clubhouse Cleaning', cadence: 'Weekly', vendor: 'DUO CLEAN' },
  153788: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Spray rock beds / walkways / curb edges', cadence: 'Weekly' },
  151567: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Fitness Center Walkthrough', cadence: 'Weekly' },
  153944: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Bed weeding (manual & chemical)', cadence: 'Monthly' },
  163425: { area: 'Tri-Cities', property: 'KN47 K1', title: 'General Landscaping Maintenance', cadence: 'Weekly' },
  153870: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Litter pickup', cadence: 'Every 3 days' },
  119264: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Lighting checks', cadence: 'Monthly' },
  151570: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Laundry room cleaning', cadence: 'Bi-Weekly' },
  153945: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Irrigation leak inspections', cadence: 'Monthly' },
  153950: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Fertilization (spring/fall)', cadence: 'Bi-Annual' },
  153951: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Irrigation startup and zone adjustments', cadence: 'Annual' },
  153952: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Irrigation winterization', cadence: 'Annual' },
  153953: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Tree pruning', cadence: 'Annual', vendor: 'Tree vendor' },
  153955: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Spot pressure washing', cadence: 'Annual' },
  153868: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Daily Pool Maintenance', cadence: 'Daily' },

  // ---- Tri-Cities: RL16 (Rey + Hannah) ----
  163426: { area: 'Tri-Cities', property: 'RL16', title: 'General Lawn Maintenance', cadence: 'Weekly' },
  112038: { area: 'Tri-Cities', property: 'RL16', title: 'Grounds Cleanup', cadence: 'Weekly' },
  114790: { area: 'Tri-Cities', property: 'RL16', title: 'Grounds Cleanup (2)', cadence: 'Weekly' },
  115088: { area: 'Tri-Cities', property: 'RL16', title: 'Exterior staircases', cadence: 'Weekly' },
  180224: { area: 'Tri-Cities', property: 'RL16', title: 'Daily Pool Maintenance', cadence: 'Daily' },

  // ---- Tri-Cities: RL21 (Rey) ----
  166100: { area: 'Tri-Cities', property: 'RL21', title: 'Exterior Landscaping (return lawn service)', cadence: 'Weekly' },
  163428: { area: 'Tri-Cities', property: 'RL21', title: 'Lawn Service', cadence: 'Weekly' },

  // ---- Tri-Cities: PS17 (Rey + Hannah) ----
  163429: { area: 'Tri-Cities', property: 'PS17', title: 'Lawn Service', cadence: 'Weekly' },
  112135: { area: 'Tri-Cities', property: 'PS17', title: 'Grounds Cleanup', cadence: 'Weekly' },
  138046: { area: 'Tri-Cities', property: 'PS17', title: 'Weekly garbage taken out', cadence: 'Weekly' },
  164484: { area: 'Tri-Cities', property: 'PS17', title: 'Litter pickup', cadence: 'Weekly' },

  // ---- Tri-Cities: PS25 (Rey + Hannah + Jared/pool) ----
  163427: { area: 'Tri-Cities', property: 'PS25', title: 'Lawn Service', cadence: 'Weekly' },
  112134: { area: 'Tri-Cities', property: 'PS25', title: 'Grounds Cleanup', cadence: 'Weekly' },
  180223: { area: 'Tri-Cities', property: 'PS25', title: 'Daily Pool Maintenance', cadence: 'Daily' },

  // ---- Tri-Cities: PS91 (Rey + Hannah) ----
  163430: { area: 'Tri-Cities', property: 'PS91', title: 'Lawn Service', cadence: 'Weekly' },
  112136: { area: 'Tri-Cities', property: 'PS91', title: 'Grounds Cleanup', cadence: 'Weekly' },

  // ---- Tacoma: TC68 (Jonas assigned in PM; several sub-services actually vendor-run) ----
  178924: { area: 'Tacoma', property: 'TC68', title: 'Lawn mowing & edging', cadence: 'Weekly', vendor: 'Lawn Care vendor' },
  178925: { area: 'Tacoma', property: 'TC68', title: 'Pet waste removal', cadence: 'Weekly' },
  178932: { area: 'Tacoma', property: 'TC68', title: 'Internal Office / Clubhouse Cleaning', cadence: 'Bi-Weekly', vendor: 'Vendor' },
  178936: { area: 'Tacoma', property: 'TC68', title: 'Litter pickup', cadence: 'Bi-Weekly' },
  178939: { area: 'Tacoma', property: 'TC68', title: 'Irrigation zone adjustments', cadence: 'Quarterly', vendor: 'Lawn Care vendor' },
  178941: { area: 'Tacoma', property: 'TC68', title: 'Bed weeding (manual & chemical)', cadence: 'Monthly', vendor: 'Lawn Care vendor' },
  178945: { area: 'Tacoma', property: 'TC68', title: 'Lighting checks', cadence: 'Monthly' },
  178947: { area: 'Tacoma', property: 'TC68', title: 'Fertilization (spring/fall)', cadence: 'Bi-Annual', vendor: 'Lawn Care vendor' },
  178950: { area: 'Tacoma', property: 'TC68', title: 'Irrigation startup', cadence: 'Annual', vendor: 'Lawn Care vendor' },
  178953: { area: 'Tacoma', property: 'TC68', title: 'Irrigation winterization', cadence: 'Annual', vendor: 'Lawn Care vendor' },
  178955: { area: 'Tacoma', property: 'TC68', title: 'Tree pruning', cadence: 'Annual', vendor: 'Vendor (TBD)' },
  178958: { area: 'Tacoma', property: 'TC68', title: 'Pressure washing', cadence: 'Annual', vendor: 'Lawn Care vendor' },

  // ---- Spokane (David Sanchez + Alexander Overall, shared across the whole portfolio) ----
  161264: { area: 'Spokane', property: 'V202', title: 'Lawn service', cadence: 'Weekly' },
  161265: { area: 'Spokane', property: 'S129', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161266: { area: 'Spokane', property: 'S300', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161267: { area: 'Spokane', property: 'P705', title: 'Lawn service', cadence: 'Weekly' },
  161270: { area: 'Spokane', property: 'A210', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161271: { area: 'Spokane', property: 'J312', title: 'Lawn service', cadence: 'Weekly' },
  161272: { area: 'Spokane', property: 'A511', title: 'Lawn service', cadence: 'Weekly' },
  161276: { area: 'Spokane', property: 'A916', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161277: { area: 'Spokane', property: 'M221', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161278: { area: 'Spokane', property: 'B101', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161279: { area: 'Spokane', property: 'M608', title: 'Lawn service', cadence: 'Weekly' },
  161280: { area: 'Spokane', property: 'M405', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161281: { area: 'Spokane', property: 'L912', title: 'Lawn service', cadence: 'Weekly' },
  161282: { area: 'Spokane', property: 'W117', title: 'Lawn service', cadence: 'Bi-Weekly' },
  161284: { area: 'Spokane', property: 'W226', title: 'Lawn service', cadence: 'Weekly' },
  161286: { area: 'Spokane', property: 'E328', title: 'Lawn service', cadence: 'Weekly' },
  161289: { area: 'Spokane', property: 'C302', title: 'Lawn service', cadence: 'Weekly' },
  161291: { area: 'Spokane', property: 'C313', title: 'Lawn service', cadence: 'Weekly' },
  162927: { area: 'Spokane', property: 'O155-OAK', title: 'Lawn service', cadence: 'Weekly' },
  163904: { area: 'Spokane', property: 'H731', title: 'Lawn service (bi-weekly)', cadence: 'Bi-Weekly' },
  179920: { area: 'Spokane', property: 'H731', title: 'Lawn service (weekly)', cadence: 'Weekly' },
  164381: { area: 'Spokane', property: 'K308', title: 'Lawn service', cadence: 'Weekly' },
  166878: { area: 'Spokane', property: 'K104-LEFEVRE', title: 'Weekly mowing', cadence: 'Weekly' },
  167333: { area: 'Spokane', property: 'K104-BROWER EVEN', title: 'Lawn service', cadence: 'Weekly' },
};

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

const OPEN_STATUSES = ['PENDING_ASSIGNMENT', 'PENDING_MORE_MANAGEMENT_AVAILABILITY', 'PENDING_COMPLETION', 'PENDING_VENDOR', 'PENDING_MORE_VENDOR_AVAILABILITY'];
// Statuses PM considers terminal-but-not-completed. Confirmed live 2026-07-14 via the full
// distinct-status enumeration on the account -- these were previously never fetched at all
// (only OPEN_STATUSES + COMPLETED were queried), so a meld could silently vanish from the
// report instead of showing as Canceled/Could Not Complete (caught via a May gap in kn47's
// bed-weeding/irrigation series: both months' melds were MAINTENANCE_COULD_NOT_COMPLETE).
const CANCELED_STATUSES = ['MANAGER_CANCELED', 'TENANT_CANCELED'];
const COULD_NOT_COMPLETE_STATUSES = ['VENDOR_COULD_NOT_COMPLETE', 'MAINTENANCE_COULD_NOT_COMPLETE'];
// Wide enough to reliably surface 4 real occurrences even for the least-frequent
// registered cadence (annual) -- a 150-day completed-meld lookback covers roughly 5
// months of history, which in practice is the only way to catch quarterly/annual
// series that don't currently have an open instance.
const COMPLETED_LOOKBACK_DAYS = 150;

async function fetchAllMelds(sc, csrf, status, cutoffStr, dateField) {
  const out = [];
  let offset = 0;
  while (true) {
    const r = await pmGet(`/api/melds/?limit=200&offset=${offset}&status=${status}`, sc, csrf);
    if (r.status !== 200) break;
    const d = JSON.parse(r.body);
    const rows = d.results || [];
    if (!rows.length) break;
    out.push(...rows);
    if (cutoffStr && dateField) {
      // Results come back newest-first; stop paging once we're past the lookback window.
      const oldestThisPage = rows[rows.length - 1][dateField];
      if (oldestThisPage && oldestThisPage.slice(0, 10) < cutoffStr) break;
    }
    if (!d.next || rows.length < 200) break;
    offset += 200;
    await new Promise(res => setTimeout(res, 80));
  }
  return out;
}

function latestEvent(m) {
  const events = (m.managementappointment || [])
    .map(a => a.availability_segment && a.availability_segment.event)
    .filter(Boolean)
    .sort((a, b) => new Date(b.dtstart) - new Date(a.dtstart));
  return events[0] || null;
}

function occurrenceInfo(m) {
  if (m.manager_cancelled || m.tenant_canceller || CANCELED_STATUSES.includes(m.status)) {
    return { status: 'CANCELED', date: (m.manager_cancelled || m.tenant_canceller || m.updated || m.created || '').slice(0, 10) };
  }
  if (m.status === 'COMPLETED') {
    return { status: 'COMPLETED', date: (m.completion_date || '').slice(0, 10) };
  }
  if (COULD_NOT_COMPLETE_STATUSES.includes(m.status)) {
    return { status: 'COULD NOT COMPLETE', date: (m.completion_date || m.updated || '').slice(0, 10) };
  }
  const ev = latestEvent(m);
  if (ev) return { status: 'SCHEDULED', date: (ev.dtstart || '').slice(0, 10) };
  return { status: 'PENDING', date: (m.created || '').slice(0, 10) };
}

// Sort key for picking the "last 4 real occurrences" -- completed/scheduled/pending all
// resolve to a real calendar date via occurrenceInfo, so a single date-desc sort works.
function occDate(m) { return occurrenceInfo(m).date || '0000-00-00'; }

async function main() {
  const { sc, csrf } = await pmLogin();
  const todayStr = new Date().toISOString().slice(0, 10);
  const cutoffStr = new Date(Date.now() - COMPLETED_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let all = [];
  for (const s of OPEN_STATUSES) {
    all.push(...await fetchAllMelds(sc, csrf, s));
  }
  all.push(...await fetchAllMelds(sc, csrf, 'COMPLETED', cutoffStr, 'completion_date'));
  for (const s of COULD_NOT_COMPLETE_STATUSES) {
    all.push(...await fetchAllMelds(sc, csrf, s, cutoffStr, 'completion_date'));
  }
  for (const s of CANCELED_STATUSES) {
    all.push(...await fetchAllMelds(sc, csrf, s, cutoffStr, 'updated'));
  }

  const seen = new Set();
  all = all.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });

  // Client-side recurring_meld filter -- the API's recurring_meld__isnull query param is
  // silently ignored (confirmed live 2026-07-14: returns the same unfiltered result set
  // regardless of the param), so this MUST be checked here, not relied on server-side.
  const relevant = all.filter(m => m.recurring_meld && GROUNDS_REGISTRY[m.recurring_meld]);

  console.log(`Fetched ${all.length} melds total, ${relevant.length} match the Grounds registry (${Object.keys(GROUNDS_REGISTRY).length} known series).`);

  const byRecurId = {};
  relevant.forEach(m => { (byRecurId[m.recurring_meld] = byRecurId[m.recurring_meld] || []).push(m); });

  const missing = Object.keys(GROUNDS_REGISTRY).filter(rid => !byRecurId[rid]);
  if (missing.length) console.log(`No live instances found for ${missing.length} registered series (likely low-cadence, not currently due): ${missing.join(', ')}`);

  // area -> property -> employee -> [ recurring rows ]. Vendor-only and truly-unassigned
  // series are dropped entirely here (Florencia, 2026-07-14: only wants series with a real
  // in-house person confirmed live) rather than shown with a placeholder employee.
  const areaMap = {};
  let skippedNoEmployee = 0;
  for (const [ridStr, meta] of Object.entries(GROUNDS_REGISTRY)) {
    const rid = Number(ridStr);
    const instances = (byRecurId[rid] || []).slice().sort((a, b) => occDate(b).localeCompare(occDate(a)));
    const recentInstances = instances.slice(0, 4);

    // Employee = most common live in_house_servicer name across the displayed last-4
    // occurrences (not the full fetch history) so a past reassignment doesn't dilute the
    // currently-visible crew. Some series (e.g. Spokane's David + Alexander) are jointly
    // assigned on every instance -- show every name tied for the top occurrence count,
    // not just one, so a real 2-person crew doesn't silently read as a single name.
    const nameCounts = {};
    recentInstances.forEach(m => (m.in_house_servicers || []).forEach(s => {
      if (!s.agent) return;
      const n = `${s.agent.first_name} ${s.agent.last_name}`.trim();
      nameCounts[n] = (nameCounts[n] || 0) + 1;
    }));
    const maxCount = Math.max(0, ...Object.values(nameCounts));
    const topNames = Object.entries(nameCounts).filter(([, c]) => c === maxCount).map(([n]) => n);
    if (!topNames.length) { skippedNoEmployee++; continue; }
    const employee = topNames.join(' & ');

    const last4 = recentInstances.slice().reverse().map(m => {
      const info = occurrenceInfo(m);
      return { ref: m.reference_id, status: info.status, date: info.date || null };
    });

    areaMap[meta.area] = areaMap[meta.area] || {};
    areaMap[meta.area][meta.property] = areaMap[meta.area][meta.property] || {};
    areaMap[meta.area][meta.property][employee] = areaMap[meta.area][meta.property][employee] || [];
    areaMap[meta.area][meta.property][employee].push({
      recurring_id: rid,
      title: meta.title,
      cadence: meta.cadence,
      pm_url: `https://app.propertymeld.com/2975/m/2975/melds/recurring/${rid}/`,
      occurrences: last4,
    });
  }
  console.log(`Dropped ${skippedNoEmployee} registered series with no live in-house servicer found (vendor-only or currently unassigned).`);

  const cadenceRank = c => { const i = CADENCE_ORDER.indexOf(c); return i === -1 ? CADENCE_ORDER.length : i; };
  const AREA_ORDER = ['Tri-Cities', 'Spokane', 'Tacoma'];
  const areas = AREA_ORDER.filter(a => areaMap[a]).map(area => ({
    area,
    properties: Object.keys(areaMap[area]).sort().map(property => ({
      property,
      employees: Object.keys(areaMap[area][property]).sort().map(employee => ({
        employee,
        recurring: areaMap[area][property][employee].sort((a, b) => cadenceRank(a.cadence) - cadenceRank(b.cadence) || a.title.localeCompare(b.title)),
      })),
    })),
  }));

  const out = {
    generated_at: todayStr,
    source: 'Property Meld (recurring melds only, registry reconciled against Florencia\'s manual tracking sheet 2026-07-14; vendor-only/unassigned series excluded) — automated',
    areas,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'grounds.json'), JSON.stringify(out, null, 2));
  const total = areas.reduce((s, a) => s + a.properties.reduce((s2, p) => s2 + p.employees.reduce((s3, e) => s3 + e.recurring.length, 0), 0), 0);
  console.log('Wrote grounds.json —', total, 'recurring series across', areas.length, 'areas');
}

main().catch(err => { console.error(err); process.exit(1); });
