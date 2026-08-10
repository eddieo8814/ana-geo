// ana-geo-explorer — canonical POI category registry (PRD §16.3, FR-EXP-008).
//
// This file is the SINGLE source of truth for categories. Every category
// reference — Overpass query, `state.json` layer entry, feature
// `properties.category`, README/SPEC example — uses a `key` defined here.
// Adding a preset means adding one entry below and nothing else.
//
// Fields
//   key       registry key; used everywhere as the category identifier
//   preset    the PRD §16.3 preset this entry realizes
//   label     human label for the Watch surface
//   elements  OSM element types queried (`way`/`relation` collapse to `center`)
//   tags      OSM tag filter; every pair must match (AND)
//   geometry  normalized output geometry — always "Point" (see geo/overpass.js)
//   color     layer colour on the map
//
// Loadable both in the browser (`window.GeoRegistry`) and in Node (`require`).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoRegistry = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const CATEGORIES = [
    { key: 'cafe',             preset: 'cafe',             label: 'Cafe',             elements: ['node', 'way'],             tags: { amenity: 'cafe' },             geometry: 'Point', color: '#f59e0b' },
    { key: 'restaurant',       preset: 'restaurant',       label: 'Restaurant',       elements: ['node', 'way'],             tags: { amenity: 'restaurant' },       geometry: 'Point', color: '#ef4444' },
    { key: 'hospital',         preset: 'hospital',         label: 'Hospital',         elements: ['node', 'way'],             tags: { amenity: 'hospital' },         geometry: 'Point', color: '#ec4899' },
    { key: 'pharmacy',         preset: 'pharmacy',         label: 'Pharmacy',         elements: ['node', 'way'],             tags: { amenity: 'pharmacy' },         geometry: 'Point', color: '#a855f7' },
    { key: 'school',           preset: 'school',           label: 'School',           elements: ['node', 'way'],             tags: { amenity: 'school' },           geometry: 'Point', color: '#3b82f6' },
    { key: 'university',       preset: 'university',       label: 'University',       elements: ['node', 'way'],             tags: { amenity: 'university' },       geometry: 'Point', color: '#6366f1' },
    { key: 'park',             preset: 'park',             label: 'Park',             elements: ['node', 'way', 'relation'], tags: { leisure: 'park' },             geometry: 'Point', color: '#22c55e' },
    { key: 'parking',          preset: 'parking',          label: 'Parking',          elements: ['node', 'way'],             tags: { amenity: 'parking' },          geometry: 'Point', color: '#64748b' },
    { key: 'charging_station', preset: 'charging station', label: 'Charging station', elements: ['node', 'way'],             tags: { amenity: 'charging_station' }, geometry: 'Point', color: '#14b8a6' },
    // §16.3 calls this preset "bus station". `amenity=bus_station` describes a
    // terminal building and returns almost nothing city-wide (7 objects across
    // all of Daejeon), so the useful realization of the preset is the stop
    // itself: `highway=bus_stop`, which is node-only in OSM practice.
    { key: 'bus_stop',         preset: 'bus station',      label: 'Bus stop',         elements: ['node'],                    tags: { highway: 'bus_stop' },         geometry: 'Point', color: '#eab308' },
  ];

  const BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

  function get(key) { return BY_KEY.get(key) || null; }
  function keys() { return CATEGORIES.map((c) => c.key); }

  // First registry entry whose tag filter is satisfied by these OSM tags.
  // Used to label a feature that came back from a merged multi-category query.
  function classify(tags) {
    if (!tags) return null;
    for (const c of CATEGORIES) {
      if (Object.entries(c.tags).every(([k, v]) => tags[k] === v)) return c.key;
    }
    return null;
  }

  return { CATEGORIES, get, keys, classify };
});
