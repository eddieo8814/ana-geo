#!/usr/bin/env python3
"""ana-geo-route Python worker — PRD §8.5 worker contract.

Spawned per request by server.js:

    <python> tools/worker.py        # request JSON on stdin, response JSON on stdout

Request envelope   {"op": str, "params": object}
Response envelope  {"ok": bool, "result": object|null,
                    "error": {"code": str, "message": str}|null}

stderr is logs only and is never parsed as data (§8.5). The process always exits
0 once it has written a well-formed envelope: a failure is carried *inside* the
envelope, and a non-zero exit is reserved for the case where no envelope could
be produced at all (server.js then reports `python_worker_failure`).

PRD §8.1 recommends one file per op (`tools/<op>.py`); this app ships a single
worker with an op table instead, because `route`, `nearest` and `isochrone`
share the whole network-acquisition path (bbox → area cap → cache → speeds).
The wire contract above is unchanged. Documented in SPEC.md §5.

Heavy imports (osmnx, networkx, geopandas) are deliberately deferred into the
functions that need them, so bbox math, the FR-ROUTE-010 area cap and the
envelope round-trip all work on a bare interpreter — and an over-cap request is
rejected before a single byte of road network is downloaded.
"""

import json
import math
import os
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "data", "cache")

# §8.4 — external host allowlist. server.js owns the canonical list in its
# ALLOWED_HOSTS constant and passes it in `params.allowedHosts` on every
# request; this copy is the fallback for a direct CLI run. OSMnx reaches
# Overpass over direct HTTPS rather than through the Node proxy (allowed by
# §8.4 for Python workers), so the allowlist is re-checked here against
# osmnx's configured endpoint before any download.
DEFAULT_ALLOWED_HOSTS = ["overpass-api.de"]

# FR-ROUTE-010 — analysis bounds. Both are overridable per request
# (`areaCapKm2`, `paddingKm`) so ANA can propose raising the cap in state.json
# instead of editing code (§19.4, §30 item 11).
DEFAULT_AREA_CAP_KM2 = 100.0
DEFAULT_PADDING_KM = 2.0

# FR-ROUTE-003 — travel modes mapped onto OSMnx network types.
NETWORK_TYPES = {"drive": "drive", "walk": "walk", "bike": "bike"}

# Straight-line reach estimates, used only to bound the isochrone download box
# before the graph exists. Deliberately generous (a network path is always
# longer than the crow-flies distance), so the box never clips a reachable area.
MODE_SPEED_KPH = {"drive": 40.0, "walk": 4.8, "bike": 15.0}

DEFAULT_ISOCHRONE_MINUTES = [5, 10, 20]

# Kept below the 60 s worker timeout in server.js so a slow public Overpass
# produces a clean error envelope instead of a killed process.
REQUESTS_TIMEOUT_S = 45

MAXSPEED_NOTE = (
    "Edges without an OSM maxspeed tag are given the mean speed of their highway "
    "type by osmnx.add_edge_speeds; travel times are therefore estimates, not "
    "measured times."
)

# FR-ROUTE-005 — a walking or cycling traveller is not described by OSM's
# maxspeed, which is the *car* speed limit of the way. Imputing it makes a
# five-minute walk cover tens of square kilometres, so these modes get a uniform
# speed instead and say so in the result.
UNIFORM_SPEED_MODES = {"walk": 4.8, "bike": 15.0}
UNIFORM_SPEED_NOTE = (
    "Travel times assume a constant {:.1f} km/h for the whole network: OSM maxspeed "
    "describes motor traffic, not a {} traveller. Gradient, crossings and waiting "
    "time are not modelled."
)

# Bumped whenever the travel-time model changes, so a cached graph built under
# the old model is never silently reused (it is keyed into the cache filename).
SPEED_MODEL_VERSION = "v2"

METERS_PER_DEG_LAT = 111320.0


class WorkerError(Exception):
    """A failure that belongs in the response envelope's `error` field."""

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# ---------- geometry helpers (no third-party imports) ----------


