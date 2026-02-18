// ============================================================
// GFS GRIDDED WINDS MODULE — NOMADS OPeNDAP Integration
// TBM850 Apple Flight Planner
// ============================================================
// Replaces station-based NOAA winds aloft with GFS model grid
// data. Queries wind U/V components at exact points along the
// route at pressure levels matching our flight levels.
//
// Data source: NOAA/NCEP GFS 0.25° via NOMADS OPeNDAP
// No authentication required — open public data.
// Requires Cloudflare Worker proxy for CORS.
// ============================================================

// Global wind cache — bridges GFS data to flight-calc.js
var _gfsWindCache = null;

// Proxy URL — same worker as NOAA winds aloft
var GFS_PROXY_URL = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';

// NOMADS OPeNDAP base
var GFS_BASE = 'https://nomads.ncep.noaa.gov/dods/gfs_0p25';

// Number of waypoints to sample along route
var GFS_ROUTE_POINTS = 20;

// GFS production lag — data typically available ~5h after cycle start
var GFS_PRODUCTION_LAG_HR = 5;

// ============================================================
// PRESSURE LEVEL MAPPING — EXPANDED for climb/descent winds
// ============================================================
// GFS 0.25° pressure levels (indices 8-18 = 700mb through 200mb):
// Index: 8    9   10   11   12   13   14   15   16   17   18
//   mb: 700  650  600  550  500  450  400  350  300  250  200
//
// This gives us winds from ~FL100 through FL340+ in a SINGLE
// API response per waypoint — zero extra API calls vs old range.
// ============================================================

// Fetch levels 8-18 (700mb through 200mb)
var GFS_LEVEL_RANGE = { start: 8, end: 18 };

// Actual pressure values at each index (mb)
var GFS_LEVEL_PRESSURES = {
    8:  700,   // ~FL100 / ~10,000ft
    9:  650,   // ~FL120 / ~12,000ft
    10: 600,   // ~FL140 / ~14,000ft
    11: 550,   // ~FL160 / ~16,000ft
    12: 500,   // ~FL180 / ~18,000ft
    13: 450,   // ~FL200 / ~20,000ft
    14: 400,   // ~FL240 / ~24,000ft
    15: 350,   // ~FL260 / ~26,000ft
    16: 300,   // ~FL280 / ~28,000ft
    17: 250,   // ~FL300 / ~30,000ft
    18: 200    // ~FL340 / ~34,000ft
};

// Flight level to approximate pressure (mb) using standard atmosphere
function flToPressure(flFeet) {
    var altFt = flFeet;
    if (altFt < 100) altFt = altFt * 100; // handle FL240 vs 24000
    var pressures = {
        10000: 700,
        12000: 650,
        14000: 600,
        16000: 550,
        18000: 500,
        20000: 450,
        22000: 425,
        24000: 400,
        25000: 376,
        26000: 350,
        27000: 325,
        28000: 300,
        29000: 275,
        30000: 250,
        31000: 243,
        34000: 200,
        39000: 150
    };
    if (pressures[altFt]) return pressures[altFt];
    // Linear interpolation fallback
    var keys = Object.keys(pressures).map(Number).sort(function(a,b){return a-b;});
    for (var i = 0; i < keys.length - 1; i++) {
        if (altFt >= keys[i] && altFt <= keys[i+1]) {
            var frac = (altFt - keys[i]) / (keys[i+1] - keys[i]);
            return pressures[keys[i]] + frac * (pressures[keys[i+1]] - pressures[keys[i]]);
        }
    }
    if (altFt < 10000) return 700 + (10000 - altFt) * 0.03; // rough extrap below FL100
    return 300; // default to FL280-ish
}


// ============================================================
// CLIMB/DESCENT TAS TABLES — derived from fltplan.com IAS data
// ============================================================
// These convert fltplan IAS at each altitude to approximate TAS
// using standard atmosphere density ratio.
// Used for GS/TAS ratio wind correction of climb/descent distance.
// ============================================================

