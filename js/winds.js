// ============================================================
// WINDS ALOFT MODULE — NOAA Fetch, Parse & Route Integration
// TBM850 Apple Flight Planner
// Requires: route.js loaded first (for greatCircleDistance, initialBearing)
// ============================================================

// Cloudflare CORS proxy for NOAA requests
var WINDS_PROXY_URL = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';

// Altitudes in the NOAA low-level winds aloft forecast (feet MSL)
var WIND_ALTITUDES = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];

// Maximum distance (nm) from route centerline to use a wind station
var MAX_STATION_DISTANCE_NM = 100;

// ============================================================
// NOAA WIND REPORTING STATIONS — CONUS
// ============================================================
var NOAA_WIND_STATIONS = [
    { id: 'ABQ', lat: 35.04, lon: -106.61 },
    { id: 'ABR', lat: 45.45, lon: -98.42 },
    { id: 'ABI', lat: 32.41, lon: -99.68 },
    { id: 'ALB', lat: 42.75, lon: -73.80 },
    { id: 'ALS', lat: 37.44, lon: -105.87 },
    { id: 'AMA', lat: 35.22, lon: -101.71 },
    { id: 'AUS', lat: 30.19, lon: -97.67 },
    { id: 'BFF', lat: 41.89, lon: -103.48 },
    { id: 'BIL', lat: 45.81, lon: -108.54 },
    { id: 'BIS', lat: 46.77, lon: -100.75 },
    { id: 'BNA', lat: 36.12, lon: -86.68 },
    { id: 'BOI', lat: 43.57, lon: -116.22 },
    { id: 'BRO', lat: 25.91, lon: -97.42 },
    { id: 'BUF', lat: 42.94, lon: -78.74 },
    { id: 'CAR', lat: 46.87, lon: -68.02 },
    { id: 'CHI', lat: 41.98, lon: -87.90 },
    { id: 'CHS', lat: 32.90, lon: -80.04 },
    { id: 'CLE', lat: 41.41, lon: -81.85 },
    { id: 'CRP', lat: 27.77, lon: -97.50 },
    { id: 'CVG', lat: 39.05, lon: -84.67 },
    { id: 'DAL', lat: 32.85, lon: -96.85 },
    { id: 'DDC', lat: 37.77, lon: -99.97 },
    { id: 'DEN', lat: 39.86, lon: -104.67 },
    { id: 'DLH', lat: 46.84, lon: -92.19 },
    { id: 'DRT', lat: 29.37, lon: -100.93 },
    { id: 'DSM', lat: 41.53, lon: -93.66 },
    { id: 'ELP', lat: 31.81, lon: -106.38 },
    { id: 'EYW', lat: 24.56, lon: -81.76 },
    { id: 'FAT', lat: 36.78, lon: -119.72 },
    { id: 'FLG', lat: 35.14, lon: -111.67 },
    { id: 'FMN', lat: 36.74, lon: -108.23 },
    { id: 'FSM', lat: 35.34, lon: -94.37 },
    { id: 'GCK', lat: 37.93, lon: -100.72 },
    { id: 'GEG', lat: 47.62, lon: -117.53 },
    { id: 'GGW', lat: 48.21, lon: -106.62 },
    { id: 'GJT', lat: 39.12, lon: -108.53 },
    { id: 'GRB', lat: 44.48, lon: -88.13 },
    { id: 'GTF', lat: 47.48, lon: -111.37 },
    { id: 'HAT', lat: 35.27, lon: -75.55 },
    { id: 'HLC', lat: 39.37, lon: -99.83 },
    { id: 'HMN', lat: 32.85, lon: -106.10 },
    { id: 'HON', lat: 44.38, lon: -98.23 },
    { id: 'HTS', lat: 38.37, lon: -82.56 },
    { id: 'ICT', lat: 37.65, lon: -97.43 },
    { id: 'ILM', lat: 34.27, lon: -77.90 },
    { id: 'IND', lat: 39.72, lon: -86.28 },
    { id: 'INL', lat: 48.57, lon: -93.40 },
    { id: 'JAN', lat: 32.31, lon: -90.08 },
    { id: 'JAX', lat: 30.49, lon: -81.69 },
    { id: 'JFK', lat: 40.64, lon: -73.78 },
    { id: 'LAS', lat: 36.08, lon: -115.15 },
    { id: 'LBB', lat: 33.67, lon: -101.82 },
    { id: 'LBF', lat: 41.13, lon: -100.68 },
    { id: 'LCH', lat: 30.13, lon: -93.22 },
    { id: 'LIT', lat: 34.73, lon: -92.22 },
    { id: 'LKN', lat: 40.86, lon: -115.74 },
    { id: 'MCI', lat: 39.30, lon: -94.71 },
    { id: 'MCO', lat: 28.43, lon: -81.31 },
    { id: 'MEM', lat: 35.06, lon: -89.98 },
    { id: 'MFR', lat: 42.37, lon: -122.87 },
    { id: 'MIA', lat: 25.79, lon: -80.29 },
    { id: 'MKE', lat: 42.95, lon: -87.90 },
    { id: 'MLS', lat: 46.43, lon: -105.89 },
    { id: 'MOB', lat: 30.69, lon: -88.25 },
    { id: 'MOT', lat: 48.26, lon: -101.28 },
    { id: 'MRF', lat: 30.37, lon: -103.65 },
    { id: 'MSN', lat: 43.14, lon: -89.34 },
    { id: 'MSP', lat: 44.88, lon: -93.22 },
    { id: 'OAK', lat: 37.72, lon: -122.22 },
    { id: 'OKC', lat: 35.39, lon: -97.60 },
    { id: 'OMA', lat: 41.30, lon: -95.89 },
    { id: 'ONT', lat: 34.06, lon: -117.60 },
    { id: 'ORD', lat: 41.98, lon: -87.90 },
    { id: 'ORF', lat: 36.90, lon: -76.20 },
    { id: 'PDX', lat: 45.59, lon: -122.60 },
    { id: 'PHX', lat: 33.43, lon: -112.02 },
    { id: 'PIA', lat: 40.67, lon: -89.69 },
    { id: 'PIR', lat: 44.38, lon: -100.29 },
    { id: 'PIT', lat: 40.50, lon: -80.23 },
    { id: 'PSP', lat: 33.83, lon: -116.51 },
    { id: 'PWM', lat: 43.65, lon: -70.31 },
    { id: 'RAP', lat: 44.05, lon: -103.05 },
    { id: 'RDU', lat: 35.88, lon: -78.79 },
    { id: 'RIC', lat: 37.51, lon: -77.32 },
    { id: 'RNO', lat: 39.50, lon: -119.77 },
    { id: 'ROA', lat: 37.32, lon: -79.97 },
    { id: 'SAT', lat: 29.53, lon: -98.47 },
    { id: 'SAV', lat: 32.13, lon: -81.20 },
    { id: 'SDF', lat: 38.17, lon: -85.74 },
    { id: 'SEA', lat: 47.45, lon: -122.31 },
    { id: 'SFO', lat: 37.62, lon: -122.38 },
    { id: 'SGF', lat: 37.24, lon: -93.39 },
    { id: 'SHV', lat: 32.45, lon: -93.83 },
    { id: 'SLC', lat: 40.79, lon: -111.98 },
    { id: 'SPI', lat: 39.84, lon: -89.68 },
    { id: 'SPS', lat: 33.99, lon: -98.49 },
    { id: 'SSM', lat: 46.47, lon: -84.36 },
    { id: 'STL', lat: 38.75, lon: -90.37 },
    { id: 'SYR', lat: 43.11, lon: -76.10 },
    { id: 'TLH', lat: 30.40, lon: -84.35 },
    { id: 'TOP', lat: 39.07, lon: -95.62 },
    { id: 'TPA', lat: 27.98, lon: -82.53 },
    { id: 'TUS', lat: 32.12, lon: -110.94 },
    { id: 'TVC', lat: 44.74, lon: -85.58 },
    { id: 'TYS', lat: 35.81, lon: -83.99 },
    { id: 'YKM', lat: 46.57, lon: -120.54 }
];


