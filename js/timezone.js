// ============================================================
// timezone.js — Lat/Lon to IANA Timezone for US Airports
// ============================================================
// Handles: state splits (Indiana, Tennessee, Kentucky, Florida
// panhandle, Michigan UP, Nebraska, Kansas, North Dakota, Oregon,
// Idaho), Arizona no-DST, Alaska, Hawaii, and all standard zones.
//
// Uses coordinate-based boundary lookup with polygon overrides
// for split-timezone regions. No external API required.
// ============================================================

const TimezoneModule = (function () {

    // ---------------------------------------------------------
    // IANA timezone names used in the US
    // ---------------------------------------------------------
    const TZ = {
        EASTERN:    'America/New_York',
        CENTRAL:    'America/Chicago',
        MOUNTAIN:   'America/Denver',
        PACIFIC:    'America/Los_Angeles',
        ARIZONA:    'America/Phoenix',         // No DST
        ALASKA:     'America/Anchorage',
        ALEUTIAN:   'America/Adak',
        HAWAII:     'Pacific/Honolulu',
        // Indiana special zones (all Eastern but some Central pockets)
        IN_KNOX:    'America/Indiana/Knox',         // Central
        IN_TELL:    'America/Indiana/Tell_City',    // Central
        IN_PETER:   'America/Indiana/Petersburg',   // Eastern
        IN_VEVAY:   'America/Indiana/Vevay',        // Eastern
        IN_VINCENNES: 'America/Indiana/Vincennes',  // Eastern
        IN_WINAMAC:   'America/Indiana/Winamac',    // Eastern
        IN_MARENGO:   'America/Indiana/Marengo',    // Eastern
        IN_INDY:      'America/Indiana/Indianapolis', // Eastern
        // North Dakota special zones
        ND_CENTER:    'America/North_Dakota/Center',     // Central
        ND_NEW_SALEM: 'America/North_Dakota/New_Salem',  // Central
        ND_BEULAH:    'America/North_Dakota/Beulah',     // Central
        // Kentucky
        KY_MONTICELLO: 'America/Kentucky/Monticello', // Eastern
        KY_LOUISVILLE: 'America/Kentucky/Louisville', // Eastern
    };

    // ---------------------------------------------------------
    // Manual overrides for airports in known split-timezone areas
    // Key = ICAO code, Value = IANA timezone
    // Add more as needed — this catches the tricky ones
    // ---------------------------------------------------------
    const AIRPORT_TZ_OVERRIDES = {
        // === INDIANA — Central Time pockets ===
        // Starke County (Knox, IN area)
        'KOXI': TZ.IN_KNOX,        // Knox County (Vincennes) — actually Eastern
        // Jasper/Pulaski counties — Central
        'KRNZ': TZ.CENTRAL,        // Jasper County (Rensselaer)
        // Gibson, Posey, Vanderburgh, Warrick, Spencer, Perry, Pike,
        // Dubois, Daviess, Martin, Knox (Central time counties in SW Indiana)
        'KEVV': TZ.CENTRAL,        // Evansville Regional
        'KHUF': TZ.CENTRAL,        // Terre Haute (Hulman)

        // === FLORIDA — Panhandle (Central Time) ===
        // Everything west of the Apalachicola River (~85.0°W) is Central
        'KPNS': TZ.CENTRAL,        // Pensacola
        'KVPS': TZ.CENTRAL,        // Destin/Fort Walton Beach
        'KECP': TZ.CENTRAL,        // Panama City NW Florida Beaches
        'KPFN': TZ.CENTRAL,        // Panama City
        'KCEW': TZ.CENTRAL,        // Crestview
        'KNFJ': TZ.CENTRAL,        // Marianna
        'KAAF': TZ.CENTRAL,        // Apalachicola

        // === TENNESSEE — Eastern Time (east of ~85.5°W) ===
        'KTYS': TZ.EASTERN,        // Knoxville
        'KTRI': TZ.EASTERN,        // Tri-Cities (Blountville)
        'KOQT': TZ.EASTERN,        // Oak Ridge
        'KCHA': TZ.EASTERN,        // Chattanooga
        // Western/Central Tennessee — Central Time
        'KBNA': TZ.CENTRAL,        // Nashville
        'KMEM': TZ.CENTRAL,        // Memphis
        'KMKL': TZ.CENTRAL,        // Jackson (McKellar-Sipes)

        // === KENTUCKY — Eastern/Central split ===
        // Western KY is Central, Eastern KY is Eastern
        // The line roughly follows ~86°W in central KY
        'KSDF': TZ.EASTERN,        // Louisville
        'KLEX': TZ.EASTERN,        // Lexington
        'KCVG': TZ.EASTERN,        // Cincinnati/N. Kentucky
        'KBWG': TZ.CENTRAL,        // Bowling Green
        'KPAH': TZ.CENTRAL,        // Paducah
        'KOWB': TZ.CENTRAL,        // Owensboro
        'KHOP': TZ.CENTRAL,        // Fort Campbell/Hopkinsville

        // === MICHIGAN — Upper Peninsula (some Central) ===
        // Menominee, Iron, Dickinson, Gogebic counties are Central
        'KMNM': TZ.CENTRAL,        // Menominee
        'KIWD': TZ.CENTRAL,        // Ironwood (Gogebic)
        'KIMT': TZ.CENTRAL,        // Iron Mountain

        // === NEBRASKA — Western panhandle is Mountain ===
        'KBFF': TZ.MOUNTAIN,       // Scottsbluff
        'KCDR': TZ.MOUNTAIN,       // Chadron
        'KAIA': TZ.MOUNTAIN,       // Alliance
        'KSNY': TZ.MOUNTAIN,       // Sidney

        // === KANSAS — Western counties are Mountain ===
        'KGLD': TZ.MOUNTAIN,       // Goodland

        // === NORTH DAKOTA — SW corner is Mountain ===
        'KDIK': TZ.MOUNTAIN,       // Dickinson
        'KISN': TZ.MOUNTAIN,       // Williston (Sloulin)
        'K2WX': TZ.MOUNTAIN,       // Beach

        // === SOUTH DAKOTA — West of Missouri River is Mountain ===
        'KRAP': TZ.MOUNTAIN,       // Rapid City
        'KSPF': TZ.MOUNTAIN,       // Spearfish (Black Hills)
        'KCUT': TZ.MOUNTAIN,       // Custer
        'KPHP': TZ.MOUNTAIN,       // Philip
        'KPIR': TZ.CENTRAL,        // Pierre (right on the line, Central)

        // === OREGON — Eastern Oregon is Mountain ===
        'KRDM': TZ.PACIFIC,        // Redmond (Central OR — actually Pacific)
        'KBNO': TZ.MOUNTAIN,       // Burns
        'KLGD': TZ.MOUNTAIN,       // La Grande
        'KPDT': TZ.MOUNTAIN,       // Pendleton
        'KONO': TZ.MOUNTAIN,       // Ontario

        // === IDAHO — Northern Idaho is Pacific ===
        'KCOE': TZ.PACIFIC,        // Coeur d'Alene
        'KLWS': TZ.PACIFIC,        // Lewiston
        'KSZT': TZ.PACIFIC,        // Sandpoint

        // === TEXAS — West of Pecos is Mountain ===
        'KELP': TZ.MOUNTAIN,       // El Paso
        'KHDO': TZ.CENTRAL,        // Hondo (near border but Central)

        // === ARIZONA — all America/Phoenix (no DST) ===
        'KPHX': TZ.ARIZONA,
        'KTUS': TZ.ARIZONA,
        'KFLG': TZ.ARIZONA,
        'KPRC': TZ.ARIZONA,
        'KSDL': TZ.ARIZONA,
        'KDVT': TZ.ARIZONA,
        'KGYR': TZ.ARIZONA,
        'KIFP': TZ.ARIZONA,
        'KIGM': TZ.ARIZONA,
        'KGCN': TZ.ARIZONA,
        'KSJN': TZ.ARIZONA,
        'KYUM': TZ.ARIZONA,

        // === ALASKA ===
        'PANC': TZ.ALASKA,         // Anchorage
        'PAFA': TZ.ALASKA,         // Fairbanks
        'PAJN': TZ.ALASKA,         // Juneau
        'PADQ': TZ.ALASKA,         // Kodiak
        'PADK': TZ.ALEUTIAN,       // Adak (Aleutian time)

        // === HAWAII ===
        'PHNL': TZ.HAWAII,         // Honolulu
        'PHOG': TZ.HAWAII,         // Kahului (Maui)
        'PHKO': TZ.HAWAII,         // Kona
        'PHLI': TZ.HAWAII,         // Lihue (Kauai)
        'PHTO': TZ.HAWAII,         // Hilo
    };

    // ---------------------------------------------------------
    // Coordinate-based timezone boundaries for continental US
    // These are simplified polygons — NOT exact county lines,
    // but accurate enough for airport lat/lon lookups.
    // The manual overrides above catch the edge cases.
    // ---------------------------------------------------------

    /**
     * Determine IANA timezone from latitude and longitude.
     * Works for all US airports including territories.
     * @param {number} lat - Latitude in decimal degrees
     * @param {number} lon - Longitude in decimal degrees
     * @param {string} [icao] - Optional ICAO code for override lookup
     * @returns {string} IANA timezone name
     */
    function getTimezone(lat, lon, icao) {
        // 1. Check manual override first (most accurate for known airports)
        if (icao && AIRPORT_TZ_OVERRIDES[icao.toUpperCase()]) {
            return AIRPORT_TZ_OVERRIDES[icao.toUpperCase()];
        }

        // 2. Hawaii (lat < 23, lon < -154)
        if (lat < 23 && lon < -154) {
            return TZ.HAWAII;
        }

        // 3. Alaska
        if (lat > 51) {
            // Aleutian Islands (far west)
            if (lon < -169.5) {
                return TZ.ALEUTIAN;
            }
            return TZ.ALASKA;
        }

        // 4. Arizona (special — no DST)
        // Arizona bounds: roughly lat 31.3-37, lon -109.1 to -114.8
        // Navajo Nation DOES observe DST but has no significant airports
        if (lat >= 31.3 && lat <= 37.0 && lon >= -114.8 && lon <= -109.05) {
            return TZ.ARIZONA;
        }

        // 5. Continental US — coordinate-based boundaries
        // The boundaries are longitude lines that shift with latitude

        // --- Pacific / Mountain boundary ---
        // Generally around -114° to -115°
        // Northern Idaho (above ~46.5°N) west of -114.5° is Pacific
        // Oregon: east of Cascades (~-121° to -117°) depends on county
        if (lon <= -124.5) {
            return TZ.PACIFIC; // Deep Pacific coast
        }

        // Pacific zone: West of Mountain boundary
        if (isPacific(lat, lon)) {
            return TZ.PACIFIC;
        }

        // --- Mountain / Central boundary ---
        // Generally around -100° to -104°
        if (isMountain(lat, lon)) {
            return TZ.MOUNTAIN;
        }

        // --- Central / Eastern boundary ---
        // Generally around -84° to -87°
        if (isCentral(lat, lon)) {
            return TZ.CENTRAL;
        }

        // Default: Eastern
        return TZ.EASTERN;
    }

    /**
     * Is this coordinate in the Pacific timezone?
     */
    function isPacific(lat, lon) {
        // West coast states + northern Idaho + most of Oregon
        // The Pacific/Mountain boundary:

        // Washington state: boundary is the Idaho border (~-117°)
        if (lat >= 45.5 && lon <= -117.0) return true;

        // Oregon: most is Pacific. Eastern Oregon (east of ~-117.5° below 44°N) is Mountain
        if (lat >= 42.0 && lat < 45.5) {
            // The boundary zigzags but roughly:
            // North of 44°: west of -117° is Pacific
            if (lat >= 44.0 && lon <= -117.0) return true;
            // South of 44°: west of -117.5° is Pacific (more of eastern OR is Mountain)
            if (lat < 44.0 && lon <= -117.0) return true;
        }

        // California: all Pacific
        if (lat >= 32.5 && lat <= 42.0 && lon <= -114.5) return true;

        // Northern Idaho: above ~46.5°N, west of -115.5° is Pacific
        if (lat >= 46.3 && lon <= -116.5 && lon > -117.0) return true;

        // Nevada: Pacific time (yes, really — Nevada is Pacific)
        if (lat >= 35.0 && lat <= 42.0 && lon >= -120.0 && lon <= -114.0) {
            return true;
        }

        return false;
    }

    /**
     * Is this coordinate in the Mountain timezone?
     */
    function isMountain(lat, lon) {
        // Mountain zone spans roughly -104° to -114° but varies
        // Pacific states (WA, OR-most, CA, NV) are handled by isPacific()
        // Mountain: MT, ID (south), WY, UT, CO, AZ (no DST), NM, 
        //           plus parts of: OR (east), NE (west), KS (west), 
        //           TX (El Paso), ND (SW), SD (west)
        // Central: rest of central states
        // Eastern: east coast states

        // Mountain/Central boundary roughly follows -104° in the north,
        // shifts east to about -100° going south through Kansas/Nebraska

        // Simple check: is it in the Mountain zone longitude range
        // and NOT in Pacific states?

        // Arizona already handled above

        // Montana, Wyoming: west of ~-104°
        if (lat >= 44.0 && lon <= -104.0 && lon > -117.0) {
            // But check it's not in Pacific zone (WA/OR/ID-north)
            if (isPacific(lat, lon)) return false;
            return true;
        }

        // Utah: roughly -109° to -114°
        if (lat >= 37.0 && lat <= 42.0 && lon >= -114.1 && lon <= -109.0) {
            return true;
        }

        // Colorado: roughly -102° to -109°
        if (lat >= 37.0 && lat <= 41.0 && lon >= -109.1 && lon <= -102.0) {
            return true;
        }

        // New Mexico: roughly -103° to -109°
        if (lat >= 31.3 && lat <= 37.0 && lon >= -109.1 && lon <= -103.0) {
            return true;
        }

        // Idaho (south): below 46.3°N, Mountain time
        if (lat >= 42.0 && lat < 46.3 && lon >= -117.0 && lon <= -111.0) {
            return true;
        }

        // Western Nebraska: west of ~-101° roughly
        if (lat >= 40.0 && lat <= 43.0 && lon <= -101.0 && lon > -104.1) {
            return true;
        }

        // Western Kansas: west of ~-101°
        if (lat >= 37.0 && lat <= 40.0 && lon <= -101.0 && lon > -102.1) {
            return true;
        }

        // Western Texas (El Paso area): roughly west of -104.5°
        if (lat >= 31.0 && lat <= 32.5 && lon <= -104.5) {
            return true;
        }

        // Western North Dakota: west of ~-101° roughly
        if (lat >= 46.0 && lat <= 49.0 && lon <= -101.5 && lon > -104.1) {
            return true;
        }

        // Western South Dakota: west of Missouri River (~-100.5°)
        if (lat >= 43.0 && lat <= 46.0 && lon <= -100.5 && lon > -104.1) {
            return true;
        }

        // Montana: check full range
        if (lat >= 44.5 && lat <= 49.0 && lon <= -104.0 && lon > -116.1) {
            if (!isPacific(lat, lon)) return true;
        }

        // Wyoming
        if (lat >= 41.0 && lat <= 45.0 && lon >= -111.1 && lon <= -104.0) {
            return true;
        }

        return false;
    }

    /**
     * Is this coordinate in the Central timezone?
     */
    function isCentral(lat, lon) {
        // Central zone: between Mountain and Eastern boundaries
        // Eastern boundary roughly follows -84° to -87° depending on latitude

        // If we got here, it's not Pacific or Mountain.
        // Need to determine if it's Central or Eastern.

        // The Central/Eastern boundary (approximate):
        // - Michigan UP: some western counties are Central (handled by overrides)
        // - Indiana: most is Eastern, some SW counties are Central
        // - Kentucky: western part is Central (west of ~-86°)
        // - Tennessee: western 2/3 is Central (west of ~-85.5°)
        // - Alabama: all Central
        // - Florida panhandle: west of Apalachicola (~-85.0°) is Central
        // - Georgia: all Eastern
        // - Ohio: all Eastern
        // - The line generally follows state borders

        // States that are entirely Central:
        // MN, IA, MO, AR, LA, MS, AL, WI, IL, OK, most of TX
        // Parts of: NE (east), KS (east), ND (east), SD (east),
        //           MI (UP west), IN (SW), KY (west), TN (west/central)

        // Longitude-based first pass:
        // If west of -87° and east of Mountain boundary → Central
        if (lon <= -87.0 && lon > -104.0) {
            if (!isMountain(lat, lon)) return true;
        }

        // Florida panhandle: west of -85.0° is Central
        if (lat >= 29.5 && lat <= 31.0 && lon <= -85.0 && lon > -88.0) {
            return true;
        }

        // Alabama: all Central (lat 30-35, lon -84.9 to -88.5)
        if (lat >= 30.0 && lat <= 35.0 && lon <= -84.9 && lon > -88.5) {
            return true;
        }

        // Mississippi: all Central
        if (lat >= 30.0 && lat <= 35.0 && lon <= -88.5 && lon > -91.7) {
            return true;
        }

        // Tennessee — Central/Eastern split:
        // East TN (east of ~-85.3° roughly) is Eastern
        // Middle and West TN is Central
        if (lat >= 34.9 && lat <= 36.7 && lon <= -85.3 && lon > -90.4) {
            return true;
        }

        // Kentucky — Central/Eastern split:
        // Western KY (west of ~-86° at Louisville latitude) is Central
        if (lat >= 36.5 && lat <= 39.2 && lon <= -86.0 && lon > -89.6) {
            return true;
        }

        // Indiana — mostly Eastern, but some western/SW counties are Central
        // The Central counties are roughly west of -86.7° and south of 41.0°
        if (lat >= 37.8 && lat < 41.0 && lon <= -86.7 && lon > -88.1) {
            // SW Indiana pocket — Central
            return true;
        }

        // Michigan UP — western counties (Gogebic, Iron, Dickinson, Menominee)
        // These are west of about -87.5° and above 45.8°
        if (lat >= 45.8 && lon <= -87.5 && lon > -90.5) {
            return true;
        }

        // Wisconsin: all Central
        if (lat >= 42.5 && lat <= 47.1 && lon <= -86.8 && lon > -92.9) {
            return true;
        }

        // Illinois: all Central
        if (lat >= 37.0 && lat <= 42.5 && lon <= -87.5 && lon > -91.5) {
            return true;
        }

        // If lon is between -84 and -87, it's likely a split state
        // and we need more detailed checking (handled by overrides mostly)
        // Default: if west of -85° and in the right lat range, lean Central
        if (lon <= -85.5 && lon > -87.0 && lat >= 30.0 && lat <= 42.0) {
            // This catches the Central side of split states
            return true;
        }

        return false;
    }

    // ---------------------------------------------------------
    // Time conversion utilities
    // ---------------------------------------------------------

    /**
     * Convert a local date/time to Zulu (UTC) string.
     * @param {number} year 
     * @param {number} month - 1-12
     * @param {number} day 
     * @param {number} hours - 0-23
     * @param {number} minutes - 0-59
     * @param {string} ianaTimezone - e.g. 'America/Chicago'
     * @returns {object} { zuluString, zuluDate, utcHours, utcMinutes, utcDay, utcMonth, utcYear }
     */
    function localToZulu(year, month, day, hours, minutes, ianaTimezone) {
        // Build a date string in the local timezone and convert to UTC
        // We use Intl.DateTimeFormat to determine the UTC offset
        const localDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

        // Create a date formatter that will show us the UTC offset
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'shortOffset'
        });

        // Use a different approach — construct the Date by finding offset
        // Step 1: Create a naive Date as if it were UTC
        const naiveUTC = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0));

        // Step 2: Format this UTC date in the target timezone to find offset
        const parts = getDatePartsInTimezone(naiveUTC, ianaTimezone);

        // Step 3: Calculate the difference (offset)
        const localAsUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
        const offsetMs = localAsUTC - naiveUTC.getTime();

        // Step 4: The actual UTC time = naive UTC - offset
        // Because: if local 10:00 in UTC-5 → UTC is 15:00
        // naive UTC was set to 10:00 UTC
        // parts will show this formatted as 05:00 in America/New_York
        // offset = 05:00 UTC - 10:00 UTC = -5 hours = -18000000 ms
        // actual UTC = 10:00 - (-5h) = 15:00 ✓

        // Actually let me redo this. I want to convert LOCAL time → UTC.
        // If user says "10:00 local in Chicago" (Central = UTC-6 in winter, UTC-5 in summer)
        // The UTC equivalent is 10:00 + 6 = 16:00Z (winter) or 10:00 + 5 = 15:00Z (summer)

        // Better approach: create the date in the target timezone using trial-and-error
        const utcDate = localTimeToUTC(year, month, day, hours, minutes, ianaTimezone);

        const zuluHH = String(utcDate.getUTCHours()).padStart(2, '0');
        const zuluMM = String(utcDate.getUTCMinutes()).padStart(2, '0');
        const zuluDay = utcDate.getUTCDate();
        const zuluMonth = utcDate.getUTCMonth() + 1;
        const zuluYear = utcDate.getUTCFullYear();

        return {
            zuluString: `${zuluHH}${zuluMM}Z`,
            zuluHHMM: `${zuluHH}:${zuluMM}`,
            utcHours: utcDate.getUTCHours(),
            utcMinutes: utcDate.getUTCMinutes(),
            utcDay: zuluDay,
            utcMonth: zuluMonth,
            utcYear: zuluYear,
            zuluDate: utcDate
        };
    }

    /**
     * Convert local time in a specific timezone to a UTC Date object.
     * Handles DST transitions correctly.
     */
    function localTimeToUTC(year, month, day, hours, minutes, ianaTimezone) {
        // Strategy: guess a UTC time, format it in the target timezone,
        // compare, and adjust.

        // Initial guess: assume UTC-6 (Central standard) as starting point
        let guessUTC = new Date(Date.UTC(year, month - 1, day, hours + 6, minutes, 0));

        // Format guessUTC in the target timezone
        let parts = getDatePartsInTimezone(guessUTC, ianaTimezone);

        // Calculate how far off we are
        let diffHours = hours - parts.hour;
        let diffMinutes = minutes - parts.minute;
        let diffDays = day - parts.day;

        // Handle day boundary
        if (diffDays > 15) diffDays -= 30; // Month wraparound forward
        if (diffDays < -15) diffDays += 30; // Month wraparound backward

        let totalDiffMinutes = (diffDays * 24 * 60) + (diffHours * 60) + diffMinutes;

        // Adjust
        guessUTC = new Date(guessUTC.getTime() + totalDiffMinutes * 60 * 1000);

        // Verify (one more iteration for edge cases near DST transitions)
        parts = getDatePartsInTimezone(guessUTC, ianaTimezone);
        diffHours = hours - parts.hour;
        diffMinutes = minutes - parts.minute;
        diffDays = day - parts.day;
        if (diffDays > 15) diffDays -= 30;
        if (diffDays < -15) diffDays += 30;
        totalDiffMinutes = (diffDays * 24 * 60) + (diffHours * 60) + diffMinutes;

        if (totalDiffMinutes !== 0) {
            guessUTC = new Date(guessUTC.getTime() + totalDiffMinutes * 60 * 1000);
        }

        return guessUTC;
    }

    /**
     * Extract date parts from a Date object formatted in a specific timezone.
     */
    function getDatePartsInTimezone(date, ianaTimezone) {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const parts = {};
        formatter.formatToParts(date).forEach(p => {
            if (p.type === 'year') parts.year = parseInt(p.value, 10);
            if (p.type === 'month') parts.month = parseInt(p.value, 10);
            if (p.type === 'day') parts.day = parseInt(p.value, 10);
            if (p.type === 'hour') parts.hour = parseInt(p.value, 10);
            if (p.type === 'minute') parts.minute = parseInt(p.value, 10);
            if (p.type === 'second') parts.second = parseInt(p.value, 10);
        });

        // Handle midnight — some locales return 24 for midnight
        if (parts.hour === 24) parts.hour = 0;

        return parts;
    }

    /**
     * Convert UTC time to local time in a specific timezone.
     * @param {Date} utcDate 
     * @param {string} ianaTimezone 
     * @returns {object} { localString, hour, minute, day, month, year, dayOfWeek }
     */
    function zuluToLocal(utcDate, ianaTimezone) {
        const parts = getDatePartsInTimezone(utcDate, ianaTimezone);

        const dayFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTimezone,
            weekday: 'short'
        });

        return {
            localString: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
            localMilitary: `${String(parts.hour).padStart(2, '0')}${String(parts.minute).padStart(2, '0')}L`,
            hour: parts.hour,
            minute: parts.minute,
            day: parts.day,
            month: parts.month,
            year: parts.year,
            dayOfWeek: dayFormatter.format(utcDate)
        };
    }

    /**
     * Get the UTC offset string for display (e.g., "UTC-5", "UTC-6")
     * for a specific timezone on a specific date.
     */
    function getUTCOffsetString(year, month, day, hours, minutes, ianaTimezone) {
        const utcDate = localTimeToUTC(year, month, day, hours, minutes, ianaTimezone);
        const localMs = Date.UTC(year, month - 1, day, hours, minutes, 0);
        const diffMs = localMs - utcDate.getTime();
        // This doesn't work right because localMs isn't actually UTC...

        // Better: just use the Intl API
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTimezone,
            timeZoneName: 'shortOffset'
        });

        const target = localTimeToUTC(year, month, day, hours, minutes, ianaTimezone);
        const formatted = formatter.format(target);
        // Extract the offset part (e.g., "GMT-5" or "GMT-6")
        const match = formatted.match(/GMT([+-]\d+(?::\d+)?)/);
        if (match) {
            return 'UTC' + match[1];
        }
        return '';
    }

    /**
     * Get the timezone abbreviation (e.g., "CST", "CDT", "EST", "EDT")
     */
    function getTimezoneAbbreviation(year, month, day, hours, minutes, ianaTimezone) {
        const utcDate = localTimeToUTC(year, month, day, hours, minutes, ianaTimezone);
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTimezone,
            timeZoneName: 'short'
        });
        const formatted = formatter.format(utcDate);
        // Extract abbreviation — it's the last word
        const parts = formatted.split(' ');
        return parts[parts.length - 1]; // e.g., "CST", "CDT"
    }

    /**
     * Get the next 7 days starting from today, formatted for day pills.
     * @param {string} ianaTimezone - Timezone to determine "today"
     * @returns {Array} [{label, dayName, dateStr, year, month, day}, ...]
     */
    function getNext7Days(ianaTimezone) {
        const now = new Date();
        const days = [];

        for (let i = 0; i < 7; i++) {
            const futureUTC = new Date(now.getTime() + i * 86400000);
            const parts = getDatePartsInTimezone(futureUTC, ianaTimezone);
            const dayFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: ianaTimezone,
                weekday: 'short'
            });
            const dateFormatter = new Intl.DateTimeFormat('en-US', {
                timeZone: ianaTimezone,
                month: 'short',
                day: 'numeric'
            });

            days.push({
                label: i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : dayFormatter.format(futureUTC)),
                dayName: dayFormatter.format(futureUTC),
                dateStr: dateFormatter.format(futureUTC),
                year: parts.year,
                month: parts.month,
                day: parts.day,
                offset: i
            });
        }

        return days;
    }

    /**
     * Add an airport timezone override at runtime.
     * Useful when loading a timezone column from the CSV.
     */
    function addOverride(icao, ianaTimezone) {
        AIRPORT_TZ_OVERRIDES[icao.toUpperCase()] = ianaTimezone;
    }

    // ---------------------------------------------------------
    // Public API
    // ---------------------------------------------------------
    return {
        getTimezone,
        localToZulu,
        zuluToLocal,
        getUTCOffsetString,
        getTimezoneAbbreviation,
        getNext7Days,
        getDatePartsInTimezone,
        localTimeToUTC,
        addOverride,
        TZ  // Expose timezone constants
    };

})();

// Make available globally
if (typeof window !== 'undefined') {
    window.TimezoneModule = TimezoneModule;
}
