#!/usr/bin/env python3
"""ana-geo-satellite-change-detection Python worker (PRD §8.5).

Request  (stdin) : {"op": string, "params": object}
Response (stdout): {"ok": bool, "result": object|null,
                    "error": {"code": string, "message": string}|null}

stderr is logs only and is never parsed as data (§8.5).

Supported ops
  change_detect  NDVI difference change detection between two Sentinel-2 L2A
                 scenes over an AOI (FR-CD-003 … FR-CD-011).
  ping           envelope round-trip probe used by the smoke tests; also the
                 only way to force an unhandled exception on purpose
                 (params.forceError).

Nothing in this file imports another ANA Geo app (§9).
"""

import json
import math
import sys
import traceback

# rasterio/numpy are heavy; import failure must still produce a valid envelope
# so the Watch surface can explain what to install (§25 "Python worker failure").
try:
    import numpy as np
    import rasterio
    from rasterio import features as rfeatures
    from rasterio import warp as rwarp
    from rasterio.windows import Window, from_bounds as window_from_bounds

    IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - exercised only on a broken install
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


METHOD = "ndvi-difference"

# Sentinel-2 L2A digital numbers are scaled reflectance. Processing baseline
# 04.00+ additionally carries BOA_ADD_OFFSET = -1000, i.e.
#     reflectance = (DN + BOA_ADD_OFFSET) * 1e-4  ==  DN * scale + offset
# with scale 1e-4 and offset -0.1. NDVI is a normalized ratio and is therefore
# invariant to `scale` but NOT to `offset`: skipping the offset on a baseline
# 4.0+ scene biases NDVI, and mixing an offset scene with a pre-4.0 one biases
# the *difference*. The caller passes the per-asset `raster:bands[0]`
# scale/offset from the STAC item when present; these are the fallbacks.
DEFAULT_SCALE = 1e-4
DEFAULT_OFFSET = 0.0

# §26.1 — polygonization can emit tens of thousands of speckles; cap what is
# handed to the browser and say so.
MAX_REGIONS = 2000
# Pixels read per band per scene. 4 reads (red/nir × before/after) of a
# 4000×4000 window is ~256 MB of float64 — refuse before the OS does.
MAX_WINDOW_PIXELS = 4000 * 4000

# Smallest NIR+RED reflectance sum for which NDVI is still meaningful; see _ndvi.
NDVI_MIN_SUM = 0.01


class WorkerError(Exception):
    """An error with a §25 error code, reported through the failure envelope."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- asset access


def resolve_path(href, allow_local=False):
    """Map a STAC asset href to something rasterio can open.

    https URLs become `/vsicurl/…` so GDAL issues HTTP range requests and reads
    only the tiles a window touches — never the whole band (§26.2, §8.4).
    Local paths are refused unless the caller explicitly opts in, which only the
    offline synthetic test does; server.js never sets `allowLocal` (§27.1).
    """
    if not isinstance(href, str) or not href:
        raise WorkerError("invalid_params", "asset href missing")
    if href.startswith("https://"):
        return "/vsicurl/" + href
    if href.startswith("http://"):
        raise WorkerError("raster_asset_unavailable", f"refusing plaintext http asset: {href}")
    if allow_local:
        return href
    raise WorkerError(
        "raster_asset_unavailable",
        f"asset href must be an https URL, got: {href[:120]}",
    )


def asset_of(scene, band, allow_local=False):
    """Pull one band's href + reflectance scaling out of a scene record."""
    assets = scene.get("assets") or {}
    entry = assets.get(band)
    if entry is None:
        available = ", ".join(sorted(assets)) or "(none)"
        raise WorkerError(
            "raster_asset_unavailable",
            f"scene '{scene.get('id')}' has no '{band}' asset (available: {available})",
        )
    if isinstance(entry, str):
        entry = {"href": entry}
    return {
        "path": resolve_path(entry.get("href"), allow_local),
        "scale": float(entry.get("scale", DEFAULT_SCALE)),
        "offset": float(entry.get("offset", DEFAULT_OFFSET)),
    }


# ------------------------------------------------------------------- alignment