var CLIMB_TAS_BY_ALT = [
    { alt: 0,     tas: 85 },
    { alt: 2000,  tas: 155 },
    { alt: 4000,  tas: 170 },
    { alt: 6000,  tas: 175 },
    { alt: 8000,  tas: 180 },
    { alt: 10000, tas: 185 },
    { alt: 12000, tas: 192 },
    { alt: 14000, tas: 200 },
    { alt: 16000, tas: 207 },
    { alt: 18000, tas: 213 },
    { alt: 20000, tas: 220 },
    { alt: 22000, tas: 220 },
    { alt: 24000, tas: 220 },
    { alt: 26000, tas: 222 },
    { alt: 28000, tas: 222 },
    { alt: 30000, tas: 225 },
    { alt: 31000, tas: 227 }
];

var DESCENT_TAS_BY_ALT = [
    { alt: 0,     tas: 230 },
    { alt: 2000,  tas: 235 },
    { alt: 4000,  tas: 240 },
    { alt: 6000,  tas: 245 },
    { alt: 8000,  tas: 253 },
    { alt: 10000, tas: 263 },
    { alt: 12000, tas: 270 },
    { alt: 14000, tas: 278 },
    { alt: 16000, tas: 285 },
    { alt: 18000, tas: 293 },
    { alt: 20000, tas: 310 },
    { alt: 22000, tas: 318 },
    { alt: 24000, tas: 324 },
    { alt: 26000, tas: 324 },
    { alt: 28000, tas: 321 },
    { alt: 30000, tas: 315 },
    { alt: 31000, tas: 313 }
];

// Interpolate a TAS table by altitude
function interpTableByAlt(table, altFt) {
    if (altFt <= table[0].alt) return table[0].tas;
    if (altFt >= table[table.length - 1].alt) return table[table.length - 1].tas;
    for (var i = 0; i < table.length - 1; i++) {
        if (altFt >= table[i].alt && altFt <= table[i+1].alt) {
            var frac = (altFt - table[i].alt) / (table[i+1].alt - table[i].alt);
            return table[i].tas + frac * (table[i+1].tas - table[i].tas);
        }
    }
    return table[table.length - 1].tas;
}


// ============================================================
// GRID INDEX HELPERS
// ============================================================

function gfsLatIndex(lat) {
    return Math.round((lat + 90) / 0.25);
}

function gfsLonIndex(lon) {
    var lon360 = lon < 0 ? lon + 360 : lon;
    return Math.round(lon360 / 0.25);
}


// ============================================================
// GFS CYCLE SELECTION
// ============================================================

function getGFSCycle() {
    var now = new Date();
    var utcHour = now.getUTCHours();
    var utcDate = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    ));

    var cycles = [18, 12, 6, 0];
    var bestCycle = null;

    for (var i = 0; i < cycles.length; i++) {
        if (utcHour >= cycles[i] + GFS_PRODUCTION_LAG_HR) {
            bestCycle = cycles[i];
            break;
        }
    }

    if (bestCycle === null) {
        utcDate = new Date(utcDate.getTime() - 86400000);
        bestCycle = 18;
    }

    var y = utcDate.getUTCFullYear();
    var m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    var d = String(utcDate.getUTCDate()).padStart(2, '0');
    var dateStr = '' + y + m + d;
    var cycleStr = String(bestCycle).padStart(2, '0') + 'z';

    var cycleStart = new Date(Date.UTC(
        utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate(),
        bestCycle, 0, 0
    ));

    console.log('[GFS] Selected cycle: ' + dateStr + '/' + cycleStr +
        ' (current UTC hour: ' + utcHour + ')');

    return {
        dateStr: dateStr,
        cycleStr: cycleStr,
        cycleHour: bestCycle,
        cycleStart: cycleStart
    };
}


// ============================================================
// FORECAST HOUR → TIME INDEX
// ============================================================

