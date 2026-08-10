# ANA Geo

**Agent-Native GIS** — a family of self-hosted map applications you operate by **watching and talking**, built on [ANA (Agent-Native Agent)](https://github.com/tykimos/agent-native-agent).

The agent is not a chatbot bolted onto a GIS. It lives inside the runtime: it reads the map state, runs the analysis, and — when you ask for something the app can't do — **proposes a code change and evolves the app while you're using it**.

> **Use = Build.**

## The progression

Seven independently runnable apps, each answering a harder geographic question than the last:

| App | Port | Question | Capability |
|---|---|---|---|
| [`apps/ana-geo-map`](apps/ana-geo-map) | 8801 | Where is it? | Map / vector visualization |
| [`apps/ana-geo-explorer`](apps/ana-geo-explorer) | 8802 | What is there? | OpenStreetMap / Overpass discovery |
| [`apps/ana-geo-search`](apps/ana-geo-search) | 8803 | What satisfies these spatial conditions? | Turf.js spatial queries |
| [`apps/ana-geo-site`](apps/ana-geo-site) | 8804 | Which candidate is best? | Multi-criteria decision analysis |
| [`apps/ana-geo-route`](apps/ana-geo-route) | 8805 | How are places connected? | OSMnx / NetworkX routing (first Python worker) |
| [`apps/ana-geo-satellite`](apps/ana-geo-satellite) | 8806 | What did this place look like at a given time? | STAC / Sentinel-2 discovery |
| [`apps/ana-geo-satellite-change-detection`](apps/ana-geo-satellite-change-detection) | 8807 | What changed over time? | NDVI-difference raster analysis |

## Run any app

```bash
cd apps/ana-geo-map
node server.js       # dashboard → http://localhost:8801
node relay.js        # inbound relay (separate process) — pushes chat to the ANA session
```

Requires **Node.js >= 20 LTS**. Zero npm dependencies — Leaflet/Turf are vendored per app. The two Python apps (`route`, `change-detection`) additionally need Python >= 3.10 with `pip install -r requirements.txt`.

To act as ANA, run a coding agent (e.g. Claude Code) in the app directory: it receives user chat via the relay, edits `state.json` and the app code, and replies through `POST /api/agent`.

## Shared contracts

Every app implements the same runtime contracts (see `PRD.md` §8):

- **State sync** — a server-owned monotonic `stateVersion` + ~2.5 s polling keeps every device convergent; feature bodies live behind `/api/results/<id>` references, never inlined in state.
- **Converse wiring** — dashboard chat → server inbox → relay → ANA session; ANA always answers via the dashboard API.
- **External data proxy** — the browser never calls third-party APIs directly; `server.js` proxies against a per-app host allowlist and forwards `Range` headers.
- **Python worker** — where Python is needed, `server.js` spawns `python3 tools/worker.py` with a JSON stdin/stdout envelope.

All external data is open: OpenStreetMap, Overpass API, Earth Search STAC (Sentinel-2 L2A). No API keys.

## Documents

- [`PRD.md`](PRD.md) — product requirements (v1.2)
- [`PRD-REVIEW.md`](PRD-REVIEW.md) — multi-agent review report (3 rounds: FAIL → CONDITIONAL PASS, findings tracked per round)

## Demo scenario (Daejeon, Republic of Korea)

```text
map        "Move to Daejeon."
explorer   "Find universities and cafes."
search     "Find cafes within 2 km of a university."
site       "Rank candidate locations using university proximity, roads, and residential separation."
route      "Find the fastest route from this candidate to the nearest major road or station."
satellite  "Find a low-cloud Sentinel-2 image for this area."
change     "Compare it with an image from six months earlier."
```

## License

See the base project: [agent-native-agent](https://github.com/tykimos/agent-native-agent).
