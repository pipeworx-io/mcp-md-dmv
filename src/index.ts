interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * Maryland DMV MCP — monthly registered-vehicle counts and electric/plug-in hybrid
 * adoption by county and ZIP code, from the Maryland Motor Vehicle Administration (MVA).
 * Keyless.
 *
 * One pack per state agency: Maryland's grain (a county-by-month and ZIP-by-month count
 * series running from 2020 to last month) has nothing in common with California's annual
 * ZIP snapshot or Pennsylvania's quarter-columns-per-county layer, so Maryland gets its
 * own tools with its own real arguments — `month` in YYYY/MM, and county names spelled
 * the way the MVA spells them.
 *
 * Sources (verified live 2026-07-29, latest month 2026/06):
 *   opendata.maryland.gov Socrata
 *     db8v-9ewn  MDOT MVA registered vehicles by county, monthly (25 rows/month)
 *     qtcv-n3tc  MDOT MVA electric + plug-in hybrid registrations by county, monthly
 *     tugr-unu9  MDOT MVA electric + plug-in hybrid registrations by ZIP code, monthly
 *
 * ── The Maryland WAF, and why every query here looks so plain ──────────────────────
 *
 * opendata.maryland.gov sits behind a Cloudflare WAF that answers certain SoQL query
 * *shapes* with a "Just a moment..." interstitial (HTTP 403, HTML body) instead of data.
 * This is reproducible, and specific to this one domain — data.ny.gov, data.wa.gov and
 * data.ct.gov all accept the identical clauses without complaint. Confirmed to trip it:
 *
 *   • any `like '%x%'` wildcard clause
 *   • a `$where` carrying two conditions joined by AND
 *   • a `$select` carrying two aggregate expressions (e.g. min(x) and max(x) together)
 *
 * The shape that reliably gets through is a single `year_month='YYYY/MM'` condition and
 * nothing else. So every fetch below sends exactly that, pulls the whole month, and does
 * all county/ZIP narrowing, aggregation and sorting in code. A month is at most ~2,100
 * rows, so this is cheap — and it is the difference between the pack working from a
 * deployed Worker and returning an HTML challenge page. Do not "optimise" it back into
 * server-side filtering.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be
 * answered comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-md-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'opendata.maryland.gov';

const REGISTRATIONS = 'db8v-9ewn';
const EV_BY_COUNTY = 'qtcv-n3tc';
const EV_BY_ZIP = 'tugr-unu9';

const SOURCE_LABEL: Record<string, string> = {
  [REGISTRATIONS]: `opendata.maryland.gov — MDOT MVA Vehicle Registrations by County (${REGISTRATIONS})`,
  [EV_BY_COUNTY]: `opendata.maryland.gov — MDOT MVA Electric and Plug-In Hybrid Registrations by County (${EV_BY_COUNTY})`,
  [EV_BY_ZIP]: `opendata.maryland.gov — MDOT MVA Electric and Plug-In Hybrid Registrations by ZIP Code (${EV_BY_ZIP})`,
};

/**
 * Maryland's 23 counties plus Baltimore City, normalised. The EV county file records the
 * registrant's county of *residence*, so it also carries ~300 out-of-state counties with
 * small counts (ADAMS, ALAMEDA, ALBEMARLE...). This set is what separates the two.
 */
const MD_JURISDICTIONS = new Set([
  'ALLEGANY', 'ANNE ARUNDEL', 'BALTIMORE', 'BALTIMORE CITY', 'CALVERT', 'CAROLINE',
  'CARROLL', 'CECIL', 'CHARLES', 'DORCHESTER', 'FREDERICK', 'GARRETT', 'HARFORD',
  'HOWARD', 'KENT', 'MONTGOMERY', 'PRINCE GEORGES', 'QUEEN ANNES', 'SOMERSET',
  'ST MARYS', 'TALBOT', 'WASHINGTON', 'WICOMICO', 'WORCESTER',
]);

/** Exact `fuel_category` labels as published. */
const ELECTRIC = 'Electric';
const PLUG_IN_HYBRID = 'Plug-In Hybrid';

/**
 * Fold away the punctuation the two Maryland datasets disagree on. The registration file
 * spells it PRINCE GEORGE'S and ST. MARY'S; the EV files spell the same places PRINCE
 * GEORGES and ST MARYS. Normalising both sides means a caller can pass either.
 */
