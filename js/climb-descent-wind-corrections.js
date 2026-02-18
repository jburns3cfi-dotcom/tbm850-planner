// ============================================================================
// CLIMB/DESCENT WIND CORRECTIONS — Add to gfs-winds.js
// ============================================================================
//
// HOW IT WORKS:
// Wind doesn't change climb/descent TIME or FUEL — it changes GROUND DISTANCE.
// - Headwind during climb → less ground covered → more cruise distance
// - Tailwind during climb → more ground covered → less cruise distance
// Same logic applies to descent.
//
// We break the climb into 2000ft altitude bands, get wind at each band from
// GFS data, compute ground speed using windTriangleGS(), and sum up the
// wind-corrected distances. The ratio vs still-air distance gives us a
// correction factor.
//
// REQUIRES: windTriangleGS() from winds.js (already exists)
// ============================================================================

// ---------------------------------------------------------------------------
// PRESSURE-TO-ALTITUDE MAPPING (Standard Atmosphere)
// GFS NOMADS levels 8-18 with approximate flight levels
// ---------------------------------------------------------------------------
var GFS_PRESSURE_LEVELS = [
    // index 8-18 in NOMADS (we now request [8:18] instead of [14:18])
    { index: 0,  mb: 700, altFt:  9882 },  // ~FL099
    { index: 1,  mb: 650, altFt: 11780 },  // ~FL118
    { index: 2,  mb: 600, altFt: 13801 },  // ~FL138
    { index: 3,  mb: 550, altFt: 15962 },  // ~FL160
    { index: 4,  mb: 500, altFt: 18289 },  // ~FL183
    { index: 5,  mb: 450, altFt: 20812 },  // ~FL208
    { index: 6,  mb: 400, altFt: 23574 },  // ~FL236
    { index: 7,  mb: 350, altFt: 26631 },  // ~FL266
    { index: 8,  mb: 300, altFt: 30065 },  // ~FL301
    { index: 9,  mb: 250, altFt: 33999 },  // ~FL340
    { index: 10, mb: 200, altFt: 38662 }   // ~FL387
];

// ---------------------------------------------------------------------------
// CLIMB TAS TABLE — from fltplan.com performance data
// IAS from fltplan × density ratio correction = approximate TAS
// These are pre-computed for each 2000ft band
// ---------------------------------------------------------------------------
var CLIMB_TAS_TABLE = [
    { altFt:  2000, ias: 148, tas: 153 },
    { altFt:  4000, ias: 158, tas: 168 },
    { altFt:  6000, ias: 158, tas: 173 },
    { altFt:  8000, ias: 158, tas: 179 },
    { altFt: 10000, ias: 157, tas: 183 },
    { altFt: 12000, ias: 158, tas: 190 },
    { altFt: 14000, ias: 158, tas: 196 },
    { altFt: 16000, ias: 158, tas: 203 },
    { altFt: 18000, ias: 158, tas: 210 },
    { altFt: 20000, ias: 158, tas: 216 },
    { altFt: 22000, ias: 154, tas: 218 },
    { altFt: 24000, ias: 150, tas: 221 },
    { altFt: 26000, ias: 146, tas: 225 },
    { altFt: 28000, ias: 142, tas: 229 },
    { altFt: 30000, ias: 138, tas: 230 },
    { altFt: 31000, ias: 135, tas: 226 }
];

// ---------------------------------------------------------------------------
// DESCENT TAS TABLE — from fltplan.com descent IAS data
// POH says 230 KCAS descent, fltplan uses varying IAS
// ---------------------------------------------------------------------------
var DESCENT_TAS_TABLE = [
    { altFt:  2000, ias: 128, tas: 132 },
    { altFt:  4000, ias: 158, tas: 168 },
    { altFt:  6000, ias: 227, tas: 249 },
    { altFt:  8000, ias: 227, tas: 257 },
    { altFt: 10000, ias: 226, tas: 263 },
    { altFt: 12000, ias: 226, tas: 272 },
    { altFt: 14000, ias: 227, tas: 281 },
    { altFt: 16000, ias: 226, tas: 290 },
    { altFt: 18000, ias: 227, tas: 302 },
    { altFt: 20000, ias: 226, tas: 310 },
    { altFt: 22000, ias: 227, tas: 322 },
    { altFt: 24000, ias: 217, tas: 320 },
    { altFt: 26000, ias: 206, tas: 318 },
    { altFt: 28000, ias: 195, tas: 315 },
    { altFt: 30000, ias: 184, tas: 307 },
    { altFt: 31000, ias: 177, tas: 297 }
];

