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
// windSummary: optional wind info object for display
function calculateFlight(dep, dest, cruiseAlt, groundSpeed, windSummary) {
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Phase 1: Climb
    var climb = calculateClimb(dep.elevation, cruiseAlt);

    // Phase 2: Descent
    var descent = calculateDescent(cruiseAlt, dest.elevation);

    // Phase 3: Cruise (remaining distance)
    var cruiseDist = totalDist - climb.distanceNM - descent.distanceNM;
    if (cruiseDist < 0) {
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
            groundSpeed: groundSpeed || cruise.tas,
            wind:       windSummary || null
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
// Now async — fetches wind data then calculates all options
// dep/dest: airport objects with ident, lat, lon, elevation
// forecastHr: '06', '12', or '24' (from existing day/time logic)
//   If null/undefined, calculates without wind correction
async function calculateAltitudeOptions(dep, dest, forecastHr) {
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var altitudes = getTop3Altitudes(trueCourse);

    // Attempt to fetch wind data
    var routeWindData = null;
    var windStatus = 'none';

    if (forecastHr) {
        try {
            routeWindData = await fetchRouteWinds(dep, dest, forecastHr);
            if (routeWindData && routeWindData.stationList.length > 0) {
                windStatus = 'ok';
                console.log('Wind data loaded: ' + routeWindData.stationList.length + ' stations');
            } else {
                windStatus = 'no-stations';
                console.warn('Wind fetch returned no usable stations');
            }
        } catch (err) {
            windStatus = 'error';
            console.error('Wind fetch error:', err);
        }
    }

    // Calculate each altitude option with wind correction
    var results = [];
    for (var i = 0; i < altitudes.length; i++) {
        var alt = altitudes[i];
        var perf = getPerformanceAtAltitude(alt);
        var gs = null;
        var windInfo = null;

        if (routeWindData) {
            windInfo = getWindSummary(routeWindData, alt, trueCourse, perf.cruiseTAS);
            if (windInfo.available) {
                gs = windInfo.gs;
            }
        }

        var plan = calculateFlight(dep, dest, alt, gs, windInfo);
        results.push(plan);
    }

    return {
        trueCourse: Math.round(trueCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: results,
        windStatus: windStatus,
        windStations: routeWindData ? routeWindData.stationList.length : 0
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
