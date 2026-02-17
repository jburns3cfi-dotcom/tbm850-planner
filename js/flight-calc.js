// ============================================================
// FLIGHT CALC MODULE — Complete Flight Planning
// TBM850 Apple Flight Planner
// Requires: performance.js, route.js loaded first
// ============================================================

// Calculate a complete flight from departure to destination
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

// Calculate flights at ALL valid altitudes, rank by total time, return best 3
function calculateAltitudeOptions(dep, dest) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Magnetic course at departure point for FAA altitude rules
    var magCourse = getMagneticCourse(trueCourse, dep.lat, dep.lon);
    var magVar = estimateMagVar(dep.lat, dep.lon);

    // Get valid altitudes based on magnetic course (FAR 91.179)
    var allAltitudes = getTop3Altitudes(magCourse);
    var allPlans = [];

    for (var i = 0; i < allAltitudes.length; i++) {
        var plan = calculateFlight(dep, dest, allAltitudes[i], null);
        allPlans.push(plan);
    }

    // Sort by total time (best first)
    allPlans.sort(function(a, b) {
        return a.totals.timeMin - b.totals.timeMin;
    });

    var top3 = allPlans.slice(0, 3);

    return {
        trueCourse: Math.round(trueCourse),
        magCourse: Math.round(magCourse),
        magVar: magVar,
        direction: magCourse < 180 ? 'Easterly' : 'Westerly',
        options: top3
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