function getGFSTimeIndex(cycleStart, departureTimeZ) {
    if (!departureTimeZ) return 0;

    var depTime;
    if (departureTimeZ instanceof Date) {
        depTime = departureTimeZ;
    } else {
        depTime = new Date(departureTimeZ);
    }

    var diffMs = depTime.getTime() - cycleStart.getTime();
    var diffHours = diffMs / 3600000;

    var fcstHour = Math.round(diffHours / 3) * 3;
    fcstHour = Math.max(0, Math.min(fcstHour, 384));

    var timeIndex = fcstHour / 3;
    console.log('[GFS] Departure offset: ' + Math.round(diffHours) +
        'h from cycle → forecast hour ' + fcstHour + ' (time index ' + timeIndex + ')');

    return timeIndex;
}


// ============================================================
// GREAT CIRCLE INTERPOLATION
// ============================================================

function interpolateGreatCircle(lat1, lon1, lat2, lon2, fraction) {
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;

    var phi1 = lat1 * toRad;
    var lam1 = lon1 * toRad;
    var phi2 = lat2 * toRad;
    var lam2 = lon2 * toRad;

    var d = 2 * Math.asin(Math.sqrt(
        Math.pow(Math.sin((phi2 - phi1) / 2), 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.pow(Math.sin((lam2 - lam1) / 2), 2)
    ));

    if (d < 0.0001) {
        return { lat: lat1, lon: lon1 };
    }

    var A = Math.sin((1 - fraction) * d) / Math.sin(d);
    var B = Math.sin(fraction * d) / Math.sin(d);

    var x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
    var y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
    var z = A * Math.sin(phi1) + B * Math.sin(phi2);

    var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg;
    var lon = Math.atan2(y, x) * toDeg;

    return { lat: lat, lon: lon };
}

function generateRouteWaypoints(depLat, depLon, destLat, destLon, numPoints) {
    var points = [];
    for (var i = 0; i <= numPoints; i++) {
        var frac = i / numPoints;
        var pt = interpolateGreatCircle(depLat, depLon, destLat, destLon, frac);
        points.push(pt);
    }
    return points;
}


// ============================================================
// NOMADS URL BUILDER
// ============================================================

function buildGFSPointURL(dateStr, cycleStr, timeIdx, latIdx, lonIdx) {
    var levRange = GFS_LEVEL_RANGE.start + ':' + GFS_LEVEL_RANGE.end;
    var base = GFS_BASE + '/gfs' + dateStr + '/gfs_0p25_' + cycleStr + '.ascii';

    var query = '?ugrdprs[' + timeIdx + '][' + levRange + '][' + latIdx + '][' + lonIdx + ']' +
                ',vgrdprs[' + timeIdx + '][' + levRange + '][' + latIdx + '][' + lonIdx + ']';

    return base + query;
}


// ============================================================
// ASCII RESPONSE PARSER
// ============================================================

function parseGFSPointResponse(text) {
    if (!text || text.length < 20) return null;

    try {
        var result = { u: {}, v: {} };
        var lines = text.split('\n');
        var currentVar = null;
        var levelOffset = GFS_LEVEL_RANGE.start;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.indexOf('ugrdprs') !== -1 && line.indexOf('[') !== -1 && line.indexOf('],') === -1) {
                currentVar = 'u';
                continue;
            }
            if (line.indexOf('vgrdprs') !== -1 && line.indexOf('[') !== -1 && line.indexOf('],') === -1) {
                currentVar = 'v';
                continue;
            }

            if (currentVar && line.charAt(0) === '[') {
                var commaPos = line.lastIndexOf(',');
                if (commaPos === -1) continue;

                var indexPart = line.substring(0, commaPos).trim();
                var valuePart = line.substring(commaPos + 1).trim();
                var value = parseFloat(valuePart);
                if (isNaN(value) || value > 9e19) continue;

                var brackets = indexPart.match(/\[(\d+)\]/g);
                if (!brackets || brackets.length < 2) continue;

                var levIdx = parseInt(brackets[1].replace(/[\[\]]/g, ''));
                var pressureIdx = levIdx + levelOffset;

                if (currentVar === 'u') {
                    result.u[pressureIdx] = value;
                } else {
                    result.v[pressureIdx] = value;
                }
            }
        }

        var uKeys = Object.keys(result.u);
        var vKeys = Object.keys(result.v);
        if (uKeys.length === 0 || vKeys.length === 0) {
            console.warn('[GFS] Parser got no wind data from response');
            return null;
        }

        return result;

    } catch (e) {
        console.error('[GFS] Parse error:', e.message);
        return null;
    }
}