// ---------------------------------------------------------------------------
// HELPER: Get TAS for a given altitude from a TAS table (linear interpolation)
// ---------------------------------------------------------------------------
function getTasAtAltitude(table, altFt) {
    // Below table minimum — use first entry
    if (altFt <= table[0].altFt) return table[0].tas;
    // Above table maximum — use last entry
    if (altFt >= table[table.length - 1].altFt) return table[table.length - 1].tas;

    // Find bounding entries and interpolate
    for (var i = 0; i < table.length - 1; i++) {
        if (altFt >= table[i].altFt && altFt <= table[i + 1].altFt) {
            var frac = (altFt - table[i].altFt) / (table[i + 1].altFt - table[i].altFt);
            return table[i].tas + frac * (table[i + 1].tas - table[i].tas);
        }
    }
    return table[table.length - 1].tas;
}

// ---------------------------------------------------------------------------
// HELPER: Get wind (dir, speed) at a given altitude from GFS waypoint data
//
// gfsWindAtPoint = array of { mb, altFt, dir, spdKt } sorted by altitude
//   (this is the wind data from GFS at a single waypoint, across all levels)
//
// For altitudes below the lowest GFS level (~FL100), we scale the FL100
// wind proportionally (wind generally decreases toward the surface).
// ---------------------------------------------------------------------------
function getWindAtAltitude(gfsWindAtPoint, altFt) {
    if (!gfsWindAtPoint || gfsWindAtPoint.length === 0) {
        return { dir: 0, spdKt: 0 };
    }

    var lowest = gfsWindAtPoint[0];  // ~FL100 (700mb)

    // Below lowest GFS level — scale wind down proportionally
    // At surface, assume ~20% of FL100 wind. Linear scale from 0 to lowest level.
    if (altFt < lowest.altFt) {
        var scaleFactor = 0.2 + 0.8 * (altFt / lowest.altFt);
        return { dir: lowest.dir, spdKt: Math.round(lowest.spdKt * scaleFactor) };
    }

    var highest = gfsWindAtPoint[gfsWindAtPoint.length - 1];

    // Above highest GFS level — use highest
    if (altFt >= highest.altFt) {
        return { dir: highest.dir, spdKt: highest.spdKt };
    }

    // Interpolate between bounding levels
    for (var i = 0; i < gfsWindAtPoint.length - 1; i++) {
        var lo = gfsWindAtPoint[i];
        var hi = gfsWindAtPoint[i + 1];
        if (altFt >= lo.altFt && altFt <= hi.altFt) {
            var frac = (altFt - lo.altFt) / (hi.altFt - lo.altFt);

            // Interpolate speed linearly
            var spd = lo.spdKt + frac * (hi.spdKt - lo.spdKt);

            // Interpolate direction (handle wraparound)
            var diff = hi.dir - lo.dir;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            var dir = (lo.dir + frac * diff + 360) % 360;

            return { dir: Math.round(dir), spdKt: Math.round(spd) };
        }
    }

    return { dir: highest.dir, spdKt: highest.spdKt };
}

