// Refreshes the Grounds report's data: for every known Grounds recurring meld series
// (lawn/landscaping/grounds-cleaning/irrigation/pool, per area), shows the LAST 4 CALENDAR
// WEEKS (Mon-Sun, not 4 real occurrences -- a week with no instance shows "No work order",
// regardless of cadence -- Florencia, 2026-09-03) with the real status (Completed/Scheduled/
// Overdue/Canceled/Could Not Complete) and date, and the assigned employee or vendor.
//
// Recurring meld ID registry below was reconciled 2026-07-14 against Florencia's manual
// tracking sheet (https://docs.google.com/spreadsheets/d/1_BYqgShTbeD6oxpXSd5yugshLOpPCHIziZW-s0HYjJg)
// -- her sheet has the authoritative list including low-cadence (quarterly/annual) series
// that a live PM pull can miss entirely if nothing is currently due. Confirmed exclusions:
// Quarterly/safety inspections (Isaac Chavez's supervisor role, not grounds crew). Confirmed
// inclusion (2026-07-14, Florencia): Jared Miller's "Daily Pool Maintenance" at kn47/ps25/rl16.
//
// AUTO-INCLUSION (added 2026-09-03, Florencia: "si se crea una nueva work order deberia estar
// en el reporte cuando se actualiza"): a live, ACTIVE recurring meld doesn't need a manual
// registry entry to appear here anymore -- if it's run by a known GROUNDS_CREW_NAMES member
// AND its title matches GROUNDS_TITLE_RE, it's included automatically (area/property/cadence
// derived from the live PropertyMeld template). The registry above still wins when an id is
// listed there (for custom titles, vendor annotations, and historical/retired entries kept for
// continuity) -- it's just no longer the ONLY way in. A series matching only ONE of the two
// conditions (crew or title, not both) is too ambiguous to auto-include and is still just
// flagged for a human to confirm.
//
// Required env vars: PROPERTYMELD_EMAIL, PROPERTYMELD_PASSWORD