// ============================================================
// MAIN ENTRY — Fetch and process winds for a route
// ============================================================
async function fetchRouteWinds(dep, dest, forecastHr) {
    // 1. Find NOAA stations near the route
    var stations = findStationsAlongRoute(dep.lat, dep.lon, dest.lat, dest.lon);
    if (stations.length === 0) {
        console.warn('[WIND] No NOAA wind stations found along route');
        return null;
    }
    console.log('[WIND] Found ' + stations.length + ' stations along route:',
        stations.map(function(s) { return s.id; }).join(', '));

    // 2. Fetch raw winds aloft text from NOAA (via proxy)
    var rawText = await fetchNOAAWindText(forecastHr);
    if (!rawText) return null;

    // 3. Parse the raw text into structured data
    var allStations = parseWindsAloftText(rawText);
    if (!allStations || Object.keys(allStations).length === 0) {
        console.error('[WIND] Parser returned no station data');
        return null;
    }
    console.log('[WIND] Parsed ' + Object.keys(allStations).length + ' stations from NOAA data');

    // 4. Filter to only our route stations
    var routeWinds = {};
    var foundStations = [];
    for (var i = 0; i < stations.length; i++) {
        var id = stations[i].id;
        if (allStations[id]) {
            routeWinds[id] = allStations[id];
            foundStations.push(stations[i]);
        }
    }

    if (foundStations.length === 0) {
        console.warn('[WIND] No matching wind data for route stations. Route IDs:',
            stations.map(function(s) { return s.id; }).join(', '));
        // Log a few parsed station IDs for debugging
        var parsedIds = Object.keys(allStations).slice(0, 10);
        console.warn('[WIND] Sample parsed station IDs:', parsedIds.join(', '));
        return null;
    }

    console.log('[WIND] Matched ' + foundStations.length + ' stations with wind data:',
        foundStations.map(function(s) { return s.id; }).join(', '));

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    return {
        stationWinds: routeWinds,
        stationList: foundStations,
        totalDist: totalDist
    };
}


