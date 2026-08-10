// Feature class registry (FR-SITE-006 reference data).
//
// ana-geo-search has a *category* registry: a key and its OSM tags, used to
// discover POIs. Site evaluation needs more per class, because a distance is
// only meaningful if the geometry it measures to is the right kind of thing:
//
//   key        — the name constraints and criteria refer to
//   metric     — the metric key the class contributes to the §18.4 result model
//   tags       — tag sets (AND within a set, OR between sets); a value may be
//                { regex } for an Overpass `~` filter
//   elements   — which OSM element types to ask for (a road is never a node)
//   geometry   — the geometry the class is expected to produce, which selects
//                the Turf distance function in geo/scoring.js
//   caution    — a data-quality warning surfaced in the UI and the README
//
// ana-geo-site owns this file outright (PRD §9: conventions are copied between
// apps, never imported).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GeoRegistry = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CLASSES = {
    university: {
      label: 'University',
      metric: 'universityDistance',
      tags: [{ amenity: 'university' }],
      elements: ['node', 'way', 'relation'],
      geometry: 'area',
    },
    school: {
      label: 'School',
      metric: 'schoolDistance',
      tags: [{ amenity: 'school' }],
      elements: ['node', 'way', 'relation'],
      geometry: 'area',
    },
    // Only the four trunk grades. `highway=*` unfiltered returns residential
    // streets, service roads, footways and driveways — measured on a small
    // Daejeon window that is more than ten times the §26.1 result cap, so the
    // acquisition truncates and the "distance to a road" metric silently
    // becomes "distance to whichever roads happened to fit".
    road: {
      label: 'Major road',
      metric: 'roadDistance',
      tags: [{ highway: { regex: '^(motorway|trunk|primary|secondary)$' } }],
      elements: ['way'],
      geometry: 'line',
    },
    // landuse=residential is polygonal and, in most of Korea, mapped in
    // patches: absence of a polygon is not evidence of absence of housing.
    residential: {
      label: 'Residential area',
      metric: 'residentialDistance',
      tags: [{ landuse: 'residential' }],
      elements: ['way', 'relation'],
      geometry: 'area',
      caution:
        'landuse=residential coverage in OSM is sparse and uneven. Treat this metric as indicative only — '
        + 'do not use it as the sole basis for a hard pass/fail decision without authoritative land-use data '
        + '(load it as GeoJSON to replace this class).',
    },
    commercial: {
      label: 'Commercial area',
      metric: 'commercialDistance',
      tags: [{ landuse: 'commercial' }, { landuse: 'retail' }],
      elements: ['way', 'relation'],
      geometry: 'area',
      caution: 'landuse=commercial/retail coverage in OSM is uneven; verify against authoritative land-use data.',
    },
    industrial: {
      label: 'Industrial area',
      metric: 'industrialDistance',
      tags: [{ landuse: 'industrial' }],
      elements: ['way', 'relation'],
      geometry: 'area',
      caution: 'landuse=industrial coverage in OSM is uneven; verify against authoritative land-use data.',
    },
    power_line: {
      label: 'Power line',
      metric: 'powerDistance',
      tags: [{ power: 'line' }, { power: 'minor_line' }],
      elements: ['way'],
      geometry: 'line',
    },
    substation: {
      label: 'Substation',
      metric: 'substationDistance',
      tags: [{ power: 'substation' }],
      elements: ['node', 'way', 'relation'],
      geometry: 'area',
    },
    railway_station: {
      label: 'Railway station',
      metric: 'railwayStationDistance',
      tags: [{ railway: 'station' }],
      elements: ['node', 'way'],
      geometry: 'point',
    },
    park: {
      label: 'Park',
      metric: 'parkDistance',
      tags: [{ leisure: 'park' }],
      elements: ['way', 'relation'],
      geometry: 'area',
    },
    water: {
      label: 'Water',
      metric: 'waterDistance',
      tags: [{ natural: 'water' }],
      elements: ['way', 'relation'],
      geometry: 'area',
    },
  };

  const keys = () => Object.keys(CLASSES);
  const get = (key) => CLASSES[key] || null;
  const has = (key) => Object.prototype.hasOwnProperty.call(CLASSES, key);
  const label = (key) => (CLASSES[key] ? CLASSES[key].label : key);
  const caution = (key) => (CLASSES[key] ? CLASSES[key].caution || null : null);

  // The §18.4 `metrics` key a class contributes. Classes loaded from a user's
  // GeoJSON are not in the table, so they derive one from their own key.
  function metricKey(key) {
    if (CLASSES[key]) return CLASSES[key].metric;
    const camel = String(key).replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase());
    return `${camel.charAt(0).toLowerCase()}${camel.slice(1)}Distance`;
  }

  return { CLASSES, keys, get, has, label, caution, metricKey };
});
