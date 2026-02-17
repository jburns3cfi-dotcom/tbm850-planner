// ============================================================
// WINDS ALOFT MODULE — NOAA Fetch & Parse
// TBM850 Apple Flight Planner
// Paste this inside a <script> tag in your HTML
// ============================================================

// Altitudes we care about from the NOAA data (feet MSL)
const WIND_ALTITUDES = [18000, 24000, 30000, 34000, 39000];
// We fetch 39000 too so we can interpolate FL350

// ============================================================
// MAIN FUNCTION — Call this from your route logic
// ============================================================
// stationIds: array of 3-letter station IDs along the route
//             e.g. ['GRB', 'MSN', 'ORD']
// forecastHr: '06', '12', or '24' (your existing logic picks this)
//
// Returns: object keyed by station ID, each containing wind data
//          per altitude with direction, speed, and temperature
// ============================================================
async function fetchWindsAloft(stationIds, forecastHr) {
    if (!stationIds || stationIds.length === 0) {
        console.error('No wind stations provided');
        return null;
    }
    if (!['06', '12', '24'].includes(forecastHr)) {
        console.error('Invalid forecast hour. Use 06, 12, or 24');
        return null;
    }

    // Fetch the raw text from NOAA Aviation Weather Center
    const rawText = await fetchNOAAWindText(forecastHr);
    if (!rawText) return null;

    // Parse the text into structured data for our stations
    const allStations = parseWindsAloftText(rawText);
    if (!allStations) return null;

    // Filter to only the stations along our route
    const routeWinds = {};
    for (const id of stationIds) {
        const upper = id.toUpperCase();
        if (allStations[upper]) {
            routeWinds[upper] = allStations[upper];
        } else {
            console.warn('Wind station ' + upper + ' not found in NOAA data');
        }
    }

    return routeWinds;
}


// ============================================================
// FETCH — Gets raw text from NOAA
// ============================================================
async function fetchNOAAWindText(forecastHr) {
    // Primary URL: Aviation Weather Center API (current as of 2025)
    const primaryURL = 'https://aviationweather.gov/api/data/windtemp'
        + '?region=all&level=high&fcst=' + forecastHr;

    // Fallback URL: older CGI endpoint
    const fallbackURL = 'https://aviationweather.gov/cgi-bin/data/windtemp.php'
        + '?region=all&fcst=' + forecastHr + '&level=high';

    try {
        let response = await fetch(primaryURL);
        if (response.ok) {
            const text = await response.text();
            if (text && text.length > 100) return text;
        }
        // Try fallback
        console.warn('Primary NOAA URL failed, trying fallback...');
        response = await fetch(fallbackURL);
        if (response.ok) {
            const text = await response.text();
            if (text && text.length > 100) return text;
        }
        console.error('Both NOAA wind URLs failed');
        return null;
    } catch (err) {
        console.error('Error fetching winds aloft:', err);
        return null;
    }
}


