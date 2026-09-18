# @pipeworx/md-dmv

Maryland DMV MCP — monthly registered-vehicle counts and electric/plug-in hybrid adoption
by county and ZIP code, from the Maryland Motor Vehicle Administration (MVA).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `md_dmv_vehicle_registrations(county?, month?, limit?)` — registered vehicles by county
  for one month, with a genuine statewide total and each county's share of it. Answers
  "how many vehicles are registered in Montgomery County Maryland", "which Maryland county
  has the most registered vehicles", "how many cars are registered in Maryland".
- `md_dmv_ev_adoption(county?, zip?, month?, group_by?, limit?)` — battery-electric and
  plug-in hybrid registrations by county or by ZIP code for one month, with a Maryland
  total for context. Answers "how many EVs are registered in Montgomery County Maryland",
  "EV registrations in ZIP 20852", "which Maryland ZIP codes have the most EVs".

## Auth

Keyless.

## Data sources

- <https://opendata.maryland.gov/resource/db8v-9ewn.json> — MDOT MVA registered vehicles by
  county, monthly. Fields: `year_month` ("2026/06"), `county`, `vehicle_count`. 25 rows per
  month (23 counties, Baltimore City, and a `NULL` bucket for registrations the MVA could
  not assign).
- <https://opendata.maryland.gov/resource/qtcv-n3tc.json> — MDOT MVA electric and plug-in
  hybrid registrations by county, monthly. Fields: `year_month`, `fuel_category`
  ("Electric" | "Plug-In Hybrid"), `county`, `count`. ~464 rows per month.
- <https://opendata.maryland.gov/resource/tugr-unu9.json> — same, by ZIP code. Fields:
  `year_month`, `fuel_category`, `zip_code`, `count`. ~2,065 rows per month.

All three run monthly from 2020/07 to 2026/06 (latest as of 2026-07-29).

## Gotcha: the Maryland WAF rejects query *shapes*, not queries

`opendata.maryland.gov` sits behind a Cloudflare WAF that answers certain SoQL query
shapes with a "Just a moment..." interstitial — **HTTP 403 with an HTML body** — instead of
data. It is reproducible, and it is specific to this one domain: `data.ny.gov`,
`data.wa.gov` and `data.ct.gov` all accept the identical clauses without complaint. It was
first hit from a deployed Cloudflare Worker, and has since been reproduced from a laptop
too, so it is a property of the request, not of the caller's IP.

Confirmed to trip it:

| Shape | Example |
|---|---|
| any `like '%x%'` wildcard clause | `$where=upper(county) like '%MONTGOMERY%'` |
| a `$where` with two conditions joined by `AND` | `$where=year_month='2026/06' AND county='MONTGOMERY'` |
| a `$select` with two aggregate expressions | `$select=min(year_month) as mn, max(year_month) as mx` |

Confirmed to work:

| Shape | Example |
|---|---|
| a single `year_month` equality condition | `$where=year_month='2026/06'` |
| a `$select` with one aggregate | `$select=max(year_month) as mx` |

So this pack sends **exactly one condition**, pulls the whole month (at most ~2,100 rows),
and does all county/ZIP narrowing, aggregation and sorting in code. That is cheap, and it
is the difference between the pack returning data and returning an HTML challenge page.
**Do not "optimise" the filtering back onto the server.**

A side benefit: because the complete month is always in hand, `statewide_total_vehicles`
and `maryland_plug_in_vehicles` are real totals rather than sums of whatever survived
`limit`. The row-level sum is reported separately as `sum_of_returned_rows`.

## Gotcha: the same county is spelled two different ways

The registration file and the EV files disagree on punctuation for the same places:

| Place | `db8v-9ewn` (registrations) | `qtcv-n3tc` / `tugr-unu9` (EV) |
|---|---|---|
| Prince George's County | `PRINCE GEORGE'S` | `PRINCE GEORGES` |
| St. Mary's County | `ST. MARY'S` | `ST MARYS` |
| Queen Anne's County | `QUEEN ANNE'S` | `QUEEN ANNES` |

Both tools fold punctuation away before matching, so a caller can pass either spelling.

## Gotcha: the EV files carry out-of-state counties

Maryland records the registrant's county (or ZIP) of **residence**, so `qtcv-n3tc` carries
~300 non-Maryland counties with small counts — ADAMS, ALAMEDA, ALBEMARLE and so on — mixed
in with the 24 Maryland jurisdictions. Every county row is flagged `in_maryland`, and
`maryland_plug_in_vehicles` counts only the Maryland ones.

The nastiest instance: **Virginia's `PRINCE GEORGE` sits right next to Maryland's
`PRINCE GEORGES`**, and Virginia's is the exact match for the phrase "Prince George". The
county resolver therefore returns both rows (flagged) rather than silently picking the
one-vehicle Virginia county over the 17,899-vehicle Maryland one.

## Verified figures (2026/06, checked 2026-07-29)

| Query | Result |
|---|---|
| `md_dmv_vehicle_registrations{county:"Montgomery"}` | 804,525 vehicles |
| `md_dmv_vehicle_registrations{}` | 5,190,640 statewide |
| `md_dmv_ev_adoption{county:"Montgomery"}` | 36,477 Electric + 12,319 Plug-In Hybrid |
| `md_dmv_ev_adoption{zip:"20852"}` | 1,660 Electric + 566 Plug-In Hybrid |
| `md_dmv_ev_adoption{}` | 153,463 Maryland plug-in vehicles |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "md-dmv": {
      "url": "https://gateway.pipeworx.io/md-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/md-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Md Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/md_dmv_vehicle_registrations \
  -H 'Content-Type: application/json' \
  -d '{"county":"Montgomery","month":"2026/06"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/md_dmv_vehicle_registrations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
