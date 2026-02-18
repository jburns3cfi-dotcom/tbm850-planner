// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js loaded first
// Optional: winds-aloft.js for wind correction
// ============================================================

// Calculate a complete flight from departure to destination
// dep: { ident, lat, lon, elevation }
// dest: { ident, lat, lon, elevation }
// cruiseAlt: altitude in feet MSL
// groundSpeed: optional wind-corrected GS (null = use TAS)
// windInfo: optional { dir, spd, headTail, crosswind }
function calculateFlight(dep, dest, cruiseAlt, groundSpeed, windInfo) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Phase 1: Climb
    var climb = calculateClimb(dep.elevation, cruiseAlt);

    // Phase 2: Descent
    var descent = calculateDescent(cruiseAlt, dest.elevation);

    // Phase 3: Cruise (remaining distance)
    var cruiseDist = totalDist - climb.distanceNM - descent.distanceNM;
    if (cruiseDist < 0) cruiseDist = 0;

    var perf = getPerformanceAtAltitude(cruiseAlt);
    var tas = perf.cruiseTAS;
    var gs = groundSpeed || tas;

    var cruise = calculateCruise(cruiseDist, cruiseAlt, gs);

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
            tas:        tas,
            groundSpeed: Math.round(gs)
        },
        descent:     descent,
        totals: {
            timeMin:  Math.round(totalTimeMin * 10) / 10,
            timeHrs:  formatTime(totalTimeMin),
            fuelGal:  Math.round(totalFuelGal * 10) / 10,
            taxiFuel: TAXI_FUEL
        },
        wind: windInfo || null
    };
}

// Calculate flights at multiple altitudes for comparison
// Now with optional wind data for ground speed correction
// windData: parsed winds aloft data from WindsAloft.fetchAllWinds()
function calculateAltitudeOptions(dep, dest, windData) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    // Get ALL valid altitudes for this direction
    var allAlts = getValidAltitudes(trueCourse, 18000, 31000);

    // Calculate midpoint of route for wind interpolation
    var mid = intermediatePoint(dep.lat, dep.lon, dest.lat, dest.lon, 0.5);

    var results = [];

    for (var i = 0; i < allAlts.length; i++) {
        var alt = allAlts[i];
        var perf = getPerformanceAtAltitude(alt);
        var gs = perf.cruiseTAS;
        var windInfo = null;

        // Apply wind correction if we have wind data
        if (windData && typeof WindsAloft !== 'undefined') {
            var windResult = WindsAloft.getGroundSpeed(
                windData, mid.lat, mid.lon, alt, trueCourse, perf.cruiseTAS
            );
            gs = windResult.groundSpeed;
            windInfo = {
                dir: windResult.wind ? windResult.wind.dir : 0,
                spd: windResult.wind ? windResult.wind.spd : 0,
                headTail: windResult.headTail,
                crosswind: windResult.crosswind
            };
        }

        var plan = calculateFlight(dep, dest, alt, gs, windInfo);
        results.push(plan);
    }

    // Sort by total time (shortest first) and take best 3
    results.sort(function (a, b) { return a.totals.timeMin - b.totals.timeMin; });
    var best3 = results.slice(0, 3);

    return {
        trueCourse: Math.round(trueCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: best3,
        hasWindData: !!windData,
        allOptions: results  // Keep all for reference
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
    var threshold = 3.5 * 60; // 3 hours 30 minutes = 210 minutes
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