def grid_code_of(scene):
    """MGRS tile identifier of a scene, e.g. 'MGRS-52-S-CG'."""
    code = scene.get("gridCode")
    if code:
        return str(code)
    props = scene.get("properties") or {}
    if props.get("grid:code"):
        return str(props["grid:code"])
    zone, band, square = props.get("mgrs:utm_zone"), props.get("mgrs:latitude_band"), props.get("mgrs:grid_square")
    if zone and band and square:
        return f"MGRS-{zone}-{band}-{square}"
    return None


def normalize_grid_code(code):
    """Canonical MGRS tile key for comparison.

    Earth Search publishes `grid:code` as 'MGRS-52SCF' while the `mgrs:*`
    property fallback composes 'MGRS-52-S-CF'. Both name the same tile, so
    equality is tested on the letters and digits only — otherwise a pair that
    is perfectly aligned gets rejected over punctuation.
    """
    return "".join(ch for ch in str(code).upper() if ch.isalnum()) if code else None


def require_same_tile(before, after):
    """FR-CD-003, first gate.

    v1 aligns by *not* resampling: two scenes from the same MGRS tile already
    share CRS, resolution, extent and pixel grid, so a window read at identical
    coordinates yields co-registered arrays. A cross-tile pair would need
    reprojection and is explicitly out of v1 scope (§21.5).
    """
    b, a = grid_code_of(before), grid_code_of(after)
    if not b or not a:
        raise WorkerError(
            "incompatible_raster",
            "scene MGRS tile is unknown; v1 requires a same-tile before/after pair",
        )
    if normalize_grid_code(b) != normalize_grid_code(a):
        raise WorkerError(
            "incompatible_raster",
            f"before scene is on tile {b} but after scene is on tile {a}; "
            "v1 requires a same-tile pair (cross-tile reprojection is not implemented)",
        )
    return b


def require_same_grid(datasets):
    """FR-CD-003, second gate: verify the grids really do coincide."""
    ref_name, ref = datasets[0]
    for name, ds in datasets[1:]:
        if ds.crs != ref.crs:
            raise WorkerError("incompatible_raster", f"CRS mismatch: {ref_name}={ref.crs} vs {name}={ds.crs}")
        if not _close(ds.res, ref.res):
            raise WorkerError("incompatible_raster", f"resolution mismatch: {ref_name}={ref.res} vs {name}={ds.res}")
        if not _close(tuple(ds.transform)[:6], tuple(ref.transform)[:6]):
            raise WorkerError("incompatible_raster", f"pixel grid origin mismatch between {ref_name} and {name}")
        if (ds.width, ds.height) != (ref.width, ref.height):
            raise WorkerError("incompatible_raster", f"raster extent mismatch: {ref_name} vs {name}")
    return ref


def _close(a, b, tol=1e-6):
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


# ---------------------------------------------------------------------- window


def aoi_window(ds, bbox_lat_lng):
    """AOI (lon/lat) → pixel window in the scene's own projected CRS.

    Both the reprojection and the clamp matter: `transform_bounds` gives the
    UTM envelope of the lon/lat box, and the clamp keeps the window inside the
    raster so `read(window=…)` returns real pixels instead of silently padding
    with the fill value.
    """
    if not (isinstance(bbox_lat_lng, (list, tuple)) and len(bbox_lat_lng) == 4):
        raise WorkerError("unsupported_geometry", "bboxLatLng must be [west, south, east, north]")
    w, s, e, n = (float(v) for v in bbox_lat_lng)
    if not (w < e and s < n):
        raise WorkerError("invalid_spatial_condition", f"degenerate AOI bbox: {bbox_lat_lng}")

    left, bottom, right, top = rwarp.transform_bounds("EPSG:4326", ds.crs, w, s, e, n, densify_pts=21)
    win = window_from_bounds(left, bottom, right, top, transform=ds.transform)

    col_off = max(0, int(math.floor(win.col_off)))
    row_off = max(0, int(math.floor(win.row_off)))
    col_end = min(ds.width, int(math.ceil(win.col_off + win.width)))
    row_end = min(ds.height, int(math.ceil(win.row_off + win.height)))
    if col_end <= col_off or row_end <= row_off:
        raise WorkerError(
            "invalid_spatial_condition",
            "the AOI does not intersect the selected scenes — pan the map over the scene footprint",
        )

    window = Window(col_off, row_off, col_end - col_off, row_end - row_off)
    if window.width * window.height > MAX_WINDOW_PIXELS:
        raise WorkerError(
            "invalid_spatial_condition",
            f"AOI is too large: {int(window.width)}×{int(window.height)} pixels "
            f"(limit {MAX_WINDOW_PIXELS:,}) — zoom in and run again",
        )
    return window


