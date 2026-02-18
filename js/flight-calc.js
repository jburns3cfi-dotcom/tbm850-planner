// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js loaded first
// Optional: gfs-winds.js for wind-corrected climb/descent
// ============================================================

// Minimum usable cruise segment (nm). If cruise distance after
// subtracting climb+descent is below this, the altitude is
// flagged as not viable for this route length.
var MIN_CRUISE_DIST_NM = 10;

// Calculate a complete flight from departure to destination
// dep: { ident, lat, lon, elevation }
// dest: { ident, lat, lon, elevation }
// cruiseAlt: altitude in feet MSL
// groundSpeed: optional wind-corrected cruise GS (null = use TAS)
// gfsData: optional GFS wind data for climb/descent corrections
// Returns full flight plan with all phases
function calculateFlight(dep, dest, cruiseAlt, groundSpeed, gfsData) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Auto-detect GFS wind cache if not passed directly
    if (!gfsData && typeof _gfsWindCache !== 'undefined' && _gfsWindCache) {
        gfsData = _gfsWindCache;
    }

    // Phase 1: Climb (still-air POH values with correction factor)
    var climb = calculateClimb(dep.elevation, cruiseAlt);
    var climbDistRaw = climb.distanceNM;  // before wind correction

    // Phase 2: Descent (still-air POH values with correction factor)
    var descent = calculateDescent(cruiseAlt, dest.elevation);
    var descentDistRaw = descent.distanceNM;  // before wind correction

    // Apply wind corrections to climb/descent DISTANCE if GFS data available
    // Wind affects ground distance covered, NOT time or fuel
    var climbDistWind = climbDistRaw;
    var descentDistWind = descentDistRaw;

    if (gfsData) {
        if (typeof calcWindCorrectedClimbDist === 'function') {
            climbDistWind = calcWindCorrectedClimbDist(
                climbDistRaw, dep.elevation, cruiseAlt, trueCourse, gfsData
            );
            console.log('[WIND-CLB] POH: ' + climbDistRaw.toFixed(1) +
                'nm → Wind-corrected: ' + climbDistWind.toFixed(1) + 'nm' +
                ' (delta: ' + (climbDistWind - climbDistRaw).toFixed(1) + 'nm)');
        }
        if (typeof calcWindCorrectedDescentDist === 'function') {
            descentDistWind = calcWindCorrectedDescentDist(
                descentDistRaw, dest.elevation, cruiseAlt, trueCourse, gfsData
            );
            console.log('[WIND-DES] POH: ' + descentDistRaw.toFixed(1) +
                'nm → Wind-corrected: ' + descentDistWind.toFixed(1) + 'nm' +
                ' (delta: ' + (descentDistWind - descentDistRaw).toFixed(1) + 'nm)');
        }
    }

    // Phase 3: Cruise (remaining distance after wind-corrected climb+descent)
    var cruiseDist = totalDist - climbDistWind - descentDistWind;

    // Short-route safeguard: flag altitude as not viable if cruise too short
    var viable = true;
    if (cruiseDist < MIN_CRUISE_DIST_NM) {
        console.log('[SHORT-RTE] FL' + (cruiseAlt / 100) +
            ': climb(' + climbDistWind.toFixed(1) + ') + descent(' +
            descentDistWind.toFixed(1) + ') = ' +
            (climbDistWind + descentDistWind).toFixed(1) +
            'nm vs route ' + totalDist.toFixed(1) + 'nm — NOT VIABLE');
        cruiseDist = 0;
        viable = false;
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
        viable:      viable,
        climb: {
            distanceNM: Math.round(climbDistWind * 10) / 10,
            distanceNM_nowind: Math.round(climbDistRaw * 10) / 10,
            timeMin:    climb.timeMin,
            fuelGal:    climb.fuelGal
        },
        cruise: {
            distanceNM: Math.round(cruiseDist * 10) / 10,
            timeMin:    cruise.timeMin,
            fuelGal:    cruise.fuelGal,
            tas:        cruise.tas,
            groundSpeed: groundSpeed || cruise.tas
        },
        descent: {
            distanceNM: Math.round(descentDistWind * 10) / 10,
            distanceNM_nowind: Math.round(descentDistRaw * 10) / 10,
            timeMin:    descent.timeMin,
            fuelGal:    descent.fuelGal
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
// Filters out non-viable altitudes (climb+descent exceeds route)
function calculateAltitudeOptions(dep, dest) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var altitudes = getTop3Altitudes(trueCourse);
    var results = [];

    for (var i = 0; i < altitudes.length; i++) {
        var plan = calculateFlight(dep, dest, altitudes[i], null, null);
        if (plan.viable) {
            results.push(plan);
        }
    }

    // If ALL altitudes were filtered out (extremely short route),
    // try lower altitudes down to FL180
    if (results.length === 0) {
        console.log('[SHORT-RTE] All standard altitudes non-viable, trying lower FLs');
        var lowerAlts = [24000, 22000, 20000, 18000];
        for (var j = 0; j < lowerAlts.length; j++) {
            var lowPlan = calculateFlight(dep, dest, lowerAlts[j], null, null);
            if (lowPlan.viable) {
                results.push(lowPlan);
                if (results.length >= 3) break;
            }
        }
    }

    // Last resort: if still nothing viable, include lowest with warning
    if (results.length === 0) {
        console.log('[SHORT-RTE] No altitude viable — route may be too short for TBM850 optimization');
        var minPlan = calculateFlight(dep, dest, 18000, null, null);
        minPlan.viable = true;  // force it in so user sees something
        minPlan.warning = 'Route very short — climb/descent dominate';
        results.push(minPlan);
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