const fs = require('fs');
const path = require('path');
const https = require('https');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PM_BASE = 'https://app.propertymeld.com', PM_MGMT = '2975';
const PROPERTY_CODE_RE = /^[a-z]{1,2}\d{2,3}/i;

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
  153953: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Tree pruning', cadence: 'Annual' },
  // 153955 (Spot pressure washing) intentionally excluded per Florencia 2026-07-15 -- not a
  // series she wants tracked on this report (was Jared Miller & Austin Mulder, both instances
  // canceled; unrelated to the kn47 grounds crew scope).
  153868: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Daily Pool Maintenance', cadence: 'Daily' },
  // Found live 2026-08-26 via the unregistered-recurring flag (Chad Cariquist, Monthly) --
  // matches the "extras" Wed slots described in pm-scheduling/CLAUDE.md but wasn't in this
  // registry yet.
  153941: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Fast-Growth Trimming', cadence: 'Monthly' },
  153943: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Flower bed refresh', cadence: 'Monthly' },
  // Live PM rrule is every 4 months (not a bucket the report tracks) -- closest cadence label.
  153948: { area: 'Tri-Cities', property: 'KN47 K1', title: 'Tree limb clearance', cadence: 'Quarterly' },
  // NOTE (2026-08-26): kn47 K1 has a SECOND, likely-duplicate lighting-check recurring, id
  // 153942 (Hannah Deckard, Monthly, "Lighting checks") alongside the registered 119264
  // ("Light Check", Hannah Deckard, every-2-months). Same pattern as the h731 duplicate found
  // 2026-07-16 -- left OUT of the registry until Florencia confirms which is canonical in PM
  // (don't add both, it would double-count the row).

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

  // ---- Tacoma: TC68 (vendor-executed, but Jonas checks/verifies each one and the office
  // corroborates -- Florencia 2026-07-15: show these under Jonas, don't drop as vendor-only) ----
  178924: { area: 'Tacoma', property: 'TC68', title: 'Lawn mowing & edging', cadence: 'Weekly' },
  178925: { area: 'Tacoma', property: 'TC68', title: 'Pet waste removal', cadence: 'Weekly' },
  178932: { area: 'Tacoma', property: 'TC68', title: 'Internal Office / Clubhouse Cleaning', cadence: 'Bi-Weekly' },
  178936: { area: 'Tacoma', property: 'TC68', title: 'Litter pickup', cadence: 'Bi-Weekly' },
  // 179091 confirmed NOT a duplicate (Florencia, 2026-08-26) -- both run on purpose.
  179091: { area: 'Tacoma', property: 'TC68', title: 'Litter pickup (2)', cadence: 'Weekly' },
  178939: { area: 'Tacoma', property: 'TC68', title: 'Irrigation zone adjustments', cadence: 'Quarterly' },
  178941: { area: 'Tacoma', property: 'TC68', title: 'Bed weeding (manual & chemical)', cadence: 'Monthly' },
  178945: { area: 'Tacoma', property: 'TC68', title: 'Lighting checks', cadence: 'Monthly' },
  178947: { area: 'Tacoma', property: 'TC68', title: 'Fertilization (spring/fall)', cadence: 'Bi-Annual' },
  178950: { area: 'Tacoma', property: 'TC68', title: 'Irrigation startup', cadence: 'Annual' },
  178953: { area: 'Tacoma', property: 'TC68', title: 'Irrigation winterization', cadence: 'Annual' },
  178955: { area: 'Tacoma', property: 'TC68', title: 'Tree pruning', cadence: 'Annual' },
  178958: { area: 'Tacoma', property: 'TC68', title: 'Pressure washing', cadence: 'Annual' },
  166937: { area: 'Tacoma', property: 'TC68', title: 'Bi-Weekly Grounds Inspections', cadence: 'Bi-Weekly' },

  // ---- Tacoma: TC34 (in-house, Jonas -- found live 2026-08-21, added here 2026-08-26) ----
  186000: { area: 'Tacoma', property: 'TC34', title: 'Lawn service / Landscaping', cadence: 'Weekly' },

  // ---- Spokane (David Sanchez + Alexander Overall, shared across the whole portfolio) ----
  // C702 has THREE "Dumpster Pick Up" recurring melds on record. 186065 was live on the lawn
  // scheduler's TEMPLATE since 2026-08-11 (Friday) but never added to this registry -- its PM
  // recurring rule is now gone (404), retired 2026-09-02, kept here only for history. 187342
  // (created 2026-08-26) and 188298 (created 2026-09-02) are the current pair -- Thursday and
  // Monday respectively -- split so dumpster pickup happens twice a week instead of once.
  186065: { area: 'Spokane', property: 'C702', title: 'Dumpster Pick Up', cadence: 'Weekly' },
  187342: { area: 'Spokane', property: 'C702', title: 'Dumpster Pick Up (Thu)', cadence: 'Weekly' },
  188298: { area: 'Spokane', property: 'C702', title: 'Dumpster Pick Up (Mon)', cadence: 'Weekly' },
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
  162926: { area: 'Spokane', property: 'O155-ELM', title: 'Lawn service', cadence: 'Weekly' },
  162927: { area: 'Spokane', property: 'O155-OAK', title: 'Lawn service', cadence: 'Weekly' },
  163904: { area: 'Spokane', property: 'H731', title: 'Lawn service', cadence: 'Bi-Weekly' },
  // 179920 removed 2026-07-16 -- was a duplicate recurrence firing every 7 days on the
  // same property/slot as 163904 (should only be bi-weekly). Florencia deleted it in PM.
  164381: { area: 'Spokane', property: 'K308', title: 'Lawn service', cadence: 'Weekly' },
  // 166878 (K104-LEFEVRE "Weekly mowing") and 167333 (K104-BROWER EVEN "Lawn service") are
  // both is_active:false in PM (confirmed 2026-08-21) -- removed. Replaced by 186951, the
  // recurrence Florencia recreated 2026-08-20 after her manager deleted the old one.
  186951: { area: 'Spokane', property: 'K104-LEFEVRE', title: 'Weekly Lawn care', cadence: 'Weekly' },
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