def read_band(path, window, scale, offset):
    """Read one band window as reflectance, with nodata as NaN (FR-CD-004)."""
    try:
        with rasterio.open(path) as ds:
            arr = ds.read(1, window=window, boundless=False).astype("float64")
            nodata = ds.nodata
    except WorkerError:
        raise
    except Exception as exc:
        raise WorkerError("raster_asset_unavailable", f"cannot read {path}: {type(exc).__name__}: {exc}")
    # Sentinel-2 L2A uses 0 as the no-data DN in addition to any declared value.
    mask = arr == 0
    if nodata is not None:
        mask |= arr == nodata
    out = arr * scale + offset
    out[mask] = np.nan
    return out


def open_checked(path):
    try:
        return rasterio.open(path)
    except Exception as exc:
        raise WorkerError("raster_asset_unavailable", f"cannot open {path}: {type(exc).__name__}: {exc}")


# ------------------------------------------------------------------- geometry


def ring_area(ring):
    """Shoelace area of one closed ring, in the ring's own (projected) units."""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def polygon_area(coords):
    """Projected area of a GeoJSON Polygon: exterior minus every hole.

    Areas are computed in the scene's UTM CRS, never in degrees — a square
    degree is not an area and varies with latitude (§21.5 / FR-CD-008).
    """
    if not coords:
        return 0.0
    area = ring_area(coords[0])
    for hole in coords[1:]:
        area -= ring_area(hole)
    return max(area, 0.0)


# -------------------------------------------------------------- change_detect


