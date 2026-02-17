// ============================================================
// PERFORMANCE MODULE — TBM850 Apple Flight Planner
// Source: fltplan.com validated data for N850AP (PRIMARY)
// ============================================================

var CLIMB_FACTOR = 1.40;
var DESCENT_FACTOR = 1.12;
var TAXI_FUEL = 8;
var FUEL_BURN_HOURLY = { firstHour: 75, subsequent: 65 };
var CLIMB_FUEL_FLOW = { low: { alt: 2000, gph: 78 }, high: { alt: 31000, gph: 54 } };
var DESCENT_FUEL_FLOW = { low: { alt: 2000, gph: 78 }, high: { alt: 31000, gph: 46 } };

var PERFORMANCE_TABLE = [
    { alt: 0,     climbIAS: 85,  roc: 1000, cruiseTAS: 227, cruiseGPH: 83,   descentIAS: 79  },
    { alt: 1000,  climbIAS: 124, roc: 1500, cruiseTAS: 229, cruiseGPH: 81,   descentIAS: 98  },
    { alt: 2000,  climbIAS: 148, roc: 1500, cruiseTAS: 231, cruiseGPH: 80,   descentIAS: 128 },
    { alt: 3000,  climbIAS: 158, roc: 2000, cruiseTAS: 233, cruiseGPH: 78,   descentIAS: 158 },
    { alt: 4000,  climbIAS: 158, roc: 1980, cruiseTAS: 236, cruiseGPH: 77,   descentIAS: 197 },
    { alt: 5000,  climbIAS: 157, roc: 1960, cruiseTAS: 238, cruiseGPH: 75,   descentIAS: 227 },
    { alt: 6000,  climbIAS: 158, roc: 1940, cruiseTAS: 240, cruiseGPH: 74,   descentIAS: 227 },
    { alt: 7000,  climbIAS: 158, roc: 1920, cruiseTAS: 243, cruiseGPH: 73,   descentIAS: 226 },
    { alt: 8000,  climbIAS: 158, roc: 1900, cruiseTAS: 245, cruiseGPH: 71,   descentIAS: 227 },
    { alt: 9000,  climbIAS: 158, roc: 1785, cruiseTAS: 248, cruiseGPH: 70,   descentIAS: 227 },
    { alt: 10000, climbIAS: 157, roc: 1670, cruiseTAS: 250, cruiseGPH: 68,   descentIAS: 226 },
    { alt: 11000, climbIAS: 158, roc: 1630, cruiseTAS: 252, cruiseGPH: 67,   descentIAS: 226 },
    { alt: 12000, climbIAS: 158, roc: 1590, cruiseTAS: 255, cruiseGPH: 66,   descentIAS: 226 },
    { alt: 13000, climbIAS: 157, roc: 1550, cruiseTAS: 257, cruiseGPH: 65,   descentIAS: 227 },
    { alt: 14000, climbIAS: 158, roc: 1510, cruiseTAS: 260, cruiseGPH: 64,   descentIAS: 227 },
    { alt: 15000, climbIAS: 157, roc: 1470, cruiseTAS: 262, cruiseGPH: 62.5, descentIAS: 226 },
    { alt: 16000, climbIAS: 158, roc: 1425, cruiseTAS: 265, cruiseGPH: 61.8, descentIAS: 226 },
    { alt: 17000, climbIAS: 158, roc: 1385, cruiseTAS: 268, cruiseGPH: 61.0, descentIAS: 227 },
    { alt: 18000, climbIAS: 158, roc: 1345, cruiseTAS: 270, cruiseGPH: 60.2, descentIAS: 227 },
    { alt: 19000, climbIAS: 157, roc: 1305, cruiseTAS: 273, cruiseGPH: 59.6, descentIAS: 226 },
    { alt: 20000, climbIAS: 158, roc: 1265, cruiseTAS: 276, cruiseGPH: 58.9, descentIAS: 226 },
    { alt: 21000, climbIAS: 156, roc: 1225, cruiseTAS: 279, cruiseGPH: 58.5, descentIAS: 227 },
    { alt: 22000, climbIAS: 154, roc: 1185, cruiseTAS: 281, cruiseGPH: 58.0, descentIAS: 227 },
    { alt: 23000, climbIAS: 152, roc: 1145, cruiseTAS: 285, cruiseGPH: 57.5, descentIAS: 222 },
    { alt: 24000, climbIAS: 150, roc: 1105, cruiseTAS: 288, cruiseGPH: 57.1, descentIAS: 217 },
    { alt: 25000, climbIAS: 147, roc: 1065, cruiseTAS: 291, cruiseGPH: 56.8, descentIAS: 210 },
    { alt: 26000, climbIAS: 146, roc: 1020, cruiseTAS: 292, cruiseGPH: 55,   descentIAS: 206 },
    { alt: 27000, climbIAS: 144, roc: 980,  cruiseTAS: 289, cruiseGPH: 55,   descentIAS: 200 },
    { alt: 28000, climbIAS: 142, roc: 940,  cruiseTAS: 287, cruiseGPH: 55,   descentIAS: 195 },
    { alt: 29000, climbIAS: 139, roc: 900,  cruiseTAS: 285, cruiseGPH: 56,   descentIAS: 189 },
    { alt: 30000, climbIAS: 138, roc: 860,  cruiseTAS: 280, cruiseGPH: 53,   descentIAS: 184 },
    { alt: 31000, climbIAS: 135, roc: 800,  cruiseTAS: 277, cruiseGPH: 48,   descentIAS: 177 }
];

