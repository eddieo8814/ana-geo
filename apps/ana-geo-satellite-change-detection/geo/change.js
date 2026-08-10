// ana-geo-satellite-change-detection — presentation rules for the change
// result (PRD §21.6 result model, §23.2 visible state, §23.3 explainability).
//
// The analysis itself lives in the Python worker; this module only decides how
// the result reads on the Watch surface. Keeping it separate is what lets ANA
// change the wording or the palette without touching the pipeline.
//
// Loadable both in the browser (`window.GeoChange`) and in Node (`require`).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoChange = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const METHOD = 'ndvi-difference'; // §21.4 — v1 is NDVI difference, no deep learning

  const DIRECTIONS = [
    { key: 'both', label: 'Any change', hint: '|NDVI after − before| ≥ threshold' },
    { key: 'loss', label: 'Vegetation loss', hint: 'NDVI after − before ≤ −threshold' },
    { key: 'gain', label: 'Vegetation gain', hint: 'NDVI after − before ≥ +threshold' },
  ];

  const COLORS = { loss: '#f97316', gain: '#22c55e', both: '#38bdf8' };

  // FR-CD-006 — the threshold is an NDVI difference, so it lives on the same
  // scale as NDVI itself: 0.2 is a substantial vegetation change, 0.05 is noise
  // on most scenes.
  const THRESHOLD = { min: 0.05, max: 0.8, step: 0.05, default: 0.2 };

  function colorFor(region, fallbackDirection) {
    const dir = (region && region.direction) || fallbackDirection || 'both';
    return COLORS[dir] || COLORS.both;
  }

  // FR-CD-011 — regions arrive ranked by area; "only show the three largest"
  // is a display limit, not a re-analysis.
  function visibleRegions(regions, regionLimit) {
    const list = regions || [];
    const n = Number(regionLimit);
    return Number.isFinite(n) && n > 0 ? list.slice(0, n) : list;
  }

  function fmtArea(sqKm) {
    const v = Number(sqKm) || 0;
    if (v === 0) return '0 km²';
    if (v < 0.01) return `${Math.round(v * 1e6).toLocaleString()} m²`;
    return `${v.toFixed(v < 1 ? 3 : 2)} km²`;
  }

  // §23.3 — the app states why the result looks the way it does, in the
  // sentence form the PRD gives: "12 regions exceeded NDVI change threshold 0.20."
  function explain(cd) {
    if (!cd) return '';
    const n = cd.regionCount != null ? cd.regionCount : (cd.regions || []).length;
    const noun = n === 1 ? 'region' : 'regions';
    const dirSuffix = cd.direction && cd.direction !== 'both'
      ? ` (${cd.direction === 'loss' ? 'vegetation loss only' : 'vegetation gain only'})`
      : '';
    return `${n} ${noun} exceeded NDVI change threshold ${Number(cd.threshold).toFixed(2)}${dirSuffix}.`;
  }

  function summaryLines(cd, raster) {
    if (!cd) return [];
    const lines = [
      ['Method', cd.method || METHOD],
      ['Before', `${cd.beforeScene || '–'}`],
      ['After', `${cd.afterScene || '–'}`],
      ['Threshold', Number(cd.threshold).toFixed(2)],
      ['Direction', (DIRECTIONS.find((d) => d.key === cd.direction) || DIRECTIONS[0]).label],
      ['Changed area', fmtArea(cd.changedAreaSqKm)],
      ['Ranked regions', `${cd.regionCount} (${fmtArea(cd.regionsAreaSqKm)})`],
    ];
    if (raster) {
      lines.push(['Tile', raster.tile || '–']);
      lines.push(['Pixel', `${(raster.pixelSizeM || [])[0] || '?'} m · ${raster.crs || ''}`]);
      lines.push(['Window', `${(raster.window || {}).width}×${(raster.window || {}).height} px`]);
    }
    return lines;
  }

  return { METHOD, DIRECTIONS, COLORS, THRESHOLD, colorFor, visibleRegions, fmtArea, explain, summaryLines };
});