// Names of the people who actually do grounds/lawn work today, across all 3 areas. Combined
// with GROUNDS_TITLE_RE below, this is what decides auto-inclusion (see the file header) --
// keep it current or a departed/replaced tech's new work silently stops appearing. Update
// this list whenever the crew changes (see pm-scheduling/CLAUDE.md for the current roster).
//
// Chad Cariquist's kn47 K1/rl16/rl21 recurring templates were found showing "Ellias Angulo"
// live (2026-09-02/03) -- Florencia does NOT recognize this name and does not know who he is
// (2026-09-03: "no se quien es"). NOT added here. Those 11 templates + 153946 "Shrub Pruning"
// were unassigned (no maintenance provider) the same day pending her identifying the real
// replacement -- do not re-add "Ellias Angulo" without her explicit confirmation of who he is.
const GROUNDS_CREW_NAMES = ['Chad Cariquist', 'Hannah Deckard', 'David Sanchez', 'Alexander Overall', 'Jonas Hoard', 'Jared Miller'];

// Explicitly excluded even though they'd otherwise auto-match crew+title -- pending a human
// decision, not something the auto-detect logic should decide on its own.
const EXCLUDE_IDS = new Set([
  153942, // "Lighting checks" (Hannah, kn47 K1) -- likely duplicate of registered 119264
          // "Light Check"; Florencia hasn't confirmed which is canonical yet (2026-09-02/03).
]);

// Title keyword gate for the flag below -- crew name ALONE isn't enough, because Jared Miller
// does both grounds (pool) and plain repairs (carpet cleaning, door/laundry lock batteries,
// hydrojetting) at the same properties. Confirmed live 2026-08-26: without this, his repair
// recurring series flooded the flag list (10 of 16 hits were his). Vocabulary drawn from the
// titles already in GROUNDS_REGISTRY above.
const GROUNDS_TITLE_RE = /lawn|mow|landscap|litter|dumpster|irrigation|fertiliz|weed|prun|pressure wash|pool|grounds|fast-growth|tree|flower bed|clubhouse|fitness center|spray|curb|rock bed|safety inspection|light/i;

