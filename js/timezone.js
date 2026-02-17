// ============================================================
// timezone.js — Timezone detection & NOAA forecast period logic
// TBM850 Flight Planner — Apple Edition
// ============================================================

// ── Configuration ──────────────────────────────────────────
// Update PROXY_BASE to match your Cloudflare Worker URL
var PROXY_BASE = 'https://tbm850-proxy.YOUR-SUBDOMAIN.workers.dev';

// ── Timezone Cache ─────────────────────────────────────────
// Avoids re-fetching timezone for the same airport
var timezoneCache = {};

// ============================================================
// MAIN ENTRY POINT — Get timezone for an airport
// Returns IANA timezone string (e.g. "America/Chicago")
// ============================================================
async function getAirportTimezone(icao, lat, lon) {
    // Check cache first
    if (timezoneCache[icao]) {
        console.log('[TZ] Cache hit for ' + icao + ': ' + timezoneCache[icao]);
        return timezoneCache[icao];
    }

    // Try AirNav first (primary)
    var tz = await getTimezoneFromAirNav(icao);

    // Fallback to free API if AirNav fails
    if (!tz) {
        console.log('[TZ] AirNav failed for ' + icao + ', trying API fallback...');
        tz = await getTimezoneFromAPI(lat, lon);
    }

    // Last resort — estimate from longitude (rough, no DST awareness)
    if (!tz) {
        console.log('[TZ] API fallback failed, estimating from longitude...');
        tz = estimateTimezoneFromLon(lon);
    }

    // Cache it
    timezoneCache[icao] = tz;
    console.log('[TZ] Resolved ' + icao + ' → ' + tz);
    return tz;
}

// ============================================================
// AirNav scrape (PRIMARY)
// Fetches the airport page via proxy and parses timezone
// ============================================================
async function getTimezoneFromAirNav(icao) {
    try {
        var url = PROXY_BASE + '/airnav?airport=' + icao;
        var resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return null;
        var html = await resp.text();

        // AirNav lists timezone in a pattern like:
        //   "Time zone:&nbsp;&nbsp;UTC -6 (UTC -5 during Daylight Saving Time)"
        //   or "Time zone:.*?(America/Chicago)" 
        //   or "Time zone:.*?UTC ([+-]?\d+)"
        
        // Try to find IANA timezone name first
        var ianaMatch = html.match(/Time\s*zone:.*?((?:US|America|Pacific)\/[A-Za-z_]+)/i);
        if (ianaMatch) {
            return ianaMatch[1];
        }

        // Try to find UTC offset pattern and map to IANA
        var utcMatch = html.match(/Time\s*zone:\s*(?:&nbsp;|\s)*UTC\s*([+-]?\d+)/i);
        if (utcMatch) {
            var offset = parseInt(utcMatch[1]);
            return mapUTCOffsetToIANA(offset, html);
        }

        return null;
    } catch (e) {
        console.warn('[TZ] AirNav fetch error:', e.message);
        return null;
    }
}

// ============================================================
// Free timezone API (FALLBACK)
// Uses timeapi.io — free, no key required
// ============================================================
async function getTimezoneFromAPI(lat, lon) {
    try {
        var url = 'https://timeapi.io/api/timezone/coordinate?latitude=' + 
                  lat.toFixed(4) + '&longitude=' + lon.toFixed(4);
        var resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!resp.ok) return null;
        var data = await resp.json();
        // timeapi.io returns { "timeZone": "America/Chicago", ... }
        if (data && data.timeZone) {
            return data.timeZone;
        }
        return null;
    } catch (e) {
        console.warn('[TZ] API fallback error:', e.message);
        return null;
    }
}

// ============================================================
// Longitude-based estimate (LAST RESORT)
// Rough estimate — doesn't handle DST or irregular boundaries
// ============================================================
function estimateTimezoneFromLon(lon) {
    // Continental US approximations
    if (lon >= -67.5)  return 'America/New_York';     // Eastern
    if (lon >= -82.5)  return 'America/New_York';     // Eastern
    if (lon >= -97.5)  return 'America/Chicago';      // Central
    if (lon >= -112.5) return 'America/Denver';       // Mountain
    if (lon >= -127.5) return 'America/Los_Angeles';  // Pacific
    if (lon >= -142.5) return 'America/Anchorage';    // Alaska
    return 'Pacific/Honolulu';                         // Hawaii
}