def haversine_m(a, b):
    """Great-circle distance in metres between two (lat, lng) pairs."""
    lat1, lng1 = math.radians(a[0]), math.radians(a[1])
    lat2, lng2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))


def padded_bbox(points, padding_km=DEFAULT_PADDING_KM):
    """FR-ROUTE-010 — bbox of the analysis points plus a fixed padding.

    `points` are (lat, lng) pairs: origin, destination and any analysis targets.
    The viewport is never an input here. Returns (west, south, east, north).
    """
    if not points:
        raise WorkerError("bad_params", "at least one point is required to bound the network")
    lats = [float(p[0]) for p in points]
    lngs = [float(p[1]) for p in points]
    south, north = min(lats), max(lats)
    west, east = min(lngs), max(lngs)
    dlat = padding_km * 1000.0 / METERS_PER_DEG_LAT
    mid = (south + north) / 2.0
    dlng = padding_km * 1000.0 / (METERS_PER_DEG_LAT * max(math.cos(math.radians(mid)), 0.01))
    return (west - dlng, south - dlat, east + dlng, north + dlat)


def bbox_dimensions_km(bbox):
    west, south, east, north = bbox
    mid = math.radians((south + north) / 2.0)
    height = (north - south) * METERS_PER_DEG_LAT / 1000.0
    width = (east - west) * METERS_PER_DEG_LAT * math.cos(mid) / 1000.0
    return width, height


def bbox_area_km2(bbox):
    w, h = bbox_dimensions_km(bbox)
    return abs(w * h)


def check_area_cap(bbox, cap_km2, context=None):
    """FR-ROUTE-010 — reject an over-cap request loudly (§25).

    Never truncates the box: a silently shrunk network would surface later as a
    phantom road disconnection, which is exactly the failure this guard exists
    to prevent. Runs before any download.
    """
    area = bbox_area_km2(bbox)
    if area > cap_km2:
        w, h = bbox_dimensions_km(bbox)
        raise WorkerError(
            "area_cap_exceeded",
            (
                "Analysis area {:.1f} km2 exceeds the {:.1f} km2 cap "
                "({:.1f} x {:.1f} km incl. {:.1f} km padding). The request was "
                "rejected, not truncated — raise analysis.areaCapKm2, move the "
                "points closer together, or split the analysis."
            ).format(area, cap_km2, w, h, DEFAULT_PADDING_KM),
            {
                "requestedAreaKm2": round(area, 2),
                "capKm2": cap_km2,
                "widthKm": round(w, 2),
                "heightKm": round(h, 2),
                "bbox": [round(v, 6) for v in bbox],
                "context": context or {},
            },
        )
    return area


def convex_hull(points):
    """Monotone-chain hull of (x, y) points; returns a closed CCW ring.

    Used for the isochrone approximation (FR-ROUTE-009). Pure Python so the
    isochrone geometry logic stays testable without geopandas/shapely.
    """
    pts = sorted(set((float(x), float(y)) for x, y in points))
    if len(pts) < 3:
        return list(pts)

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    ring = lower[:-1] + upper[:-1]
    if len(ring) < 3:
        return list(pts)
    return ring + [ring[0]]


def ring_area_km2(ring):
    """Shoelace area of a lng/lat ring, in a local equirectangular projection."""
    if len(ring) < 4:
        return 0.0
    lat0 = math.radians(sum(p[1] for p in ring) / len(ring))
    k = METERS_PER_DEG_LAT / 1000.0
    xy = [((p[0] * math.cos(lat0)) * k, p[1] * k) for p in ring]
    s = 0.0
    for i in range(len(xy) - 1):
        s += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1]
    return abs(s) / 2.0


# ---------- graph helpers (networkx-shaped, injectable for tests) ----------