// ---------------------------------------------------------------------------
// MAIN: Calculate wind-corrected climb distance
//
// Parameters:
//   pohClimbDistNm  — still-air climb distance from performance tables (NM)
//   pohClimbTimeMin — climb time from performance tables (minutes)
//   depElevFt       — departure airport elevation (feet)
//   cruiseAltFt     — cruise altitude (feet), e.g. 28000 for FL280
//   courseTrue      — true course from departure (degrees)
//   gfsWindAtPoint  — GFS wind data array at departure area, sorted by altitude
//                     Each entry: { mb, altFt, dir, spdKt }
//
// Returns: { distNm, avgHeadwind, correction }
//   distNm       — wind-corrected ground distance during climb (NM)
//   avgHeadwind  — average headwind component (positive=headwind, negative=tailwind)
//   correction   — distance correction in NM (positive=more ground covered)
// ---------------------------------------------------------------------------
function calcWindCorrectedClimbDist(pohClimbDistNm, pohClimbTimeMin, depElevFt, cruiseAltFt, courseTrue, gfsWindAtPoint) {
    // If no wind data, return POH distance unchanged
    if (!gfsWindAtPoint || gfsWindAtPoint.length === 0) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    var BAND_SIZE = 2000; // 2000ft altitude bands
    var startAlt = Math.max(depElevFt, 0);
    var endAlt = cruiseAltFt;

    if (endAlt <= startAlt) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    // Break climb into altitude bands and compute GS for each
    var totalTimeWeightedGS = 0;
    var totalTimeWeightedTAS = 0;
    var totalTime = 0;

    var alt = startAlt;
    while (alt < endAlt) {
        var bandTop = Math.min(alt + BAND_SIZE, endAlt);
        var bandMid = (alt + bandTop) / 2;
        var bandThickness = bandTop - alt;

        // Get TAS at this band's midpoint
        var tas = getTasAtAltitude(CLIMB_TAS_TABLE, bandMid);

        // Get wind at this band's midpoint
        var wind = getWindAtAltitude(gfsWindAtPoint, bandMid);

        // Compute ground speed using wind triangle
        var gs = windTriangleGS(tas, wind.dir, wind.spdKt, courseTrue);

        // Get rate of climb at this altitude from fltplan data
        // (approximate — we use a lookup similar to how performance.js works)
        var roc = getClimbRateAtAltitude(bandMid);

        // Time in this band (minutes)
        var bandTimeMin = (bandThickness / roc);  // roc is ft/min

        totalTimeWeightedGS += gs * bandTimeMin;
        totalTimeWeightedTAS += tas * bandTimeMin;
        totalTime += bandTimeMin;

        alt = bandTop;
    }

    if (totalTime <= 0) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    // Effective average GS and TAS during climb
    var avgGS = totalTimeWeightedGS / totalTime;
    var avgTAS = totalTimeWeightedTAS / totalTime;

    // Wind correction ratio: how GS compares to TAS
    var gsRatio = avgGS / avgTAS;

    // Apply ratio to POH distance
    var correctedDist = Math.round(pohClimbDistNm * gsRatio);

    // Average headwind component (positive = headwind)
    var avgHeadwind = Math.round(avgTAS - avgGS);

    var correction = correctedDist - pohClimbDistNm;

    console.log('[WIND-CLB] Climb ' + Math.round(depElevFt) + ' → FL' + Math.round(cruiseAltFt/100) +
        ': avgTAS=' + Math.round(avgTAS) + ', avgGS=' + Math.round(avgGS) +
        ', HW=' + avgHeadwind + 'kt, POH dist=' + pohClimbDistNm +
        'nm → corrected=' + correctedDist + 'nm (' + (correction >= 0 ? '+' : '') + correction + ')');

    return {
        distNm: correctedDist,
        avgHeadwind: avgHeadwind,
        correction: correction
    };
}

// ---------------------------------------------------------------------------
// MAIN: Calculate wind-corrected descent distance
//
// Same approach as climb but using descent TAS table.
// Note: descent goes from cruise altitude DOWN to destination elevation.
//
// Parameters:
//   pohDescentDistNm  — still-air descent distance from performance tables (NM)
//   pohDescentTimeMin — descent time from performance tables (minutes)
//   destElevFt        — destination airport elevation (feet)
//   cruiseAltFt       — cruise altitude (feet)
//   courseTrue        — true course toward destination (degrees)
//   gfsWindAtPoint    — GFS wind data array at arrival area, sorted by altitude
//
// Returns: { distNm, avgHeadwind, correction }
// ---------------------------------------------------------------------------
function calcWindCorrectedDescentDist(pohDescentDistNm, pohDescentTimeMin, destElevFt, cruiseAltFt, courseTrue, gfsWindAtPoint) {
    // If no wind data, return POH distance unchanged
    if (!gfsWindAtPoint || gfsWindAtPoint.length === 0) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    var BAND_SIZE = 2000;
    var startAlt = cruiseAltFt;  // descent starts at cruise altitude
    var endAlt = Math.max(destElevFt, 0);

    if (startAlt <= endAlt) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    // Break descent into altitude bands (top down)
    var totalTimeWeightedGS = 0;
    var totalTimeWeightedTAS = 0;
    var totalTime = 0;

    var alt = startAlt;
    while (alt > endAlt) {
        var bandBottom = Math.max(alt - BAND_SIZE, endAlt);
        var bandMid = (alt + bandBottom) / 2;
        var bandThickness = alt - bandBottom;

        // Get TAS at this band's midpoint
        var tas = getTasAtAltitude(DESCENT_TAS_TABLE, bandMid);

        // Get wind at this band's midpoint
        var wind = getWindAtAltitude(gfsWindAtPoint, bandMid);

        // Compute ground speed using wind triangle
        var gs = windTriangleGS(tas, wind.dir, wind.spdKt, courseTrue);

        // Descent rate — use approximate from POH (2000 fpm is our baseline)
        // fltplan uses varying descent rates but 2000fpm is standard
        var rod = getDescentRateAtAltitude(bandMid);

        // Time in this band (minutes)
        var bandTimeMin = (bandThickness / rod);

        totalTimeWeightedGS += gs * bandTimeMin;
        totalTimeWeightedTAS += tas * bandTimeMin;
        totalTime += bandTimeMin;

        alt = bandBottom;
    }

    if (totalTime <= 0) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    var avgGS = totalTimeWeightedGS / totalTime;
    var avgTAS = totalTimeWeightedTAS / totalTime;
    var gsRatio = avgGS / avgTAS;
    var correctedDist = Math.round(pohDescentDistNm * gsRatio);
    var avgHeadwind = Math.round(avgTAS - avgGS);
    var correction = correctedDist - pohDescentDistNm;

    console.log('[WIND-DES] Descent FL' + Math.round(cruiseAltFt/100) + ' → ' + Math.round(destElevFt) +
        'ft: avgTAS=' + Math.round(avgTAS) + ', avgGS=' + Math.round(avgGS) +
        ', HW=' + avgHeadwind + 'kt, POH dist=' + pohDescentDistNm +
        'nm → corrected=' + correctedDist + 'nm (' + (correction >= 0 ? '+' : '') + correction + ')');

    return {
        distNm: correctedDist,
        avgHeadwind: avgHeadwind,
        correction: correction
    };
}

