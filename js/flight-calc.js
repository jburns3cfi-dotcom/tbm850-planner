// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js, gfs-winds.js loaded first
// ============================================================

// Calculate a complete flight from departure to destination
// dep: { ident, lat, lon, elevation }
// dest: { ident, lat, lon, elevation }
// cruiseAlt: altitude in feet MSL
// groundSpeed: optional wind-corrected GS (null = use TAS)
// gfsData: optional GFS wind data object for climb/descent corrections
// Returns full flight plan with all phases
function calculateFlight(dep, dest, cruiseAlt, groundSpeed, gfsData) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Auto-detect GFS data: use passed param, or fall back to global cache
    if (!gfsData && typeof _gfsWindCache !== 'undefined' && _gfsWindCache) {
        gfsData = _gfsWindCache;
    }

    // Phase 1: Climb (POH/fltplan still-air values)
    var climb = calculateClimb(dep.elevation, cruiseAlt);

    // Phase 2: Descent (POH/fltplan still-air values)
    var descent = calculateDescent(cruiseAlt, dest.elevation);

    // Apply wind corrections to climb/descent DISTANCE only
    // Time and fuel are unchanged — wind only affects ground covered
    var climbDist = climb.distanceNM;
    var descentDist = descent.distanceNM;
    var climbWindCorr = 0;
    var descentWindCorr = 0;

    if (gfsData && gfsData.waypoints && gfsData.waypoints.length >= 2) {
        // Wind-corrected climb distance
        var climbResult = calcWindCorrectedClimbDist(
            climb.distanceNM, dep.elevation, cruiseAlt, trueCourse, gfsData
        );
        climbDist = climbResult.distNm;
        climbWindCorr = climbResult.correction;

        // Wind-corrected descent distance
        var descentResult = calcWindCorrectedDescentDist(
            descent.distanceNM, dest.elevation, cruiseAlt, trueCourse, gfsData
        );
        descentDist = descentResult.distNm;
        descentWindCorr = descentResult.correction;
    }

    // Phase 3: Cruise (remaining distance after wind-corrected climb/descent)
    var cruiseDist = totalDist - climbDist - descentDist;

    // Safety: cruise distance must be positive
    if (cruiseDist < 0) {
        // Route too short for full climb + descent at this altitude
        console.warn('[CALC] Cruise distance negative (' + Math.round(cruiseDist) +
            'nm) — altitude may be too high for this ' + Math.round(totalDist) + 'nm route');
        cruiseDist = 0;
    }

    var cruise = calculateCruise(cruiseDist, cruiseAlt, groundSpeed);

    // Totals
    var totalTimeMin = climb.timeMin + cruise.timeMin + descent.timeMin;
    var totalFuelGal = TAXI_FUEL + climb.fuelGal + cruise.fuelGal + descent.fuelGal;

    return {
        departure:   dep.ident,
        destination: dest.ident,
        distance:    Math.round(totalDist * 10) / 10,
        trueCourse:  Math.round(trueCourse),
        cruiseAlt:   cruiseAlt,
        climb: {
            distanceNM: Math.round(climbDist * 10) / 10,
            timeMin:    climb.timeMin,
            fuelGal:    climb.fuelGal,
            windCorrection: climbWindCorr,
            pohDistNM:  climb.distanceNM  // original still-air distance for reference
        },
        cruise: {
            distanceNM: Math.round(cruiseDist * 10) / 10,
            timeMin:    cruise.timeMin,
            fuelGal:    cruise.fuelGal,
            tas:        cruise.tas,
            groundSpeed: groundSpeed || cruise.tas
        },
        descent: {
            distanceNM: Math.round(descentDist * 10) / 10,
            timeMin:    descent.timeMin,
            fuelGal:    descent.fuelGal,
            windCorrection: descentWindCorr,
            pohDistNM:  descent.distanceNM  // original still-air distance for reference
        },
        totals: {
            timeMin:  Math.round(totalTimeMin * 10) / 10,
            timeHrs:  formatTime(totalTimeMin),
            fuelGal:  Math.round(totalFuelGal * 10) / 10,
            taxiFuel: TAXI_FUEL
        }
    };
}

// Calculate flights at multiple altitudes for comparison
// gfsData: optional GFS wind data for climb/descent corrections
function calculateAltitudeOptions(dep, dest, gfsData) {
    // Auto-detect GFS data from global cache if not passed
    if (!gfsData && typeof _gfsWindCache !== 'undefined' && _gfsWindCache) {
        gfsData = _gfsWindCache;
    }
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var altitudes = getTop3Altitudes(trueCourse);
    var results = [];

    for (var i = 0; i < altitudes.length; i++) {
        var plan = calculateFlight(dep, dest, altitudes[i], null, gfsData);
        results.push(plan);
    }

    return {
        trueCourse: Math.round(trueCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: results
    };
}

// Format minutes to hours:minutes string
function formatTime(totalMinutes) {
    var hrs = Math.floor(totalMinutes / 60);
    var mins = Math.round(totalMinutes % 60);
    if (mins === 60) { hrs++; mins = 0; }
    return hrs + ':' + (mins < 10 ? '0' : '') + mins;
}

// Check if any altitude option triggers fuel stop search (>= 3:30)
function needsFuelStop(altitudeOptions) {
    var threshold = 3.5 * 60; // 3 hours 30 minutes
    for (var i = 0; i < altitudeOptions.options.length; i++) {
        if (altitudeOptions.options[i].totals.timeMin >= threshold) {
            return true;
        }
    }
    return false;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculateFlight, calculateAltitudeOptions, formatTime, needsFuelStop
    };
}