def op_change_detect(params):
    before = params.get("beforeItem") or {}
    after = params.get("afterItem") or {}
    if not before or not after:
        raise WorkerError("invalid_params", "beforeItem and afterItem are required")

    threshold = float(params.get("threshold", 0.2))
    if not (0 < threshold <= 2):
        raise WorkerError("invalid_params", f"threshold must be in (0, 2], got {threshold}")
    direction = str(params.get("direction", "both"))
    if direction not in ("both", "loss", "gain"):
        raise WorkerError("invalid_params", f"direction must be both|loss|gain, got {direction}")
    min_region_sq_m = float(params.get("minRegionSqM", 10000.0))
    allow_local = bool(params.get("allowLocal", False))

    tile = require_same_tile(before, after)  # FR-CD-003

    band_specs = {
        "before_red": asset_of(before, "red", allow_local),
        "before_nir": asset_of(before, "nir", allow_local),
        "after_red": asset_of(after, "red", allow_local),
        "after_nir": asset_of(after, "nir", allow_local),
    }

    opened = [(name, open_checked(spec["path"])) for name, spec in band_specs.items()]
    try:
        ref = require_same_grid(opened)  # FR-CD-003
        window = aoi_window(ref, params.get("bboxLatLng"))
        win_transform = ref.window_transform(window)
        crs = ref.crs
        pixel_w, pixel_h = abs(win_transform.a), abs(win_transform.e)
        pixel_area = pixel_w * pixel_h  # m², CRS is projected (UTM)
    finally:
        for _, ds in opened:
            ds.close()

    bands = {
        name: read_band(spec["path"], window, spec["scale"], spec["offset"])
        for name, spec in band_specs.items()
    }

    with np.errstate(divide="ignore", invalid="ignore"):
        # FR-CD-004 — NDVI = (NIR − RED) / (NIR + RED)
        ndvi_before = _ndvi(bands["before_nir"], bands["before_red"])
        ndvi_after = _ndvi(bands["after_nir"], bands["after_red"])
        diff = ndvi_after - ndvi_before  # FR-CD-005 — after − before

    valid = np.isfinite(diff)
    if not valid.any():
        raise WorkerError(
            "incompatible_raster",
            "no valid pixels in the AOI for both scenes (cloud mask, scene edge, or all-nodata window)",
        )

    # FR-CD-006 / FR-CD-007 — threshold classification into a change raster.
    if direction == "loss":
        changed = valid & (diff <= -threshold)
    elif direction == "gain":
        changed = valid & (diff >= threshold)
    else:
        changed = valid & (np.abs(diff) >= threshold)

    changed_pixels = int(changed.sum())
    valid_pixels = int(valid.sum())
    changed_area_sq_km = changed_pixels * pixel_area / 1e6  # FR-CD-008

    # FR-CD-009 — vectorize the change raster. 4-connectivity keeps regions that
    # only touch at a corner separate, which matches how they read on the map.
    mask = changed.astype("uint8")
    regions = []
    for geom, value in rfeatures.shapes(mask, mask=changed, transform=win_transform, connectivity=4):
        if value != 1:
            continue
        area_sq_m = polygon_area(geom["coordinates"])
        if area_sq_m < min_region_sq_m:
            continue
        regions.append({"geometry": geom, "areaSqM": area_sq_m})

    # FR-CD-011 — rank by area, largest first.
    regions.sort(key=lambda r: r["areaSqM"], reverse=True)
    dropped = 0
    if len(regions) > MAX_REGIONS:
        dropped = len(regions) - MAX_REGIONS
        regions = regions[:MAX_REGIONS]

    features = []
    summary = []
    for rank, region in enumerate(regions, start=1):
        geom_ll = rwarp.transform_geom(crs, "EPSG:4326", region["geometry"], precision=6)
        stats = _region_stats(diff, changed, region["geometry"], win_transform)
        area_sq_km = round(region["areaSqM"] / 1e6, 6)
        rid = f"change-{rank:03d}"
        summary.append(
            {
                "id": rid,
                "rank": rank,
                "areaSqKm": area_sq_km,
                "areaSqM": round(region["areaSqM"], 3),
                "meanDiff": stats["mean"],
                "minDiff": stats["min"],
                "maxDiff": stats["max"],
                "direction": "loss" if stats["mean"] < 0 else "gain",
            }
        )
        features.append(
            {
                "type": "Feature",
                "id": rid,
                "geometry": geom_ll,
                "properties": {
                    "name": f"Change region {rank}",
                    "category": "ndvi-change",
                    "source": "sentinel-2-l2a",
                    "sourceId": f"{before.get('id')}→{after.get('id')}",
                    "score": stats["mean"],
                    "rank": rank,
                    "areaSqKm": area_sq_km,
                    "metrics": {
                        "areaSqM": round(region["areaSqM"], 3),
                        "meanNdviDiff": stats["mean"],
                        "minNdviDiff": stats["min"],
                        "maxNdviDiff": stats["max"],
                    },
                    "direction": "loss" if stats["mean"] < 0 else "gain",
                    "fetchedAt": None,
                },
            }
        )

    notes = []
    window_pixels = int(window.width) * int(window.height)
    unusable = 1.0 - (valid_pixels / window_pixels if window_pixels else 1.0)
    if unusable > 0.2:
        # Usually cloud, water, shadow or a scene edge — but a reflectance
        # scaling mismatch looks identical from here, so name both.
        notes.append(
            f"{unusable * 100:.0f}% of the AOI has no usable NDVI in one of the scenes "
            "(cloud, water, shadow, scene edge, or a reflectance scaling mismatch)"
        )
    if dropped:
        notes.append(f"{dropped} smaller region(s) dropped: capped at {MAX_REGIONS} polygons")
    if not features and changed_pixels:
        notes.append(
            f"{changed_pixels} changed pixel(s) found, but no region reached the "
            f"{min_region_sq_m:,.0f} m² minimum area"
        )
    if not changed_pixels:
        notes.append(f"no pixel exceeded NDVI change threshold {threshold:.2f}")

    return {
        # §21.6 result model, plus the provenance fields §28 asks for.
        "changeDetection": {
            "method": METHOD,
            "beforeScene": before.get("id"),
            "afterScene": after.get("id"),
            "threshold": threshold,
            "direction": direction,
            "changedAreaSqKm": round(changed_area_sq_km, 6),
            "regionsAreaSqKm": round(sum(r["areaSqKm"] for r in summary), 6),
            "regionCount": len(summary),
            "regions": summary,
        },
        "raster": {
            "tile": tile,
            "crs": str(crs),
            "pixelSizeM": [pixel_w, pixel_h],
            "window": {
                "colOff": int(window.col_off),
                "rowOff": int(window.row_off),
                "width": int(window.width),
                "height": int(window.height),
            },
            "changedPixels": changed_pixels,
            "validPixels": valid_pixels,
            "minRegionSqM": min_region_sq_m,
            "droppedRegions": dropped,
        },
        "geojson": {"type": "FeatureCollection", "features": features},
        "notes": notes,
    }