// ---------------------------------------------------------------------------
// HELPER: Rate of climb at altitude (from fltplan.com data)
// Returns feet per minute
// ---------------------------------------------------------------------------
function getClimbRateAtAltitude(altFt) {
    // fltplan.com rate of climb data for N850AP
    var rocTable = [
        { alt:     0, roc: 1000 },
        { alt:  1000, roc: 1500 },
        { alt:  2000, roc: 1500 },
        { alt:  3000, roc: 2000 },
        { alt:  4000, roc: 1980 },
        { alt:  5000, roc: 1960 },
        { alt:  6000, roc: 1940 },
        { alt:  7000, roc: 1920 },
        { alt:  8000, roc: 1900 },
        { alt:  9000, roc: 1785 },
        { alt: 10000, roc: 1670 },
        { alt: 11000, roc: 1630 },
        { alt: 12000, roc: 1590 },
        { alt: 13000, roc: 1550 },
        { alt: 14000, roc: 1510 },
        { alt: 15000, roc: 1470 },
        { alt: 16000, roc: 1425 },
        { alt: 17000, roc: 1385 },
        { alt: 18000, roc: 1345 },
        { alt: 19000, roc: 1305 },
        { alt: 20000, roc: 1265 },
        { alt: 21000, roc: 1225 },
        { alt: 22000, roc: 1185 },
        { alt: 23000, roc: 1145 },
        { alt: 24000, roc: 1105 },
        { alt: 25000, roc: 1065 },
        { alt: 26000, roc: 1020 },
        { alt: 27000, roc:  980 },
        { alt: 28000, roc:  940 },
        { alt: 29000, roc:  900 },
        { alt: 30000, roc:  860 },
        { alt: 31000, roc:  800 }
    ];

    // Find bounding entries and interpolate
    if (altFt <= rocTable[0].alt) return rocTable[0].roc;
    if (altFt >= rocTable[rocTable.length - 1].alt) return rocTable[rocTable.length - 1].roc;

    for (var i = 0; i < rocTable.length - 1; i++) {
        if (altFt >= rocTable[i].alt && altFt <= rocTable[i + 1].alt) {
            var frac = (altFt - rocTable[i].alt) / (rocTable[i + 1].alt - rocTable[i].alt);
            return rocTable[i].roc + frac * (rocTable[i + 1].roc - rocTable[i].roc);
        }
    }
    return rocTable[rocTable.length - 1].roc;
}

// ---------------------------------------------------------------------------
// HELPER: Rate of descent at altitude
// POH uses 2000 fpm as standard, but varies slightly by altitude.
// We use a simplified model based on POH descent table.
// ---------------------------------------------------------------------------
function getDescentRateAtAltitude(altFt) {
    // POH descent at Vz=2000 fpm is the nominal rate.
    // In practice, ATC may require different rates. Using 2000 as baseline.
    // Above FL240 slightly lower, below FL100 slightly lower for approach
    if (altFt > 24000) return 1800;  // slower descent at higher altitudes
    if (altFt < 6000)  return 1500;  // slower for approach
    return 2000;                      // standard mid-altitude descent rate
}

