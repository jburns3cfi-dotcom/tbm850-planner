// ============================================================
// WINDS ALOFT MODULE — TBM850 Apple Flight Planner
// Fetches NOAA winds via Cloudflare proxy, parses, interpolates
// Proxy: tbm850-proxy.jburns3cfi.workers.dev
// ============================================================

var WindsAloft = (function () {

    var PROXY_BASE = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';
    var NOAA_BASE = 'https://aviationweather.gov/api/data/windtemp';

    // Cache: keyed by "region-level-hours"
    var cache = {};

    // 95 NOAA wind stations with coordinates
    var STATIONS = {
        'ABI': {lat:32.41,lon:-99.68}, 'ABQ': {lat:35.04,lon:-106.61}, 'ABR': {lat:45.44,lon:-98.42},
        'ALB': {lat:42.75,lon:-73.80}, 'AMA': {lat:35.22,lon:-101.72}, 'AUS': {lat:30.19,lon:-97.67},
        'BFF': {lat:41.89,lon:-103.48}, 'BHM': {lat:33.56,lon:-86.75}, 'BIL': {lat:45.81,lon:-108.54},
        'BIS': {lat:46.77,lon:-100.75}, 'BNA': {lat:36.12,lon:-86.68}, 'BOI': {lat:43.57,lon:-116.22},
        'BRO': {lat:25.91,lon:-97.42}, 'BUF': {lat:42.94,lon:-78.74}, 'CHS': {lat:32.90,lon:-80.04},
        'CLE': {lat:41.41,lon:-81.85}, 'CRP': {lat:27.77,lon:-97.50}, 'CVG': {lat:39.05,lon:-84.67},
        'CYS': {lat:41.16,lon:-104.82}, 'DAL': {lat:32.85,lon:-96.85}, 'DAY': {lat:39.90,lon:-84.22},
        'DDC': {lat:37.77,lon:-99.97}, 'DEN': {lat:39.86,lon:-104.67}, 'DFW': {lat:32.90,lon:-97.04},
        'DLH': {lat:46.84,lon:-92.19}, 'DRT': {lat:29.37,lon:-100.93}, 'DSM': {lat:41.53,lon:-93.66},
        'ELP': {lat:31.81,lon:-106.38}, 'EYW': {lat:24.56,lon:-81.76}, 'FAT': {lat:36.78,lon:-119.72},
        'FMY': {lat:26.59,lon:-81.86}, 'GEG': {lat:47.62,lon:-117.53}, 'GFK': {lat:47.95,lon:-97.18},
        'GGW': {lat:48.21,lon:-106.63}, 'GJT': {lat:39.12,lon:-108.53}, 'GRB': {lat:44.49,lon:-88.13},
        'GSO': {lat:36.10,lon:-79.94}, 'GTF': {lat:47.48,lon:-111.37}, 'HOU': {lat:29.65,lon:-95.28},
        'HTS': {lat:38.37,lon:-82.56}, 'ICT': {lat:37.65,lon:-97.43}, 'ILM': {lat:34.27,lon:-77.90},
        'IND': {lat:39.73,lon:-86.27}, 'INL': {lat:48.57,lon:-93.40}, 'JAX': {lat:30.49,lon:-81.69},
        'JAN': {lat:32.31,lon:-90.08}, 'JFK': {lat:40.64,lon:-73.78}, 'LAS': {lat:36.08,lon:-115.17},
        'LBB': {lat:33.67,lon:-101.82}, 'LBF': {lat:41.13,lon:-100.68}, 'LIT': {lat:34.73,lon:-92.22},
        'MCI': {lat:39.30,lon:-94.71}, 'MCO': {lat:28.43,lon:-81.31}, 'MEM': {lat:35.05,lon:-89.98},
        'MIA': {lat:25.79,lon:-80.29}, 'MKE': {lat:42.95,lon:-87.90}, 'MLS': {lat:46.43,lon:-105.89},
        'MOB': {lat:30.69,lon:-88.25}, 'MSP': {lat:44.88,lon:-93.22}, 'MTO': {lat:40.49,lon:-88.28},
        'OKC': {lat:35.39,lon:-97.60}, 'OMA': {lat:41.30,lon:-95.89}, 'ONT': {lat:34.06,lon:-117.60},
        'ORD': {lat:41.98,lon:-87.90}, 'PDX': {lat:45.59,lon:-122.60}, 'PHX': {lat:33.43,lon:-112.02},
        'PIR': {lat:44.38,lon:-100.29}, 'PIT': {lat:40.50,lon:-80.23}, 'PSB': {lat:40.88,lon:-77.98},
        'PUB': {lat:38.29,lon:-104.50}, 'RAP': {lat:44.05,lon:-103.05}, 'RDU': {lat:35.88,lon:-78.79},
        'RIC': {lat:37.51,lon:-77.32}, 'RNO': {lat:39.50,lon:-119.77}, 'ROA': {lat:37.32,lon:-79.97},
        'SAT': {lat:29.53,lon:-98.47}, 'SAV': {lat:32.13,lon:-81.20}, 'SDF': {lat:38.17,lon:-85.74},
        'SEA': {lat:47.45,lon:-122.31}, 'SFO': {lat:37.62,lon:-122.38}, 'SGF': {lat:37.24,lon:-93.39},
        'SHV': {lat:32.45,lon:-93.83}, 'SJT': {lat:31.36,lon:-100.50}, 'SLC': {lat:40.79,lon:-111.98},
        'SLE': {lat:44.91,lon:-123.00}, 'SPS': {lat:33.99,lon:-98.49}, 'SSM': {lat:46.48,lon:-84.36},
        'STL': {lat:38.75,lon:-90.37}, 'SYR': {lat:43.11,lon:-76.11}, 'TLH': {lat:30.40,lon:-84.35},
        'TPA': {lat:27.98,lon:-82.53}, 'TUS': {lat:32.12,lon:-110.94}, 'TVC': {lat:44.74,lon:-85.58},
        'UNI': {lat:40.22,lon:-111.72}, 'WMC': {lat:42.93,lon:-117.81}, 'YKM': {lat:46.57,lon:-120.54}
    };

    /**
     * Fetch winds aloft from NOAA for a specific forecast period.
     * @param {string} region - 'all' for CONUS
     * @param {string} level - 'lo' (sfc-24k) or 'hi' (24k-45k)
     * @param {number} fcstHours - 6, 12, or 24
     * @returns {Promise<object>} Parsed wind data keyed by station
     */
    function fetchWinds(region, level, fcstHours) {
        var key = region + '-' + level + '-' + fcstHours;
        if (cache[key]) {
            return Promise.resolve(cache[key]);
        }

        // New API params: region=us, level=low/high, fcst=6/12/24, layout=off
        var levelParam = level === 'hi' ? 'high' : 'low';
        var noaaUrl = NOAA_BASE + '?region=us&level=' + levelParam + '&fcst=' + fcstHours + '&layout=off';
        var proxyUrl = PROXY_BASE + encodeURIComponent(noaaUrl);

        return fetch(proxyUrl)
            .then(function (resp) {
                if (!resp.ok) throw new Error('Wind fetch HTTP ' + resp.status);
                return resp.text();
            })
            .then(function (text) {
                var data = parseWindsText(text);
                cache[key] = data;
                return data;
            });
    }

    /**
     * Fetch both lo and hi level winds and merge them.
     */
    function fetchAllWinds(fcstHours) {
        return Promise.all([
            fetchWinds('all', 'lo', fcstHours),
            fetchWinds('all', 'hi', fcstHours)
        ]).then(function (results) {
            // Merge hi into lo (hi has FL300, FL340, FL390, FL450)
            var merged = JSON.parse(JSON.stringify(results[0]));
            var hi = results[1];
            for (var stn in hi) {
                if (!merged[stn]) merged[stn] = {};
                for (var alt in hi[stn]) {
                    merged[stn][alt] = hi[stn][alt];
                }
            }
            return merged;
        });
    }

    /**
     * Parse NOAA winds aloft text format.
     * Returns { 'STN': { '3000': {dir,spd,temp}, '6000': {...}, ... }, ... }
     */
    function parseWindsText(text) {
        var lines = text.split('\n');
        var data = {};
        var altitudes = [];
        var inData = false;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Look for the header line with altitude columns
            // Old format: "STN    3000    6000    9000..."
            // New format: "FT  3000    6000    9000..."
            if (line.match(/^STN/) || line.match(/^Station/i) || line.match(/^FT\s/)) {
                // Parse altitude headers
                // Format: "STN    3000    6000    9000    12000   18000   24000   30000   34000   39000"
                var parts = line.split(/\s+/);
                altitudes = [];
                for (var j = 1; j < parts.length; j++) {
                    var a = parts[j].replace(/FT/i, '').replace(/FL/i, '');
                    var altVal = parseInt(a, 10);
                    // FL values (like 300) need to be multiplied by 100
                    if (altVal > 0 && altVal < 1000) altVal *= 100;
                    if (!isNaN(altVal) && altVal > 0) {
                        altitudes.push(altVal);
                    }
                }
                inData = true;
                continue;
            }

            if (!inData || altitudes.length === 0) continue;

            // Skip separator lines
            if (line.match(/^-+/) || line.match(/^=+/)) continue;

            // Data lines: "ORD 2714 2725+03 2735+00 2745-07 2760-18 2770-31 278945 287952 289060"
            // Some stations skip low altitudes (e.g. no 3000ft entry)
            var match = line.match(/^([A-Z]{3})\s+(.+)/);
            if (!match) continue;

            var station = match[1];
            var windStr = match[2].trim();

            // Split remaining into wind entries by whitespace
            var entries = windStr.split(/\s+/);
            data[station] = {};

            // If fewer entries than altitudes, missing ones are at the BEGINNING
            // (low altitudes are often omitted). Right-align entries to altitudes.
            var offset = altitudes.length - entries.length;
            if (offset < 0) offset = 0;

            for (var k = 0; k < entries.length; k++) {
                var altIdx = k + offset;
                if (altIdx >= altitudes.length) break;
                var decoded = decodeWindEntry(entries[k]);
                if (decoded) {
                    data[station][altitudes[altIdx]] = decoded;
                }
            }
        }

        return data;
    }

    /**
     * Decode a single NOAA wind entry.
     * Formats:
     *   "2714"     → dir 270, speed 14, no temp (low altitudes)
     *   "2725+03"  → dir 270, speed 25, temp +3°C
     *   "2725-07"  → dir 270, speed 25, temp -7°C
     *   "278945"   → dir 270, speed 89, temp -45°C (6-digit packed)
     *   "9900"     → light and variable (< 5 kt)
     *   "9900+03"  → light and variable, temp +3°C
     */
    function decodeWindEntry(entry) {
        if (!entry || entry === '' || entry === '----') return null;

        // Light and variable
        if (entry.substring(0, 4) === '9900') {
            var lvTemp = 0;
            if (entry.length > 4) {
                lvTemp = parseInt(entry.substring(4), 10) || 0;
            }
            return { dir: 0, spd: 0, temp: lvTemp };
        }

        // Check for +/- temp suffix
        var tempMatch = entry.match(/([+-]\d+)$/);
        var windPart = entry;
        var temp = null;

        if (tempMatch) {
            temp = parseInt(tempMatch[1], 10);
            windPart = entry.substring(0, entry.indexOf(tempMatch[0]));
        }

        if (windPart.length === 4) {
            // Standard: DDSS (direction tens + speed)
            var dirTens = parseInt(windPart.substring(0, 2), 10);
            var spd = parseInt(windPart.substring(2, 4), 10);

            // Speeds >= 100: direction is encoded as direction + 50
            // e.g., dir 27 + 50 = 77, speed reads as 14 but means 114
            if (dirTens > 50) {
                dirTens -= 50;
                spd += 100;
            }

            return { dir: dirTens * 10, spd: spd, temp: temp };
        }

        if (windPart.length === 6) {
            // Packed format: DDSSTT (dir tens, speed, temp negative)
            var dirTens2 = parseInt(windPart.substring(0, 2), 10);
            var spd2 = parseInt(windPart.substring(2, 4), 10);
            var temp2 = -parseInt(windPart.substring(4, 6), 10);

            if (dirTens2 > 50) {
                dirTens2 -= 50;
                spd2 += 100;
            }

            return { dir: dirTens2 * 10, spd: spd2, temp: temp2 };
        }

        return null;
    }

    /**
     * Interpolate wind at a specific lat/lon/altitude from station data.
     * Uses inverse-distance weighting of nearest stations.
     * @param {object} windData - parsed station data from fetchAllWinds
     * @param {number} lat
     * @param {number} lon
     * @param {number} altitude - feet MSL
     * @returns {object} { dir, spd, temp } or null
     */
    function interpolateWind(windData, lat, lon, altitude) {
        if (!windData) return null;

        // Find nearest stations that have data at or near this altitude
        var candidates = [];
        for (var stn in windData) {
            if (!STATIONS[stn]) continue;
            var stnData = windData[stn];

            // Interpolate altitude for this station
            var windAtAlt = interpolateAltitude(stnData, altitude);
            if (!windAtAlt) continue;

            var dist = quickDistance(lat, lon, STATIONS[stn].lat, STATIONS[stn].lon);
            candidates.push({
                station: stn,
                dist: dist,
                wind: windAtAlt
            });
        }

        if (candidates.length === 0) return null;

        // Sort by distance, take nearest 4
        candidates.sort(function (a, b) { return a.dist - b.dist; });
        var nearest = candidates.slice(0, 4);

        // If closest is very close (< 10nm), just use it
        if (nearest[0].dist < 10) {
            return nearest[0].wind;
        }

        // Inverse distance weighting
        var totalWeight = 0;
        var wDir_x = 0, wDir_y = 0, wSpd = 0, wTemp = 0;

        for (var i = 0; i < nearest.length; i++) {
            var w = 1 / (nearest[i].dist * nearest[i].dist);
            totalWeight += w;

            var dirRad = nearest[i].wind.dir * Math.PI / 180;
            wDir_x += Math.sin(dirRad) * nearest[i].wind.spd * w;
            wDir_y += Math.cos(dirRad) * nearest[i].wind.spd * w;
            wSpd += nearest[i].wind.spd * w;

            if (nearest[i].wind.temp !== null) {
                wTemp += nearest[i].wind.temp * w;
            }
        }

        var avgDir = Math.atan2(wDir_x / totalWeight, wDir_y / totalWeight) * 180 / Math.PI;
        if (avgDir < 0) avgDir += 360;

        return {
            dir: Math.round(avgDir),
            spd: Math.round(wSpd / totalWeight),
            temp: Math.round(wTemp / totalWeight)
        };
    }

    /**
     * Interpolate wind data between altitude levels at a single station.
     */
    function interpolateAltitude(stationData, altitude) {
        var alts = [];
        for (var a in stationData) {
            alts.push(parseInt(a, 10));
        }
        alts.sort(function (a, b) { return a - b; });

        if (alts.length === 0) return null;

        // Below lowest
        if (altitude <= alts[0]) {
            return stationData[alts[0]];
        }
        // Above highest
        if (altitude >= alts[alts.length - 1]) {
            return stationData[alts[alts.length - 1]];
        }

        // Find bounding altitudes
        var lower = alts[0], upper = alts[alts.length - 1];
        for (var i = 0; i < alts.length - 1; i++) {
            if (altitude >= alts[i] && altitude <= alts[i + 1]) {
                lower = alts[i];
                upper = alts[i + 1];
                break;
            }
        }

        if (lower === upper) return stationData[lower];

        var frac = (altitude - lower) / (upper - lower);
        var lo = stationData[lower];
        var hi = stationData[upper];
        if (!lo || !hi) return lo || hi;

        // Interpolate direction using vector math
        var loRad = lo.dir * Math.PI / 180;
        var hiRad = hi.dir * Math.PI / 180;
        var x = Math.sin(loRad) * lo.spd * (1 - frac) + Math.sin(hiRad) * hi.spd * frac;
        var y = Math.cos(loRad) * lo.spd * (1 - frac) + Math.cos(hiRad) * hi.spd * frac;
        var dir = Math.atan2(x, y) * 180 / Math.PI;
        if (dir < 0) dir += 360;
        var spd = Math.sqrt(x * x + y * y);

        var temp = null;
        if (lo.temp !== null && hi.temp !== null) {
            temp = lo.temp * (1 - frac) + hi.temp * frac;
        }

        return {
            dir: Math.round(dir),
            spd: Math.round(spd),
            temp: temp !== null ? Math.round(temp) : null
        };
    }

    /**
     * Calculate headwind/tailwind component given wind and course.
     * Positive = tailwind, negative = headwind.
     * @returns {object} { headTail, crosswind, groundSpeed }
     */
    function windComponents(windDir, windSpd, trueCourse, tas) {
        if (!windSpd || windSpd === 0) {
            return { headTail: 0, crosswind: 0, groundSpeed: tas };
        }

        // Angle between wind direction and course
        // Wind FROM windDir, we're going trueCourse
        var angle = (windDir - trueCourse) * Math.PI / 180;

        // Headwind component (positive = headwind INTO us)
        var headwind = windSpd * Math.cos(angle);
        // Crosswind component
        var crosswind = windSpd * Math.sin(angle);

        // Ground speed = TAS - headwind component
        // (headwind is positive when wind is from ahead, so subtract)
        var gs = tas - headwind;
        if (gs < 50) gs = 50; // Safety floor

        return {
            headTail: Math.round(-headwind), // Positive = tailwind
            crosswind: Math.round(crosswind),
            groundSpeed: Math.round(gs)
        };
    }

    /**
     * Get wind-corrected ground speed for a route segment.
     * @param {object} windData - from fetchAllWinds
     * @param {number} lat - midpoint lat
     * @param {number} lon - midpoint lon
     * @param {number} altitude - cruise altitude
     * @param {number} trueCourse - degrees
     * @param {number} tas - knots
     * @returns {object} { groundSpeed, wind: {dir,spd}, headTail, crosswind }
     */
    function getGroundSpeed(windData, lat, lon, altitude, trueCourse, tas) {
        var wind = interpolateWind(windData, lat, lon, altitude);
        if (!wind) {
            return { groundSpeed: tas, wind: null, headTail: 0, crosswind: 0 };
        }

        var components = windComponents(wind.dir, wind.spd, trueCourse, tas);
        return {
            groundSpeed: components.groundSpeed,
            wind: wind,
            headTail: components.headTail,
            crosswind: components.crosswind
        };
    }

    /**
     * Quick distance between two points (approximate, in NM).
     */
    function quickDistance(lat1, lon1, lat2, lon2) {
        var dLat = (lat2 - lat1) * 60;
        var dLon = (lon2 - lon1) * 60 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
        return Math.sqrt(dLat * dLat + dLon * dLon);
    }

    /**
     * Clear the cache (call when changing forecast period).
     */
    function clearCache() {
        cache = {};
    }

    // Public API
    return {
        fetchWinds: fetchWinds,
        fetchAllWinds: fetchAllWinds,
        parseWindsText: parseWindsText,
        decodeWindEntry: decodeWindEntry,
        interpolateWind: interpolateWind,
        windComponents: windComponents,
        getGroundSpeed: getGroundSpeed,
        clearCache: clearCache,
        STATIONS: STATIONS
    };

})();

if (typeof window !== 'undefined') {
    window.WindsAloft = WindsAloft;
}