// ============================================================
// GROUND SPEED — Segment-based, cross-track weighted
// ============================================================
// Each station owns a segment of the route. Segment boundaries
// are weighted midpoints: stations closer to the route centerline
// get larger segments (more influence). Then GS per segment is
// computed from that station's wind, and effective GS = totalDist
// / totalTime. This naturally time-weights headwinds AND gives
// more influence to stations with better route-line accuracy.
// ============================================================
function calculateGroundSpeed(routeWindData, cruiseAlt, trueCourse, tas) {
    if (!routeWindData || !routeWindData.stationWinds) return tas;

    var stations = routeWindData.stationList;
    var totalDist = routeWindData.totalDist;
    if (!stations || stations.length === 0 || !totalDist) return tas;

    // Filter to stations that have wind data at this altitude
    var validStations = [];
    for (var i = 0; i < stations.length; i++) {
        var wind = interpolateWind(routeWindData.stationWinds[stations[i].id], cruiseAlt);
        if (wind) {
            validStations.push({
                id: stations[i].id,
                distFromDep: stations[i].distFromDep,
                crossTrack: stations[i].crossTrack || 0,
                wind: wind
            });
        }
    }
    if (validStations.length === 0) return tas;

    // Build segment boundaries using cross-track weighted midpoints
    // Close-to-route stations get larger segments (boundary pushed toward far station)
    var boundaries = [0]; // start of route
    for (var i = 0; i < validStations.length - 1; i++) {
        var a = validStations[i];
        var b = validStations[i + 1];
        // Inverse cross-track weight: closer = bigger number = more territory
        var wA = 1 / (a.crossTrack + 5);
        var wB = 1 / (b.crossTrack + 5);
        // Push boundary toward the FAR station (giving close station more territory)
        var midpoint = a.distFromDep + (b.distFromDep - a.distFromDep) * (wA / (wA + wB));
        boundaries.push(midpoint);
    }
    boundaries.push(totalDist); // end of route

    // Compute time per segment
    var totalTime = 0;
    var coveredDist = 0;
    for (var j = 0; j < validStations.length; j++) {
        var segDist = boundaries[j + 1] - boundaries[j];
        if (segDist <= 0) continue;

        var comp = windComponents(validStations[j].wind.direction, validStations[j].wind.speed, trueCourse);
        var segGS = windTriangleGS(tas, validStations[j].wind.direction, validStations[j].wind.speed, trueCourse);

        totalTime += segDist / segGS;
        coveredDist += segDist;
    }

    // Fill uncovered distance with TAS
    if (coveredDist < totalDist) {
        totalTime += (totalDist - coveredDist) / tas;
    }

    var effectiveGS = Math.round(totalDist / totalTime);

    console.log('[WIND] Segment GS calc: ' + validStations.length + ' segments, effective GS=' +
        effectiveGS + 'kt (TAS=' + tas + ')');

    return effectiveGS;
}


