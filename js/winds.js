// ============================================================
// WINDS ALOFT MODULE — NOAA Fetch, Parse & Route Integration
// TBM850 Apple Flight Planner
// Requires: route.js loaded first (for greatCircleDistance, initialBearing)
// ============================================================

// Cloudflare CORS proxy for NOAA requests
var WINDS_PROXY_URL = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';

// Altitudes in the NOAA high-level winds aloft forecast (feet MSL)
var WIND_ALTITUDES = [18000, 24000, 30000, 34000, 39000];

// Maximum distance (nm) from route centerline to use a wind station
var MAX_STATION_DISTANCE_NM = 150;

// ============================================================
// NOAA WIND REPORTING STATIONS — CONUS
// id: 3-letter NOAA station identifier
// lat/lon: decimal degrees
// ============================================================
var NOAA_WIND_STATIONS = [
    { id: 'ABQ', lat: 35.04, lon: -106.61 },  // Albuquerque NM
    { id: 'ABR', lat: 45.45, lon: -98.42 },   // Aberdeen SD
    { id: 'ABI', lat: 32.41, lon: -99.68 },   // Abilene TX
    { id: 'ALB', lat: 42.75, lon: -73.80 },   // Albany NY
    { id: 'ALS', lat: 37.44, lon: -105.87 },  // Alamosa CO
    { id: 'AMA', lat: 35.22, lon: -101.71 },  // Amarillo TX
    { id: 'AUS', lat: 30.19, lon: -97.67 },   // Austin TX
    { id: 'BFF', lat: 41.89, lon: -103.48 },  // Scottsbluff NE
    { id: 'BIL', lat: 45.81, lon: -108.54 },  // Billings MT
    { id: 'BIS', lat: 46.77, lon: -100.75 },  // Bismarck ND
    { id: 'BNA', lat: 36.12, lon: -86.68 },   // Nashville TN
    { id: 'BOI', lat: 43.57, lon: -116.22 },  // Boise ID
    { id: 'BRO', lat: 25.91, lon: -97.42 },   // Brownsville TX
    { id: 'BUF', lat: 42.94, lon: -78.74 },   // Buffalo NY
    { id: 'CAR', lat: 46.87, lon: -68.02 },   // Caribou ME
    { id: 'CHI', lat: 41.98, lon: -87.90 },   // Chicago IL (same as ORD area)
    { id: 'CHS', lat: 32.90, lon: -80.04 },   // Charleston SC
    { id: 'CLE', lat: 41.41, lon: -81.85 },   // Cleveland OH
    { id: 'CRP', lat: 27.77, lon: -97.50 },   // Corpus Christi TX
    { id: 'CVG', lat: 39.05, lon: -84.67 },   // Cincinnati/Covington KY
    { id: 'DAL', lat: 32.85, lon: -96.85 },   // Dallas TX
    { id: 'DDC', lat: 37.77, lon: -99.97 },   // Dodge City KS
    { id: 'DEN', lat: 39.86, lon: -104.67 },  // Denver CO
    { id: 'DLH', lat: 46.84, lon: -92.19 },   // Duluth MN
    { id: 'DRT', lat: 29.37, lon: -100.93 },  // Del Rio TX
    { id: 'DSM', lat: 41.53, lon: -93.66 },   // Des Moines IA
    { id: 'ELP', lat: 31.81, lon: -106.38 },  // El Paso TX
    { id: 'EYW', lat: 24.56, lon: -81.76 },   // Key West FL
    { id: 'FAT', lat: 36.78, lon: -119.72 },  // Fresno CA
    { id: 'FLG', lat: 35.14, lon: -111.67 },  // Flagstaff AZ
    { id: 'FMN', lat: 36.74, lon: -108.23 },  // Farmington NM
    { id: 'FSM', lat: 35.34, lon: -94.37 },   // Fort Smith AR
    { id: 'GCK', lat: 37.93, lon: -100.72 },  // Garden City KS
    { id: 'GEG', lat: 47.62, lon: -117.53 },  // Spokane WA
    { id: 'GGW', lat: 48.21, lon: -106.62 },  // Glasgow MT
    { id: 'GJT', lat: 39.12, lon: -108.53 },  // Grand Junction CO
    { id: 'GRB', lat: 44.48, lon: -88.13 },   // Green Bay WI
    { id: 'GTF', lat: 47.48, lon: -111.37 },  // Great Falls MT
    { id: 'HAT', lat: 35.27, lon: -75.55 },   // Cape Hatteras NC
    { id: 'HLC', lat: 39.37, lon: -99.83 },   // Hill City KS
    { id: 'HMN', lat: 32.85, lon: -106.10 },  // Holloman NM
    { id: 'HON', lat: 44.38, lon: -98.23 },   // Huron SD
    { id: 'HTS', lat: 38.37, lon: -82.56 },   // Huntington WV
    { id: 'ICT', lat: 37.65, lon: -97.43 },   // Wichita KS
    { id: 'ILM', lat: 34.27, lon: -77.90 },   // Wilmington NC
    { id: 'IND', lat: 39.72, lon: -86.28 },   // Indianapolis IN
    { id: 'INL', lat: 48.57, lon: -93.40 },   // International Falls MN
    { id: 'JAN', lat: 32.31, lon: -90.08 },   // Jackson MS
    { id: 'JAX', lat: 30.49, lon: -81.69 },   // Jacksonville FL
    { id: 'JFK', lat: 40.64, lon: -73.78 },   // New York JFK
    { id: 'LAS', lat: 36.08, lon: -115.15 },  // Las Vegas NV
    { id: 'LBB', lat: 33.67, lon: -101.82 },  // Lubbock TX
    { id: 'LBF', lat: 41.13, lon: -100.68 },  // North Platte NE
    { id: 'LCH', lat: 30.13, lon: -93.22 },   // Lake Charles LA
    { id: 'LIT', lat: 34.73, lon: -92.22 },   // Little Rock AR
    { id: 'LKN', lat: 40.86, lon: -115.74 },  // Elko NV
    { id: 'MCI', lat: 39.30, lon: -94.71 },   // Kansas City MO
    { id: 'MCO', lat: 28.43, lon: -81.31 },   // Orlando FL
    { id: 'MEM', lat: 35.06, lon: -89.98 },   // Memphis TN
    { id: 'MFR', lat: 42.37, lon: -122.87 },  // Medford OR
    { id: 'MIA', lat: 25.79, lon: -80.29 },   // Miami FL
    { id: 'MKE', lat: 42.95, lon: -87.90 },   // Milwaukee WI
    { id: 'MLS', lat: 46.43, lon: -105.89 },  // Miles City MT
    { id: 'MOB', lat: 30.69, lon: -88.25 },   // Mobile AL
    { id: 'MOT', lat: 48.26, lon: -101.28 },  // Minot ND
    { id: 'MRF', lat: 30.37, lon: -103.65 },  // Marfa TX
    { id: 'MSN', lat: 43.14, lon: -89.34 },   // Madison WI
    { id: 'MSP', lat: 44.88, lon: -93.22 },   // Minneapolis MN
    { id: 'OAK', lat: 37.72, lon: -122.22 },  // Oakland CA
    { id: 'OKC', lat: 35.39, lon: -97.60 },   // Oklahoma City OK
    { id: 'OMA', lat: 41.30, lon: -95.89 },   // Omaha NE
    { id: 'ONT', lat: 34.06, lon: -117.60 },  // Ontario CA
    { id: 'ORD', lat: 41.98, lon: -87.90 },   // Chicago O'Hare IL
    { id: 'ORF', lat: 36.90, lon: -76.20 },   // Norfolk VA
    { id: 'PDX', lat: 45.59, lon: -122.60 },  // Portland OR
    { id: 'PHX', lat: 33.43, lon: -112.02 },  // Phoenix AZ
    { id: 'PIA', lat: 40.67, lon: -89.69 },   // Peoria IL
    { id: 'PIR', lat: 44.38, lon: -100.29 },  // Pierre SD
    { id: 'PIT', lat: 40.50, lon: -80.23 },   // Pittsburgh PA
    { id: 'PSP', lat: 33.83, lon: -116.51 },  // Palm Springs CA
    { id: 'PWM', lat: 43.65, lon: -70.31 },   // Portland ME
    { id: 'RAP', lat: 44.05, lon: -103.05 },  // Rapid City SD
    { id: 'RDU', lat: 35.88, lon: -78.79 },   // Raleigh-Durham NC
    { id: 'RIC', lat: 37.51, lon: -77.32 },   // Richmond VA
    { id: 'RNO', lat: 39.50, lon: -119.77 },  // Reno NV
    { id: 'ROA', lat: 37.32, lon: -79.97 },   // Roanoke VA
    { id: 'SAT', lat: 29.53, lon: -98.47 },   // San Antonio TX
    { id: 'SAV', lat: 32.13, lon: -81.20 },   // Savannah GA
    { id: 'SDF', lat: 38.17, lon: -85.74 },   // Louisville KY
    { id: 'SEA', lat: 47.45, lon: -122.31 },  // Seattle WA
    { id: 'SFO', lat: 37.62, lon: -122.38 },  // San Francisco CA
    { id: 'SGF', lat: 37.24, lon: -93.39 },   // Springfield MO
    { id: 'SHV', lat: 32.45, lon: -93.83 },   // Shreveport LA
    { id: 'SLC', lat: 40.79, lon: -111.98 },  // Salt Lake City UT
    { id: 'SPI', lat: 39.84, lon: -89.68 },   // Springfield IL
    { id: 'SPS', lat: 33.99, lon: -98.49 },   // Wichita Falls TX
    { id: 'SSM', lat: 46.47, lon: -84.36 },   // Sault Ste Marie MI
    { id: 'STL', lat: 38.75, lon: -90.37 },   // St Louis MO
    { id: 'SYR', lat: 43.11, lon: -76.10 },   // Syracuse NY
    { id: 'TLH', lat: 30.40, lon: -84.35 },   // Tallahassee FL
    { id: 'TOP', lat: 39.07, lon: -95.62 },   // Topeka KS
    { id: 'TPA', lat: 27.98, lon: -82.53 },   // Tampa FL
    { id: 'TUS', lat: 32.12, lon: -110.94 },  // Tucson AZ
    { id: 'TVC', lat: 44.74, lon: -85.58 },   // Traverse City MI
    { id: 'TYS', lat: 35.81, lon: -83.99 },   // Knoxville TN
    { id: 'YKM', lat: 46.57, lon: -120.54 }   // Yakima WA
];