// ---------------------------------------------------------------------------
// HELPER: Extract wind profile at a location from GFS waypoint data
//
// This takes the raw GFS data for a specific waypoint (all pressure levels)
// and formats it as the sorted array that getWindAtAltitude() expects.
//
// gfsWaypointData = the decoded data for one waypoint with U/V at each level
//   Format: { levels: [ { mb, uMs, vMs }, ... ] }
//
// Returns: [ { mb, altFt, dir, spdKt }, ... ] sorted by altitude ascending
// ---------------------------------------------------------------------------
function extractWindProfile(gfsWaypointData) {
    if (!gfsWaypointData || !gfsWaypointData.levels) return [];

    var profile = [];

    for (var i = 0; i < gfsWaypointData.levels.length; i++) {
        var lev = gfsWaypointData.levels[i];

        // Convert U/V (m/s) to direction and speed (kt)
        var uMs = lev.uMs;
        var vMs = lev.vMs;
        var spdMs = Math.sqrt(uMs * uMs + vMs * vMs);
        var spdKt = Math.round(spdMs * 1.944);  // m/s to knots

        // Meteorological convention: direction wind is FROM
        var dirRad = Math.atan2(-uMs, -vMs);
        var dirDeg = (dirRad * 180 / Math.PI + 360) % 360;

        // Find altitude for this pressure level
        var altFt = pressureToAltitude(lev.mb);

        profile.push({
            mb: lev.mb,
            altFt: altFt,
            dir: Math.round(dirDeg),
            spdKt: spdKt
        });
    }

    // Sort by altitude ascending
    profile.sort(function(a, b) { return a.altFt - b.altFt; });

    return profile;
}

// ---------------------------------------------------------------------------
// HELPER: Standard atmosphere pressure to altitude conversion
// Returns altitude in feet
// ---------------------------------------------------------------------------
function pressureToAltitude(pressureMb) {
    // Standard atmosphere: h = (1 - (P/1013.25)^0.190284) × 145366.45
    var ratio = pressureMb / 1013.25;
    var altFt = (1 - Math.pow(ratio, 0.190284)) * 145366.45;
    return Math.round(altFt);
}

// ---------------------------------------------------------------------------
// CONVENIENCE: Get averaged wind profile for departure area
// Averages winds from the first N waypoints along the route
// ---------------------------------------------------------------------------
function getDepartureWindProfile(allWaypointData, numPoints) {
    numPoints = numPoints || 3;  // default: average first 3 waypoints
    var count = Math.min(numPoints, allWaypointData.length);

    if (count === 0) return [];

    // Use first waypoint's profile as base structure
    var baseProfile = extractWindProfile(allWaypointData[0]);
    if (count === 1) return baseProfile;

    // Average across multiple waypoints
    for (var p = 1; p < count; p++) {
        var profile = extractWindProfile(allWaypointData[p]);
        for (var i = 0; i < baseProfile.length && i < profile.length; i++) {
            // Simple vector average: convert back to U/V, average, convert back
            var dir1 = baseProfile[i].dir * Math.PI / 180;
            var spd1 = baseProfile[i].spdKt;
            var u1 = -spd1 * Math.sin(dir1);
            var v1 = -spd1 * Math.cos(dir1);

            var dir2 = profile[i].dir * Math.PI / 180;
            var spd2 = profile[i].spdKt;
            var u2 = -spd2 * Math.sin(dir2);
            var v2 = -spd2 * Math.cos(dir2);

            var avgU = (u1 * p + u2) / (p + 1);
            var avgV = (v1 * p + v2) / (p + 1);

            var avgSpd = Math.sqrt(avgU * avgU + avgV * avgV);
            var avgDir = (Math.atan2(-avgU, -avgV) * 180 / Math.PI + 360) % 360;

            baseProfile[i].spdKt = Math.round(avgSpd);
            baseProfile[i].dir = Math.round(avgDir);
        }
    }

    return baseProfile;
}

// ---------------------------------------------------------------------------
// CONVENIENCE: Get averaged wind profile for arrival area
// Averages winds from the last N waypoints along the route
// ---------------------------------------------------------------------------
function getArrivalWindProfile(allWaypointData, numPoints) {
    numPoints = numPoints || 3;
    var total = allWaypointData.length;
    var startIdx = Math.max(0, total - numPoints);

    // Reuse departure function logic but on the tail end
    var arrivalData = allWaypointData.slice(startIdx);
    return getDepartureWindProfile(arrivalData, arrivalData.length);
}