def edge_between(graph, u, v, weight):
    """Cheapest parallel edge u→v under `weight` (OSMnx graphs are multigraphs)."""
    data = graph.get_edge_data(u, v)
    if not data:
        return {}
    if "length" in data or "travel_time" in data:  # plain DiGraph
        return data
    return min(data.values(), key=lambda d: _num(d.get(weight), math.inf))


def _num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def path_edges(graph, path, weight):
    return [edge_between(graph, path[i], path[i + 1], weight) for i in range(len(path) - 1)]


def path_totals(graph, path, weight="length"):
    """Total length (m) and travel time (s) along a node path."""
    length = 0.0
    seconds = 0.0
    for d in path_edges(graph, path, weight):
        length += _num(d.get("length"))
        seconds += _num(d.get("travel_time"))
    return length, seconds


def path_coordinates(graph, path, weight="length"):
    """[lng, lat] coordinate list for a node path (FR-ROUTE-006).

    Uses the OSM edge geometry where present so the line follows the road, and
    falls back to the node-to-node segment for simplified edges.
    """
    coords = []
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        d = edge_between(graph, u, v, weight)
        geom = d.get("geometry")
        if geom is not None and hasattr(geom, "coords"):
            seg = [(float(x), float(y)) for x, y in geom.coords]
        else:
            seg = [
                (float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"])),
                (float(graph.nodes[v]["x"]), float(graph.nodes[v]["y"])),
            ]
        # Two-way OSM edges can carry the geometry of the opposite direction.
        anchor = (float(graph.nodes[u]["x"]), float(graph.nodes[u]["y"]))
        if _sqdist(seg[0], anchor) > _sqdist(seg[-1], anchor):
            seg.reverse()
        if coords and coords[-1] == seg[0]:
            seg = seg[1:]
        coords.extend(seg)
    if not coords and path:
        n = path[0]
        coords = [(float(graph.nodes[n]["x"]), float(graph.nodes[n]["y"]))]
    return [[round(x, 7), round(y, 7)] for x, y in coords]


def _sqdist(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def build_route(graph, path, mode, optimized_for, weight):
    """§19.5 route result contract (+ provenance fields)."""
    length, seconds = path_totals(graph, path, weight)
    return {
        "mode": mode,
        "distanceMeters": round(length, 1),
        "travelTimeSeconds": round(seconds, 1),
        "geometry": {"type": "LineString", "coordinates": path_coordinates(graph, path, weight)},
        "optimizedFor": optimized_for,
        "nodeCount": len(path),
    }


def rank_candidates(graph, origin_node, candidate_nodes, cost_by_node, rank_by="time", limit=None):
    """FR-ROUTE-008 — order candidates by network cost, not straight-line distance.

    `cost_by_node` is {"time": {node: seconds}, "distance": {node: metres}} —
    two single-source Dijkstra runs, so every candidate carries both metrics
    whichever one it is ranked by. Candidates the network cannot reach are
    returned separately rather than dropped, so an empty ranking is explainable.
    """
    if rank_by not in ("time", "distance"):
        raise WorkerError("bad_params", "rankBy must be 'time' or 'distance'")
    reachable, unreachable = [], []
    for cand in candidate_nodes:
        node = cand["node"]
        seconds = cost_by_node.get("time", {}).get(node)
        metres = cost_by_node.get("distance", {}).get(node)
        primary = seconds if rank_by == "time" else metres
        entry = dict(cand)
        entry.pop("node", None)
        if primary is None:
            entry["reason"] = "not reachable from the origin on this network"
            unreachable.append(entry)
            continue
        entry["travelTimeSeconds"] = None if seconds is None else round(seconds, 1)
        entry["distanceMeters"] = None if metres is None else round(metres, 1)
        entry["_node"] = node
        reachable.append(entry)
    key = "travelTimeSeconds" if rank_by == "time" else "distanceMeters"
    reachable.sort(key=lambda e: (e[key] is None, e[key]))
    for i, entry in enumerate(reachable):
        entry["rank"] = i + 1
    if limit:
        reachable = reachable[: int(limit)]
    return reachable, unreachable


def isochrone_nodes(graph, center_node, seconds, nx=None):
    """Nodes reachable within `seconds` of travel time (FR-ROUTE-009)."""
    if nx is None:
        nx = _networkx()
    sub = nx.ego_graph(graph, center_node, radius=seconds, distance="travel_time")
    return list(sub.nodes)


def isochrone_polygon(graph, nodes, minutes, mode):
    """Convex hull of the reachable node cloud — an approximation, and labelled as one.

    A hull bridges gaps the network cannot actually cross (rivers, motorway-only
    corridors), so it over-covers. The alternative — an alpha shape or an edge
    buffer — needs shapely operations this V1 deliberately avoids; the honest
    move is to publish the approximation with its method attached.
    """
    pts = [(float(graph.nodes[n]["x"]), float(graph.nodes[n]["y"])) for n in nodes]
    ring = convex_hull(pts)
    props = {
        "minutes": minutes,
        "seconds": minutes * 60,
        "mode": mode,
        "nodeCount": len(nodes),
        "approximate": True,
        "method": "convex-hull-of-reachable-nodes",
        "note": "Approximate: the convex hull of reachable intersections over-covers gaps in the network.",
    }
    if len(ring) < 4:
        props["degenerate"] = True
        return {"type": "Feature", "id": "iso-%d" % minutes, "geometry": None, "properties": props}
    props["areaKm2"] = round(ring_area_km2(ring), 3)
    return {
        "type": "Feature",
        "id": "iso-%d" % minutes,
        "geometry": {"type": "Polygon", "coordinates": [[[round(x, 7), round(y, 7)] for x, y in ring]]},
        "properties": props,
    }


# ---------- deferred third-party imports ----------


def _networkx():
    try:
        import networkx as nx
    except ImportError as exc:
        raise WorkerError(
            "missing_dependency",
            "networkx is not installed — run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
            {"detail": str(exc)},
        )
    return nx


def _osmnx():
    try:
        import osmnx as ox
    except ImportError as exc:
        raise WorkerError(
            "missing_dependency",
            "osmnx is not installed — run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
            {"detail": str(exc)},
        )
    return ox


def _fn(ox, module, name):
    """osmnx 2.x moved routing/distance helpers into submodules; 1.x kept them top-level."""
    sub = getattr(ox, module, None)
    fn = getattr(sub, name, None) if sub is not None else None
    if fn is None:
        fn = getattr(ox, name, None)
    if fn is None:
        raise WorkerError("osmnx_api_mismatch", "installed osmnx exposes no %s()" % name)
    return fn


def _assert_allowlisted(ox, allowed_hosts):
    """§8.4 — the worker's own external hosts obey the same per-app allowlist."""
    from urllib.parse import urlparse

    url = getattr(ox.settings, "overpass_url", "https://overpass-api.de/api")
    host = urlparse(url).hostname
    if host not in allowed_hosts:
        raise WorkerError(
            "host_not_allowlisted",
            "osmnx is configured for %s, which is not in the app allowlist %s" % (host, allowed_hosts),
            {"host": host, "allowedHosts": list(allowed_hosts)},
        )


def _configure(ox):
    for name, value in (
        ("use_cache", True),
        ("cache_folder", os.path.join(CACHE_DIR, "osmnx")),
        ("log_console", False),
        ("requests_timeout", REQUESTS_TIMEOUT_S),
        ("overpass_rate_limit", True),
    ):
        if hasattr(ox.settings, name):
            setattr(ox.settings, name, value)


def maxspeed_coverage(graph):
    """FR-ROUTE-005 — how much of the travel time is measured vs. imputed."""
    total = tagged = 0
    for _, _, d in graph.edges(data=True):
        total += 1
        v = d.get("maxspeed")
        if v not in (None, "", [], {}):
            tagged += 1
    return {
        "edgesTotal": total,
        "edgesWithMaxspeed": tagged,
        "edgesImputed": total - tagged,
        "imputed": total - tagged > 0,
        "note": MAXSPEED_NOTE,
    }


def cache_name(bbox, network_type):
    """Cache key = (rounded bbox, network_type) per FR-ROUTE-010.

    Rounded to 3 decimals (~100 m) so two clicks on the same street reuse one
    download instead of fetching a near-identical network. The speed-model
    version is part of the key because travel times are stored in the file.
    """
    w, s, e, n = (round(v, 3) for v in bbox)
    return "%s_%s_%.3f_%.3f_%.3f_%.3f" % (network_type, SPEED_MODEL_VERSION, w, s, e, n)


def apply_speed_model(ox, graph, mode):
    """Give every edge a `travel_time`, and report how it was derived.

    Two models, because one does not fit both cases: motor traffic follows the
    OSM speed limits (with osmnx imputing the missing ones from the road type),
    while a pedestrian or a cyclist does not — see UNIFORM_SPEED_MODES.
    """
    if mode in UNIFORM_SPEED_MODES:
        kph = UNIFORM_SPEED_MODES[mode]
        mps = kph * 1000.0 / 3600.0
        for _, _, data in graph.edges(data=True):
            data["speed_kph"] = kph
            data["travel_time"] = _num(data.get("length")) / mps
        return graph, {
            "model": "uniform-speed",
            "speedKph": kph,
            "imputed": True,
            "note": UNIFORM_SPEED_NOTE.format(kph, mode),
        }

    coverage = maxspeed_coverage(graph)
    if any("travel_time" not in d for _, _, d in graph.edges(data=True)):
        graph = _fn(ox, "routing", "add_edge_speeds")(graph)
        graph = _fn(ox, "routing", "add_edge_travel_times")(graph)
    coverage["model"] = "osm-maxspeed-with-highway-type-imputation"
    return graph, coverage


def load_network(bbox, mode, allowed_hosts):
    """Acquire the road network for `bbox`, from cache when possible (FR-ROUTE-010)."""
    ox = _osmnx()
    _configure(ox)
    net_type = NETWORK_TYPES[mode]
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, cache_name(bbox, net_type) + ".graphml")
    started = time.time()

    if os.path.exists(path):
        graph = _fn(ox, "io", "load_graphml")(
            path, edge_dtypes={"length": float, "travel_time": float, "speed_kph": float}
        )
        cached = True
    else:
        _assert_allowlisted(ox, allowed_hosts)  # only a *download* touches the network
        west, south, east, north = bbox
        graph_from_bbox = _fn(ox, "graph", "graph_from_bbox")
        try:
            graph = graph_from_bbox(bbox=(west, south, east, north), network_type=net_type)
        except TypeError:  # osmnx 1.x keyword set
            graph = graph_from_bbox(
                north=north, south=south, east=east, west=west, network_type=net_type
            )
        cached = False

    if graph.number_of_edges() == 0:
        raise WorkerError(
            "empty_network",
            "No %s road network exists in the requested area." % net_type,
            {"bbox": [round(v, 6) for v in bbox]},
        )

    graph, speed_model = apply_speed_model(ox, graph, mode)
    if not cached:
        _fn(ox, "io", "save_graphml")(graph, path)

    info = {
        "bbox": [round(v, 6) for v in bbox],
        "areaKm2": round(bbox_area_km2(bbox), 2),
        "networkType": net_type,
        "nodes": graph.number_of_nodes(),
        "edges": graph.number_of_edges(),
        "cached": cached,
        "cacheKey": cache_name(bbox, net_type),
        "elapsedSeconds": round(time.time() - started, 2),
        "speedEstimates": speed_model,
        "source": "OpenStreetMap via Overpass (osmnx)",
    }
    return graph, info


def nearest_node(graph, point):
    """Snap a (lat, lng) to the closest graph node; returns (node, metres).

    Deliberately not osmnx.distance.nearest_nodes: on an unprojected graph that
    function requires scikit-learn, which would add a large dependency outside
    the three §19.3 names for a linear scan we can do exactly here. Networks are
    capped at ~100 km² (FR-ROUTE-010), so this stays in the millisecond range.
    """
    best, best_d = None, math.inf
    for node, data in graph.nodes(data=True):
        d = haversine_m(point, (float(data["y"]), float(data["x"])))
        if d < best_d:
            best, best_d = node, d
    if best is None:
        raise WorkerError("empty_network", "the loaded network has no nodes")
    return best, round(best_d, 1)


# ---------- params ----------


def _point(params, *names):
    for name in names:
        v = params.get(name)
        if v is None:
            continue
        if isinstance(v, dict):
            v = [v.get("lat"), v.get("lng")]
        if not isinstance(v, (list, tuple)) or len(v) < 2 or v[0] is None or v[1] is None:
            raise WorkerError("bad_params", "%s must be [lat, lng]" % name)
        lat, lng = float(v[0]), float(v[1])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise WorkerError("bad_params", "%s is out of range: [%s, %s]" % (name, lat, lng))
        return (lat, lng)
    raise WorkerError("bad_params", "%s is required" % names[0])


def _mode(params):
    mode = params.get("mode", "drive")
    if mode not in NETWORK_TYPES:
        raise WorkerError(
            "bad_params",
            "unsupported travel mode '%s' — use one of %s" % (mode, ", ".join(NETWORK_TYPES)),
        )
    return mode


def _bounds(params):
    cap = float(params.get("areaCapKm2") or DEFAULT_AREA_CAP_KM2)
    padding = float(params.get("paddingKm") or DEFAULT_PADDING_KM)
    hosts = params.get("allowedHosts") or DEFAULT_ALLOWED_HOSTS
    return cap, padding, list(hosts)


# ---------- ops ----------


def op_route(params):
    """FR-ROUTE-001/002/004/005/006/007 — origin→destination path and summary."""
    origin = _point(params, "origin")
    dest = _point(params, "destination", "dest")
    mode = _mode(params)
    optimize = params.get("optimize", "time")
    if optimize not in ("time", "distance"):
        raise WorkerError("bad_params", "optimize must be 'time' or 'distance'")
    cap, padding, hosts = _bounds(params)

    points = [origin, dest] + [(_num(t[0]), _num(t[1])) for t in (params.get("targets") or [])]
    bbox = padded_bbox(points, padding)
    check_area_cap(bbox, cap, {"op": "route", "mode": mode, "paddingKm": padding})

    graph, network = load_network(bbox, mode, hosts)
    ox = _osmnx()
    nx = _networkx()
    o_node, o_snap = nearest_node(graph, origin)
    d_node, d_snap = nearest_node(graph, dest)
    if o_node == d_node:
        raise WorkerError(
            "degenerate_route",
            "Origin and destination snap to the same intersection — pick points further apart.",
            {"snapMeters": {"origin": o_snap, "destination": d_snap}},
        )

    routes = {}
    for label, weight in (("distance", "length"), ("time", "travel_time")):
        try:
            path = nx.shortest_path(graph, o_node, d_node, weight=weight)
        except nx.NetworkXNoPath:
            raise WorkerError(
                "no_route",
                "No %s route exists between these points inside the analysis area." % mode,
                {"bbox": network["bbox"], "areaKm2": network["areaKm2"]},
            )
        except nx.NodeNotFound:
            raise WorkerError("no_route", "Origin or destination is not on the loaded network.")
        routes[label] = build_route(graph, path, mode, label, weight)

    return {
        "route": routes[optimize],          # §19.5 contract
        "alternatives": routes,             # FR-ROUTE-004 and FR-ROUTE-005 side by side
        "network": network,
        "snapMeters": {"origin": o_snap, "destination": d_snap},
        "origin": list(origin),
        "destination": list(dest),
    }


def op_nearest(params):
    """FR-ROUTE-008 — rank candidate destinations by network cost."""
    origin = _point(params, "origin")
    mode = _mode(params)
    rank_by = params.get("rankBy", "time")
    limit = params.get("limit")
    cap, padding, hosts = _bounds(params)

    raw = params.get("candidates") or []
    if not raw:
        raise WorkerError("bad_params", "candidates is required — a list of {id, name, lat, lng}")
    candidates = []
    for i, c in enumerate(raw):
        lat, lng = c.get("lat"), c.get("lng")
        if lat is None or lng is None:
            raise WorkerError("bad_params", "candidate %d has no lat/lng" % i)
        candidates.append(
            {
                "id": c.get("id") or "cand-%d" % i,
                "name": c.get("name"),
                "category": c.get("category"),
                "lat": float(lat),
                "lng": float(lng),
            }
        )

    points = [origin] + [(c["lat"], c["lng"]) for c in candidates]
    bbox = padded_bbox(points, padding)
    check_area_cap(bbox, cap, {"op": "nearest", "mode": mode, "candidates": len(candidates)})

    graph, network = load_network(bbox, mode, hosts)
    ox = _osmnx()
    nx = _networkx()
    o_node, o_snap = nearest_node(graph, origin)

    cost_by_node = {
        "time": nx.single_source_dijkstra_path_length(graph, o_node, weight="travel_time"),
        "distance": nx.single_source_dijkstra_path_length(graph, o_node, weight="length"),
    }
    for c in candidates:
        node, snap = nearest_node(graph, (c["lat"], c["lng"]))
        c["node"] = node
        c["snapMeters"] = snap

    ranked, unreachable = rank_candidates(graph, o_node, candidates, cost_by_node, rank_by, limit)

    best_route = None
    if ranked:
        weight = "travel_time" if rank_by == "time" else "length"
        path = nx.shortest_path(graph, o_node, ranked[0]["_node"], weight=weight)
        best_route = build_route(graph, path, mode, rank_by, weight)
    for entry in ranked:
        entry.pop("_node", None)

    return {
        "ranking": ranked,
        "unreachable": unreachable,
        "rankedBy": rank_by,
        "route": best_route,      # route to the winner, ready to draw (FR-ROUTE-006)
        "network": network,
        "snapMeters": {"origin": o_snap},
        "origin": list(origin),
    }


def op_isochrone(params):
    """FR-ROUTE-009 — approximate reachable regions for 5 / 10 / 20 minutes."""
    origin = _point(params, "origin")
    mode = _mode(params)
    cap, padding, hosts = _bounds(params)
    minutes = params.get("minutes") or DEFAULT_ISOCHRONE_MINUTES
    try:
        minutes = sorted({int(m) for m in minutes})
    except (TypeError, ValueError):
        raise WorkerError("bad_params", "minutes must be a list of integers")
    if not minutes or minutes[0] <= 0:
        raise WorkerError("bad_params", "minutes must be positive")

    # There is no destination to bound the box, so the reach is estimated from
    # the mode's free-flow speed. A 20-minute drive box exceeds the default cap
    # by design — the rejection below states the numbers instead of quietly
    # returning a clipped isochrone.
    reach_km = MODE_SPEED_KPH[mode] * (minutes[-1] / 60.0)
    corner_lat = origin[0] + reach_km * 1000.0 / METERS_PER_DEG_LAT
    corner_lng = origin[1] + reach_km * 1000.0 / (
        METERS_PER_DEG_LAT * max(math.cos(math.radians(origin[0])), 0.01)
    )
    span = [
        (2 * origin[0] - corner_lat, 2 * origin[1] - corner_lng),
        (corner_lat, corner_lng),
    ]
    bbox = padded_bbox(span, padding)
    check_area_cap(
        bbox,
        cap,
        {
            "op": "isochrone",
            "mode": mode,
            "maxMinutes": minutes[-1],
            "estimatedReachKm": round(reach_km, 2),
            "hint": "lower the maximum minutes, switch to walk, or raise analysis.areaCapKm2",
        },
    )

    graph, network = load_network(bbox, mode, hosts)
    ox = _osmnx()
    nx = _networkx()
    center, snap = nearest_node(graph, origin)

    features = []
    summary = []
    for m in minutes:
        nodes = isochrone_nodes(graph, center, m * 60, nx)
        feature = isochrone_polygon(graph, nodes, m, mode)
        features.append(feature)
        summary.append(
            {
                "minutes": m,
                "nodeCount": feature["properties"]["nodeCount"],
                "areaKm2": feature["properties"].get("areaKm2"),
                "degenerate": feature["properties"].get("degenerate", False),
            }
        )

    return {
        "isochrone": {
            "type": "FeatureCollection",
            "features": features,
        },
        "summary": summary,
        "minutes": minutes,
        "mode": mode,
        "approximate": True,
        "method": "convex-hull-of-reachable-nodes",
        "network": network,
        "snapMeters": {"origin": snap},
        "origin": list(origin),
    }


def op_capabilities(params):
    """What this worker can do and which dependencies are actually importable."""
    deps = {}
    for name in ("osmnx", "networkx", "geopandas"):
        try:
            module = __import__(name)
            deps[name] = getattr(module, "__version__", "unknown")
        except ImportError as exc:
            deps[name] = "MISSING (%s)" % exc
    return {
        "ops": sorted(OPS),
        "modes": sorted(NETWORK_TYPES),
        "python": sys.version.split()[0],
        "dependencies": deps,
        "defaults": {
            "areaCapKm2": DEFAULT_AREA_CAP_KM2,
            "paddingKm": DEFAULT_PADDING_KM,
            "isochroneMinutes": DEFAULT_ISOCHRONE_MINUTES,
            "allowedHosts": DEFAULT_ALLOWED_HOSTS,
        },
    }


def op_echo(params):
    """Envelope round-trip probe (§8.5) — used by tools/smoke_envelope.js."""
    return {"echo": params, "pid": os.getpid()}


def op_boom(params):
    """Deliberate crash, so the error envelope path is exercised by a test."""
    raise RuntimeError(params.get("message") or "deliberate worker failure")


def op_sleep(params):
    """Deliberate stall, so the server-side timeout path is exercised by a test."""
    time.sleep(float(params.get("seconds") or 1))
    return {"slept": params.get("seconds")}


OPS = {
    "route": op_route,
    "nearest": op_nearest,
    "isochrone": op_isochrone,
    "capabilities": op_capabilities,
    "echo": op_echo,
    "boom": op_boom,
    "sleep": op_sleep,
}


# ---------- envelope (§8.5) ----------


def ok_envelope(result):
    return {"ok": True, "result": result, "error": None}


def error_envelope(code, message, details=None):
    error = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"ok": False, "result": None, "error": error}


def handle(request):
    """Dispatch one request envelope to an op, returning a response envelope."""
    if not isinstance(request, dict):
        return error_envelope("bad_request", "request envelope must be a JSON object")
    op = request.get("op")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        return error_envelope("bad_request", "params must be a JSON object")
    fn = OPS.get(op)
    if fn is None:
        return error_envelope(
            "unknown_op", "unknown op '%s' — known ops: %s" % (op, ", ".join(sorted(OPS)))
        )
    try:
        return ok_envelope(fn(params))
    except WorkerError as exc:
        return error_envelope(exc.code, exc.message, exc.details)
    except Exception as exc:  # noqa: BLE001 — any op crash becomes a visible envelope (§25)
        traceback.print_exc(file=sys.stderr)  # stderr is logs only (§8.5)
        return error_envelope("worker_exception", "%s: %s" % (type(exc).__name__, exc))


def main():
    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        sys.stdout.write(json.dumps(error_envelope("bad_request", "stdin is not JSON: %s" % exc)))
        return 0
    sys.stdout.write(json.dumps(handle(request)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