// ============================================================
// U/V → WIND DIRECTION & SPEED
// ============================================================

function uvToWind(u, v) {
    var MS_TO_KT = 1.94384;

    var speedMs = Math.sqrt(u * u + v * v);
    var speedKt = speedMs * MS_TO_KT;

    var dirRad = Math.atan2(-u, -v);
    var dirDeg = dirRad * 180 / Math.PI;
    if (dirDeg < 0) dirDeg += 360;

    return {
        direction: Math.round(dirDeg),
        speed: Math.round(speedKt)
    };
}


// ============================================================
// MAIN FETCH — Get GFS winds along route
// ============================================================
// Sets _gfsWindCache on success for flight-calc.js auto-detect
// ============================================================

async function fetchGFSWinds(dep, dest, departureTimeZ) {
    console.log('[GFS] Fetching gridded winds for route: ' +
        dep.ident + ' → ' + dest.ident);

    // Clear cache before fetch
    _gfsWindCache = null;

    var cycle = getGFSCycle();
    var timeIdx = getGFSTimeIndex(cycle.cycleStart, departureTimeZ);

    var waypoints = generateRouteWaypoints(dep.lat, dep.lon, dest.lat, dest.lon, GFS_ROUTE_POINTS);
    console.log('[GFS] Generated ' + waypoints.length + ' waypoints along route');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    for (var i = 0; i < waypoints.length; i++) {
        waypoints[i].distFromDep = greatCircleDistance(dep.lat, dep.lon, waypoints[i].lat, waypoints[i].lon);
    }

    var urls = [];
    for (var j = 0; j < waypoints.length; j++) {
        var latIdx = gfsLatIndex(waypoints[j].lat);
        var lonIdx = gfsLonIndex(waypoints[j].lon);
        urls.push(buildGFSPointURL(cycle.dateStr, cycle.cycleStr, timeIdx, latIdx, lonIdx));
    }

    console.log('[GFS] Sample URL: ' + urls[0]);

    var BATCH_SIZE = 5;
    var BATCH_DELAY = 400;

    function fetchOnePoint(url) {
        var proxyUrl = GFS_PROXY_URL + encodeURIComponent(url);
        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, 15000);
        return fetch(proxyUrl, { signal: controller.signal })
            .then(function(resp) {
                clearTimeout(timeoutId);
                if (!resp.ok) {
                    console.warn('[GFS] HTTP ' + resp.status + ' for waypoint');
                    return null;
                }
                return resp.text();
            })
            .then(function(text) {
                if (text && (text.indexOf('GrADS Data Server - error') !== -1 ||
                             text.indexOf('<html') !== -1 ||
                             text.indexOf('not an available') !== -1)) {
                    console.warn('[GFS] Server returned error page for waypoint');
                    return null;
                }
                return text;
            })
            .catch(function(err) {
                clearTimeout(timeoutId);
                console.warn('[GFS] Fetch error: ' + err.message);
                return null;
            });
    }

    function delay(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    var responses = new Array(urls.length);
    for (var b = 0; b < urls.length; b += BATCH_SIZE) {
        var batchEnd = Math.min(b + BATCH_SIZE, urls.length);
        var batchPromises = [];
        for (var bi = b; bi < batchEnd; bi++) {
            batchPromises.push(fetchOnePoint(urls[bi]));
        }
        var batchResults = await Promise.all(batchPromises);
        for (var br = 0; br < batchResults.length; br++) {
            responses[b + br] = batchResults[br];
        }
        if (batchEnd < urls.length) {
            await delay(BATCH_DELAY);
        }
    }

    // Retry failed points once
    var failedIndices = [];
    for (var ri = 0; ri < responses.length; ri++) {
        if (!responses[ri]) failedIndices.push(ri);
    }
    if (failedIndices.length > 0 && failedIndices.length <= 12) {
        console.log('[GFS] Retrying ' + failedIndices.length + ' failed waypoints...');
        await delay(800);
        for (var fi = 0; fi < failedIndices.length; fi++) {
            var fidx = failedIndices[fi];
            responses[fidx] = await fetchOnePoint(urls[fidx]);
            if (fi < failedIndices.length - 1) await delay(300);
        }
    }

    // Parse responses and build wind data
    var validPoints = [];
    for (var k = 0; k < waypoints.length; k++) {
        if (!responses[k]) continue;

        var parsed = parseGFSPointResponse(responses[k]);
        if (!parsed) continue;

        var winds = {};
        for (var levIdx = GFS_LEVEL_RANGE.start; levIdx <= GFS_LEVEL_RANGE.end; levIdx++) {
            if (parsed.u[levIdx] !== undefined && parsed.v[levIdx] !== undefined) {
                var w = uvToWind(parsed.u[levIdx], parsed.v[levIdx]);
                var mb = GFS_LEVEL_PRESSURES[levIdx];
                winds[mb] = {
                    direction: w.direction,
                    speed: w.speed,
                    u: parsed.u[levIdx],
                    v: parsed.v[levIdx]
                };
            }
        }

        if (Object.keys(winds).length > 0) {
            validPoints.push({
                lat: waypoints[k].lat,
                lon: waypoints[k].lon,
                distFromDep: waypoints[k].distFromDep,
                winds: winds
            });
        }
    }

    if (validPoints.length === 0) {
        console.error('[GFS] No valid wind data from any waypoint');
        return null;
    }

    console.log('[GFS] Got wind data at ' + validPoints.length + '/' +
        waypoints.length + ' waypoints');

    if (validPoints.length > 0 && validPoints[0].winds[300]) {
        var sample = validPoints[0].winds[300];
        console.log('[GFS] Sample winds at start (300mb): ' +
            sample.direction + '° @ ' + sample.speed + 'kt');
    }
    if (validPoints.length > 10 && validPoints[Math.floor(validPoints.length/2)].winds[300]) {
        var mid = validPoints[Math.floor(validPoints.length/2)].winds[300];
        console.log('[GFS] Sample winds at midpoint (300mb): ' +
            mid.direction + '° @ ' + mid.speed + 'kt');
    }

    var result = {
        waypoints: validPoints,
        totalDist: totalDist,
        source: 'GFS',
        cycle: cycle.dateStr + '/' + cycle.cycleStr,
        forecastHour: timeIdx * 3,
        pointCount: validPoints.length
    };

    // Set global cache so flight-calc.js can auto-detect
    _gfsWindCache = result;
    console.log('[GFS] Wind cache set with ' + validPoints.length + ' waypoints');

    return result;
}