// ============================================================
// STATION FINDER — Identify NOAA stations along a route
// ============================================================
function findStationsAlongRoute(depLat, depLon, destLat, destLon) {
    var routeDist = greatCircleDistance(depLat, depLon, destLat, destLon);
    var results = [];

    for (var i = 0; i < NOAA_WIND_STATIONS.length; i++) {
        var stn = NOAA_WIND_STATIONS[i];
        var distFromDep = greatCircleDistance(depLat, depLon, stn.lat, stn.lon);
        var distToEnd = greatCircleDistance(stn.lat, stn.lon, destLat, destLon);

        var crossTrack = (distFromDep <= routeDist + 50 && distToEnd <= routeDist + 50)
            ? approximateCrossTrack(depLat, depLon, destLat, destLon, stn.lat, stn.lon)
            : 9999;

        if (crossTrack <= MAX_STATION_DISTANCE_NM &&
            distFromDep <= routeDist + 50 &&
            distToEnd <= routeDist + 50) {
            results.push({
                id: stn.id,
                lat: stn.lat,
                lon: stn.lon,
                distFromDep: distFromDep,
                crossTrack: crossTrack
            });
        }
    }

    results.sort(function(a, b) { return a.distFromDep - b.distFromDep; });
    return results;
}


// ============================================================
// CROSS-TRACK DISTANCE
// ============================================================
function approximateCrossTrack(lat1, lon1, lat2, lon2, latP, lonP) {
    var R = 3440.065;
    var toRad = Math.PI / 180;
    var d13 = greatCircleDistance(lat1, lon1, latP, lonP) / R;
    var brng13 = initialBearing(lat1, lon1, latP, lonP) * toRad;
    var brng12 = initialBearing(lat1, lon1, lat2, lon2) * toRad;
    var xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
    return Math.abs(xt * R);
}


// ============================================================
// FETCH — Gets raw text from NOAA via Cloudflare proxy
// ============================================================
async function fetchNOAAWindText(forecastHr) {
    var noaaURL = 'https://aviationweather.gov/api/data/windtemp'
        + '?region=all&level=low&fcst=' + forecastHr;

    var proxyURL = WINDS_PROXY_URL + encodeURIComponent(noaaURL);
    console.log('[WIND] Fetching NOAA winds: fcst=' + forecastHr);

    try {
        var response = await fetch(proxyURL);
        if (!response.ok) {
            console.error('[WIND] NOAA fetch failed: HTTP ' + response.status);
            return null;
        }
        var text = await response.text();
        if (!text || text.length < 100) {
            console.error('[WIND] NOAA data too short (' + (text ? text.length : 0) + ' chars)');
            return null;
        }
        console.log('[WIND] Received ' + text.length + ' chars from NOAA');
        return text;
    } catch (err) {
        console.error('[WIND] Fetch error:', err);
        return null;
    }
}


// ============================================================
// PARSER — Decodes NOAA winds aloft fixed-width text format
// ============================================================
// NOAA low-level format example:
//   FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
//   ABI       9900+21 2008+16 2214+10 2429-02 234416 234830 245044 245559
//   ABR 1715  1830+05 2035+00 2244-07 2358-20 236734 237648 238060 238568
//
// Token-mapping approach: split each data line into whitespace tokens,
// then assign each token to the nearest altitude column by character position.
// ============================================================
function parseWindsAloftText(rawText) {
    var lines = rawText.split('\n');
    var stations = {};

    // Step 1: Find the header line containing altitude labels
    var headerLine = null;
    var headerIndex = -1;
    for (var i = 0; i < lines.length; i++) {
        var matchCount = 0;
        for (var a = 0; a < WIND_ALTITUDES.length; a++) {
            if (lines[i].indexOf(WIND_ALTITUDES[a].toString()) >= 0) matchCount++;
        }
        if (matchCount >= 3) {
            headerLine = lines[i];
            headerIndex = i;
            break;
        }
    }
    if (!headerLine) {
        console.error('[WIND] Could not find altitude header in NOAA data');
        return null;
    }

    // Step 2: Get the character position of each altitude in the header
    // These positions mark the CENTER of each column
    var altPositions = [];
    for (var a = 0; a < WIND_ALTITUDES.length; a++) {
        var altStr = WIND_ALTITUDES[a].toString();
        var pos = headerLine.indexOf(altStr);
        if (pos >= 0) {
            altPositions.push({
                alt: WIND_ALTITUDES[a],
                pos: pos + Math.floor(altStr.length / 2)  // center of label
            });
        }
    }

    if (altPositions.length < 3) {
        console.error('[WIND] Too few altitude columns found: ' + altPositions.length);
        return null;
    }

    // Step 3: Parse each station data line
    for (var j = headerIndex + 1; j < lines.length; j++) {
        var line = lines[j];
        if (line.trim().length < 10) continue;

        // Station ID: first 3 uppercase letters
        var stnMatch = line.match(/^([A-Z]{3})\s/);
        if (!stnMatch) continue;

        var stnId = stnMatch[1];

        // Find all wind data tokens in this line with their positions
        // Tokens start after the station ID (position 3+)
        var tokens = [];
        var tokenRegex = /\S+/g;
        var match;
        var isFirst = true;
        while ((match = tokenRegex.exec(line)) !== null) {
            if (isFirst) { isFirst = false; continue; } // skip station ID
            tokens.push({
                text: match[0],
                pos: match.index + Math.floor(match[0].length / 2)  // center of token
            });
        }

        // Map each token to the nearest altitude column
        var winds = {};
        for (var t = 0; t < tokens.length; t++) {
            var tokenCenter = tokens[t].pos;
            var bestAlt = null;
            var bestDist = 9999;

            for (var c = 0; c < altPositions.length; c++) {
                var dist = Math.abs(tokenCenter - altPositions[c].pos);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestAlt = altPositions[c].alt;
                }
            }

            // Only accept if token is reasonably close to a column header
            // (within half the distance between adjacent columns)
            if (bestAlt !== null && bestDist < 12) {
                var decoded = decodeWindEntry(tokens[t].text, bestAlt);
                if (decoded) {
                    winds[bestAlt] = decoded;
                }
            }
        }

        if (Object.keys(winds).length > 0) {
            stations[stnId] = winds;
        }
    }

    return stations;
}


