// ============================================================
// FUEL STOPS MODULE — TBM850 Apple Flight Planner
// Finds candidate fuel stop airports along route
// Requires: route.js, airports.js loaded first
// ============================================================

var FuelStops = (function () {

    var CORRIDOR_WIDTH_NM = 30;    // Search this far off the great circle
    var MIN_BUFFER_NM = 200;       // Must be ≥200nm from departure AND destination
    var MIN_RUNWAY_FT = 3500;      // Minimum runway for TBM850
    var MAX_RESULTS = 8;           // Show up to 8 candidates

    // Airport types we'll accept for fuel stops
    var VALID_TYPES = ['large_airport', 'medium_airport', 'small_airport'];

    /**
     * Find fuel stop candidates along a route.
     * @param {object} dep - departure airport { ident, lat, lon, ... }
     * @param {object} dest - destination airport { ident, lat, lon, ... }
     * @param {number} totalDist - total route distance in NM
     * @returns {Array} sorted candidates [{airport, distFromDep, distFromDest, distOffRoute}, ...]
     */
    function findCandidates(dep, dest, totalDist) {
        if (!airportDB || airportDB.length === 0) return [];

        // Calculate the valid zone: between 200nm and (totalDist - 200nm)
        var minDist = MIN_BUFFER_NM;
        var maxDist = totalDist - MIN_BUFFER_NM;
        if (maxDist <= minDist) {
            // Route too short for fuel stop with 200nm buffers
            return [];
        }

        // Ideal fuel stop is roughly in the middle
        var idealDist = totalDist / 2;

        var candidates = [];

        for (var i = 0; i < airportDB.length; i++) {
            var apt = airportDB[i];

            // Skip the departure and destination
            if (apt.ident === dep.ident || apt.ident === dest.ident) continue;

            // Filter by type
            if (VALID_TYPES.indexOf(apt.type) === -1) continue;

            // Quick lat/lon bounding box check first (fast reject)
            if (!inBoundingBox(apt.lat, apt.lon, dep.lat, dep.lon, dest.lat, dest.lon, CORRIDOR_WIDTH_NM)) {
                continue;
            }

            // Calculate distance from departure
            var distFromDep = greatCircleDistance(dep.lat, dep.lon, apt.lat, apt.lon);

            // Must be in the valid zone (200nm buffers)
            if (distFromDep < minDist || distFromDep > maxDist) continue;

            // Calculate distance from destination
            var distFromDest = greatCircleDistance(apt.lat, apt.lon, dest.lat, dest.lon);
            if (distFromDest < MIN_BUFFER_NM) continue;

            // Calculate cross-track distance (how far off the direct route)
            var offRoute = crossTrackDistance(dep.lat, dep.lon, dest.lat, dest.lon, apt.lat, apt.lon);
            if (Math.abs(offRoute) > CORRIDOR_WIDTH_NM) continue;

            // Score: prefer airports closer to the ideal midpoint and closer to route
            var distFromIdeal = Math.abs(distFromDep - idealDist);
            var score = distFromIdeal + Math.abs(offRoute) * 2;

            // Bonus for larger airports
            if (apt.type === 'large_airport') score -= 30;
            if (apt.type === 'medium_airport') score -= 15;

            candidates.push({
                airport: apt,
                distFromDep: Math.round(distFromDep),
                distFromDest: Math.round(distFromDest),
                distOffRoute: Math.round(Math.abs(offRoute)),
                score: score
            });
        }

        // Sort by score (lower is better)
        candidates.sort(function (a, b) { return a.score - b.score; });

        return candidates.slice(0, MAX_RESULTS);
    }

    /**
     * Cross-track distance: how far a point is from the great circle route.
     * Returns signed distance in NM (positive = right of course).
     */
    function crossTrackDistance(lat1, lon1, lat2, lon2, latP, lonP) {
        var R = 3440.065; // Earth radius in NM
        var d13 = greatCircleDistance(lat1, lon1, latP, lonP) / R; // angular dist dep→point
        var brng13 = initialBearing(lat1, lon1, latP, lonP) * Math.PI / 180;
        var brng12 = initialBearing(lat1, lon1, lat2, lon2) * Math.PI / 180;

        var xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
        return xt * R;
    }

    /**
     * Quick bounding box check to reject far-away airports fast.
     */
    function inBoundingBox(lat, lon, lat1, lon1, lat2, lon2, bufferNM) {
        var buffer = bufferNM / 60; // rough degrees
        var minLat = Math.min(lat1, lat2) - buffer;
        var maxLat = Math.max(lat1, lat2) + buffer;
        var minLon = Math.min(lon1, lon2) - buffer;
        var maxLon = Math.max(lon1, lon2) + buffer;
        return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
    }

    // Public API
    return {
        findCandidates: findCandidates,
        MIN_BUFFER_NM: MIN_BUFFER_NM
    };

})();

if (typeof window !== 'undefined') {
    window.FuelStops = FuelStops;
}