function normCounty(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMaryland(county: unknown): boolean {
  return MD_JURISDICTIONS.has(normCounty(county));
}

/**
 * Resolve a caller's county string against the names actually present this month.
 *
 * An exact (punctuation-folded) match wins, but Maryland's EV file also contains
 * Virginia's PRINCE GEORGE right next to Maryland's PRINCE GEORGES, and Virginia's is the
 * exact match for the phrase "Prince George". So Maryland jurisdictions whose name merely
 * contains the query are added alongside, and every row is flagged `in_maryland` — the
 * caller sees both and can tell them apart, rather than silently getting the wrong one.
 */
function matchCounties<T>(rows: T[], query: string, nameOf: (row: T) => unknown): T[] {
  const q = normCounty(query);
  if (!q) return rows;
  const out: T[] = [];
  const seen = new Set<T>();
  for (const r of rows) {
    if (normCounty(nameOf(r)) === q) { out.push(r); seen.add(r); }
  }
  for (const r of rows) {
    if (seen.has(r)) continue;
    const n = normCounty(nameOf(r));
    if (n.includes(q) && MD_JURISDICTIONS.has(n)) out.push(r);
  }
  return out;
}

/** Latest published month for a dataset, as YYYY/MM. A single max() is WAF-safe. */
async function latestMonth(resource: string): Promise<string | null> {
  return soqlMax(DOMAIN, resource, 'year_month', { userAgent: UA });
}

/**
 * One month of a Maryland dataset, whole. The single `year_month` condition is the only
 * shape the WAF reliably passes — see the header. `limit` is generous on purpose: the
 * registration file is 25 rows/month, the EV county file ~464, the EV ZIP file ~2,065.
 */
async function monthRows(resource: string, month: string, limit: number): Promise<Array<Record<string, string>>> {
  return soqlRows<Record<string, string>>(
    DOMAIN,
    resource,
    { where: `year_month='${soqlEscape(month)}'`, limit },
    { userAgent: UA },
  );
}

function badMonth(month: string, resource: string, latest: string | null): Record<string, unknown> {
  return govNotFound(
    'month_unavailable',
    `Maryland publishes this series monthly from 2020/07 to ${latest ?? '2026/06'}. Retry with month="${latest ?? '2026/06'}" in YYYY/MM form.`,
    { requested_month: month, latest_month: latest, dataset: resource },
  );
}

const MONTH_RE = /^\d{4}\/\d{2}$/;

const tools: McpToolExport['tools'] = [
  {
    name: 'md_dmv_vehicle_registrations',
    description:
      'Count vehicles registered in Maryland by county for a given month, from Maryland Motor Vehicle Administration (MVA) data published monthly since 2020. Returns each county\'s registered-vehicle count plus the genuine statewide total for that month and each county\'s share of it, so it answers "how many vehicles are registered in Montgomery County Maryland", "which Maryland county has the most registered vehicles", "how many cars are registered in Maryland", and month-over-month trend questions via the `month` argument. Counts the whole registered fleet of every fuel type; for the electric and plug-in hybrid slice of it use md_dmv_ev_adoption.',
    inputSchema: {
      type: 'object',
      properties: {
        county: {
          type: 'string',
          description: 'Maryland county or Baltimore City, e.g. "Montgomery", "Prince George\'s", "Baltimore City". Apostrophes and periods are optional.',
        },
        month: {
          type: 'string',
          description: 'Month as YYYY/MM, e.g. "2026/06". Defaults to the most recent month Maryland has published. The series starts at 2020/07.',
        },
        limit: { type: ['number', 'string'], description: 'Max counties to return (default 30, max 200). Maryland publishes 25 rows per month, so the default returns them all.' },
      },
    },
  },
  {
    name: 'md_dmv_ev_adoption',
    description:
      'Measure electric-vehicle adoption in Maryland from Maryland MVA registration counts: how many battery-electric and plug-in hybrid vehicles are registered in a county or a ZIP code each month, split by fuel category, with a statewide Maryland total for context. Answers "how many EVs are registered in Montgomery County Maryland", "EV registrations in ZIP 20852", "which Maryland county has the most electric vehicles", "which Maryland ZIP codes have the most EVs", and EV growth over time via the `month` argument (monthly since 2020). Pass `zip` or group_by="zip" for the ZIP-level file, otherwise results come back by county. For Maryland\'s whole registered fleet across every fuel type use md_dmv_vehicle_registrations.',
    inputSchema: {
      type: 'object',
      properties: {
        county: {
          type: 'string',
          description: 'Maryland county or Baltimore City, e.g. "Montgomery", "Prince George\'s". Apostrophes are optional. Results are flagged in_maryland because this file also carries out-of-state counties of residence.',
        },
        zip: {
          type: 'string',
          description: 'Five-digit ZIP code, e.g. "20852". Supplying this reads the ZIP-level file instead of the county file.',
        },
        month: {
          type: 'string',
          description: 'Month as YYYY/MM, e.g. "2026/06". Defaults to the most recent month Maryland has published. The series starts at 2020/07.',
        },
        group_by: {
          type: 'string',
          description: 'Breakdown dimension: "county" (default) or "zip". Passing `zip` implies group_by="zip".',
        },
        limit: { type: ['number', 'string'], description: 'Max counties or ZIP codes to return (default 30, max 500).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

async function vehicleRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const requested = govString(args, 'month');
  if (requested && !MONTH_RE.test(requested)) {
    return badMonth(requested, REGISTRATIONS, await latestMonth(REGISTRATIONS));
  }
  const latest = requested ? null : await latestMonth(REGISTRATIONS);
  const month = requested ?? latest ?? '2026/06';

  const raw = await monthRows(REGISTRATIONS, month, 2000);
  if (!raw.length) {
    return badMonth(month, REGISTRATIONS, latest ?? (await latestMonth(REGISTRATIONS)));
  }

  // The whole month is in hand, so the statewide figure is a real total rather than a
  // sum of whatever survived `limit`.
  const all = raw
    .map((r) => ({ county: String(r.county ?? ''), vehicles: govNumber(r.vehicle_count) }))
    .filter((r) => r.county);
  const statewide = all.reduce((a, r) => a + (r.vehicles ?? 0), 0);

  const county = govString(args, 'county');
  let rows = county ? matchCounties(all, county, (r) => r.county) : all;
  rows = rows.slice().sort((a, b) => (b.vehicles ?? 0) - (a.vehicles ?? 0));
  if (!rows.length) {
    return govNotFound(
      'no_matching_county',
      `No Maryland county matched "${county}" in ${month}. Maryland publishes 24 jurisdictions — try county="Montgomery", county="Prince George's", county="Baltimore" (the county) or county="Baltimore City", or omit the county argument to get all of them.`,
      { month, requested_county: county, available_counties: all.map((r) => r.county).sort() },
    );
  }

  const limit = govLimit(args.limit, 30, 200);
  const shown = rows.slice(0, limit);
  const sum = shown.reduce((a, r) => a + (r.vehicles ?? 0), 0);
  return {
    state: 'MD',
    grain: `registered vehicles by county for the month of ${month}`,
    as_of: month,
    source: SOURCE_LABEL[REGISTRATIONS],
    month,
    statewide_total_vehicles: statewide,
    county_count: rows.length,
    sum_of_returned_rows: sum,
    truncated: rows.length > limit,
    rows: shown.map((r) => ({
      county: r.county,
      vehicles: r.vehicles,
      share_of_state_pct: statewide && r.vehicles !== null ? Math.round((r.vehicles / statewide) * 1000) / 10 : null,
    })),
    note:
      'statewide_total_vehicles is the sum of every county Maryland published for this month, so it is a real state total; sum_of_returned_rows only covers the rows above. '
      + "This file spells the county PRINCE GEORGE'S with an apostrophe, while the EV files behind md_dmv_ev_adoption spell the same place PRINCE GEORGES without one. "
      + 'A "NULL" row holds registrations the MVA could not assign to a county.',
  };
}

interface EvArea {
  area: string;
  electric: number;
  plug_in_hybrid: number;
  plug_in_total: number;
}

async function evAdoption(args: Record<string, unknown>): Promise<unknown> {
  const zip = govString(args, 'zip');
  const groupBy = (govString(args, 'group_by') ?? (zip ? 'zip' : 'county')).toLowerCase();
  if (groupBy !== 'zip' && groupBy !== 'county') {
    return govNotFound('unsupported_group_by', 'Maryland EV data supports group_by of "county" or "zip".', {
      supported_group_by: ['county', 'zip'],
      requested_group_by: groupBy,
    });
  }
  const byZip = groupBy === 'zip';
  const resource = byZip ? EV_BY_ZIP : EV_BY_COUNTY;
  const keyField = byZip ? 'zip_code' : 'county';

  const requested = govString(args, 'month');
  if (requested && !MONTH_RE.test(requested)) {
    return badMonth(requested, resource, await latestMonth(resource));
  }
  const latest = requested ? null : await latestMonth(resource);
  const month = requested ?? latest ?? '2026/06';

  const raw = await monthRows(resource, month, 4000);
  if (!raw.length) {
    return badMonth(month, resource, latest ?? (await latestMonth(resource)));
  }

  // Published as one row per (area, fuel_category); pivot so a caller gets both numbers
  // and their sum on a single row per place.
  const byArea = new Map<string, EvArea>();
  for (const r of raw) {
    const area = String(r[keyField] ?? '').trim();
    if (!area) continue;
    let entry = byArea.get(area);
    if (!entry) { entry = { area, electric: 0, plug_in_hybrid: 0, plug_in_total: 0 }; byArea.set(area, entry); }
    const n = govNumber(r.count) ?? 0;
    if (r.fuel_category === ELECTRIC) entry.electric += n;
    else if (r.fuel_category === PLUG_IN_HYBRID) entry.plug_in_hybrid += n;
    entry.plug_in_total += n;
  }
  const all = [...byArea.values()];

  // Computed from the complete month, so these are real Maryland totals whatever `limit` does.
  const mdAreas = byZip ? all : all.filter((a) => isMaryland(a.area));
  const mdTotals = mdAreas.reduce(
    (acc, a) => {
      acc.electric += a.electric; acc.plug_in_hybrid += a.plug_in_hybrid; acc.plug_in_total += a.plug_in_total;
      return acc;
    },
    { electric: 0, plug_in_hybrid: 0, plug_in_total: 0 },
  );

  let rows = all;
  if (byZip && zip) {
    rows = all.filter((a) => a.area === zip);
    if (!rows.length) {
      return govNotFound(
        'no_matching_zip',
        `No Maryland EV registrations recorded for ZIP ${zip} in ${month}. Maryland ZIP codes start 20 or 21 — try zip="20852", or omit the zip argument to rank every ZIP code.`,
        { month, requested_zip: zip, zip_count: all.length },
      );
    }
  }
  const county = govString(args, 'county');
  if (!byZip && county) {
    rows = matchCounties(all, county, (a) => a.area);
    if (!rows.length) {
      return govNotFound(
        'no_matching_county',
        `No Maryland EV registrations matched county "${county}" in ${month}. This file omits the apostrophe, so Prince George's is spelled PRINCE GEORGES here; try county="Montgomery", or omit the county argument to rank every county.`,
        { month, requested_county: county, maryland_counties: [...MD_JURISDICTIONS].sort() },
      );
    }
  }

  rows = rows.slice().sort((a, b) => b.plug_in_total - a.plug_in_total);
  const limit = govLimit(args.limit, 30, 500);
  const shown = rows.slice(0, limit);
  const sum = shown.reduce((a, r) => a + r.plug_in_total, 0);

  return {
    state: 'MD',
    grain: `registered battery-electric and plug-in hybrid vehicles by ${byZip ? 'ZIP code' : 'county'} for the month of ${month}`,
    as_of: month,
    source: SOURCE_LABEL[resource],
    month,
    maryland_plug_in_vehicles: mdTotals.plug_in_total,
    maryland_electric_vehicles: mdTotals.electric,
    maryland_plug_in_hybrid_vehicles: mdTotals.plug_in_hybrid,
    [byZip ? 'zip_count' : 'county_count']: rows.length,
    sum_of_returned_rows: sum,
    truncated: rows.length > limit,
    rows: shown.map((r) => ({
      [byZip ? 'zip' : 'county']: r.area,
      electric: r.electric,
      plug_in_hybrid: r.plug_in_hybrid,
      plug_in_vehicles: r.plug_in_total,
      ...(byZip ? {} : { in_maryland: isMaryland(r.area) }),
    })),
    note: byZip
      ? 'plug_in_vehicles = electric + plug_in_hybrid; conventional hybrids are absent from this file. Maryland records the registrant\'s ZIP of residence, so a handful of out-of-state ZIP codes appear with small counts; Maryland\'s own ZIP codes start 20 or 21. maryland_plug_in_vehicles sums every ZIP code in the file.'
      : 'plug_in_vehicles = electric + plug_in_hybrid; conventional hybrids are absent from this file. Maryland records the registrant\'s county of residence, so ~300 out-of-state counties appear with small counts — in_maryland marks the 24 Maryland jurisdictions, and maryland_plug_in_vehicles counts only those. '
        + "This file spells the county PRINCE GEORGES without an apostrophe, while md_dmv_vehicle_registrations spells the same place PRINCE GEORGE'S with one; Virginia's PRINCE GEORGE also appears here with a handful of vehicles.",
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'md_dmv_vehicle_registrations': return await vehicleRegistrations(args);
      case 'md_dmv_ev_adoption': return await evAdoption(args);
      default:
        return govNotFound('unknown_tool', `md-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The WAF interstitial is the failure worth naming: it arrives as a 403 with an HTML
    // body, which otherwise reads to a caller as a bug on our side.
    const challenged = /html challenge|just a moment|403/i.test(message);
    return {
      error: `md-dmv/${name}: ${message}`,
      hint: challenged
        ? 'opendata.maryland.gov served a Cloudflare challenge instead of data. Retry once — the query shape this pack sends is the one Maryland accepts, and the block is usually transient.'
        : /timeout|abort/i.test(message)
          ? 'opendata.maryland.gov timed out. Retry once; a single month is a small fetch, so a stall is upstream load rather than the size of the request.'
          : 'opendata.maryland.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new four-by-four id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