// ============================================================
// WIND AT FLIGHT LEVEL — Interpolate between pressure levels
// ============================================================

function getGFSWindAtFL(waypointWinds, flFeet) {
    var targetMb = flToPressure(flFeet);

    var levels = Object.keys(waypointWinds).map(Number).sort(function(a,b){return b-a;});
    if (levels.length === 0) return null;

    for (var i = 0; i < levels.length; i++) {
        if (Math.abs(levels[i] - targetMb) < 1) {
            return waypointWinds[levels[i]];
        }
    }

    var upper = null;
    var lower = null;
    for (var j = 0; j < levels.length; j++) {
        if (levels[j] >= targetMb) upper = levels[j];
        if (levels[j] <= targetMb && lower === null) lower = levels[j];
    }

    if (!upper && !lower) return null;
    if (!upper) return waypointWinds[lower];
    if (!lower) return waypointWinds[upper];
    if (upper === lower) return waypointWinds[upper];

    var frac = (upper - targetMb) / (upper - lower);
    var wU = waypointWinds[upper];
    var wL = waypointWinds[lower];

    var u = wU.u + frac * (wL.u - wU.u);
    var v = wU.v + frac * (wL.v - wU.v);
    var result = uvToWind(u, v);
    result.u = u;
    result.v = v;
    return result;
}


