// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js, winds.js loaded first
// ============================================================

// Calculate a complete flight from departure to destination
// dep: { ident, lat, lon, elevation }
// dest: { ident, lat, lon, elevation }
// cruiseAlt: altitude in feet MSL
// groundSpeed: optional wind-corrected GS (null = use TAS)
function calculateFlight(dep, dest, cruiseAlt, groundSpeed) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Phase 1: Climb
    var climb = calculateClimb(dep.elevation, cruiseAlt);

    // Phase 2: Descent
    var descent = calculateDescent(cruiseAlt, dest.elevation);

    // Phase 3: Cruise (remaining distance)
    var cruiseDist = totalDist - climb.distanceNM - descent.distanceNM;
    if (cruiseDist < 0) cruiseDist = 0;

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
        climb:       climb,
        cruise: {
            distanceNM: Math.round(cruiseDist * 10) / 10,
            timeMin:    cruise.timeMin,
            fuelGal:    cruise.fuelGal,
            tas:        cruise.tas,
            groundSpeed: groundSpeed || cruise.tas
        },
        descent:     descent,
        totals: {
            timeMin:  Math.round(totalTimeMin * 10) / 10,
            timeHrs:  formatTime(totalTimeMin),
            fuelGal:  Math.round(totalFuelGal * 10) / 10,
            taxiFuel: TAXI_FUEL
        }
    };
}

// ============================================================
// ASYNC ALTITUDE OPTIONS — Wind-aware, best 3 by time
// ============================================================
// Calculates all 4 valid altitudes for the course direction,
// fetches winds aloft, applies GS correction, returns best 3.
// forecastHr: '06', '12', or '24' — NOAA forecast period
// ============================================================
async function calculateAltitudeOptions(dep, dest, forecastHr) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var magCourse = trueCourse; // Will be corrected if getMagneticVariation exists
    if (typeof getMagneticVariation === 'function') {
        var midLat = (dep.lat + dest.lat) / 2;
        var midLon = (dep.lon + dest.lon) / 2;
        var magVar = getMagneticVariation(midLat, midLon);
        magCourse = (trueCourse - magVar + 360) % 360;
    }

    // Get all valid altitudes (4 for the direction), not just top 3
    var allAltitudes = getValidAltitudes(trueCourse, 24000, 31000);

    // Fetch winds aloft
    var windData = null;
    var windStatus = 'none';
    if (forecastHr) {
        try {
            windData = await fetchRouteWinds(dep, dest, forecastHr);
            windStatus = windData ? 'ok' : 'failed';
        } catch (err) {
            console.error('[CALC] Wind fetch error:', err);
            windStatus = 'failed';
        }
    }

    if (windData) {
        console.log('[CALC] Wind data available — applying GS corrections');
    } else {
        console.log('[CALC] No wind data — using TAS for ground speed');
    }

    // Calculate flight plan for each altitude
    var options = [];
    for (var i = 0; i < allAltitudes.length; i++) {
        var alt = allAltitudes[i];

        // Get TAS at this altitude from performance table
        var tas = getCruiseTAS(alt);

        // Calculate wind-corrected ground speed
        var gs = null;
        var windSummary = null;
        if (windData) {
            gs = calculateGroundSpeed(windData, alt, trueCourse, tas);
            windSummary = getWindSummary(windData, alt, trueCourse, tas);
        }

        var plan = calculateFlight(dep, dest, alt, gs);
        plan.windSummary = windSummary;
        options.push(plan);
    }

    // Sort by total time (shortest first)
    options.sort(function(a, b) {
        return a.totals.timeMin - b.totals.timeMin;
    });

    // Return best 3
    var best3 = options.slice(0, 3);

    return {
        trueCourse: Math.round(trueCourse),
        magCourse: Math.round(magCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        windStatus: windStatus,
        windStationCount: windData ? windData.stationList.length : 0,
        options: best3
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