// ============================================================
// DECODER — Single wind/temp entry
// ============================================================
// Encoding rules:
//   4 digits: DDSS where DD=direction/10, SS=speed
//   6 digits: DDSSTT where TT=temperature (negative above FL240)
//   With +/- temp: DDSS+TT or DDSS-TT
//   Direction >= 51: subtract 50 from dir, add 100 to speed
//   "9900" = light and variable
// ============================================================
function decodeWindEntry(entry, altitude) {
    if (!entry || entry.length < 4) return null;

    var clean = entry.replace(/\s/g, '');

    // Pattern 1: 4 digits + optional signed temp (e.g., "2007+13", "9900", "2429-02")
    var match1 = clean.match(/^(\d{4})([+-]\d{1,3})?$/);
    // Pattern 2: 6 digits — DDSSTT for high altitudes (e.g., "234416", "245559")
    var match2 = clean.match(/^(\d{6})$/);

    var direction, speed, temp;

    if (match2) {
        // 6-digit format: DDSSTT
        direction = parseInt(clean.substring(0, 2));
        speed = parseInt(clean.substring(2, 4));
        temp = parseInt(clean.substring(4, 6));
        // Above FL240, temps are always negative
        if (altitude >= 24000 && temp > 0) temp = -temp;
    } else if (match1) {
        // 4-digit + optional temp format
        direction = parseInt(match1[1].substring(0, 2));
        speed = parseInt(match1[1].substring(2, 4));
        temp = match1[2] ? parseInt(match1[2]) : null;
    } else {
        return null;
    }

    // Light and variable
    if (direction === 99 && speed === 0) {
        return { direction: 0, speed: 0, temp: temp };
    }

    // Winds over 99kt: direction encoded with +50 offset
    if (direction >= 51) {
        direction -= 50;
        speed += 100;
    }

    // Convert to actual degrees (direction was /10 in encoding)
    direction *= 10;

    // Sanity checks
    if (direction < 0 || direction > 360) return null;
    if (speed < 0 || speed > 300) return null;

    return { direction: direction, speed: speed, temp: temp };
}


// ============================================================
// INTERPOLATION — Get wind at any altitude between levels
// ============================================================
function interpolateWind(stationWinds, targetAlt) {
    var alts = Object.keys(stationWinds).map(Number).sort(function(a, b) { return a - b; });

    if (stationWinds[targetAlt]) return stationWinds[targetAlt];

    var lower = null, upper = null;
    for (var i = 0; i < alts.length; i++) {
        if (alts[i] <= targetAlt) lower = alts[i];
        if (alts[i] >= targetAlt && upper === null) upper = alts[i];
    }

    if (lower === null && upper === null) return null;
    if (lower === null) return stationWinds[upper];
    if (upper === null) return stationWinds[lower];
    if (lower === upper) return stationWinds[lower];

    var fraction = (targetAlt - lower) / (upper - lower);
    var lo = stationWinds[lower];
    var hi = stationWinds[upper];

    var speed = Math.round(lo.speed + (hi.speed - lo.speed) * fraction);
    var temp = (lo.temp !== null && hi.temp !== null)
        ? Math.round(lo.temp + (hi.temp - lo.temp) * fraction)
        : lo.temp || hi.temp;
    var direction = interpolateDirection(lo.direction, hi.direction, fraction);

    return { direction: direction, speed: speed, temp: temp };
}