// ============================================================
// PARSER — Decodes NOAA winds aloft text format
// ============================================================
// NOAA format example:
//   STN  3000 6000 9000 12000 18000  24000  30000  34000  39000
//   GRB            2735 2742+03 2750-05 2660-18 276235 285848 287060
//
// Encoding rules:
//   First 2 digits = direction in tens of degrees (27 = 270°)
//   Next 2 digits  = speed in knots (35 = 35kt)
//   +/- number     = temperature in Celsius
//   If direction digits >= 51: subtract 50, add 100 to speed
//     (e.g. 7235 means direction 220°, speed 135kt)
//   "9900" = light and variable (direction 0, speed 0)
//   Temps above FL240 are always negative (sign omitted)
// ============================================================
function parseWindsAloftText(rawText) {
    const lines = rawText.split('\n');
    const stations = {};

    // Find the header line that tells us column positions
    // It contains altitude labels like "18000" "24000" etc.
    let headerLine = null;
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/\b18000\b/) && lines[i].match(/\b34000\b/)) {
            headerLine = lines[i];
            headerIndex = i;
            break;
        }
    }
    if (!headerLine) {
        console.error('Could not find altitude header in NOAA data');
        return null;
    }

    // Get column positions for each altitude we care about
    const altColumns = {};
    for (const alt of WIND_ALTITUDES) {
        const altStr = alt.toString();
        const pos = headerLine.indexOf(altStr);
        if (pos >= 0) {
            altColumns[alt] = pos;
        }
    }

    // Parse each station line (lines after the header)
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length < 10) continue; // skip blank lines

        // Station ID is the first 3 letters
        const stnMatch = line.match(/^([A-Z]{3})\s/);
        if (!stnMatch) continue;

        const stnId = stnMatch[1];
        const winds = {};

        for (const alt of WIND_ALTITUDES) {
            if (!altColumns[alt]) continue;

            // Extract the wind data chunk at this column position
            // Data fields are roughly 7-9 chars wide
            const startPos = altColumns[alt] - 2; // small offset for alignment
            const chunk = line.substring(
                Math.max(0, startPos),
                Math.min(line.length, startPos + 10)
            ).trim();

            const decoded = decodeWindEntry(chunk, alt);
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
// DECODER — Decodes a single wind/temp entry
// ============================================================
// entry: string like "2750-05" or "276235" or "9900"
// altitude: feet MSL (used to determine temp sign)
// Returns: { direction, speed, temp } or null
// ============================================================
function decodeWindEntry(entry, altitude) {
    if (!entry || entry.trim().length < 4) return null;

    // Clean up — remove any spaces
    const clean = entry.replace(/\s/g, '');

    // Match the wind encoding pattern
    // Patterns: "2735" "2735+07" "2735-18" "273507" "276235"
    const match = clean.match(/^(\d{4})([+-]?\d{1,3})?$/);
    if (!match) return null;

    const windPart = match[1];
    let tempPart = match[2] || null;

    let direction = parseInt(windPart.substring(0, 2));
    let speed = parseInt(windPart.substring(2, 4));

    // Light and variable
    if (direction === 99 && speed === 0) {
        return { direction: 0, speed: 0, temp: tempPart ? parseTempPart(tempPart, altitude) : null };
    }

    // Winds over 99 knots: direction is offset by 50
    if (direction >= 51) {
        direction -= 50;
        speed += 100;
    }

    // Convert direction from tens of degrees to actual degrees
    direction *= 10;

    // Parse temperature
    let temp = null;
    if (tempPart) {
        temp = parseTempPart(tempPart, altitude);
    }

    return { direction: direction, speed: speed, temp: temp };
}

function parseTempPart(tempStr, altitude) {
    let temp = parseInt(tempStr);
    // Above FL240, temperatures are always negative (sign not printed)
    if (altitude >= 24000 && temp > 0) {
        temp = -temp;
    }
    return temp;
}


// ============================================================
// INTERPOLATION — Get wind at any altitude between levels
// ============================================================
// stationWinds: the wind data object for one station
//               e.g. { 18000: {dir,spd,temp}, 24000: {...}, ... }
// targetAlt: desired altitude in feet (e.g. 35000 for FL350)
// Returns: { direction, speed, temp } interpolated
// ============================================================
function interpolateWind(stationWinds, targetAlt) {
    const alts = Object.keys(stationWinds).map(Number).sort((a, b) => a - b);

    // Exact match?
    if (stationWinds[targetAlt]) {
        return stationWinds[targetAlt];
    }

    // Find bracketing altitudes
    let lower = null, upper = null;
    for (const alt of alts) {
        if (alt <= targetAlt) lower = alt;
        if (alt >= targetAlt && upper === null) upper = alt;
    }

    // Can't interpolate if we're outside the data range
    if (lower === null || upper === null) {
        return lower !== null ? stationWinds[lower] : stationWinds[upper];
    }
    if (lower === upper) return stationWinds[lower];

    // Linear interpolation factor
    const fraction = (targetAlt - lower) / (upper - lower);
    const lo = stationWinds[lower];
    const hi = stationWinds[upper];

    // Interpolate speed and temperature linearly
    const speed = Math.round(lo.speed + (hi.speed - lo.speed) * fraction);
    const temp = (lo.temp !== null && hi.temp !== null)
        ? Math.round(lo.temp + (hi.temp - lo.temp) * fraction)
        : lo.temp || hi.temp;

    // Interpolate direction (handle wrap-around at 360°)
    const direction = interpolateDirection(lo.direction, hi.direction, fraction);

    return { direction: direction, speed: speed, temp: temp };
}

function interpolateDirection(dir1, dir2, fraction) {
    // Handle the 360/0 wrap-around
    let diff = dir2 - dir1;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    let result = dir1 + diff * fraction;
    if (result < 0) result += 360;
    if (result >= 360) result -= 360;
    return Math.round(result);
}


// ============================================================
// CONVENIENCE — Get winds for a route at a specific altitude
// ============================================================
// routeWinds: output from fetchWindsAloft()
// altitude: desired altitude in feet (e.g. 28000 for FL280)
// Returns: object keyed by station with interpolated wind at that altitude
// ============================================================
function getRouteWindsAtAltitude(routeWinds, altitude) {
    const result = {};
    for (const stn in routeWinds) {
        result[stn] = interpolateWind(routeWinds[stn], altitude);
    }
    return result;
}


// ============================================================
// HEADWIND/TAILWIND COMPONENT — For ground speed calculation
// ============================================================
// windDir: wind direction in degrees (where wind is FROM)
// windSpd: wind speed in knots
// courseTrue: aircraft true course in degrees
// Returns: { headwind, crosswind }
//   headwind: positive = headwind, negative = tailwind
//   crosswind: positive = from right, negative = from left
// ============================================================
function windComponents(windDir, windSpd, courseTrue) {
    const angleDiff = (windDir - courseTrue) * (Math.PI / 180);
    return {
        headwind: Math.round(windSpd * Math.cos(angleDiff)),
        crosswind: Math.round(windSpd * Math.sin(angleDiff))
    };
}


// ============================================================
// USAGE EXAMPLE (delete this or comment it out in production)
// ============================================================
/*
// In your route calculation, after identifying stations and forecast period:

async function calculateRouteWinds() {
    const stationsAlongRoute = ['GRB', 'MSN', 'DBQ'];  // from your existing logic
    const forecastPeriod = '06';                          // from your existing logic
    const cruiseAltitude = 28000;                         // FL280
    const trueCourse = 245;                               // degrees

    // 1. Fetch winds for all stations
    const routeWinds = await fetchWindsAloft(stationsAlongRoute, forecastPeriod);
    if (!routeWinds) {
        console.log('Could not retrieve winds aloft');
        return;
    }

    // 2. Get winds at your cruise altitude for each station
    const windsAtAlt = getRouteWindsAtAltitude(routeWinds, cruiseAltitude);

    // 3. Calculate head/tailwind for each station
    for (const stn in windsAtAlt) {
        const w = windsAtAlt[stn];
        const components = windComponents(w.direction, w.speed, trueCourse);
        console.log(stn + ': ' + w.direction + '° at ' + w.speed + 'kt, '
            + 'Temp: ' + w.temp + '°C, '
            + (components.headwind > 0 ? 'Headwind' : 'Tailwind') + ': '
            + Math.abs(components.headwind) + 'kt');
    }
}
*/