// ============================================================
// Map UTC offset to IANA timezone (for AirNav parsing)
// Uses DST hint from AirNav page to disambiguate
// ============================================================
function mapUTCOffsetToIANA(offset, html) {
    // Check if page mentions specific timezone abbreviation
    var lowerHtml = html.toLowerCase();
    
    // Standard UTC offsets for US timezones (standard time)
    // During DST, clocks spring forward by 1 hour
    var map = {
        '-5':  'America/New_York',
        '-6':  'America/Chicago',
        '-7':  'America/Denver',
        '-8':  'America/Los_Angeles',
        '-9':  'America/Anchorage',
        '-10': 'Pacific/Honolulu'
    };

    // Check for Arizona (UTC-7 year-round, no DST)
    if (offset === -7 && lowerHtml.indexOf('daylight saving') === -1) {
        return 'America/Phoenix';
    }

    return map[String(offset)] || 'America/Chicago'; // default Central
}


// ============================================================
// DEPARTURE DATE/TIME UTILITIES
// ============================================================

// Get the day buttons starting from today through the rest of the week
// Returns array of { label: "Today", date: Date, dayName: "Tue" }
function getDayOptions() {
    var days = [];
    var now = new Date();
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (var i = 0; i < 7; i++) {
        var d = new Date(now);
        d.setDate(now.getDate() + i);
        d.setHours(0, 0, 0, 0); // midnight local
        
        days.push({
            label: i === 0 ? 'Today' : dayNames[d.getDay()],
            date: d,
            dayIndex: i
        });
    }
    return days;
}

// Convert local military time + date + IANA timezone to a UTC Date object
// militaryTime: string like "0800" or "1430"
// localDate: Date object (just the date portion matters)
// timezone: IANA string like "America/Chicago"
function localToZulu(militaryTime, localDate, timezone) {
    if (!militaryTime || militaryTime.length < 4) return null;
    
    var hours = parseInt(militaryTime.substring(0, 2));
    var minutes = parseInt(militaryTime.substring(2, 4));
    
    if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) return null;

    // Build a date string in the target timezone
    var year = localDate.getFullYear();
    var month = String(localDate.getMonth() + 1).padStart(2, '0');
    var day = String(localDate.getDate()).padStart(2, '0');
    var dateStr = year + '-' + month + '-' + day + 'T' +
                  String(hours).padStart(2, '0') + ':' +
                  String(minutes).padStart(2, '0') + ':00';

    // Use Intl to figure out the UTC offset for this specific date/time in this timezone
    // This automatically handles DST
    try {
        var formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
            timeZoneName: 'shortOffset'
        });
        
        // Create a date assuming UTC first, then calculate offset
        var utcGuess = new Date(dateStr + 'Z');
        
        // Format that UTC time in the target timezone to see what local time it maps to
        var parts = formatter.formatToParts(utcGuess);
        var tzPart = parts.find(function(p) { return p.type === 'timeZoneName'; });
        
        // Parse offset from something like "GMT-6" or "GMT-5"
        if (tzPart && tzPart.value) {
            var offsetMatch = tzPart.value.match(/GMT([+-]?\d+):?(\d+)?/);
            if (offsetMatch) {
                var offHours = parseInt(offsetMatch[1]);
                var offMins = offsetMatch[2] ? parseInt(offsetMatch[2]) : 0;
                var totalOffsetMs = (offHours * 60 + (offHours < 0 ? -offMins : offMins)) * 60000;
                
                // Local time = UTC + offset, so UTC = Local - offset
                var localMs = new Date(dateStr).getTime(); // parsed as local-ish
                // Actually, let's use a more reliable method:
                var targetLocal = new Date(year, localDate.getMonth(), localDate.getDate(), hours, minutes, 0);
                var zuluMs = targetLocal.getTime() - totalOffsetMs;
                return new Date(zuluMs);
            }
        }
    } catch (e) {
        console.warn('[TZ] Intl offset detection failed:', e.message);
    }

    // Simpler fallback: use Intl to compare times
    return localToZuluFallback(militaryTime, localDate, timezone);
}