function interpolateDirection(dir1, dir2, fraction) {
    var diff = dir2 - dir1;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    var result = dir1 + diff * fraction;
    if (result < 0) result += 360;
    if (result >= 360) result -= 360;
    return Math.round(result);
}


// ============================================================
// WIND COMPONENTS — Headwind/tailwind & crosswind
// ============================================================
function windComponents(windDir, windSpd, courseTrue) {
    var angleDiff = (windDir - courseTrue) * (Math.PI / 180);
    return {
        headwind: Math.round(windSpd * Math.cos(angleDiff)),
        crosswind: Math.round(windSpd * Math.sin(angleDiff))
    };
}


// ============================================================
// WIND TRIANGLE GROUND SPEED
// ============================================================
// Full wind triangle: accounts for crosswind crab penalty.
//
// Simple formula (what we had):
//   GS = TAS - headwind_component
//   Ignores crosswind → 16kt error when 95kt wind crosses at 88°
//
// Wind triangle formula:
//   GS = √(TAS² - crosswind²) - headwind
//   Crosswind forces crab angle, reducing ground speed
//   even when headwind component is near zero.
//
// This matches how fltplan.com and ForeFlight compute GS.
// ============================================================
function windTriangleGS(tas, windDir, windSpd, courseTrue) {
    var angleDiff = (windDir - courseTrue) * (Math.PI / 180);
    var headwind = windSpd * Math.cos(angleDiff);   // positive = headwind
    var crosswind = windSpd * Math.sin(angleDiff);  // signed

    // TAS must exceed crosswind for valid triangle
    var tasSquared = tas * tas;
    var crossSquared = crosswind * crosswind;

    if (crossSquared >= tasSquared) {
        // Wind exceeds TAS perpendicular — aircraft can't maintain track
        // Shouldn't happen for TBM at FL240+ but handle gracefully
        return Math.max(50, tas - Math.abs(headwind));
    }

    var gs = Math.sqrt(tasSquared - crossSquared) - headwind;
    return Math.max(50, Math.round(gs));
}


// ============================================================
// WIND SUMMARY — Segment-based, cross-track weighted
// ============================================================
function getWindSummary(routeWindData, cruiseAlt, trueCourse, tas) {
    if (!routeWindData || !routeWindData.stationWinds) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data' };
    }

    var stations = routeWindData.stationList;
    var totalDist = routeWindData.totalDist;
    if (!stations || stations.length === 0 || !totalDist) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data' };
    }

    // Filter to stations with wind data
    var validStations = [];
    for (var i = 0; i < stations.length; i++) {
        var wind = interpolateWind(routeWindData.stationWinds[stations[i].id], cruiseAlt);
        if (wind) {
            validStations.push({
                id: stations[i].id,
                distFromDep: stations[i].distFromDep,
                crossTrack: stations[i].crossTrack || 0,
                wind: wind
            });
        }
    }
    if (validStations.length === 0) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data' };
    }

    // Cross-track weighted segment boundaries (same as calculateGroundSpeed)
    var boundaries = [0];
    for (var i = 0; i < validStations.length - 1; i++) {
        var a = validStations[i];
        var b = validStations[i + 1];
        var wA = 1 / (a.crossTrack + 5);
        var wB = 1 / (b.crossTrack + 5);
        boundaries.push(a.distFromDep + (b.distFromDep - a.distFromDep) * (wA / (wA + wB)));
    }
    boundaries.push(totalDist);

    var totalTime = 0;
    var weightedHeadwind = 0;
    var coveredDist = 0;

    for (var j = 0; j < validStations.length; j++) {
        var segDist = boundaries[j + 1] - boundaries[j];
        if (segDist <= 0) continue;

        var comp = windComponents(validStations[j].wind.direction, validStations[j].wind.speed, trueCourse);
        var segGS = windTriangleGS(tas, validStations[j].wind.direction, validStations[j].wind.speed, trueCourse);
        var segTime = segDist / segGS;

        totalTime += segTime;
        weightedHeadwind += comp.headwind * segTime;
        coveredDist += segDist;
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
        stationCount: validStations.length,
        description: desc,
        source: 'NOAA'
    };
}
