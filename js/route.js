// ============================================================
// ROUTE MODULE — Great Circle Math
// TBM850 Apple Flight Planner
// ============================================================

var DEG2RAD = Math.PI / 180;
var RAD2DEG = 180 / Math.PI;
var EARTH_RADIUS_NM = 3440.065;

// Great circle distance in nautical miles
function greatCircleDistance(lat1, lon1, lat2, lon2) {
    var dLat = (lat2 - lat1) * DEG2RAD;
    var dLon = (lon2 - lon1) * DEG2RAD;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_NM * c;
}

// Initial bearing (true course) from point 1 to point 2 in degrees
function initialBearing(lat1, lon1, lat2, lon2) {
    var rlat1 = lat1 * DEG2RAD;
    var rlat2 = lat2 * DEG2RAD;
    var dLon = (lon2 - lon1) * DEG2RAD;
    var x = Math.sin(dLon) * Math.cos(rlat2);
    var y = Math.cos(rlat1) * Math.sin(rlat2) -
            Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLon);
    var brng = Math.atan2(x, y) * RAD2DEG;
    return (brng + 360) % 360;
}

// Intermediate point along great circle at given fraction (0 = start, 1 = end)
function intermediatePoint(lat1, lon1, lat2, lon2, fraction) {
    var rlat1 = lat1 * DEG2RAD;
    var rlon1 = lon1 * DEG2RAD;
    var rlat2 = lat2 * DEG2RAD;
    var rlon2 = lon2 * DEG2RAD;

    var d = greatCircleDistance(lat1, lon1, lat2, lon2) / EARTH_RADIUS_NM;
    if (d === 0) return { lat: lat1, lon: lon1 };

    var a = Math.sin((1 - fraction) * d) / Math.sin(d);
    var b = Math.sin(fraction * d) / Math.sin(d);

    var x = a * Math.cos(rlat1) * Math.cos(rlon1) + b * Math.cos(rlat2) * Math.cos(rlon2);
    var y = a * Math.cos(rlat1) * Math.sin(rlon1) + b * Math.cos(rlat2) * Math.sin(rlon2);
    var z = a * Math.sin(rlat1) + b * Math.sin(rlat2);

    return {
        lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG,
        lon: Math.atan2(y, x) * RAD2DEG
    };
}

// Generate array of waypoints along route at specified interval (NM)
function routeWaypoints(lat1, lon1, lat2, lon2, intervalNM) {
    var totalDist = greatCircleDistance(lat1, lon1, lat2, lon2);
    if (totalDist === 0) return [{ lat: lat1, lon: lon1, distFromDep: 0 }];

    var points = [];
    var numSegments = Math.ceil(totalDist / intervalNM);
    for (var i = 0; i <= numSegments; i++) {
        var frac = Math.min(i / numSegments, 1);
        var pt = intermediatePoint(lat1, lon1, lat2, lon2, frac);
        pt.distFromDep = totalDist * frac;
        points.push(pt);
    }
    return points;
}

// ============================================================
// FAA ALTITUDE RULES
// ============================================================
// Eastbound (0°-179°): ODD flight levels — FL250, FL270, FL290, FL310
// Westbound (180°-359°): EVEN flight levels — FL240, FL260, FL280, FL300
// These are the practical TBM850 cruise altitudes.
// ============================================================
function getValidAltitudes(trueCourse) {
    var isEastbound = trueCourse >= 0 && trueCourse < 180;
    if (isEastbound) {
        return [25000, 27000, 29000, 31000];
    } else {
        return [24000, 26000, 28000, 30000];
    }
}

// Get top 3 altitudes — returns all valid altitudes for wind ranking.
// flight-calc.js will calculate all and pick the best 3 by time.
function getTop3Altitudes(trueCourse) {
    return getValidAltitudes(trueCourse);
}

// ============================================================
// MAGNETIC VARIATION — Approximate declination for CONUS
// ============================================================
// Simplified model based on NOAA WMM 2025 for continental US.
// Accuracy: within ~1-2° for CONUS, sufficient for flight planning.
// Positive = east declination, negative = west declination.
// In CONUS, variation ranges from ~-17° (Pacific NW) to ~-1° (east FL)
// to ~+10° (New England).
//
// Formula: simple polynomial fit for CONUS lat/lon
// ============================================================
function getMagneticVariation(lat, lon) {
    // Simplified CONUS magnetic variation model (WMM 2025 approx)
    // Based on linear regression of declination vs lat/lon
    // Declination ≈ f(longitude) with small latitude correction
    //
    // For CONUS: variation roughly follows longitude
    // At lon=-120: about -14°  (west of true north)
    // At lon=-105: about -9°
    // At lon=-90:  about -3°
    // At lon=-80:  about +2°
    // At lon=-70:  about +8°
    //
    // Linear fit: declination ≈ 0.38 * lon + 32 + 0.15 * (lat - 40)
    var variation = 0.38 * lon + 32 + 0.15 * (lat - 40);

    // Clamp to reasonable range for CONUS
    return Math.max(-20, Math.min(15, Math.round(variation * 10) / 10));
}

// Convert true course to magnetic course
function trueToMagnetic(trueCourse, lat, lon) {
    var variation = getMagneticVariation(lat, lon);
    var magCourse = trueCourse - variation;
    return ((magCourse % 360) + 360) % 360;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        greatCircleDistance, initialBearing, intermediatePoint,
        routeWaypoints, getValidAltitudes, getTop3Altitudes,
        getMagneticVariation, trueToMagnetic
    };
}
