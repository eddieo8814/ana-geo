// AOI definition — viewport bbox (FR-SAT-001) and rectangle drawing (FR-SAT-002).
// Browser global: GeoAoi. No imports from other apps (§9).
/* global L */

(function (global) {
  'use strict';

  const AOI_STYLE = { color: '#f59e0b', weight: 2, dashArray: '6 4', fill: true, fillOpacity: 0.06 };

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  // [west, south, east, north] — the bbox order STAC expects (§20.4).
  function bboxFromBounds(b) {
    return [round6(b.getWest()), round6(b.getSouth()), round6(b.getEast()), round6(b.getNorth())];
  }

  function boundsFromBbox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    return L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
  }

  // FR-SAT-002 also accepts a loaded polygon; v1 reduces it to its bbox because
  // §20.4 fixes `bbox` as the search parameter. Documented in SPEC.md §10.
  function bboxFromGeoJSON(gj) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const visit = (coords) => {
      if (typeof coords[0] === 'number') {
        w = Math.min(w, coords[0]); e = Math.max(e, coords[0]);
        s = Math.min(s, coords[1]); n = Math.max(n, coords[1]);
        return;
      }
      for (const c of coords) visit(c);
    };
    const geoms = gj.type === 'FeatureCollection' ? gj.features.map((f) => f.geometry)
      : gj.type === 'Feature' ? [gj.geometry] : [gj];
    for (const g of geoms) { if (g && g.coordinates) visit(g.coordinates); }
    if (!isFinite(w)) return null;
    return [round6(w), round6(s), round6(e), round6(n)];
  }

  // Rectangle drawing without a plugin: shift-drag, plus a two-click fallback for
  // trackpads and touch. Leaflet binds shift-drag to boxZoom, so boxZoom is
  // disabled while this controller is installed.
  function createDrawer(map, onComplete) {
    let rubber = null;      // live rectangle while dragging / between clicks
    let dragOrigin = null;  // shift-drag anchor
    let clickOrigin = null; // two-click anchor
    let clickMode = false;

    map.boxZoom.disable();

    const container = map.getContainer();

    function clearRubber() {
      if (rubber) { map.removeLayer(rubber); rubber = null; }
    }

    function draw(a, b) {
      const bounds = L.latLngBounds(a, b);
      if (rubber) rubber.setBounds(bounds);
      else rubber = L.rectangle(bounds, AOI_STYLE).addTo(map);
      return bounds;
    }

    function finish(bounds) {
      clearRubber();
      dragOrigin = null; clickOrigin = null;
      setClickMode(false);
      map.dragging.enable();
      if (bounds && bounds.isValid()) onComplete(bboxFromBounds(bounds));
    }

    // --- shift-drag ---
    map.on('mousedown', (e) => {
      if (!e.originalEvent.shiftKey || clickMode) return;
      dragOrigin = e.latlng;
      map.dragging.disable();
    });
    map.on('mousemove', (e) => {
      if (dragOrigin) { draw(dragOrigin, e.latlng); return; }
      if (clickMode && clickOrigin) draw(clickOrigin, e.latlng);
    });
    map.on('mouseup', (e) => {
      if (!dragOrigin) return;
      const bounds = L.latLngBounds(dragOrigin, e.latlng);
      // Ignore an accidental shift-click that produced no area.
      finish(bounds.getNorth() === bounds.getSouth() ? null : bounds);
    });

    // --- two-click ---
    map.on('click', (e) => {
      if (!clickMode) return;
      if (!clickOrigin) { clickOrigin = e.latlng; return; }
      finish(L.latLngBounds(clickOrigin, e.latlng));
    });

    function setClickMode(on) {
      clickMode = on;
      container.style.cursor = on ? 'crosshair' : '';
      if (!on) { clickOrigin = null; clearRubber(); }
    }

    return {
      toggleClickMode() { setClickMode(!clickMode); return clickMode; },
      isClickMode() { return clickMode; },
      cancel() { finish(null); },
    };
  }

  global.GeoAoi = { AOI_STYLE, bboxFromBounds, boundsFromBbox, bboxFromGeoJSON, createDrawer };
})(typeof window !== 'undefined' ? window : globalThis);
