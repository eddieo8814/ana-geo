// Layer styling (PRD §8.1 geo/styles.js) — one place that decides how a route,
// an isochrone band and a candidate destination look on the map.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GeoStyles = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const COLORS = {
    route: '#38bdf8',
    origin: '#22c55e',
    destination: '#f97316',
    candidate: '#a78bfa',
    winner: '#22c55e',
    // 5 / 10 / 20 min — nearer bands read as tighter and warmer.
    isochrone: ['#f472b6', '#a78bfa', '#38bdf8'],
  };

  function routeStyle() {
    return { color: COLORS.route, weight: 5, opacity: 0.9 };
  }

  // Bands are drawn largest-first by the caller so the 5-minute polygon stays
  // on top of the 20-minute one it sits inside.
  function isochroneStyle(feature, minutes) {
    const order = (minutes || []).indexOf(feature.properties.minutes);
    const color = COLORS.isochrone[order >= 0 ? order % COLORS.isochrone.length : 0];
    return { color, weight: 1.5, opacity: 0.9, fillColor: color, fillOpacity: 0.15 };
  }

  // The nearest destination is the answer to the question, so it is drawn
  // differently from the candidates it beat.
  function candidateStyle(feature) {
    const rank = feature.properties && feature.properties.rank;
    const ranked = Number.isInteger(rank);
    const winner = ranked && rank === 1;
    const color = winner ? COLORS.winner : COLORS.candidate;
    return {
      radius: winner ? 9 : 6,
      color,
      weight: ranked ? 2 : 1,
      fillColor: color,
      fillOpacity: ranked ? 0.85 : 0.35,
    };
  }

  function candidateMarker(feature, latlng, L) {
    return L.circleMarker(latlng, candidateStyle(feature));
  }

  function endpointMarker(kind, latlng, L) {
    return L.circleMarker(latlng, {
      radius: 8,
      color: COLORS[kind],
      weight: 3,
      fillColor: COLORS[kind],
      fillOpacity: 0.6,
    });
  }

  return { COLORS, routeStyle, isochroneStyle, candidateStyle, candidateMarker, endpointMarker };
});