// ============================================================
// WIND AT ARBITRARY ALTITUDE — for climb/descent corrections
// ============================================================
// Uses GFS waypoint wind data at the nearest pressure level.
// Below FL100 (700mb floor): scales wind proportionally
// (20% at surface, linear to 100% at FL100).
// ============================================================

function getWindAtAltFromWaypoint(waypointWinds, altFt) {
    // Below FL100: use 700mb wind scaled down
    if (altFt < 10000) {
        var fl100Wind = waypointWinds[700]; // 700mb ≈ FL100
        if (!fl100Wind) {
            // fallback: use lowest available level
            var keys = Object.keys(waypointWinds).map(Number).sort(function(a,b){return b-a;});
            if (keys.length === 0) return null;
            fl100Wind = waypointWinds[keys[0]];
        }
        // Scale: 20% at surface, linear to 100% at 10000ft
        var scaleFactor = 0.20 + 0.80 * (altFt / 10000);
        return {
            direction: fl100Wind.direction,
            speed: Math.round(fl100Wind.speed * scaleFactor),
            u: fl100Wind.u * scaleFactor,
            v: fl100Wind.v * scaleFactor
        };
    }

    // FL100 and above: use pressure level interpolation
    return getGFSWindAtFL(waypointWinds, altFt);
}


// ============================================================
// AVERAGE WINDS FROM WAYPOINTS — for climb/descent area
// ============================================================
// Averages wind U/V components from a group of consecutive
// GFS waypoints (e.g. first 3 for climb, last 3 for descent).
// Returns averaged wind data keyed by pressure level (mb).
// ============================================================

function averageWindsFromWaypoints(gfsWaypoints, startIdx, count) {
    var endIdx = Math.min(startIdx + count, gfsWaypoints.length);
    var actual = endIdx - startIdx;
    if (actual <= 0) return null;

    // Collect all pressure levels present
    var allLevels = {};
    for (var i = startIdx; i < endIdx; i++) {
        var wp = gfsWaypoints[i];
        var keys = Object.keys(wp.winds);
        for (var j = 0; j < keys.length; j++) {
            allLevels[keys[j]] = true;
        }
    }

    // Average U/V at each level
    var averaged = {};
    var levelKeys = Object.keys(allLevels);
    for (var li = 0; li < levelKeys.length; li++) {
        var mb = Number(levelKeys[li]);
        var sumU = 0, sumV = 0, cnt = 0;
        for (var wi = startIdx; wi < endIdx; wi++) {
            var wdata = gfsWaypoints[wi].winds[mb];
            if (wdata) {
                sumU += wdata.u;
                sumV += wdata.v;
                cnt++;
            }
        }
        if (cnt > 0) {
            var avgU = sumU / cnt;
            var avgV = sumV / cnt;
            var w = uvToWind(avgU, avgV);
            averaged[mb] = {
                direction: w.direction,
                speed: w.speed,
                u: avgU,
                v: avgV
            };
        }
    }

    return averaged;
}


// ============================================================
// WIND-CORRECTED CLIMB DISTANCE
// ============================================================
// POH climb distance is still-air. Wind changes the GROUND
// distance covered during climb (not the time or fuel).
//
// Algorithm:
// 1. Average wind from first 3 GFS waypoints (departure area)
// 2. Break climb into 2000ft altitude bands
// 3. For each band: get wind at that altitude, get TAS,
//    compute GS/TAS ratio, apply to POH distance fraction
// 4. Sum wind-corrected distances across all bands
//
// Headwind = less ground covered = MORE cruise distance later
// Tailwind = more ground covered = LESS cruise distance later
// ============================================================