def _ndvi(nir, red):
    """NDVI = (NIR − RED) / (NIR + RED), with the unstable pixels dropped.

    Two guards, both load-bearing on real L2A data:

    1. `nir + red` near zero. After BOA_ADD_OFFSET the reflectance of deep
       water, shadow and burnt surfaces can be ~0 or slightly negative, and the
       ratio then amplifies sensor noise without limit — an unguarded division
       on a Daejeon scene produced NDVI differences of 1e16, which then
       dominate every region statistic.
    2. |NDVI| > 1. Algebraically impossible for non-negative reflectance, so a
       result outside the range means the inputs were non-physical.

    Both cases become NaN, i.e. "no vegetation information here", and are
    excluded from the valid-pixel count rather than silently clipped.
    """
    denom = nir + red
    unstable = ~np.isfinite(denom) | (denom < NDVI_MIN_SUM)
    safe = np.where(unstable, 1.0, denom)
    out = np.where(unstable, np.nan, (nir - red) / safe)
    return np.where(np.abs(out) > 1.0, np.nan, out)


def _region_stats(diff, changed, geom, transform):
    """Mean/min/max NDVI difference inside one region (§23.3 explainability)."""
    region_mask = rfeatures.geometry_mask(
        [geom], out_shape=diff.shape, transform=transform, invert=True, all_touched=False
    )
    sel = region_mask & changed & np.isfinite(diff)
    if not sel.any():
        return {"mean": None, "min": None, "max": None}
    values = diff[sel]
    return {
        "mean": round(float(values.mean()), 4),
        "min": round(float(values.min()), 4),
        "max": round(float(values.max()), 4),
    }


# ----------------------------------------------------------------------- ping


def op_ping(params):
    """Envelope round-trip probe (see module docstring).

    `forceError` raises on purpose and `sleepMs` stalls on purpose; both exist
    so the smoke tests can exercise the failure and timeout branches of the
    Node side without waiting for a real raster job to go wrong.
    """
    if params.get("forceError"):
        raise RuntimeError("forced worker exception (ping.forceError)")
    sleep_ms = float(params.get("sleepMs") or 0)
    if sleep_ms > 0:
        import time

        time.sleep(min(sleep_ms, 120_000) / 1000.0)
    return {"pong": True, "echo": params}


OPS = {"change_detect": op_change_detect, "ping": op_ping}


# ------------------------------------------------------------------- dispatch


def run(request):
    op = request.get("op")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        return fail("invalid_params", "params must be an object")
    handler = OPS.get(op)
    if handler is None:
        return fail("unknown_op", f"unknown op: {op!r} (known: {', '.join(sorted(OPS))})")
    if IMPORT_ERROR and op != "ping":
        return fail(
            "worker_dependency_missing",
            f"Python dependencies are not installed ({IMPORT_ERROR}). "
            "Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        )
    try:
        return {"ok": True, "result": handler(params), "error": None}
    except WorkerError as exc:
        return fail(exc.code, exc.message)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)  # stderr is logs only (§8.5)
        return fail("worker_failure", f"{type(exc).__name__}: {exc}")


def fail(code, message):
    return {"ok": False, "result": None, "error": {"code": code, "message": message}}


def main():
    raw = sys.stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        response = fail("invalid_params", f"request is not valid JSON: {exc}")
    else:
        response = run(request if isinstance(request, dict) else {})
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
