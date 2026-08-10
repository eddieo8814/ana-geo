// Leaflet layer construction and styling.
// Browser-only. Candidates, reference feature classes and the classes bound to
// a hard constraint each get their own look, so the map itself shows why a
// candidate won or was rejected (PRD §23.3).
/* global L */

(function (root, factory) {
  root.GeoLayers = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const STYLES = {
    candidate: { color: '#94a3b8', weight: 2, fillColor: '#94a3b8', fillOpacity: 0.25, radius: 7 },
    ranked: { color: '#22c55e', weight: 2, fillColor: '#22c55e', fillOpacity: 0.5, radius: 9 },
    top: { color: '#facc15', weight: 3, fillColor: '#facc15', fillOpacity: 0.6, radius: 11 },
    rejected: { color: '#f87171', weight: 2, dashArray: '4 3', fillColor: '#f87171', fillOpacity: 0.2, radius: 7 },
    reference: { color: '#38bdf8', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.12, radius: 4 },
    hard: { color: '#fb923c', weight: 2, fillColor: '#fb923c', fillOpacity: 0.18, radius: 4 },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function rows(pairs) {
    return pairs.map(([k, v]) => `<b>${escapeHtml(k)}</b>: ${escapeHtml(v)}`).join('<br>');
  }

  function referencePopup(feature) {
    const p = feature.properties || {};
    return rows([
      ['name', p.name || '(unnamed)'],
      ['class', p.category || '—'],
      ['source', p.sourceId || p.source || '—'],
    ]);
  }

  // The §23.3 explanation, rendered where the candidate is.
  function candidatePopup(feature, result) {
    const p = feature.properties || {};
    const head = [['candidate', p.label || feature.id || '—'], ['geometry', feature.geometry.type]];
    if (!result) return `${rows(head)}<br><i>not scored yet — run the ranking</i>`;
    head.push(['eligible', result.eligible ? 'yes' : 'no']);
    if (result.eligible) head.push(['rank', `#${result.rank}`], ['score', result.score]);
    const e = result.explanation || { headline: '', lines: [] };
    const lines = (e.lines || []).map((l) => `· ${escapeHtml(l)}`).join('<br>');
    return `${rows(head)}<hr style="border:none;border-top:1px solid #33415577;margin:6px 0">`
      + `<b>${escapeHtml(e.headline)}</b><br>${lines}`;
  }

  function styleFor(result) {
    if (!result) return STYLES.candidate;
    if (!result.eligible) return STYLES.rejected;
    return result.rank === 1 ? STYLES.top : STYLES.ranked;
  }

  // `role` is 'reference' or 'hard'; unknown roles fall back to 'reference'.
  function buildReference(geojson, role) {
    const style = STYLES[role] || STYLES.reference;
    return L.geoJSON(geojson, {
      style,
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, style),
      onEachFeature: (feature, layer) => layer.bindPopup(referencePopup(feature)),
    });
  }

  // `resultsById` maps candidateId → the §18.4 result object (may be empty
  // before the first run, in which case candidates render unscored).
  function buildCandidates(geojson, resultsById, onSelect) {
    const byId = resultsById || new Map();
    return L.geoJSON(geojson, {
      style: (feature) => styleFor(byId.get(String(feature.id))),
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, styleFor(byId.get(String(feature.id)))),
      onEachFeature: (feature, layer) => {
        const result = byId.get(String(feature.id));
        layer.bindPopup(candidatePopup(feature, result));
        const badge = result && result.eligible ? `#${result.rank} · ${result.score}`
          : (feature.properties && feature.properties.label) || String(feature.id);
        layer.bindTooltip(badge, { permanent: true, direction: 'top', className: 'cand-tip' });
        // Selecting a candidate must not also register a map click, or clicking
        // an existing candidate while "add by map click" is on would stack a
        // second candidate on top of it.
        if (onSelect) {
          layer.on('click', (ev) => { L.DomEvent.stopPropagation(ev); onSelect(String(feature.id)); });
        }
      },
    });
  }

  return { STYLES, buildReference, buildCandidates, candidatePopup, referencePopup, styleFor };
});