// ============================================================
// MAIN ENTRY — Fetch and process winds for a route
// ============================================================
// dep/dest: { lat, lon } — departure and destination airports
// trueCourse: degrees — route true course
// forecastHr: '06', '12', or '24'
// Returns: { stationWinds, stationList } or null on failure
// ============================================================
async function fetchRouteWinds(dep, dest, forecastHr) {
    // 1. Find NOAA stations near the route
    var stations = findStationsAlongRoute(dep.lat, dep.lon, dest.lat, dest.lon);
    if (stations.length === 0) {
        console.warn('No NOAA wind stations found along route');
        return null;
    }

    // 2. Fetch raw winds aloft text from NOAA (via proxy)
    var rawText = await fetchNOAAWindText(forecastHr);
    if (!rawText) return null;

    // 3. Parse the raw text into structured data
    var allStations = parseWindsAloftText(rawText);
    if (!allStations) return null;

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
        console.warn('No matching wind data for route stations');
        return null;
    }

    return {
        stationWinds: routeWinds,
        stationList: foundStations
    };
}


// ============================================================
// GROUND SPEED — Calculate wind-corrected GS for cruise
// ============================================================
// routeWindData: output from fetchRouteWinds()
// cruiseAlt: altitude in feet MSL
// trueCourse: aircraft true course in degrees
// tas: true airspeed from performance table
// Returns: ground speed in knots (average across route stations)
// ============================================================
function calculateGroundSpeed(routeWindData, cruiseAlt, trueCourse, tas) {
    if (!routeWindData || !routeWindData.stationWinds) return tas;

    var totalGS = 0;
    var count = 0;

    for (var stn in routeWindData.stationWinds) {
        // Get interpolated wind at cruise altitude
        var wind = interpolateWind(routeWindData.stationWinds[stn], cruiseAlt);
        if (!wind) continue;

        // Calculate head/tail wind component
        var components = windComponents(wind.direction, wind.speed, trueCourse);

        // Ground speed = TAS - headwind (headwind positive, tailwind negative)
        var gs = tas - components.headwind;

        // Safety floor: GS can't be less than 50kt (extreme headwind protection)
        gs = Math.max(50, gs);

        totalGS += gs;
        count++;
    }

    if (count === 0) return tas;

    return Math.round(totalGS / count);
}


