#!/usr/bin/env python3
"""Offline unit checks for tools/worker.py — no osmnx, no network, no Overpass.

    .venv/bin/python tools/smoke_worker.py      # full run
    python3 tools/smoke_worker.py               # graph checks skipped if networkx is absent

Every routing algorithm in the worker is exercised on a hand-built synthetic
graph whose shortest-distance and shortest-time paths deliberately disagree, so
a weight mix-up (FR-ROUTE-004 vs FR-ROUTE-005) fails here rather than in a live
Overpass run. The FR-ROUTE-010 area cap is checked through the real `route` op:
if the cap ever stopped firing before the download, this test would try to reach
the network and fail instead of passing quietly.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import worker  # noqa: E402

try:
    import networkx as nx
except ImportError:  # pragma: no cover - bare interpreter
    nx = None

PASS, FAIL, SKIP = [], [], []


def check(name, condition, detail=""):
    (PASS if condition else FAIL).append(name)
    mark = "ok  " if condition else "FAIL"
    print("%s %s%s" % (mark, name, (" — " + str(detail)) if detail and not condition else ""))


def skip(name, why):
    SKIP.append(name)
    print("skip %s — %s" % (name, why))


def raises(fn, code):
    try:
        fn()
    except worker.WorkerError as exc:
        return exc if exc.code == code else None
    except Exception:  # noqa: BLE001
        return None
    return None


# ---------- synthetic network ----------
#
#   n6 ──fast── n5 ──fast── n4          fast road: long but quick
#   │                        │
#  fast                     fast
#   │                        │
#   n1 ──slow── n2 ──slow── n3          slow street: short but congested
#
# n1→n3 by distance: n1,n2,n3          = 1800 m / 360 s
# n1→n3 by time:     n1,n6,n5,n4,n3    = 4000 m / 210 s
# n9 is an isolated node — an unreachable candidate.

NODES = {
    "n1": (127.380, 36.350),
    "n2": (127.390, 36.350),
    "n3": (127.400, 36.350),
    "n4": (127.400, 36.360),
    "n5": (127.390, 36.360),
    "n6": (127.380, 36.360),
    "n9": (127.500, 36.500),
}

EDGES = [
    ("n1", "n2", 900.0, 180.0),
    ("n2", "n3", 900.0, 180.0),
    ("n1", "n6", 1100.0, 60.0),
    ("n6", "n5", 900.0, 45.0),
    ("n5", "n4", 900.0, 45.0),
    ("n4", "n3", 1100.0, 60.0),
]


class FakeGeom:
    """Stands in for a shapely LineString on an edge (`.coords` is all we use)."""

    def __init__(self, coords):
        self.coords = coords


def build_graph():
    g = nx.MultiDiGraph()
    for name, (x, y) in NODES.items():
        g.add_node(name, x=x, y=y)
    for u, v, length, tt in EDGES:
        g.add_edge(u, v, length=length, travel_time=tt, maxspeed="60")
        g.add_edge(v, u, length=length, travel_time=tt)  # no maxspeed → imputed side
    return g


# ---------- bbox / area cap (FR-ROUTE-010) ----------


def test_bbox_and_cap():
    origin, dest = (36.3504, 127.3845), (36.3600, 127.3950)
    bbox = worker.padded_bbox([origin, dest], 2.0)
    w, s, e, n = bbox
    check("padded_bbox encloses the points", w < 127.3845 and e > 127.3950 and s < 36.3504 and n > 36.36)

    width, height = worker.bbox_dimensions_km(bbox)
    # 0.0105 deg lng ≈ 0.94 km + 4 km padding; 0.0096 deg lat ≈ 1.07 km + 4 km.
    check("padding adds ~2 km per side", 4.8 < width < 5.2 and 4.9 < height < 5.3, (width, height))
    check("small bbox is under the cap", worker.bbox_area_km2(bbox) < 100)
    check("check_area_cap passes a small box", worker.check_area_cap(bbox, 100.0) is not None)

    # ~20 km diagonal: 14.1 km on each axis + 4 km padding → ~330 km².
    far_origin = (36.3504, 127.3845)
    far_dest = (36.4771, 127.5418)
    big = worker.padded_bbox([far_origin, far_dest], 2.0)
    area = worker.bbox_area_km2(big)
    check("20 km diagonal bbox is over the 100 km2 cap", area > 100, area)
    exc = raises(lambda: worker.check_area_cap(big, 100.0), "area_cap_exceeded")
    check("check_area_cap raises area_cap_exceeded", exc is not None)
    if exc:
        d = exc.details
        check(
            "rejection reports requested area and cap",
            d.get("requestedAreaKm2", 0) > 100 and d.get("capKm2") == 100.0,
            d,
        )
        check("rejection message names both numbers", "km2" in exc.message and "cap" in exc.message)

    # The op itself must refuse before any network access (no osmnx needed).
    env = worker.handle(
        {
            "op": "route",
            "params": {
                "origin": list(far_origin),
                "destination": list(far_dest),
                "mode": "drive",
            },
        }
    )
    check("route op rejects an over-cap request without downloading", env["ok"] is False)
    check("… with code area_cap_exceeded", env["error"]["code"] == "area_cap_exceeded", env["error"])

    # A raised cap is honoured — this is the evolution path ANA proposes for an
    # over-cap request. Checked on the guard itself: driving it through the op
    # would download a 330 km² network, which does not belong in an offline test.
    check("raising the cap admits the same box", worker.check_area_cap(big, 5000.0) == area)

    # Isochrone bounds come from the mode's reach, not from a destination.
    for mode, expect_over in (("walk", False), ("bike", True), ("drive", True)):
        reach = worker.MODE_SPEED_KPH[mode] * (20 / 60.0)
        iso_bbox = worker.padded_bbox(
            [(36.35 - reach / 111.32, 127.38 - reach / 90.0), (36.35 + reach / 111.32, 127.38 + reach / 90.0)],
            2.0,
        )
        over = worker.bbox_area_km2(iso_bbox) > 100
        check("20-minute %s isochrone box is %s the cap" % (mode, "over" if expect_over else "under"),
              over is expect_over, worker.bbox_area_km2(iso_bbox))

    drive = worker.handle({"op": "isochrone", "params": {"origin": [36.35, 127.38], "mode": "drive"}})
    check(
        "20-minute drive isochrone is refused by the cap, with a hint",
        drive["ok"] is False
        and drive["error"]["code"] == "area_cap_exceeded"
        and "hint" in drive["error"]["details"]["context"],
        drive["error"],
    )


# ---------- hulls and areas (FR-ROUTE-009 geometry) ----------


def test_hull():
    square = [(0, 0), (1, 0), (1, 1), (0, 1), (0.5, 0.5)]
    ring = worker.convex_hull(square)
    check("hull ring is closed", ring[0] == ring[-1])
    check("hull drops the interior point", len(ring) == 5, ring)
    check("hull keeps every corner", all(c in ring for c in [(0, 0), (1, 0), (1, 1), (0, 1)]))
    check("collinear/degenerate input does not crash", len(worker.convex_hull([(0, 0), (1, 1)])) == 2)

    # 0.01° x 0.01° near lat 36.35 ≈ 1.113 km x 0.897 km ≈ 0.998 km².
    box = [(127.38, 36.35), (127.39, 36.35), (127.39, 36.36), (127.38, 36.36), (127.38, 36.35)]
    area = worker.ring_area_km2(box)
    check("ring_area_km2 matches the analytic area", 0.95 < area < 1.05, area)


# ---------- routing on the synthetic graph ----------


def test_routing():
    g = build_graph()

    by_dist = nx.shortest_path(g, "n1", "n3", weight="length")
    by_time = nx.shortest_path(g, "n1", "n3", weight="travel_time")
    check("shortest-distance path takes the slow street (FR-ROUTE-004)", by_dist == ["n1", "n2", "n3"], by_dist)
    check(
        "shortest-time path takes the fast detour (FR-ROUTE-005)",
        by_time == ["n1", "n6", "n5", "n4", "n3"],
        by_time,
    )

    length, seconds = worker.path_totals(g, by_dist, "length")
    check("distance path totals", (length, seconds) == (1800.0, 360.0), (length, seconds))
    length_t, seconds_t = worker.path_totals(g, by_time, "travel_time")
    check("time path totals", (length_t, seconds_t) == (4000.0, 210.0), (length_t, seconds_t))
    check("the time path is longer but faster", length_t > length and seconds_t < seconds)

    route = worker.build_route(g, by_dist, "drive", "distance", "length")
    check("route matches the §19.5 contract", set(["mode", "distanceMeters", "travelTimeSeconds", "geometry"]) <= set(route))
    check("route geometry is a LineString (FR-ROUTE-006)", route["geometry"]["type"] == "LineString")
    coords = route["geometry"]["coordinates"]
    check("geometry has no duplicated joints", coords == [[127.38, 36.35], [127.39, 36.35], [127.4, 36.35]], coords)
    check("summary carries distance, time and mode (FR-ROUTE-007)",
          route["distanceMeters"] == 1800.0 and route["travelTimeSeconds"] == 360.0 and route["mode"] == "drive")

    # An edge whose stored geometry runs v→u must still be emitted u→v.
    g2 = build_graph()
    g2.add_edge("n1", "n2", length=850.0, travel_time=100.0,
                geometry=FakeGeom([(127.390, 36.350), (127.385, 36.3505), (127.380, 36.350)]))
    seg = worker.path_coordinates(g2, ["n1", "n2"], "length")
    check("reversed edge geometry is re-oriented along the path", seg[0] == [127.38, 36.35] and seg[-1] == [127.39, 36.35], seg)
    check("edge geometry vertices are kept", len(seg) == 3, seg)

    check("edge_between picks the cheapest parallel edge",
          worker.edge_between(g2, "n1", "n2", "length").get("length") == 850.0)

    node, metres = worker.nearest_node(g, (36.3505, 127.3801))
    check("nearest_node snaps to the closest intersection", node == "n1" and metres < 100, (node, metres))
    far_node, far_m = worker.nearest_node(g, (36.4999, 127.4999))
    check("nearest_node reports the snap distance", far_node == "n9" and far_m < 200, (far_node, far_m))

    # maxspeed coverage drives the "times are estimates" disclosure (FR-ROUTE-005).
    cov = worker.maxspeed_coverage(g)
    check("maxspeed coverage counts every edge", cov["edgesTotal"] == 12, cov)
    check("maxspeed coverage separates tagged from imputed",
          cov["edgesWithMaxspeed"] == 6 and cov["edgesImputed"] == 6 and cov["imputed"] is True, cov)

    # A walking traveller must not inherit the car speed limit of the way: with
    # osmnx's default imputation a 5-minute walk covered 45 km² of Daejeon.
    gw = build_graph()
    gw, model = worker.apply_speed_model(None, gw, "walk")
    check("walk mode uses a uniform speed, not OSM maxspeed",
          model["model"] == "uniform-speed" and model["speedKph"] == 4.8, model)
    walk_edge = worker.edge_between(gw, "n1", "n2", "length")
    check("walk travel time follows length / walking speed",
          abs(walk_edge["travel_time"] - 900.0 / (4.8 * 1000 / 3600)) < 1e-6, walk_edge["travel_time"])
    check("a 5-minute walk does not clear a 900 m block",
          set(worker.isochrone_nodes(gw, "n1", 300, nx)) == {"n1"}, worker.isochrone_nodes(gw, "n1", 300, nx))
    # n6 is 60 s away by car and 825 s away on foot: reaching n2 (900 m) but not
    # n6 (1100 m) at 700 s proves the car travel times were replaced, not reused.
    check("walking reach follows distance, not the driving travel time",
          set(worker.isochrone_nodes(gw, "n1", 700, nx)) == {"n1", "n2"}, worker.isochrone_nodes(gw, "n1", 700, nx))
    check("the speed model is part of the cache key",
          worker.SPEED_MODEL_VERSION in worker.cache_name((127.3, 36.3, 127.4, 36.4), "walk"))


def test_nearest():
    g = build_graph()
    costs = {
        "time": nx.single_source_dijkstra_path_length(g, "n1", weight="travel_time"),
        "distance": nx.single_source_dijkstra_path_length(g, "n1", weight="length"),
    }
    candidates = [
        {"id": "c-slow", "name": "Near but slow", "lat": 36.350, "lng": 127.390, "node": "n2"},
        {"id": "c-fast", "name": "Far but fast", "lat": 36.360, "lng": 127.380, "node": "n6"},
        {"id": "c-gone", "name": "Off network", "lat": 36.500, "lng": 127.500, "node": "n9"},
    ]

    ranked, unreachable = worker.rank_candidates(g, "n1", candidates, costs, "time")
    check("time ranking puts the fast candidate first (FR-ROUTE-008)",
          [c["id"] for c in ranked] == ["c-fast", "c-slow"], [c["id"] for c in ranked])
    check("ranks are 1-based and dense", [c["rank"] for c in ranked] == [1, 2])
    check("each entry carries both metrics",
          ranked[0]["travelTimeSeconds"] == 60.0 and ranked[0]["distanceMeters"] == 1100.0, ranked[0])

    ranked_d, _ = worker.rank_candidates(g, "n1", candidates, costs, "distance")
    check("distance ranking reverses the order",
          [c["id"] for c in ranked_d] == ["c-slow", "c-fast"], [c["id"] for c in ranked_d])

    check("unreachable candidates are reported, not silently dropped",
          [c["id"] for c in unreachable] == ["c-gone"] and "reason" in unreachable[0], unreachable)
    check("internal node ids do not leak into results", all("node" not in c for c in ranked + unreachable))
    check("an invalid rankBy is refused", raises(
        lambda: worker.rank_candidates(g, "n1", candidates, costs, "price"), "bad_params") is not None)

    limited, _ = worker.rank_candidates(g, "n1", candidates, costs, "time", limit=1)
    check("limit truncates the ranking", len(limited) == 1)


def test_isochrone():
    g = build_graph()

    within_2min = set(worker.isochrone_nodes(g, "n1", 120, nx))
    check("2-minute reach covers exactly the fast corridor", within_2min == {"n1", "n6", "n5"}, within_2min)
    within_5min = set(worker.isochrone_nodes(g, "n1", 300, nx))
    check("5-minute reach covers the whole connected network", within_5min == set(NODES) - {"n9"}, within_5min)
    check("the isolated node is never reachable", "n9" not in within_5min)

    feature = worker.isochrone_polygon(g, sorted(within_5min), 5, "drive")
    check("isochrone is a Polygon (FR-ROUTE-009)", feature["geometry"]["type"] == "Polygon")
    ring = feature["geometry"]["coordinates"][0]
    check("polygon ring is closed", ring[0] == ring[-1] and len(ring) >= 4, ring)
    check("isochrone is labelled approximate", feature["properties"]["approximate"] is True
          and feature["properties"]["method"] == "convex-hull-of-reachable-nodes")
    check("isochrone reports its node count and area",
          feature["properties"]["nodeCount"] == 6 and feature["properties"]["areaKm2"] > 0, feature["properties"])

    tiny = worker.isochrone_polygon(g, ["n1"], 1, "drive")
    check("a single-node isochrone degrades to a flagged null geometry",
          tiny["geometry"] is None and tiny["properties"]["degenerate"] is True, tiny)


# ---------- §8.5 envelope ----------


def test_envelope():
    ok = worker.handle({"op": "echo", "params": {"hello": "route"}})
    check("ok envelope shape", ok["ok"] is True and ok["error"] is None and ok["result"]["echo"] == {"hello": "route"}, ok)

    unknown = worker.handle({"op": "nope", "params": {}})
    check("unknown op yields an error envelope",
          unknown["ok"] is False and unknown["result"] is None and unknown["error"]["code"] == "unknown_op", unknown)
    check("unknown op lists the known ops", "route" in unknown["error"]["message"])

    boom = worker.handle({"op": "boom", "params": {"message": "kaboom"}})
    check("an unexpected exception becomes an error envelope",
          boom["ok"] is False and boom["error"]["code"] == "worker_exception" and "kaboom" in boom["error"]["message"], boom)

    bad = worker.handle({"op": "route", "params": {"origin": [36.35, 127.38]}})
    check("missing destination is a bad_params error", bad["error"]["code"] == "bad_params", bad)
    mode = worker.handle({"op": "route", "params": {"origin": [36.35, 127.38], "destination": [36.36, 127.39], "mode": "hovercraft"}})
    check("an unsupported mode is refused (FR-ROUTE-003)",
          mode["error"]["code"] == "bad_params" and "hovercraft" in mode["error"]["message"], mode)

    check("a non-object request is refused", worker.handle(["not", "an", "object"])["error"]["code"] == "bad_request")

    caps = worker.handle({"op": "capabilities", "params": {}})
    check("capabilities lists every op", set(caps["result"]["ops"]) == set(worker.OPS))
    check("capabilities reports the allowlist (§8.4)",
          caps["result"]["defaults"]["allowedHosts"] == ["overpass-api.de"], caps["result"]["defaults"])


def main():
    print("worker offline checks — %s\n" % os.path.basename(worker.__file__))
    test_bbox_and_cap()
    test_hull()
    test_envelope()
    if nx is None:
        skip("graph algorithms (routing, nearest, isochrone)", "networkx not importable")
    else:
        test_routing()
        test_nearest()
        test_isochrone()
    print("\n%d passed, %d failed, %d skipped" % (len(PASS), len(FAIL), len(SKIP)))
    if FAIL:
        print("failed: " + ", ".join(FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
