// Canonical category registry (PRD §16.3 preset vocabulary).
// FR-ROUTE-008 sources its candidate destinations by registry key, exactly as
// FR-EXP-002 / FR-EXP-008 do. ana-geo-route owns its own copy (PRD §9: no
// imports from another app); the key scheme is deliberately identical to the
// explorer and search apps so candidate sets are portable between them.
//
// `tags` is a list of tag sets: within a set every tag must match (AND); a
// feature matching any one set belongs to the category (OR).
// `areal` marks categories whose OSM ways are closed areas (parks, campuses),
// which the Overpass converter turns into polygons rather than lines.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GeoRegistry = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CATEGORIES = {
    cafe: { label: 'Cafe', tags: [{ amenity: 'cafe' }], areal: false },
    restaurant: { label: 'Restaurant', tags: [{ amenity: 'restaurant' }], areal: false },
    hospital: { label: 'Hospital', tags: [{ amenity: 'hospital' }], areal: true },
    pharmacy: { label: 'Pharmacy', tags: [{ amenity: 'pharmacy' }], areal: false },
    school: { label: 'School', tags: [{ amenity: 'school' }], areal: true },
    university: { label: 'University', tags: [{ amenity: 'university' }], areal: true },
    park: { label: 'Park', tags: [{ leisure: 'park' }], areal: true },
    parking: { label: 'Parking', tags: [{ amenity: 'parking' }], areal: true },
    charging_station: { label: 'Charging station', tags: [{ amenity: 'charging_station' }], areal: false },
    bus_station: {
      label: 'Bus station',
      tags: [{ amenity: 'bus_station' }, { highway: 'bus_stop' }],
      areal: false,
    },
    subway_station: {
      label: 'Subway station',
      tags: [{ railway: 'station', station: 'subway' }, { railway: 'subway_entrance' }],
      areal: false,
    },
  };

  const keys = () => Object.keys(CATEGORIES);
  const get = (key) => CATEGORIES[key] || null;
  const label = (key) => (CATEGORIES[key] ? CATEGORIES[key].label : key);
  const has = (key) => Object.prototype.hasOwnProperty.call(CATEGORIES, key);

  return { CATEGORIES, keys, get, label, has };
});