function getPerformanceAtAltitude(altitude) {
    var alt = Math.max(0, Math.min(31000, altitude));
    var lower = PERFORMANCE_TABLE[0];
    var upper = PERFORMANCE_TABLE[PERFORMANCE_TABLE.length - 1];

    for (var i = 0; i < PERFORMANCE_TABLE.length; i++) {
        if (PERFORMANCE_TABLE[i].alt === alt) return JSON.parse(JSON.stringify(PERFORMANCE_TABLE[i]));
        if (PERFORMANCE_TABLE[i].alt < alt) lower = PERFORMANCE_TABLE[i];
        if (PERFORMANCE_TABLE[i].alt > alt) { upper = PERFORMANCE_TABLE[i]; break; }
    }
    if (lower.alt === upper.alt) return JSON.parse(JSON.stringify(lower));

    var frac = (alt - lower.alt) / (upper.alt - lower.alt);
    return {
        alt: alt,
        climbIAS:   Math.round(lower.climbIAS + (upper.climbIAS - lower.climbIAS) * frac),
        roc:        Math.round(lower.roc + (upper.roc - lower.roc) * frac),
        cruiseTAS:  Math.round((lower.cruiseTAS + (upper.cruiseTAS - lower.cruiseTAS) * frac) * 10) / 10,
        cruiseGPH:  Math.round((lower.cruiseGPH + (upper.cruiseGPH - lower.cruiseGPH) * frac) * 10) / 10,
        descentIAS: Math.round(lower.descentIAS + (upper.descentIAS - lower.descentIAS) * frac)
    };
}

function interpolateFuelFlow(endpoints, altitude) {
    var frac = (altitude - endpoints.low.alt) / (endpoints.high.alt - endpoints.low.alt);
    frac = Math.max(0, Math.min(1, frac));
    return endpoints.low.gph + (endpoints.high.gph - endpoints.low.gph) * frac;
}

function calculateClimb(departureElevFt, cruiseAltFt) {
    if (cruiseAltFt <= departureElevFt) return { timeMin: 0, fuelGal: 0, distanceNM: 0 };

    var totalTimeMin = 0, totalFuelGal = 0, totalDistNM = 0;
    var step = 1000;
    var currentAlt = departureElevFt;

    while (currentAlt < cruiseAltFt) {
        var nextAlt = Math.min(currentAlt + step, cruiseAltFt);
        var midAlt = (currentAlt + nextAlt) / 2;
        var altGain = nextAlt - currentAlt;
        var perf = getPerformanceAtAltitude(midAlt);
        var timeMin = altGain / perf.roc;
        var gph = interpolateFuelFlow(CLIMB_FUEL_FLOW, midAlt);
        var fuelGal = gph * (timeMin / 60);
        var distNM = perf.climbIAS * (timeMin / 60);
        totalTimeMin += timeMin;
        totalFuelGal += fuelGal;
        totalDistNM += distNM;
        currentAlt = nextAlt;
    }

    return {
        timeMin:    Math.round(totalTimeMin * CLIMB_FACTOR * 10) / 10,
        fuelGal:    Math.round(totalFuelGal * CLIMB_FACTOR * 10) / 10,
        distanceNM: Math.round(totalDistNM * CLIMB_FACTOR * 10) / 10
    };
}

function calculateDescent(cruiseAltFt, destElevFt) {
    if (cruiseAltFt <= destElevFt) return { timeMin: 0, fuelGal: 0, distanceNM: 0 };

    var totalTimeMin = 0, totalFuelGal = 0, totalDistNM = 0;
    var step = 1000;
    var currentAlt = cruiseAltFt;

    while (currentAlt > destElevFt) {
        var nextAlt = Math.max(currentAlt - step, destElevFt);
        var midAlt = (currentAlt + nextAlt) / 2;
        var altLoss = currentAlt - nextAlt;
        var perf = getPerformanceAtAltitude(midAlt);
        var descentRate = Math.min(2500, Math.max(1000, perf.descentIAS * 8));
        var timeMin = altLoss / descentRate;
        var gph = interpolateFuelFlow(DESCENT_FUEL_FLOW, midAlt);
        var fuelGal = gph * (timeMin / 60);
        var distNM = perf.descentIAS * (timeMin / 60);
        totalTimeMin += timeMin;
        totalFuelGal += fuelGal;
        totalDistNM += distNM;
        currentAlt = nextAlt;
    }

    return {
        timeMin:    Math.round(totalTimeMin * DESCENT_FACTOR * 10) / 10,
        fuelGal:    Math.round(totalFuelGal * DESCENT_FACTOR * 10) / 10,
        distanceNM: Math.round(totalDistNM * DESCENT_FACTOR * 10) / 10
    };
}

function calculateCruise(cruiseDistNM, altitude, groundSpeed) {
    if (cruiseDistNM <= 0) return { timeMin: 0, fuelGal: 0, tas: 0 };
    var perf = getPerformanceAtAltitude(altitude);
    var gs = groundSpeed || perf.cruiseTAS;
    var timeHrs = cruiseDistNM / gs;
    var timeMin = timeHrs * 60;
    var fuelGal;
    if (timeHrs <= 1) {
        fuelGal = FUEL_BURN_HOURLY.firstHour * timeHrs;
    } else {
        fuelGal = FUEL_BURN_HOURLY.firstHour + FUEL_BURN_HOURLY.subsequent * (timeHrs - 1);
    }
    return {
        timeMin: Math.round(timeMin * 10) / 10,
        fuelGal: Math.round(fuelGal * 10) / 10,
        tas: perf.cruiseTAS
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PERFORMANCE_TABLE, CLIMB_FACTOR, DESCENT_FACTOR,
        TAXI_FUEL, FUEL_BURN_HOURLY,
        getPerformanceAtAltitude, calculateClimb, calculateDescent, calculateCruise
    };
}
