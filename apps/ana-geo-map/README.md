# ana-geo-map

The smallest Agent-Native GIS: an interactive map you operate by **watching and talking**.

> Screenshot: run the app and capture `http://localhost:8801` (placeholder — add after first run).

**Core question:** *Where is it?*

## Run

```bash
node server.js          # dashboard + state + chat bridge  → http://localhost:8801
node relay.js           # inbound relay (separate process) — pushes chat to the ANA session
```

Requires **Node.js >= 20 LTS**. Zero npm dependencies (Leaflet is vendored in `vendor/leaflet/`).

To act as ANA, run a coding agent (e.g. Claude Code) in this directory; it receives user messages from `relay.js` output (or `data/inbox.log`), edits `state.json` / the app code, and replies with `POST /api/agent`.

### Wiring a live Claude Code session via fakechat (recommended)

`relay.js` only prints inbound messages — nothing answers until a brain is attached. With the [fakechat channel plugin](https://github.com/tykimos/agent-native-agent) a separate Claude Code session receives dashboard chat as push events:

```bash
# 1. app server
node server.js                       # :8801

# 2. brain — a separate Claude Code session started WITH the fakechat channel
#    (once: claude plugin install fakechat@claude-plugins-official)
cd apps/ana-geo-map && claude --channels plugin:fakechat@claude-plugins-official
#    channels attach at session start only — restart the session if you forgot the flag

# 3. bridge — dashboard inbox → fakechat WS (:8787) → session
node fakechat-bridge.js              # instead of relay.js
```

Tell the brain session once: *"You are ANA for this app. For every `<channel source="fakechat">` message: read `state.json`, do what was asked (edit state via `PUT /api/state`, or propose code changes), and always reply with `POST http://localhost:8801/api/agent` — never only in the channel."*

Diagnosis when chat gets no reply: inject straight into the channel, bypassing the bridge — `curl -s -X POST localhost:8787/ -F 'id=diag-1' -F 'text=ping'` (expect 204). If the session sees it, the bridge/app side is at fault; if not, the session wasn't started with the channel — restart it with `--channels`.

## Dependencies

- Node.js >= 20 LTS (global `fetch`)
- Leaflet 1.9.4 (vendored)

## External data sources

- OpenStreetMap raster tiles (basemap only; © OpenStreetMap contributors)

## Example prompts

```text
"Move the map to Daejeon."
"Zoom in."
"Put a marker here."
"Remove all markers."
"Show this GeoJSON."
"Add a distance measure tool."   ← evolution: ANA proposes a code change
```

## Current capabilities

Pan/zoom, center & zoom display, click-to-marker (persisted in `state.json`, synced to every device via `stateVersion` polling), GeoJSON upload → server-stored result layer with fit-to-bounds, layer toggles, chat bridge with inbound relay.

## Limitations

- Displays geography but cannot discover what exists there (no external POI search).
- `map.observedView` is a single slot — with multiple devices, the last writer wins.
- Approval cards render as plain feed messages in this first version.

## Next evolution

**`ana-geo-explorer`** — *"What is there?"* Adds OpenStreetMap/Overpass category discovery (cafes, schools, hospitals…) as toggleable result layers over the same runtime.
