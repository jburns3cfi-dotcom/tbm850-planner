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

// Proxy URL — same worker as NOAA winds aloft
var GFS_PROXY_URL = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';

// NOMADS OPeNDAP base
var GFS_BASE = 'https://nomads.ncep.noaa.gov/dods/gfs_0p25';

// Number of waypoints to sample along route
var GFS_ROUTE_POINTS = 20;

// GFS production lag — data typically available ~5h after cycle start
var GFS_PRODUCTION_LAG_HR = 5;

// ============================================================
// PRESSURE LEVEL MAPPING
// ============================================================
// GFS 0.25° pressure levels for ugrdprs/vgrdprs (26 levels):
// Index: 0    1    2    3    4    5    6    7    8    9
//   mb: 1000  975  950  925  900  850  800  750  700  650
// Index: 10   11   12   13   14   15   16   17   18   19
//   mb:  600  550  500  450  400  350  300  250  200  150
// Index: 20   21   22   23   24   25
//   mb:  100   70   50   30   20   10
//
// We now fetch indices 8-18 (700mb through 200mb) to cover:
//   FL100 ≈ 700mb (index 8)   — needed for climb/descent winds
//   FL118 ≈ 650mb (index 9)
//   FL138 ≈ 600mb (index 10)
//   FL160 ≈ 550mb (index 11)
//   FL183 ≈ 500mb (index 12)
//   FL208 ≈ 450mb (index 13)
//   FL236 ≈ 400mb (index 14)  — cruise range starts here
//   FL266 ≈ 350mb (index 15)
//   FL301 ≈ 300mb (index 16)
//   FL340 ≈ 250mb (index 17)
//   FL387 ≈ 200mb (index 18)
// ============================================================

// Map flight level (feet) to GFS pressure level index
// We fetch indices 8-18 (700mb through 200mb) and interpolate
var GFS_LEVEL_RANGE = { start: 8, end: 18 };

// Actual pressure values at each NOMADS index (mb)
var GFS_LEVEL_PRESSURES = {
    8:  700,
    9:  650,
    10: 600,
    11: 550,
    12: 500,
    13: 450,
    14: 400,
    15: 350,
    16: 300,
    17: 250,
    18: 200
};

// Standard atmosphere: pressure (mb) to altitude (feet)
// Used for climb/descent wind corrections
var GFS_LEVEL_ALTITUDES = {
    700:  9882,
    650: 11780,
    600: 13801,
    550: 15962,
    500: 18289,
    450: 20812,
    400: 23574,
    350: 26631,
    300: 30065,
    250: 33999,
    200: 38662
};

// Flight level to approximate pressure (mb) using standard atmosphere
function flToPressure(flFeet) {
    // Standard atmosphere approximation
    var altFt = flFeet;
    if (altFt < 100) altFt = altFt * 100; // handle FL240 vs 24000
    var pressures = {
        10000: 697,
        12000: 647,
        14000: 595,
        16000: 547,
        18000: 500,
        20000: 466,
        22000: 428,
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
    if (altFt < keys[0]) return 700;
    return 300; // default to FL280-ish
}


// ============================================================
// GRID INDEX HELPERS
// ============================================================

// Convert latitude to GFS 0.25° grid index
function gfsLatIndex(lat) {
    // GFS grid: -90 to +90 in 0.25° steps = 721 points
    // Index 0 = -90°, Index 720 = +90°
    return Math.round((lat + 90) / 0.25);
}

// Convert longitude to GFS 0.25° grid index
function gfsLonIndex(lon) {
    // GFS grid: 0 to 359.75 in 0.25° steps = 1440 points
    // Western hemisphere: -74° → 286°
    var lon360 = lon < 0 ? lon + 360 : lon;
    return Math.round(lon360 / 0.25);
}


// ============================================================
// GFS CYCLE SELECTION
// ============================================================
// GFS runs 4x daily: 00Z, 06Z, 12Z, 18Z
// Data available ~5h after cycle start
// Pick most recent available cycle
// ============================================================

function getGFSCycle() {
    var now = new Date();
    var utcHour = now.getUTCHours();
    var utcDate = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()
    ));

    // Available cycles in order
    var cycles = [18, 12, 6, 0];
    var bestCycle = null;

    for (var i = 0; i < cycles.length; i++) {
        if (utcHour >= cycles[i] + GFS_PRODUCTION_LAG_HR) {
            bestCycle = cycles[i];
            break;
        }
    }

    // If nothing from today is ready, use yesterday's 18Z
    if (bestCycle === null) {
        utcDate = new Date(utcDate.getTime() - 86400000);
        bestCycle = 18;
    }

    var y = utcDate.getUTCFullYear();
    var m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    var d = String(utcDate.getUTCDate()).padStart(2, '0');
    var dateStr = '' + y + m + d;
    var cycleStr = String(bestCycle).padStart(2, '0') + 'z';

    // Cycle start time as Date object
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
// GFS 0.25° has 3-hourly steps: 0,3,6,...,384
// Time index = forecast_hour / 3
// ============================================================

