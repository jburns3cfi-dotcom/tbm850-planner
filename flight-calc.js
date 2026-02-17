// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js loaded first
// ============================================================

// Calculate a complete flight from departure to destination
// dep: { ident, lat, lon, elevation }
// dest: { ident, lat, lon, elevation }
// cruiseAlt: altitude in feet MSL
// groundSpeed: optional wind-corrected GS (null = use TAS)
// Returns full flight plan with all phases
function calculateFlight(dep, dest, cruiseAlt, groundSpeed) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Phase 1: Climb
    var climb = calculateClimb(dep.elevation, cruiseAlt);

    // Phase 2: Descent
    var descent = calculateDescent(cruiseAlt, dest.elevation);

    // Phase 3: Cruise (remaining distance)
    var cruiseDist = totalDist - climb.distanceNM - descent.distanceNM;
    if (cruiseDist < 0) {
        // Route too short for full climb + descent at this altitude
        // Adjust: reduce cruise to 0, pro-rate climb and descent
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

// Calculate flights at multiple altitudes for comparison
function calculateAltitudeOptions(dep, dest) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var altitudes = getTop3Altitudes(trueCourse);
    var results = [];

    for (var i = 0; i < altitudes.length; i++) {
        var plan = calculateFlight(dep, dest, altitudes[i], null);
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