// ============================================================
// STATION FINDER — Identify NOAA stations along a route
// ============================================================
// Returns array of station objects sorted by distance along route
// ============================================================
function findStationsAlongRoute(depLat, depLon, destLat, destLon) {
    var routeDist = greatCircleDistance(depLat, depLon, destLat, destLon);
    var results = [];

    for (var i = 0; i < NOAA_WIND_STATIONS.length; i++) {
        var stn = NOAA_WIND_STATIONS[i];

        // Distance from departure to this station
        var distFromDep = greatCircleDistance(depLat, depLon, stn.lat, stn.lon);

        // Distance from station to destination
        var distToEnd = greatCircleDistance(stn.lat, stn.lon, destLat, destLon);

        // Cross-track distance approximation:
        // If station is "between" dep and dest (not behind or past),
        // and close to the route line
        var alongTrack = (distFromDep + distToEnd - routeDist);

        // alongTrack near 0 means station is on the route line
        // Larger values mean station is off to the side or beyond
        // Convert to approximate perpendicular distance
        var crossTrack = Math.abs(alongTrack) < routeDist
            ? approximateCrossTrack(depLat, depLon, destLat, destLon, stn.lat, stn.lon)
            : 9999;

        // Station must be within MAX_STATION_DISTANCE_NM of route
        // and not too far behind departure or past destination
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

    // Sort by distance from departure (gives along-route ordering)
    results.sort(function(a, b) { return a.distFromDep - b.distFromDep; });

    return results;
}


// ============================================================
// CROSS-TRACK DISTANCE — Perpendicular distance from route
// ============================================================
// Uses spherical cross-track formula
// All inputs in decimal degrees
// Returns distance in nautical miles
// ============================================================
function approximateCrossTrack(lat1, lon1, lat2, lon2, latP, lonP) {
    var R = 3440.065; // Earth radius in nm
    var toRad = Math.PI / 180;

    var d13 = greatCircleDistance(lat1, lon1, latP, lonP) / R; // angular dist dep->point
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
        + '?region=all&level=high&fcst=' + forecastHr;

    var proxyURL = WINDS_PROXY_URL + encodeURIComponent(noaaURL);

    try {
        var response = await fetch(proxyURL);
        if (!response.ok) {
            console.error('NOAA wind fetch failed: HTTP ' + response.status);
            return null;
        }
        var text = await response.text();
        if (!text || text.length < 100) {
            console.error('NOAA wind data too short or empty');
            return null;
        }
        return text;
    } catch (err) {
        console.error('Error fetching winds aloft:', err);
        return null;
    }
}


// ============================================================
// PARSER — Decodes NOAA winds aloft text format
// ============================================================
// NOAA format (high-level forecast):
//   STN  18000  24000  30000  34000  39000
//   GRB  2750-05 2660-18 276235 285848 287060
//
// Encoding:
//   First 2 digits = direction / 10 (27 = 270°)
//   Next 2 digits  = speed in knots (35 = 35kt)
//   +/- then temp   = temperature °C
//   If direction >= 51: subtract 50, add 100 to speed
//   "9900" = light and variable
//   Above FL240: temps always negative (sign omitted)
// ============================================================
function parseWindsAloftText(rawText) {
    var lines = rawText.split('\n');
    var stations = {};

    // Find header line with altitude labels
    var headerLine = null;
    var headerIndex = -1;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].match(/\b18000\b/) && lines[i].match(/\b34000\b/)) {
            headerLine = lines[i];
            headerIndex = i;
            break;
        }
    }
    if (!headerLine) {
        console.error('Could not find altitude header in NOAA wind data');
        return null;
    }

    // Get column positions for each altitude
    var altColumns = {};
    for (var a = 0; a < WIND_ALTITUDES.length; a++) {
        var altStr = WIND_ALTITUDES[a].toString();
        var pos = headerLine.indexOf(altStr);
        if (pos >= 0) {
            altColumns[WIND_ALTITUDES[a]] = pos;
        }
    }

    // Parse station data lines
    for (var j = headerIndex + 1; j < lines.length; j++) {
        var line = lines[j];
        if (line.trim().length < 10) continue;

        var stnMatch = line.match(/^([A-Z]{3})\s/);
        if (!stnMatch) continue;

        var stnId = stnMatch[1];
        var winds = {};

        for (var k = 0; k < WIND_ALTITUDES.length; k++) {
            var alt = WIND_ALTITUDES[k];
            if (!altColumns[alt]) continue;

            var startPos = altColumns[alt] - 2;
            var chunk = line.substring(
                Math.max(0, startPos),
                Math.min(line.length, startPos + 10)
            ).trim();

            var decoded = decodeWindEntry(chunk, alt);
            if (decoded) {
                winds[alt] = decoded;
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
function decodeWindEntry(entry, altitude) {
    if (!entry || entry.trim().length < 4) return null;

    var clean = entry.replace(/\s/g, '');

    var match = clean.match(/^(\d{4})([+-]?\d{1,3})?$/);
    if (!match) return null;

    var windPart = match[1];
    var tempPart = match[2] || null;

    var direction = parseInt(windPart.substring(0, 2));
    var speed = parseInt(windPart.substring(2, 4));

    // Light and variable
    if (direction === 99 && speed === 0) {
        return {
            direction: 0,
            speed: 0,
            temp: tempPart ? parseTempPart(tempPart, altitude) : null
        };
    }

    // Winds over 99kt: direction offset by 50
    if (direction >= 51) {
        direction -= 50;
        speed += 100;
    }

    // Convert to actual degrees
    direction *= 10;

    var temp = tempPart ? parseTempPart(tempPart, altitude) : null;

    return { direction: direction, speed: speed, temp: temp };
}

function parseTempPart(tempStr, altitude) {
    var temp = parseInt(tempStr);
    // Above FL240, temps are always negative (sign omitted in data)
    if (altitude >= 24000 && temp > 0) {
        temp = -temp;
    }
    return temp;
}


// ============================================================
// INTERPOLATION — Get wind at any altitude between levels
// ============================================================
function interpolateWind(stationWinds, targetAlt) {
    var alts = Object.keys(stationWinds).map(Number).sort(function(a, b) { return a - b; });

    // Exact match
    if (stationWinds[targetAlt]) {
        return stationWinds[targetAlt];
    }

    // Find bracketing altitudes
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
// windDir: degrees (where wind is FROM)
// windSpd: knots
// courseTrue: aircraft true course degrees
// Returns: { headwind, crosswind }
//   headwind positive = headwind, negative = tailwind
//   crosswind positive = from right, negative = from left
// ============================================================
function windComponents(windDir, windSpd, courseTrue) {
    var angleDiff = (windDir - courseTrue) * (Math.PI / 180);
    return {
        headwind: Math.round(windSpd * Math.cos(angleDiff)),
        crosswind: Math.round(windSpd * Math.sin(angleDiff))
    };
}


// ============================================================
// WIND SUMMARY — Human-readable wind info for display
// ============================================================
// Returns object with average wind info for the altitude table
// ============================================================
function getWindSummary(routeWindData, cruiseAlt, trueCourse, tas) {
    if (!routeWindData || !routeWindData.stationWinds) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data' };
    }

    var totalHeadwind = 0;
    var totalSpeed = 0;
    var count = 0;

    for (var stn in routeWindData.stationWinds) {
        var wind = interpolateWind(routeWindData.stationWinds[stn], cruiseAlt);
        if (!wind) continue;
        var comp = windComponents(wind.direction, wind.speed, trueCourse);
        totalHeadwind += comp.headwind;
        totalSpeed += wind.speed;
        count++;
    }

    if (count === 0) {
        return { available: false, gs: tas, windComponent: 0, description: 'No wind data' };
    }

    var avgHeadwind = Math.round(totalHeadwind / count);
    var avgWindSpeed = Math.round(totalSpeed / count);
    var gs = Math.max(50, tas - avgHeadwind);
    var desc = avgHeadwind > 0
        ? avgHeadwind + 'kt headwind'
        : Math.abs(avgHeadwind) + 'kt tailwind';

    return {
        available: true,
        gs: gs,
        windComponent: avgHeadwind,
        avgWindSpeed: avgWindSpeed,
        stationCount: count,
        description: desc
    };
}