async function fetchAllMelds(sc, csrf, status, cutoffStr, dateField) {
  const out = [];
  let offset = 0;
  while (true) {
    const r = await pmGet(`/api/melds/?limit=200&offset=${offset}&status=${status}`, sc, csrf);
    // Fail loud instead of silently truncating this status bucket -- a transient PM
    // error here used to just stop paging with no log/throw, so a whole page of melds
    // (e.g. all PENDING_ASSIGNMENT past page 2) could go missing with zero trace.
    if (r.status !== 200) throw new Error(`PropertyMeld melds fetch failed: status=${status} offset=${offset} http=${r.status}`);
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

// Real status only -- Canceled/Could Not Complete/Completed/Scheduled/Overdue (Florencia,
// 2026-09-03: "lo que se muestra tiene que ser el estado real... y la fecha"). No separate
// "Pending" bucket: an open meld with no appointment yet is SCHEDULED if its reference date
// (creation date, since that's all there is) hasn't passed, else OVERDUE -- same rule as an
// open meld that HAS an appointment date in the past.
function occurrenceInfo(m, todayStr) {
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
  const refDate = (ev ? ev.dtstart : m.created || '').slice(0, 10);
  if (refDate && refDate < todayStr) return { status: 'OVERDUE', date: refDate };
  return { status: 'SCHEDULED', date: refDate };
}

// Calendar-week helpers (Florencia, 2026-09-03: "las fechas del reporte tienen que ser
// semanales, no por cadencia") -- weeks are Mon-Sun, ending with the current week, regardless
// of how often any given series actually fires.
const WEEK_COUNT = 4;
function ymd(d) { return d.toISOString().slice(0, 10); }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}
function lastNWeeks(todayStr, n) {
  const curMon = mondayOf(todayStr);
  const weeks = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(curMon); start.setUTCDate(start.getUTCDate() - i * 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    weeks.push({ start: ymd(start), end: ymd(end) });
  }
  return weeks;
}

function inferArea(propertyName) {
  const p = (propertyName || '').toLowerCase();
  if (/^(kn|rl|ps)\d/.test(p)) return 'Tri-Cities';
  if (/^tc\d/.test(p)) return 'Tacoma';
  return 'Spokane';
}

function normalizePropertyDisplay(propertyName) {
  if (!propertyName) return '?';
  const m = propertyName.match(PROPERTY_CODE_RE);
  if (!m) return propertyName;
  return propertyName.slice(0, m[0].length).toUpperCase() + propertyName.slice(m[0].length);
}

function cadenceFromRrule(rrule) {
  if (!rrule) return 'No cadence set';
  const n = rrule.interval || 1;
  if (rrule.freq === 'DAILY') return n === 1 ? 'Daily' : n === 3 ? 'Every 3 days' : n === 7 ? 'Weekly' : n === 14 ? 'Bi-Weekly' : `Every ${n} days`;
  if (rrule.freq === 'WEEKLY') return n === 1 ? 'Weekly' : n === 2 ? 'Bi-Weekly' : `Every ${n} weeks`;
  if (rrule.freq === 'MONTHLY') return n === 1 ? 'Monthly' : n === 3 ? 'Quarterly' : n === 6 ? 'Bi-Annual' : `Every ${n} months`;
  if (rrule.freq === 'YEARLY') return n === 1 ? 'Annual' : `Every ${n} years`;
  return 'No cadence set';
}

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

  // Auto-include a live, ACTIVE recurring meld run by a known grounds crew member with a
  // grounds-sounding title even if it's never been added to GROUNDS_REGISTRY -- this is what
  // makes a brand-new work order show up on the next report update instead of needing someone
  // to remember to register it (Florencia, 2026-09-03). A series matching only ONE of the two
  // conditions is too ambiguous to auto-include and is still just flagged for a human to check.
  const unregisteredIds = [...new Set(all.filter(m => m.recurring_meld && !GROUNDS_REGISTRY[m.recurring_meld]).map(m => m.recurring_meld))]
    .filter(rid => !EXCLUDE_IDS.has(rid));
  const flagged = [];
  const workingRegistry = { ...GROUNDS_REGISTRY };
  for (const rid of unregisteredIds) {
    const tr = await pmGet(`/api/melds/recurring/${rid}/`, sc, csrf);
    if (tr.status !== 200) continue;
    const template = JSON.parse(tr.body);
    if (!template.is_active) continue;
    const names = (template.maintenance || []).map(a => a.name).filter(Boolean);
    const crewMatch = names.some(n => GROUNDS_CREW_NAMES.includes(n));
    const titleMatch = GROUNDS_TITLE_RE.test(template.brief_description || '');
    if (crewMatch && titleMatch) {
      workingRegistry[rid] = {}; // area/property/title/cadence derived live in the main loop below
    } else if (crewMatch || titleMatch) {
      flagged.push({
        recurring_id: rid,
        title: template.brief_description || '',
        property: (template.prop && template.prop.property_name) || null,
        employee: names.join(' & '),
      });
    }
    await new Promise(res => setTimeout(res, 80));
  }
  if (flagged.length) console.log(`⚠ ${flagged.length} recurring series partially match grounds crew/title, needs a human look: ${JSON.stringify(flagged)}`);

  // Client-side recurring_meld filter -- the API's recurring_meld__isnull query param is
  // silently ignored (confirmed live 2026-07-14: returns the same unfiltered result set
  // regardless of the param), so this MUST be checked here, not relied on server-side.
  const relevant = all.filter(m => m.recurring_meld && workingRegistry[m.recurring_meld]);

  console.log(`Fetched ${all.length} melds total, ${relevant.length} match ${Object.keys(workingRegistry).length} Grounds series (${Object.keys(GROUNDS_REGISTRY).length} registered + ${Object.keys(workingRegistry).length - Object.keys(GROUNDS_REGISTRY).length} auto-detected).`);

  const byRecurId = {};
  relevant.forEach(m => { (byRecurId[m.recurring_meld] = byRecurId[m.recurring_meld] || []).push(m); });

  const missing = Object.keys(GROUNDS_REGISTRY).filter(rid => !byRecurId[rid]);
  if (missing.length) console.log(`No live occurrence history for ${missing.length} registered series (likely low-cadence, not currently due): ${missing.join(', ')}`);

  const weeks = lastNWeeks(todayStr, WEEK_COUNT);

  // area -> property -> employee -> [ recurring rows ]. Employee is read from each series'
  // live recurring-meld template (current assignment in PM right now), NOT derived from past
  // occurrences -- occurrence-level servicer data is locked once a meld closes (PM: "Closed
  // Status Melds can not be edited"), so a stale/wrong historical assignment could never be
  // corrected in the report even after Florencia fixed it in PM (found 2026-07-15 via kn47
  // Tree Pruning still showing Octavio after being reassigned to Rey at the template level).
  // Vendor-only and truly-unassigned series are dropped entirely (Florencia, 2026-07-14: only
  // wants series with a real in-house person confirmed live) rather than shown with a
  // placeholder employee.
  const areaMap = {};
  let skippedNoEmployee = 0;
  for (const [ridStr, meta] of Object.entries(workingRegistry)) {
    const rid = Number(ridStr);

    // Registry `vendor` annotations are reconciled against Florencia's manual tracking sheet
    // and take priority over PM's live template -- PM's recurring-meld template lists a
    // default in-house agent (e.g. Jonas Hoard) on several TC68 series even though the actual
    // work is vendor-run (confirmed 2026-07-15: PM has no maintenance_vendor field populated
    // for these, so there's no live signal to detect vendor-run status other than her sheet).
    if (meta.vendor) { skippedNoEmployee++; continue; }

    const instances = byRecurId[rid] || [];
    const infoList = instances.map(m => ({ m, info: occurrenceInfo(m, todayStr) }));

    // One cell per calendar week -- the occurrence (if any) whose real date falls in that week,
    // else null ("No work order"). If a week somehow has more than one instance (a reschedule
    // producing a second record), the most recently updated one wins.
    const weekCells = weeks.map(w => {
      const matches = infoList.filter(x => x.info.date && x.info.date >= w.start && x.info.date <= w.end);
      if (!matches.length) return null;
      matches.sort((a, b) => (b.m.updated || '').localeCompare(a.m.updated || ''));
      return { ref: matches[0].m.reference_id, status: matches[0].info.status, date: matches[0].info.date || null };
    });

    const tr = await pmGet(`/api/melds/recurring/${rid}/`, sc, csrf);
    if (tr.status !== 200) { console.log(`Could not fetch recurring template ${rid} (HTTP ${tr.status}) -- skipping.`); skippedNoEmployee++; continue; }
    const template = JSON.parse(tr.body);
    const names = (template.maintenance || []).map(a => a.name).filter(Boolean);
    if (!names.length) { skippedNoEmployee++; continue; }
    const employee = names.join(' & ');
    await new Promise(res => setTimeout(res, 80));

    // Registry meta always wins when present; auto-detected entries (meta === {}) derive
    // everything live from the PropertyMeld template instead.
    const livePropName = template.prop && template.prop.property_name;
    const area = meta.area || inferArea(livePropName);
    const property = meta.property || normalizePropertyDisplay(livePropName);
    const title = meta.title || (template.brief_description || '').trim();
    const cadence = meta.cadence || cadenceFromRrule(template.event && template.event.rrule);

    areaMap[area] = areaMap[area] || {};
    areaMap[area][property] = areaMap[area][property] || {};
    areaMap[area][property][employee] = areaMap[area][property][employee] || [];
    areaMap[area][property][employee].push({
      recurring_id: rid,
      title,
      cadence,
      pm_url: `https://app.propertymeld.com/2975/m/2975/melds/recurring/${rid}/`,
      occurrences: weekCells,
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
    weeks: weeks.map(w => w.start),
    areas,
    flagged,
  };

  const outPath = path.join(DATA_DIR, 'grounds.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  const total = areas.reduce((s, a) => s + a.properties.reduce((s2, p) => s2 + p.employees.reduce((s3, e) => s3 + e.recurring.length, 0), 0), 0);
  console.log('Wrote grounds.json —', total, 'recurring series across', areas.length, 'areas');
}

main().catch(err => { console.error(err); process.exit(1); });
