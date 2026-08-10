// Leaflet layer construction and styling (FR-SEARCH-009).
// Browser-only: results, buffers, and acquired feature sets each get their own
// distinct look so the map explains the query at a glance (PRD §23.3).
/* global L */

(function (root, factory) {
  root.GeoLayers = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const STYLES = {
    target: { color: '#64748b', weight: 1, fillColor: '#64748b', fillOpacity: 0.15, radius: 4 },
    reference: { color: '#f59e0b', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.2, radius: 5 },
    result: { color: '#22c55e', weight: 2, fillColor: '#22c55e', fillOpacity: 0.55, radius: 7 },
    buffer: { color: '#38bdf8', weight: 1, dashArray: '4 3', fillColor: '#38bdf8', fillOpacity: 0.08 },
  };

  function popupHtml(feature) {
    const p = feature.properties || {};
    const rows = [
      ['name', p.name || '(unnamed)'],
      ['category', p.category || '—'],
      ['source', p.sourceId || p.source || '—'],
    ];
    for (const [k, v] of Object.entries(p.metrics || {})) rows.push([k, v]);
    if (p.relation) rows.push(['buffer', `${p.relation} ${p.distance} ${p.unit} of ${p.reference}`]);
    return rows.map(([k, v]) => `<b>${k}</b>: ${escapeHtml(String(v))}`).join('<br>');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // `role` selects the style; unknown roles fall back to the target style.
  function build(geojson, role) {
    const style = STYLES[role] || STYLES.target;
    return L.geoJSON(geojson, {
      style,
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, style),
      onEachFeature: (feature, layer) => layer.bindPopup(popupHtml(feature)),
    });
  }

  return { STYLES, build, popupHtml };
});