function getGFSTimeIndex(cycleStart, departureTimeZ) {
    if (!departureTimeZ) {
        // Default: use analysis (time index 0)
        return 0;
    }

    var depTime;
    if (departureTimeZ instanceof Date) {
        depTime = departureTimeZ;
    } else {
        depTime = new Date(departureTimeZ);
    }

    var diffMs = depTime.getTime() - cycleStart.getTime();
    var diffHours = diffMs / 3600000;

    // Round to nearest 3-hour step
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
// Generate evenly spaced waypoints along a great circle route
// ============================================================

function interpolateGreatCircle(lat1, lon1, lat2, lon2, fraction) {
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;

    var phi1 = lat1 * toRad;
    var lam1 = lon1 * toRad;
    var phi2 = lat2 * toRad;
    var lam2 = lon2 * toRad;

    // Angular distance
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
    // Start just past departure, end just before destination
    // (climb/descent phases handle the endpoints)
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
// Builds OPeNDAP ASCII query for U and V wind at a single
// grid point across all needed pressure levels.
// ============================================================

function buildGFSPointURL(dateStr, cycleStr, timeIdx, latIdx, lonIdx) {
    // Query levels 8-18 (700mb through 200mb) in one request
    var levRange = GFS_LEVEL_RANGE.start + ':' + GFS_LEVEL_RANGE.end;
    var base = GFS_BASE + '/gfs' + dateStr + '/gfs_0p25_' + cycleStr + '.ascii';

    // ugrdprs[time][lev_start:lev_end][lat][lon],vgrdprs[time][lev_start:lev_end][lat][lon]
    var query = '?ugrdprs[' + timeIdx + '][' + levRange + '][' + latIdx + '][' + lonIdx + ']' +
                ',vgrdprs[' + timeIdx + '][' + levRange + '][' + latIdx + '][' + lonIdx + ']';

    return base + query;
}


// ============================================================
// ASCII RESPONSE PARSER
// ============================================================
// NOMADS OPeNDAP ASCII format returns data like:
//
// ugrdprs, [1][11][1][1]
// [0][0][0][0], -12.34
// [0][1][0][0], -14.56
// ... (11 levels now instead of 5)
//
// vgrdprs, [1][11][1][1]
// [0][0][0][0], 5.67
// [0][1][0][0], 6.78
// ...
// ============================================================

function parseGFSPointResponse(text) {
    if (!text || text.length < 20) return null;

    try {
        var result = { u: {}, v: {} };
        var lines = text.split('\n');
        var currentVar = null; // 'u' or 'v'
        var levelOffset = GFS_LEVEL_RANGE.start; // first level index in our range

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Detect variable header: "ugrdprs, [1][11][1][1]" or "ugrdprs.ugrdprs, ..."
            if (line.indexOf('ugrdprs') !== -1 && line.indexOf('[') !== -1 && line.indexOf('],') === -1) {
                currentVar = 'u';
                continue;
            }
            if (line.indexOf('vgrdprs') !== -1 && line.indexOf('[') !== -1 && line.indexOf('],') === -1) {
                currentVar = 'v';
                continue;
            }

            // Parse data lines: "[0][0][0][0], -12.34" or "[0][0][0], -12.34"
            if (currentVar && line.charAt(0) === '[') {
                var commaPos = line.lastIndexOf(',');
                if (commaPos === -1) continue;

                var indexPart = line.substring(0, commaPos).trim();
                var valuePart = line.substring(commaPos + 1).trim();
                var value = parseFloat(valuePart);
                if (isNaN(value) || value > 9e19) continue; // skip fill values

                // Extract level index from the bracket notation
                // Format is [time][lev][lat][lon] — we want the lev index
                var brackets = indexPart.match(/\[(\d+)\]/g);
                if (!brackets || brackets.length < 2) continue;

                // Level is the second bracket (index 1)
                var levIdx = parseInt(brackets[1].replace(/[\[\]]/g, ''));

                // Map to actual pressure level index
                var pressureIdx = levIdx + levelOffset;

                if (currentVar === 'u') {
                    result.u[pressureIdx] = value;
                } else {
                    result.v[pressureIdx] = value;
                }
            }
        }

        // Validate we got at least some data
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
// GFS returns U (east-west) and V (north-south) in m/s
// Convert to direction (degrees true) and speed (knots)
// ============================================================

function uvToWind(u, v) {
    var MS_TO_KT = 1.94384;

    // Speed
    var speedMs = Math.sqrt(u * u + v * v);
    var speedKt = speedMs * MS_TO_KT;

    // Direction (meteorological convention: where wind comes FROM)
    // atan2(-u, -v) gives the "from" direction
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
// Returns wind data at ~20 waypoints with winds at all needed
// pressure levels. Falls back gracefully on any failure.
// ============================================================

async function fetchGFSWinds(dep, dest, departureTimeZ) {
    console.log('[GFS] Fetching gridded winds for route: ' +
        dep.icao + ' → ' + dest.icao);

    // 1. Determine GFS cycle
    var cycle = getGFSCycle();

    // 2. Determine forecast time index
    var timeIdx = getGFSTimeIndex(cycle.cycleStart, departureTimeZ);

    // 3. Generate route waypoints
    var waypoints = generateRouteWaypoints(dep.lat, dep.lon, dest.lat, dest.lon, GFS_ROUTE_POINTS);
    console.log('[GFS] Generated ' + waypoints.length + ' waypoints along route');

    // 4. Calculate distances from departure for each waypoint
    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    for (var i = 0; i < waypoints.length; i++) {
        waypoints[i].distFromDep = greatCircleDistance(dep.lat, dep.lon, waypoints[i].lat, waypoints[i].lon);
    }

    // 5. Build URLs for all waypoints
    var urls = [];
    for (var j = 0; j < waypoints.length; j++) {
        var latIdx = gfsLatIndex(waypoints[j].lat);
        var lonIdx = gfsLonIndex(waypoints[j].lon);
        urls.push(buildGFSPointURL(cycle.dateStr, cycle.cycleStr, timeIdx, latIdx, lonIdx));
    }

    console.log('[GFS] Sample URL: ' + urls[0]);

    // 6. Fetch in batches to avoid NOMADS rate limits
    //    5 concurrent requests per batch, 400ms between batches
    var BATCH_SIZE = 5;
    var BATCH_DELAY = 400; // ms between batches

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
                // Detect HTML error pages returned with HTTP 200
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

    // Process in batches
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
        // Delay between batches (skip after last batch)
        if (batchEnd < urls.length) {
            await delay(BATCH_DELAY);
        }
    }

    // Retry failed points once (single requests with delay)
    var failedIndices = [];
    for (var ri = 0; ri < responses.length; ri++) {
        if (!responses[ri]) failedIndices.push(ri);
    }
    if (failedIndices.length > 0 && failedIndices.length <= 12) {
        console.log('[GFS] Retrying ' + failedIndices.length + ' failed waypoints...');
        await delay(800);
        for (var fi = 0; fi < failedIndices.length; fi++) {
            var idx = failedIndices[fi];
            responses[idx] = await fetchOnePoint(urls[idx]);
            if (fi < failedIndices.length - 1) await delay(300);
        }
    }

    // 7. Parse responses and build wind data
    var validPoints = [];
    for (var k = 0; k < waypoints.length; k++) {
        if (!responses[k]) continue;

        var parsed = parseGFSPointResponse(responses[k]);
        if (!parsed) continue;

        // Convert U/V to wind dir/speed at each pressure level
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

    // Log sample wind data at first and middle waypoints
    if (validPoints.length > 0 && validPoints[0].winds[300]) {
        var sample = validPoints[0].winds[300];
        console.log('[GFS] Sample winds at start (300mb): ' +
            sample.direction + '° @ ' + sample.speed + 'kt');
    }
    if (validPoints.length > 0 && validPoints[0].winds[700]) {
        var sampleLow = validPoints[0].winds[700];
        console.log('[GFS] Sample winds at start (700mb/~FL100): ' +
            sampleLow.direction + '° @ ' + sampleLow.speed + 'kt');
    }
    if (validPoints.length > 10 && validPoints[Math.floor(validPoints.length/2)].winds[300]) {
        var mid = validPoints[Math.floor(validPoints.length/2)].winds[300];
        console.log('[GFS] Sample winds at midpoint (300mb): ' +
            mid.direction + '° @ ' + mid.speed + 'kt');
    }

    return {
        waypoints: validPoints,
        totalDist: totalDist,
        source: 'GFS',
        cycle: cycle.dateStr + '/' + cycle.cycleStr,
        forecastHour: timeIdx * 3,
        pointCount: validPoints.length
    };
}


// ============================================================
// WIND AT FLIGHT LEVEL — Interpolate between pressure levels
// ============================================================
// Flight levels don't land exactly on GFS pressure levels.
// Interpolate between the two nearest levels.
// ============================================================

function getGFSWindAtFL(waypointWinds, flFeet) {
    var targetMb = flToPressure(flFeet);

    // Find bracketing pressure levels
    var levels = Object.keys(waypointWinds).map(Number).sort(function(a,b){return b-a;}); // descending (high mb = low alt)
    if (levels.length === 0) return null;

    // Exact match
    for (var i = 0; i < levels.length; i++) {
        if (Math.abs(levels[i] - targetMb) < 1) {
            return waypointWinds[levels[i]];
        }
    }

    // Find bracket
    var upper = null; // higher pressure = lower altitude
    var lower = null; // lower pressure = higher altitude
    for (var j = 0; j < levels.length; j++) {
        if (levels[j] >= targetMb) upper = levels[j];
        if (levels[j] <= targetMb && lower === null) lower = levels[j];
    }

    // Edge cases
    if (!upper && !lower) return null;
    if (!upper) return waypointWinds[lower];
    if (!lower) return waypointWinds[upper];
    if (upper === lower) return waypointWinds[upper];

    // Linear interpolation by pressure
    var frac = (upper - targetMb) / (upper - lower);
    var wU = waypointWinds[upper];
    var wL = waypointWinds[lower];

    // Interpolate U/V components (more accurate than dir/speed)
    var u = wU.u + frac * (wL.u - wU.u);
    var v = wU.v + frac * (wL.v - wU.v);
    var result = uvToWind(u, v);
    result.u = u;
    result.v = v;
    return result;
}


// ============================================================
// GFS GROUND SPEED — Segment-based, using exact route points
// ============================================================
// Each GFS waypoint owns a segment (midpoint to midpoint).
// Compute GS per segment, time per segment, then effective
// GS = totalDist / totalTime. Same time-weighting approach
// as the station-based method, but with much better data.
// ============================================================

function calculateGFSGroundSpeed(gfsData, cruiseAltFt, trueCourse, tas) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length === 0) return tas;

    var points = gfsData.waypoints;
    var totalDist = gfsData.totalDist;

    // Build segments with wind at the target flight level
    var segments = [];
    for (var i = 0; i < points.length; i++) {
        var wind = getGFSWindAtFL(points[i].winds, cruiseAltFt);
        if (!wind) continue;

        // Segment boundaries: midpoints between adjacent waypoints
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

        // Wind components relative to aircraft track
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

    // Total time = sum of (segment distance / segment GS)
    var totalTime = 0;
    var coveredDist = 0;
    for (var j = 0; j < segments.length; j++) {
        totalTime += segments[j].dist / segments[j].gs;
        coveredDist += segments[j].dist;
    }

    // Fill uncovered distance with TAS
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
    var weightedHeadwind = 0;
    var coveredDist = 0;
    var count = 0;

    for (var i = 0; i < points.length; i++) {
        var wind = getGFSWindAtFL(points[i].winds, cruiseAltFt);
        if (!wind) continue;

        var segStart = (i === 0) ? 0 : (points[i-1].distFromDep + points[i].distFromDep) / 2;
        var segEnd = (i === points.length - 1) ? totalDist : (points[i].distFromDep + points[i+1].distFromDep) / 2;
        var segDist = segEnd - segStart;
        if (segDist <= 0) continue;

        var comp = windComponents(wind.direction, wind.speed, trueCourse);
        var segGS = windTriangleGS(tas, wind.direction, wind.speed, trueCourse);
        var segTime = segDist / segGS;

        totalTime += segTime;
        weightedHeadwind += comp.headwind * segTime;
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
    // Derive effective wind component from actual GS vs TAS
    // This accounts for the crosswind crab penalty
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


// ============================================================
// CLIMB/DESCENT WIND CORRECTIONS
// ============================================================
// Wind doesn't change climb/descent TIME or FUEL — it changes
// GROUND DISTANCE. A headwind during climb = less ground
// covered = more cruise distance. Tailwind = opposite.
//
// We break the phase into 2000ft altitude bands, get wind at
// each band from GFS data, compute GS vs TAS ratio, and apply
// that ratio to the POH still-air distance.
//
// Requires: windTriangleGS() from winds.js
// ============================================================

// Climb TAS at each altitude — derived from fltplan IAS with
// standard atmosphere density correction
var CLIMB_TAS_BY_ALT = [
    { alt:  2000, tas: 153 },
    { alt:  4000, tas: 168 },
    { alt:  6000, tas: 173 },
    { alt:  8000, tas: 179 },
    { alt: 10000, tas: 183 },
    { alt: 12000, tas: 190 },
    { alt: 14000, tas: 196 },
    { alt: 16000, tas: 203 },
    { alt: 18000, tas: 210 },
    { alt: 20000, tas: 216 },
    { alt: 22000, tas: 218 },
    { alt: 24000, tas: 221 },
    { alt: 26000, tas: 225 },
    { alt: 28000, tas: 229 },
    { alt: 30000, tas: 230 },
    { alt: 31000, tas: 226 }
];

// Descent TAS at each altitude — from fltplan descent IAS
var DESCENT_TAS_BY_ALT = [
    { alt:  2000, tas: 132 },
    { alt:  4000, tas: 168 },
    { alt:  6000, tas: 249 },
    { alt:  8000, tas: 257 },
    { alt: 10000, tas: 263 },
    { alt: 12000, tas: 272 },
    { alt: 14000, tas: 281 },
    { alt: 16000, tas: 290 },
    { alt: 18000, tas: 302 },
    { alt: 20000, tas: 310 },
    { alt: 22000, tas: 322 },
    { alt: 24000, tas: 320 },
    { alt: 26000, tas: 318 },
    { alt: 28000, tas: 315 },
    { alt: 30000, tas: 307 },
    { alt: 31000, tas: 297 }
];

// Rate of climb (fpm) from fltplan.com data
var CLIMB_ROC_BY_ALT = [
    { alt:     0, roc: 1000 }, { alt:  1000, roc: 1500 },
    { alt:  2000, roc: 1500 }, { alt:  3000, roc: 2000 },
    { alt:  4000, roc: 1980 }, { alt:  5000, roc: 1960 },
    { alt:  6000, roc: 1940 }, { alt:  7000, roc: 1920 },
    { alt:  8000, roc: 1900 }, { alt:  9000, roc: 1785 },
    { alt: 10000, roc: 1670 }, { alt: 11000, roc: 1630 },
    { alt: 12000, roc: 1590 }, { alt: 13000, roc: 1550 },
    { alt: 14000, roc: 1510 }, { alt: 15000, roc: 1470 },
    { alt: 16000, roc: 1425 }, { alt: 17000, roc: 1385 },
    { alt: 18000, roc: 1345 }, { alt: 19000, roc: 1305 },
    { alt: 20000, roc: 1265 }, { alt: 21000, roc: 1225 },
    { alt: 22000, roc: 1185 }, { alt: 23000, roc: 1145 },
    { alt: 24000, roc: 1105 }, { alt: 25000, roc: 1065 },
    { alt: 26000, roc: 1020 }, { alt: 27000, roc:  980 },
    { alt: 28000, roc:  940 }, { alt: 29000, roc:  900 },
    { alt: 30000, roc:  860 }, { alt: 31000, roc:  800 }
];

// Interpolate a value from a table by altitude
function interpTableByAlt(table, altFt, field) {
    if (altFt <= table[0].alt) return table[0][field];
    if (altFt >= table[table.length - 1].alt) return table[table.length - 1][field];
    for (var i = 0; i < table.length - 1; i++) {
        if (altFt >= table[i].alt && altFt <= table[i + 1].alt) {
            var frac = (altFt - table[i].alt) / (table[i + 1].alt - table[i].alt);
            return table[i][field] + frac * (table[i + 1][field] - table[i][field]);
        }
    }
    return table[table.length - 1][field];
}

// Get wind at a specific altitude from a GFS waypoint's wind data
// For altitudes below 700mb (~FL100), scale wind proportionally
function getWindAtAltFromWaypoint(waypointWinds, altFt) {
    if (!waypointWinds || Object.keys(waypointWinds).length === 0) {
        return { direction: 0, speed: 0 };
    }

    // Convert altitude to pressure, then look up
    var targetMb = flToPressure(altFt);

    // Get available pressure levels sorted descending (high mb = low alt)
    var levels = Object.keys(waypointWinds).map(Number).sort(function(a,b){return b-a;});

    var highestMb = levels[0];       // highest pressure = lowest altitude
    var lowestMb = levels[levels.length - 1]; // lowest pressure = highest altitude

    // Below lowest available altitude — scale down proportionally
    if (targetMb > highestMb) {
        var lowestWind = waypointWinds[highestMb];
        // At surface, assume ~20% of lowest-level wind
        var lowestAlt = GFS_LEVEL_ALTITUDES[highestMb] || 10000;
        var scaleFactor = 0.2 + 0.8 * Math.min(1.0, altFt / lowestAlt);
        return {
            direction: lowestWind.direction,
            speed: Math.round(lowestWind.speed * scaleFactor)
        };
    }

    // Above highest available level — use highest
    if (targetMb < lowestMb) {
        var hw = waypointWinds[lowestMb];
        return { direction: hw.direction, speed: hw.speed };
    }

    // Find bracketing levels and interpolate
    var upper = null; // higher pressure (lower alt)
    var lower = null; // lower pressure (higher alt)
    for (var j = 0; j < levels.length; j++) {
        if (levels[j] >= targetMb) upper = levels[j];
        if (levels[j] <= targetMb && lower === null) lower = levels[j];
    }

    if (!upper || !lower || upper === lower) {
        var best = upper || lower;
        if (best && waypointWinds[best]) {
            return { direction: waypointWinds[best].direction, speed: waypointWinds[best].speed };
        }
        return { direction: 0, speed: 0 };
    }

    // Interpolate U/V
    var wU = waypointWinds[upper];
    var wL = waypointWinds[lower];
    var frac = (upper - targetMb) / (upper - lower);
    var u = wU.u + frac * (wL.u - wU.u);
    var v = wU.v + frac * (wL.v - wU.v);
    var result = uvToWind(u, v);
    return { direction: result.direction, speed: result.speed };
}

// Average wind profile from multiple GFS waypoints
// Returns a synthetic "winds" object (keyed by mb) usable by getWindAtAltFromWaypoint
function averageWindsFromWaypoints(gfsWaypoints, startIdx, count) {
    if (!gfsWaypoints || gfsWaypoints.length === 0) return null;

    var end = Math.min(startIdx + count, gfsWaypoints.length);
    var actual = end - startIdx;
    if (actual <= 0) return null;

    // Collect all pressure levels from all selected waypoints
    var avgWinds = {};
    var levCounts = {};

    for (var i = startIdx; i < end; i++) {
        var wp = gfsWaypoints[i];
        if (!wp || !wp.winds) continue;

        var levels = Object.keys(wp.winds);
        for (var j = 0; j < levels.length; j++) {
            var mb = levels[j];
            var w = wp.winds[mb];
            if (!avgWinds[mb]) {
                avgWinds[mb] = { u: 0, v: 0 };
                levCounts[mb] = 0;
            }
            avgWinds[mb].u += w.u;
            avgWinds[mb].v += w.v;
            levCounts[mb]++;
        }
    }

    // Compute averages and convert to wind format
    var result = {};
    var mbs = Object.keys(avgWinds);
    for (var k = 0; k < mbs.length; k++) {
        var mb = mbs[k];
        var avgU = avgWinds[mb].u / levCounts[mb];
        var avgV = avgWinds[mb].v / levCounts[mb];
        var wind = uvToWind(avgU, avgV);
        result[mb] = {
            direction: wind.direction,
            speed: wind.speed,
            u: avgU,
            v: avgV
        };
    }

    return result;
}


// ============================================================
// MAIN: Calculate wind-corrected climb distance
// ============================================================
// pohClimbDistNm  — still-air climb distance from perf tables
// depElevFt       — departure airport elevation
// cruiseAltFt     — target cruise altitude
// courseTrue      — true course from departure
// gfsData         — full GFS data object from fetchGFSWinds()
//
// Returns: { distNm, avgHeadwind, correction }
// ============================================================

function calcWindCorrectedClimbDist(pohClimbDistNm, depElevFt, cruiseAltFt, courseTrue, gfsData) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length < 2) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    // Average winds from first 3 waypoints (near departure)
    var depWinds = averageWindsFromWaypoints(gfsData.waypoints, 0, 3);
    if (!depWinds) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    var BAND_SIZE = 2000;
    var startAlt = Math.max(depElevFt, 0);
    var endAlt = cruiseAltFt;

    if (endAlt <= startAlt) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    var totalTimeWeightedGS = 0;
    var totalTimeWeightedTAS = 0;
    var totalTime = 0;

    var alt = startAlt;
    while (alt < endAlt) {
        var bandTop = Math.min(alt + BAND_SIZE, endAlt);
        var bandMid = (alt + bandTop) / 2;
        var bandThickness = bandTop - alt;

        var tas = interpTableByAlt(CLIMB_TAS_BY_ALT, bandMid, 'tas');
        var roc = interpTableByAlt(CLIMB_ROC_BY_ALT, bandMid, 'roc');
        var wind = getWindAtAltFromWaypoint(depWinds, bandMid);
        var gs = windTriangleGS(tas, wind.direction, wind.speed, courseTrue);

        var bandTimeMin = bandThickness / roc; // minutes

        totalTimeWeightedGS += gs * bandTimeMin;
        totalTimeWeightedTAS += tas * bandTimeMin;
        totalTime += bandTimeMin;

        alt = bandTop;
    }

    if (totalTime <= 0) {
        return { distNm: pohClimbDistNm, avgHeadwind: 0, correction: 0 };
    }

    var avgGS = totalTimeWeightedGS / totalTime;
    var avgTAS = totalTimeWeightedTAS / totalTime;
    var gsRatio = avgGS / avgTAS;
    var correctedDist = Math.round(pohClimbDistNm * gsRatio * 10) / 10;
    var avgHeadwind = Math.round(avgTAS - avgGS);
    var correction = Math.round((correctedDist - pohClimbDistNm) * 10) / 10;

    console.log('[WIND-CLB] Climb ' + Math.round(depElevFt) + 'ft → FL' +
        Math.round(cruiseAltFt / 100) + ': avgTAS=' + Math.round(avgTAS) +
        ', avgGS=' + Math.round(avgGS) + ', HW=' + avgHeadwind +
        'kt, POH dist=' + pohClimbDistNm + 'nm → corrected=' +
        correctedDist + 'nm (' + (correction >= 0 ? '+' : '') + correction + ')');

    return {
        distNm: correctedDist,
        avgHeadwind: avgHeadwind,
        correction: correction
    };
}


// ============================================================
// MAIN: Calculate wind-corrected descent distance
// ============================================================

function calcWindCorrectedDescentDist(pohDescentDistNm, destElevFt, cruiseAltFt, courseTrue, gfsData) {
    if (!gfsData || !gfsData.waypoints || gfsData.waypoints.length < 2) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    // Average winds from last 3 waypoints (near destination)
    var arrWinds = averageWindsFromWaypoints(
        gfsData.waypoints,
        Math.max(0, gfsData.waypoints.length - 3),
        3
    );
    if (!arrWinds) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    var BAND_SIZE = 2000;
    var startAlt = cruiseAltFt;
    var endAlt = Math.max(destElevFt, 0);

    if (startAlt <= endAlt) {
        return { distNm: pohDescentDistNm, avgHeadwind: 0, correction: 0 };
    }

    var totalTimeWeightedGS = 0;
    var totalTimeWeightedTAS = 0;
    var totalTime = 0;

    // Descent rate: 2000 fpm standard, slightly slower above FL240 and below 6000ft
    function descentRate(altFt) {
        if (altFt > 24000) return 1800;
        if (altFt < 6000) return 1500;
        return 2000;
    }

    var alt = startAlt;
    while (alt > endAlt) {
        var bandBottom = Math.max(alt - BAND_SIZE, endAlt);
        var bandMid = (alt + bandBottom) / 2;
        var bandThickness = alt - bandBottom;

        var tas = interpTableByAlt(DESCENT_TAS_BY_ALT, bandMid, 'tas');
        var rod = descentRate(bandMid);
        var wind = getWindAtAltFromWaypoint(arrWinds, bandMid);
        var gs = windTriangleGS(tas, wind.direction, wind.speed, courseTrue);

        var bandTimeMin = bandThickness / rod;

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
    var correctedDist = Math.round(pohDescentDistNm * gsRatio * 10) / 10;
    var avgHeadwind = Math.round(avgTAS - avgGS);
    var correction = Math.round((correctedDist - pohDescentDistNm) * 10) / 10;

    console.log('[WIND-DES] Descent FL' + Math.round(cruiseAltFt / 100) +
        ' → ' + Math.round(destElevFt) + 'ft: avgTAS=' + Math.round(avgTAS) +
        ', avgGS=' + Math.round(avgGS) + ', HW=' + avgHeadwind +
        'kt, POH dist=' + pohDescentDistNm + 'nm → corrected=' +
        correctedDist + 'nm (' + (correction >= 0 ? '+' : '') + correction + ')');

    return {
        distNm: correctedDist,
        avgHeadwind: avgHeadwind,
        correction: correction
    };
}