// Fallback Zulu conversion using iterative approach
function localToZuluFallback(militaryTime, localDate, timezone) {
    var hours = parseInt(militaryTime.substring(0, 2));
    var minutes = parseInt(militaryTime.substring(2, 4));
    
    // Start with a rough UTC guess (assume Central = UTC-6)
    var rough = new Date(Date.UTC(
        localDate.getFullYear(),
        localDate.getMonth(),
        localDate.getDate(),
        hours + 6, minutes, 0
    ));
    
    // Use Intl to see what local time this UTC time corresponds to
    var localStr = rough.toLocaleString('en-US', { 
        timeZone: timezone, 
        hour: '2-digit', minute: '2-digit', hour12: false 
    });
    var localParts = localStr.split(':');
    var localH = parseInt(localParts[0]);
    var localM = parseInt(localParts[1]);
    
    // Adjust by the difference
    var diffMinutes = (hours * 60 + minutes) - (localH * 60 + localM);
    return new Date(rough.getTime() + diffMinutes * 60000);
}

// Format a Date as Zulu string: "1430Z" 
function formatZulu(zuluDate) {
    if (!zuluDate) return '----Z';
    var h = String(zuluDate.getUTCHours()).padStart(2, '0');
    var m = String(zuluDate.getUTCMinutes()).padStart(2, '0');
    return h + m + 'Z';
}

// Get timezone abbreviation for display (e.g., "CST", "EST")
function getTimezoneAbbr(timezone, date) {
    try {
        var formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            timeZoneName: 'short'
        });
        var parts = formatter.formatToParts(date || new Date());
        var tzPart = parts.find(function(p) { return p.type === 'timeZoneName'; });
        return tzPart ? tzPart.value : '';
    } catch (e) {
        return '';
    }
}


// ============================================================
// NOAA WINDS ALOFT FORECAST PERIOD SELECTION
// ============================================================
// NOAA issues winds aloft forecasts (FD/FB) with these forecast periods:
//   06hr, 12hr, 24hr
// Issued 4 times daily, valid at specific UTC hours.
//
// Logic:
//   - Departure in the past or right now → use 06 (most immediate)
//   - Calculate hours until departure
//   - 0–9 hours out   → 06
//   - 9–18 hours out  → 12
//   - 18+ hours out   → 24
//
// We use generous overlap ranges so the selected forecast 
// is the one whose valid time is closest to departure.

function selectForecastPeriod(departureZulu) {
    if (!departureZulu) return '06';
    
    var now = new Date();
    var hoursOut = (departureZulu.getTime() - now.getTime()) / 3600000;
    
    // Past or immediate — use most current forecast
    if (hoursOut <= 0) {
        return '06';
    }
    
    // Within ~9 hours — 6hr forecast is best
    if (hoursOut <= 9) {
        return '06';
    }
    
    // 9–18 hours — 12hr forecast
    if (hoursOut <= 18) {
        return '12';
    }
    
    // Beyond 18 hours — 24hr forecast (furthest available)
    return '24';
}

// Get a human-readable label for the forecast period
function getForecastLabel(period) {
    var labels = {
        '06': '6-Hour Forecast',
        '12': '12-Hour Forecast',
        '24': '24-Hour Forecast'
    };
    return labels[period] || period;
}

// Full departure info object — call this after user picks day + time
// Returns { zuluTime, zuluString, localAbbr, forecastPeriod, forecastLabel, hoursOut }
function computeDepartureInfo(militaryTime, selectedDate, timezone) {
    var zuluTime = localToZulu(militaryTime, selectedDate, timezone);
    var forecastPeriod = selectForecastPeriod(zuluTime);
    var now = new Date();
    var hoursOut = zuluTime ? Math.max(0, (zuluTime.getTime() - now.getTime()) / 3600000) : 0;
    
    return {
        zuluTime: zuluTime,
        zuluString: formatZulu(zuluTime),
        localAbbr: getTimezoneAbbr(timezone, selectedDate),
        forecastPeriod: forecastPeriod,
        forecastLabel: getForecastLabel(forecastPeriod),
        hoursOut: Math.round(hoursOut * 10) / 10,
        isPast: hoursOut <= 0
    };
}
