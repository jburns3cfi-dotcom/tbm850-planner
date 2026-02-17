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

// FAA odd/even altitude rules
// Eastbound (0-179°): odd thousands + 500 → FL190, FL210, FL230, FL250, FL270, FL290, FL310
// Westbound (180-359°): even thousands + 500 → FL200, FL220, FL240, FL260, FL280, FL300
function getValidAltitudes(trueCourse, minAlt, maxAlt) {
    var isEastbound = trueCourse >= 0 && trueCourse < 180;
    var alts = [];
    if (isEastbound) {
        // Odd flight levels: 190, 210, 230, 250, 270, 290, 310
        for (var fl = 190; fl <= 310; fl += 20) {
            var alt = fl * 100;
            if (alt >= minAlt && alt <= maxAlt) alts.push(alt);
        }
    } else {
        // Even flight levels: 180, 200, 220, 240, 260, 280, 300
        for (var fl = 180; fl <= 300; fl += 20) {
            var alt = fl * 100;
            if (alt >= minAlt && alt <= maxAlt) alts.push(alt);
        }
    }
    return alts;
}

// Get top 3 altitude options based on course direction
function getTop3Altitudes(trueCourse) {
    var allValid = getValidAltitudes(trueCourse, 18000, 31000);
    // Return up to 3, preferring higher altitudes (better fuel efficiency)
    return allValid.slice(-3).reverse();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        greatCircleDistance, initialBearing, intermediatePoint,
        routeWaypoints, getValidAltitudes, getTop3Altitudes
    };
}