function calcWindCorrectedClimbDist(pohDistNm, depElevFt, cruiseAltFt, courseTrue, gfsData) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length < 3) {
        return pohDistNm;
    }

    // Get averaged winds from first 3 waypoints (departure area)
    var avgWinds = averageWindsFromWaypoints(gfsData.waypoints, 0, 3);
    if (!avgWinds) return pohDistNm;

    // Break climb into 2000ft bands
    var bandSize = 2000;
    var totalClimbFt = cruiseAltFt - depElevFt;
    if (totalClimbFt <= 0) return pohDistNm;

    var sumRatio = 0;
    var bandCount = 0;
    var altStart = depElevFt;

    while (altStart < cruiseAltFt) {
        var altEnd = Math.min(altStart + bandSize, cruiseAltFt);
        var midAlt = (altStart + altEnd) / 2;

        // TAS at this altitude during climb
        var tas = interpTableByAlt(CLIMB_TAS_BY_ALT, midAlt);

        // Wind at this altitude
        var wind = getWindAtAltFromWaypoint(avgWinds, midAlt);
        if (wind && tas > 0) {
            var gs = windTriangleGS(tas, wind.direction, wind.speed, courseTrue);
            var ratio = gs / tas;
            // Weight by band thickness (thinner last band if not even)
            var bandThickness = altEnd - altStart;
            sumRatio += ratio * bandThickness;
            bandCount += bandThickness;
        } else {
            // No wind data for this band — assume no correction
            var bandThickness2 = altEnd - altStart;
            sumRatio += 1.0 * bandThickness2;
            bandCount += bandThickness2;
        }

        altStart = altEnd;
    }

    if (bandCount === 0) return pohDistNm;

    var avgRatio = sumRatio / bandCount;
    var correctedDist = pohDistNm * avgRatio;

    console.log('[WIND-CLB] Altitude-weighted GS/TAS ratio: ' + avgRatio.toFixed(4) +
        ' | POH dist: ' + pohDistNm.toFixed(1) + 'nm → corrected: ' + correctedDist.toFixed(1) + 'nm');

    return correctedDist;
}


// ============================================================
// WIND-CORRECTED DESCENT DISTANCE
// ============================================================
// Same logic as climb but uses last 3 GFS waypoints (arrival
// area) and descent TAS table.
// ============================================================

function calcWindCorrectedDescentDist(pohDistNm, destElevFt, cruiseAltFt, courseTrue, gfsData) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length < 3) {
        return pohDistNm;
    }

    // Get averaged winds from last 3 waypoints (arrival area)
    var startIdx = Math.max(0, gfsData.waypoints.length - 3);
    var avgWinds = averageWindsFromWaypoints(gfsData.waypoints, startIdx, 3);
    if (!avgWinds) return pohDistNm;

    // Break descent into 2000ft bands (top-down)
    var bandSize = 2000;
    var totalDescentFt = cruiseAltFt - destElevFt;
    if (totalDescentFt <= 0) return pohDistNm;

    var sumRatio = 0;
    var bandCount = 0;
    var altStart = cruiseAltFt;

    while (altStart > destElevFt) {
        var altEnd = Math.max(altStart - bandSize, destElevFt);
        var midAlt = (altStart + altEnd) / 2;

        var tas = interpTableByAlt(DESCENT_TAS_BY_ALT, midAlt);

        var wind = getWindAtAltFromWaypoint(avgWinds, midAlt);
        if (wind && tas > 0) {
            var gs = windTriangleGS(tas, wind.direction, wind.speed, courseTrue);
            var ratio = gs / tas;
            var bandThickness = altStart - altEnd;
            sumRatio += ratio * bandThickness;
            bandCount += bandThickness;
        } else {
            var bandThickness2 = altStart - altEnd;
            sumRatio += 1.0 * bandThickness2;
            bandCount += bandThickness2;
        }

        altStart = altEnd;
    }

    if (bandCount === 0) return pohDistNm;

    var avgRatio = sumRatio / bandCount;
    var correctedDist = pohDistNm * avgRatio;

    console.log('[WIND-DES] Altitude-weighted GS/TAS ratio: ' + avgRatio.toFixed(4) +
        ' | POH dist: ' + pohDistNm.toFixed(1) + 'nm → corrected: ' + correctedDist.toFixed(1) + 'nm');

    return correctedDist;
}


