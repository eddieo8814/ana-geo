#!/usr/bin/env python3
"""Offline synthetic test for the change-detection worker.

Builds a UTM 52N / 10 m raster pair with three planted NDVI change patches of
known size, runs the real `change_detect` op over local files, and asserts the
areas, the ranking and the change classification against values computed by
hand. Nothing here touches the network, so this is the check that has to pass
whether or not Earth Search is reachable.

    python3 tools/smoke_synthetic.py        (or .venv/bin/python3)

Exit code 0 = all assertions passed.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import worker  # noqa: E402  (the module under test)

# ---------------------------------------------------------------- fixture plan
#
# EPSG:32652 (WGS 84 / UTM zone 52N) — the zone Daejeon sits in — at 10 m,
# which is the native grid of Sentinel-2 red (B04) and nir (B08).
CRS = "EPSG:32652"
PIXEL = 10.0
WIDTH = HEIGHT = 200
ORIGIN_X, ORIGIN_Y = 400_000.0, 4_030_000.0  # top-left corner, easting/northing

# Three rectangles, in (row0, col0, rows, cols, ndvi_after) form. Areas follow
# directly: rows*cols*100 m². They are planted in *decreasing* size so the
# expected ranking is patch 1, 2, 3.
PATCHES = [
    {"name": "clearcut",  "row": 20,  "col": 20,  "rows": 40, "cols": 30, "ndvi_after": 0.10},  # 1200 px, loss
    {"name": "newgrowth", "row": 100, "col": 40,  "rows": 20, "cols": 20, "ndvi_after": 0.95},  # 400 px, gain
    {"name": "smallcut",  "row": 150, "col": 150, "rows": 10, "cols": 15, "ndvi_after": 0.20},  # 150 px, loss
]
BACKGROUND_NDVI = 0.60
# One patch under the minimum-area filter, to prove the filter actually filters.
SPECKLE = {"row": 5, "col": 190, "rows": 3, "cols": 3, "ndvi_after": 0.05}  # 900 m²

THRESHOLD = 0.2
MIN_REGION_SQ_M = 10_000.0  # 1 ha = 100 pixels at 10 m

EXPECTED = [
    {"id": "change-001", "rank": 1, "area_sq_km": 1200 * 100 / 1e6, "direction": "loss"},   # 0.120
    {"id": "change-002", "rank": 2, "area_sq_km": 400 * 100 / 1e6, "direction": "gain"},    # 0.040
    {"id": "change-003", "rank": 3, "area_sq_km": 150 * 100 / 1e6, "direction": "loss"},    # 0.015
]
# changedAreaSqKm counts every changed pixel, including the speckle that is too
# small to become a ranked region.
EXPECTED_CHANGED_PIXELS = 1200 + 400 + 150 + 9
EXPECTED_CHANGED_AREA_SQ_KM = EXPECTED_CHANGED_PIXELS * 100 / 1e6  # 0.17590


# ---------------------------------------------------------------- fixture I/O


def ndvi_to_dn(ndvi):
    """Invert NDVI into a (red, nir) DN pair the worker will read back.

    Fix red reflectance at 0.10 and solve nir from
        ndvi = (nir - red) / (nir + red)   ⇒   nir = red * (1 + ndvi)/(1 - ndvi)
    then invert the L2A scaling `reflectance = DN * 1e-4 - 0.1`, i.e. the
    baseline 04.00+ BOA_ADD_OFFSET case, so the test also proves the worker
    applies the offset. (With the offset ignored, a 0.60 background NDVI reads
    back as ~0.35 and the diffs move — the assertions below would fail.)
    """
    red_reflectance = 0.10
    nir_reflectance = red_reflectance * (1.0 + ndvi) / (1.0 - ndvi)
    to_dn = lambda r: np.rint((r + 0.1) / 1e-4).astype("uint16")  # noqa: E731
    return to_dn(np.full_like(ndvi, red_reflectance, dtype="float64")), to_dn(nir_reflectance)


def write_band(path, array, transform):
    with rasterio.open(
        path, "w", driver="GTiff", height=array.shape[0], width=array.shape[1],
        count=1, dtype="uint16", crs=CRS, transform=transform, nodata=0,
        tiled=True, blockxsize=128, blockysize=128, compress="deflate",
    ) as dst:
        dst.write(array, 1)


def build_fixture(tmpdir):
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL, PIXEL)

    ndvi_before = np.full((HEIGHT, WIDTH), BACKGROUND_NDVI, dtype="float64")
    ndvi_after = ndvi_before.copy()
    for patch in PATCHES + [SPECKLE]:
        r, c, h, w = patch["row"], patch["col"], patch["rows"], patch["cols"]
        ndvi_after[r:r + h, c:c + w] = patch["ndvi_after"]

    paths = {}
    for label, ndvi in (("before", ndvi_before), ("after", ndvi_after)):
        red, nir = ndvi_to_dn(ndvi)
        for band, arr in (("red", red), ("nir", nir)):
            p = os.path.join(tmpdir, f"{label}_{band}.tif")
            write_band(p, arr, transform)
            paths[f"{label}_{band}"] = p

    def scene(label, grid_code="MGRS-52-S-CG"):
        return {
            "id": f"S2A_TEST_{label.upper()}",
            "gridCode": grid_code,
            "assets": {
                "red": {"href": paths[f"{label}_red"], "scale": 1e-4, "offset": -0.1},
                "nir": {"href": paths[f"{label}_nir"], "scale": 1e-4, "offset": -0.1},
            },
        }

    # AOI = the whole raster, expressed in lon/lat as the client would send it.
    west, south, east, north = transform_bounds(
        CRS, "EPSG:4326",
        ORIGIN_X, ORIGIN_Y - HEIGHT * PIXEL, ORIGIN_X + WIDTH * PIXEL, ORIGIN_Y,
        densify_pts=21,
    )
    # Pad outwards so the reprojected AOI covers the raster; the worker clamps
    # the window to the raster extent.
    pad = 0.01
    bbox = [west - pad, south - pad, east + pad, north + pad]
    return scene, bbox


# ------------------------------------------------------------------ assertions


PASSED = []


def check(label, actual, expected, places=None):
    if places is not None:
        ok = round(float(actual), places) == round(float(expected), places)
    else:
        ok = actual == expected
    if not ok:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
    PASSED.append(label)
    print(f"  ok  {label}  = {actual!r}")


def section(title):
    print(f"\n{title}")


# ----------------------------------------------------------------------- tests


def test_change_detect(scene, bbox):
    section("1. change_detect over the synthetic pair (FR-CD-003 … FR-CD-011)")
    env = worker.run({
        "op": "change_detect",
        "params": {
            "beforeItem": scene("before"), "afterItem": scene("after"),
            "bboxLatLng": bbox, "threshold": THRESHOLD,
            "direction": "both", "minRegionSqM": MIN_REGION_SQ_M,
            "allowLocal": True,  # offline fixture; server.js strips this flag
        },
    })
    if not env["ok"]:
        raise AssertionError(f"worker failed: {env['error']}")
    cd = env["result"]["changeDetection"]
    raster = env["result"]["raster"]
    features = env["result"]["geojson"]["features"]

    check("method", cd["method"], "ndvi-difference")
    check("threshold echoed", cd["threshold"], THRESHOLD)
    check("crs preserved", raster["crs"], CRS)
    check("pixel size", raster["pixelSizeM"], [PIXEL, PIXEL])
    check("valid pixels", raster["validPixels"], WIDTH * HEIGHT)
    check("changed pixels", raster["changedPixels"], EXPECTED_CHANGED_PIXELS)
    # FR-CD-008 — total changed area, to the third decimal of a km².
    check("changedAreaSqKm", cd["changedAreaSqKm"], EXPECTED_CHANGED_AREA_SQ_KM, places=3)
    check("regionCount", cd["regionCount"], len(EXPECTED))
    check("feature count", len(features), len(EXPECTED))

    # FR-CD-009 / FR-CD-011 — polygonized, ranked by area, largest first.
    for expected, region, feature in zip(EXPECTED, cd["regions"], features):
        check(f"{expected['id']} rank", region["rank"], expected["rank"])
        check(f"{expected['id']} id", region["id"], expected["id"])
        check(f"{expected['id']} areaSqKm", region["areaSqKm"], expected["area_sq_km"], places=3)
        check(f"{expected['id']} direction", region["direction"], expected["direction"])
        check(f"{expected['id']} feature id", feature["id"], expected["id"])
        check(f"{expected['id']} geometry type", feature["geometry"]["type"], "Polygon")
        # Polygons are handed to Leaflet in lon/lat, never in UTM metres.
        lon, lat = feature["geometry"]["coordinates"][0][0]
        if not (126 < lon < 129 and 35 < lat < 37):
            raise AssertionError(f"{expected['id']}: polygon not in lon/lat near Daejeon: {(lon, lat)}")
        PASSED.append(f"{expected['id']} lon/lat")
        print(f"  ok  {expected['id']} lon/lat = {(round(lon, 5), round(lat, 5))!r}")

    check("ranked area total", cd["regionsAreaSqKm"], sum(e["area_sq_km"] for e in EXPECTED), places=3)
    # The 900 m² speckle is counted as changed but never becomes a region.
    check("speckle filtered out", raster["changedPixels"] > sum(
        int(r["areaSqM"]) // 100 for r in cd["regions"]), True)

    section("2. mean NDVI difference per region (§23.3 explainability)")
    # Planted values: 0.10−0.60 = −0.50, 0.95−0.60 = +0.35, 0.20−0.60 = −0.40.
    for expected_mean, region in zip([-0.5, 0.35, -0.4], cd["regions"]):
        check(f"{region['id']} meanDiff", region["meanDiff"], expected_mean, places=3)


def test_threshold_is_configurable(scene, bbox):
    section("3. threshold changes the result (FR-CD-006)")
    # 0.45 keeps only the −0.50 clearcut; 0.30 keeps all three.
    for threshold, expected_regions in ((0.45, 1), (0.30, 3)):
        env = worker.run({"op": "change_detect", "params": {
            "beforeItem": scene("before"), "afterItem": scene("after"), "bboxLatLng": bbox,
            "threshold": threshold, "minRegionSqM": MIN_REGION_SQ_M, "allowLocal": True,
        }})
        assert env["ok"], env["error"]
        check(f"threshold {threshold} → regions", env["result"]["changeDetection"]["regionCount"], expected_regions)


def test_direction_filter(scene, bbox):
    section("4. direction filter (§21.7 'vegetation loss, not growth')")
    for direction, expected_regions in (("loss", 2), ("gain", 1), ("both", 3)):
        env = worker.run({"op": "change_detect", "params": {
            "beforeItem": scene("before"), "afterItem": scene("after"), "bboxLatLng": bbox,
            "threshold": THRESHOLD, "direction": direction,
            "minRegionSqM": MIN_REGION_SQ_M, "allowLocal": True,
        }})
        assert env["ok"], env["error"]
        check(f"direction {direction} → regions", env["result"]["changeDetection"]["regionCount"], expected_regions)


def test_tile_mismatch_rejected(scene, bbox):
    section("5. cross-tile pair is refused (FR-CD-003)")
    env = worker.run({"op": "change_detect", "params": {
        "beforeItem": scene("before", "MGRS-52-S-CG"),
        "afterItem": scene("after", "MGRS-52-S-DG"),
        "bboxLatLng": bbox, "threshold": THRESHOLD, "allowLocal": True,
    }})
    check("ok flag", env["ok"], False)
    check("error code", env["error"]["code"], "incompatible_raster")
    if "MGRS-52-S-DG" not in env["error"]["message"]:
        raise AssertionError("error message should name the mismatching tiles")
    PASSED.append("error names both tiles")
    print("  ok  error names both tiles")


def test_aoi_outside_scene(scene):
    section("6. AOI outside the scene is refused (§25 invalid spatial condition)")
    env = worker.run({"op": "change_detect", "params": {
        "beforeItem": scene("before"), "afterItem": scene("after"),
        "bboxLatLng": [10.0, 45.0, 10.1, 45.1],  # somewhere in Italy
        "threshold": THRESHOLD, "allowLocal": True,
    }})
    check("ok flag", env["ok"], False)
    check("error code", env["error"]["code"], "invalid_spatial_condition")


def test_local_path_refused_by_default(scene, bbox):
    section("7. local asset paths are refused without allowLocal (§27.1)")
    env = worker.run({"op": "change_detect", "params": {
        "beforeItem": scene("before"), "afterItem": scene("after"),
        "bboxLatLng": bbox, "threshold": THRESHOLD,  # no allowLocal
    }})
    check("ok flag", env["ok"], False)
    check("error code", env["error"]["code"], "raster_asset_unavailable")


def test_envelope_contract():
    section("8. worker envelope contract (§8.5)")
    ok = worker.run({"op": "ping", "params": {"hello": "world"}})
    check("ping ok", ok["ok"], True)
    check("ping echo", ok["result"]["echo"], {"hello": "world"})
    check("ping error is null", ok["error"], None)

    unknown = worker.run({"op": "no_such_op", "params": {}})
    check("unknown op ok flag", unknown["ok"], False)
    check("unknown op code", unknown["error"]["code"], "unknown_op")
    check("unknown op result is null", unknown["result"], None)

    boom = worker.run({"op": "ping", "params": {"forceError": True}})
    check("forced exception ok flag", boom["ok"], False)
    check("forced exception code", boom["error"]["code"], "worker_failure")

    bad = worker.run({"op": "change_detect", "params": {}})
    check("missing scenes code", bad["error"]["code"], "invalid_params")


def test_subprocess_roundtrip():
    section("9. stdin/stdout round trip through the real process (§8.5)")
    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "worker.py")],
        input=json.dumps({"op": "ping", "params": {"n": 1}}),
        capture_output=True, text=True, timeout=60,
    )
    check("exit code", proc.returncode, 0)
    env = json.loads(proc.stdout)
    check("stdout is one envelope", env["ok"], True)
    check("echo survived the pipe", env["result"]["echo"], {"n": 1})

    proc = subprocess.run(
        [sys.executable, os.path.join(HERE, "worker.py")],
        input="not json at all", capture_output=True, text=True, timeout=60,
    )
    env = json.loads(proc.stdout)
    check("bad json → envelope", env["error"]["code"], "invalid_params")


def main():
    tmpdir = tempfile.mkdtemp(prefix="ana-geo-cd-synth-")
    try:
        scene, bbox = build_fixture(tmpdir)
        print(f"fixture: {WIDTH}×{HEIGHT} px @ {PIXEL} m, {CRS}, AOI {[round(v, 4) for v in bbox]}")
        test_change_detect(scene, bbox)
        test_threshold_is_configurable(scene, bbox)
        test_direction_filter(scene, bbox)
        test_tile_mismatch_rejected(scene, bbox)
        test_aoi_outside_scene(scene)
        test_local_path_refused_by_default(scene, bbox)
        test_envelope_contract()
        test_subprocess_roundtrip()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    print(f"\nPASS — {len(PASSED)} assertions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