// ============================================================
// GFS GROUND SPEED — Segment-based cruise calculation
// ============================================================

function calculateGFSGroundSpeed(gfsData, cruiseAltFt, trueCourse, tas) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length === 0) return tas;

    var points = gfsData.waypoints;
    var totalDist = gfsData.totalDist;

    var segments = [];
    for (var i = 0; i < points.length; i++) {
        var wind = getGFSWindAtFL(points[i].winds, cruiseAltFt);
        if (!wind) continue;

        var segStart, segEnd;
        if (i === 0) {
            segStart = 0;
        } else {
            segStart = (points[i-1].distFromDep + points[i].distFromDep) / 2;
        }
        if (i === points.length - 1) {
            segEnd = totalDist;
        } else {
            segEnd = (points[i].distFromDep + points[i+1].distFromDep) / 2;
        }

        var segDist = segEnd - segStart;
        if (segDist <= 0) continue;

        var comp = windComponents(wind.direction, wind.speed, trueCourse);
        var segGS = windTriangleGS(tas, wind.direction, wind.speed, trueCourse);

        segments.push({
            dist: segDist,
            gs: segGS,
            headwind: comp.headwind,
            windDir: wind.direction,
            windSpd: wind.speed
        });
    }

    if (segments.length === 0) return tas;

    var totalTime = 0;
    var coveredDist = 0;
    for (var j = 0; j < segments.length; j++) {
        totalTime += segments[j].dist / segments[j].gs;
        coveredDist += segments[j].dist;
    }

    if (coveredDist < totalDist) {
        totalTime += (totalDist - coveredDist) / tas;
    }

    var effectiveGS = Math.round(totalDist / totalTime);
    console.log('[GFS] Segment GS calc: ' + segments.length + ' segments, effective GS=' +
        effectiveGS + 'kt (TAS=' + tas + ', delta=' + (effectiveGS - tas) + ')');

    return effectiveGS;
}


// ============================================================
// GFS WIND SUMMARY — For display
// ============================================================

function getGFSWindSummary(gfsData, cruiseAltFt, trueCourse, tas) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length === 0) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data', source: 'none' };
    }

    var points = gfsData.waypoints;
    var totalDist = gfsData.totalDist;

    var totalTime = 0;
    var coveredDist = 0;
    var count = 0;

    for (var i = 0; i < points.length; i++) {
        var wind = getGFSWindAtFL(points[i].winds, cruiseAltFt);
        if (!wind) continue;

        var segStart = (i === 0) ? 0 : (points[i-1].distFromDep + points[i].distFromDep) / 2;
        var segEnd = (i === points.length - 1) ? totalDist : (points[i].distFromDep + points[i+1].distFromDep) / 2;
        var segDist = segEnd - segStart;
        if (segDist <= 0) continue;

        var segGS = windTriangleGS(tas, wind.direction, wind.speed, trueCourse);
        var segTime = segDist / segGS;

        totalTime += segTime;
        coveredDist += segDist;
        count++;
    }

    if (count === 0 || totalTime === 0) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data', source: 'none' };
    }

    if (coveredDist < totalDist) {
        totalTime += (totalDist - coveredDist) / tas;
    }

    var effectiveGS = Math.round(totalDist / totalTime);
    var effectiveHeadwind = Math.round(tas - effectiveGS);
    var desc = effectiveHeadwind > 0
        ? effectiveHeadwind + 'kt headwind'
        : Math.abs(effectiveHeadwind) + 'kt tailwind';

    return {
        available: true,
        gs: effectiveGS,
        windComponent: effectiveHeadwind,
        stationCount: count,
        description: desc,
        source: 'GFS ' + gfsData.cycle
    };
}
