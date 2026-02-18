// ============================================================
// departure-time.js — Departure Time Input + Zulu + Day Pills
// ============================================================
// Requires: timezone.js (TimezoneModule) loaded first
//
// Provides:
//   - Local military time input (24-hour format)
//   - Automatic Zulu conversion display
//   - Day-of-week pill selector (today + 6 days)
//   - Updates when departure airport changes
//
// Usage:
//   DepartureTime.init()          — call once after DOM is ready
//   DepartureTime.setAirport(apt) — call when departure airport changes
//   DepartureTime.getZuluTime()   — returns { zuluString, zuluDate, ... }
//   DepartureTime.getLocalTime()  — returns { hours, minutes, year, month, day }
//   DepartureTime.getDepartureDate() — returns selected date {year, month, day}
// ============================================================

const DepartureTime = (function () {

    // State
    let currentAirport = null;   // { icao, lat, lon, name, ... }
    let currentTimezone = null;  // IANA timezone string
    let selectedDayOffset = 0;   // 0 = today, 1 = tomorrow, etc.

    /**
     * Parse a 4-digit military time string (e.g. "1430", "0200", "2359").
     * Returns { hours, minutes } or null if invalid.
     */
    function parseMilitaryTime(val) {
        if (!val) return null;
        // Strip anything that's not a digit
        var digits = val.replace(/\D/g, '');
        if (digits.length !== 4) return null;
        var h = parseInt(digits.substring(0, 2), 10);
        var m = parseInt(digits.substring(2, 4), 10);
        if (h < 0 || h > 23 || m < 0 || m > 59) return null;
        return { hours: h, minutes: m };
    }

    /**
     * Initialize the departure time UI.
     * Call once after the DOM elements exist.
     */
    function init() {
        const timeInput = document.getElementById('departure-time-input');
        const dayPillsContainer = document.getElementById('day-pills');

        if (!timeInput) {
            console.warn('DepartureTime: #departure-time-input not found in DOM');
            return;
        }

        // Set default time to current local time (rounded to next 30 min)
        setDefaultTime();

        // Listen for time input changes
        timeInput.addEventListener('input', function() {
            // Strip non-digits, enforce max 4 chars
            var clean = timeInput.value.replace(/\D/g, '');
            if (clean.length > 4) clean = clean.substring(0, 4);
            if (clean !== timeInput.value) timeInput.value = clean;
            onTimeChange();
        });
        timeInput.addEventListener('change', onTimeChange);

        // Build initial day pills (uses browser's local timezone until airport is set)
        buildDayPills();

        // Initial Zulu conversion
        updateZuluDisplay();
    }

    /**
     * Set the departure airport. Call this whenever the user changes
     * the departure airport. Updates timezone and recalculates Zulu.
     * @param {object} airport - { icao, lat, lon, name, ... }
     */
    function setAirport(airport) {
        if (!airport || !airport.lat || !airport.lon) {
            console.warn('DepartureTime.setAirport: invalid airport data');
            return;
        }

        currentAirport = airport;

        // Look up timezone from coordinates
        const icao = airport.icao || airport.ident || '';
        currentTimezone = TimezoneModule.getTimezone(
            parseFloat(airport.lat),
            parseFloat(airport.lon),
            icao
        );

        // Update the timezone label
        updateTimezoneLabel();

        // Rebuild day pills in the airport's timezone
        buildDayPills();

        // Recalculate Zulu
        updateZuluDisplay();
    }

    /**
     * Set the default departure time to the nearest future 30-min mark.
     */
    function setDefaultTime() {
        const now = new Date();
        let h = now.getHours();
        let m = now.getMinutes();

        // Round up to next 30 minutes + 1 hour buffer
        if (m < 30) {
            m = 30;
        } else {
            m = 0;
            h += 1;
        }
        h += 1; // Add 1-hour planning buffer

        if (h >= 24) h -= 24;

        const timeInput = document.getElementById('departure-time-input');
        if (timeInput) {
            timeInput.value = String(h).padStart(2, '0') + String(m).padStart(2, '0');
        }
    }

    /**
     * Build the day-of-week pill buttons.
     */
    function buildDayPills() {
        const container = document.getElementById('day-pills');
        if (!container) return;

        // Use departure airport timezone or browser timezone
        const tz = currentTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const days = TimezoneModule.getNext7Days(tz);

        container.innerHTML = '';

        days.forEach((dayInfo, index) => {
            const pill = document.createElement('button');
            pill.className = 'day-pill' + (index === selectedDayOffset ? ' active' : '');
            pill.setAttribute('data-offset', index);

            // Two-line pill: day name on top, date below
            pill.innerHTML = `<span class="pill-label">${dayInfo.label}</span><span class="pill-date">${dayInfo.dateStr}</span>`;

            pill.addEventListener('click', () => {
                selectDay(index);
            });

            // Touch-friendly: prevent double-tap zoom on iPad
            pill.addEventListener('touchend', (e) => {
                e.preventDefault();
                selectDay(index);
            });

            container.appendChild(pill);
        });
    }

    /**
     * Select a day pill by offset index.
     */
    function selectDay(offset) {
        selectedDayOffset = offset;

        // Update pill visual state
        const pills = document.querySelectorAll('.day-pill');
        pills.forEach((pill, i) => {
            pill.classList.toggle('active', i === offset);
        });

        // Recalculate Zulu
        updateZuluDisplay();

        // Fire custom event so app.js can react
        document.dispatchEvent(new CustomEvent('departureTimeChanged', {
            detail: getDepartureInfo()
        }));
    }

    /**
     * Handle time input changes.
     */
    function onTimeChange() {
        updateZuluDisplay();

        // Fire custom event
        document.dispatchEvent(new CustomEvent('departureTimeChanged', {
            detail: getDepartureInfo()
        }));
    }

    /**
     * Update the Zulu conversion display line.
     */
    function updateZuluDisplay() {
        const zuluLine = document.getElementById('zulu-conversion');
        const tzLabel = document.getElementById('timezone-label');
        if (!zuluLine) return;

        const timeInput = document.getElementById('departure-time-input');
        if (!timeInput || !timeInput.value) {
            zuluLine.textContent = 'Enter departure time';
            return;
        }

        const parsed = parseMilitaryTime(timeInput.value);
        if (!parsed) {
            zuluLine.textContent = timeInput.value.length < 4 ? 'Enter 4 digits (e.g. 1430)' : 'Invalid time';
            return;
        }

        const hours = parsed.hours;
        const minutes = parsed.minutes;

        // Get the selected date
        const dateInfo = getSelectedDate();

        if (!currentTimezone) {
            // No airport set yet — show time but note no timezone
            zuluLine.textContent = `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}L \u2014 select departure airport for Zulu`;
            return;
        }

        // Convert to Zulu
        const zulu = TimezoneModule.localToZulu(
            dateInfo.year, dateInfo.month, dateInfo.day,
            hours, minutes, currentTimezone
        );

        // Get timezone abbreviation (CST, CDT, EST, etc.)
        const tzAbbr = TimezoneModule.getTimezoneAbbreviation(
            dateInfo.year, dateInfo.month, dateInfo.day,
            hours, minutes, currentTimezone
        );

        const utcOffset = TimezoneModule.getUTCOffsetString(
            dateInfo.year, dateInfo.month, dateInfo.day,
            hours, minutes, currentTimezone
        );

        // Format: "1430L (CST) = 2030Z"
        const localStr = `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}L`;
        zuluLine.textContent = `${localStr} (${tzAbbr}) = ${zulu.zuluString}`;

        // Update timezone label if present
        if (tzLabel) {
            tzLabel.textContent = `${tzAbbr} (${utcOffset})`;
        }
    }

    /**
     * Update just the timezone label.
     */
    function updateTimezoneLabel() {
        const tzLabel = document.getElementById('timezone-label');
        if (!tzLabel || !currentTimezone) return;

        // Use current time for abbreviation
        const now = new Date();
        const parts = TimezoneModule.getDatePartsInTimezone(now, currentTimezone);
        const tzAbbr = TimezoneModule.getTimezoneAbbreviation(
            parts.year, parts.month, parts.day,
            parts.hour, parts.minute, currentTimezone
        );
        tzLabel.textContent = tzAbbr;
    }

    /**
     * Get the date for the selected day pill.
     */
    function getSelectedDate() {
        const tz = currentTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const days = TimezoneModule.getNext7Days(tz);

        if (selectedDayOffset < days.length) {
            return {
                year: days[selectedDayOffset].year,
                month: days[selectedDayOffset].month,
                day: days[selectedDayOffset].day
            };
        }

        // Fallback to today
        const now = new Date();
        return {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate()
        };
    }

    /**
     * Get the complete departure info for use by other modules.
     * Call this from app.js when you need the departure time/date.
     */
    function getDepartureInfo() {
        const timeInput = document.getElementById('departure-time-input');
        if (!timeInput || !timeInput.value) return null;

        const parsed = parseMilitaryTime(timeInput.value);
        if (!parsed) return null;

        const hours = parsed.hours;
        const minutes = parsed.minutes;
        const dateInfo = getSelectedDate();

        const result = {
            localHours: hours,
            localMinutes: minutes,
            localMilitary: `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}L`,
            year: dateInfo.year,
            month: dateInfo.month,
            day: dateInfo.day,
            dayOffset: selectedDayOffset,
            timezone: currentTimezone,
            airport: currentAirport
        };

        // Add Zulu conversion if timezone is known
        if (currentTimezone) {
            const zulu = TimezoneModule.localToZulu(
                dateInfo.year, dateInfo.month, dateInfo.day,
                hours, minutes, currentTimezone
            );
            result.zuluString = zulu.zuluString;
            result.zuluDate = zulu.zuluDate;
            result.zuluHours = zulu.utcHours;
            result.zuluMinutes = zulu.utcMinutes;
            result.zuluDay = zulu.utcDay;
            result.zuluMonth = zulu.utcMonth;
            result.zuluYear = zulu.utcYear;
        }

        return result;
    }

    /**
     * Get just the Zulu time components (for winds aloft fetching).
     */
    function getZuluTime() {
        const info = getDepartureInfo();
        if (!info || !info.zuluDate) return null;
        return {
            zuluString: info.zuluString,
            zuluDate: info.zuluDate,
            zuluHours: info.zuluHours,
            zuluMinutes: info.zuluMinutes,
            zuluDay: info.zuluDay,
            zuluMonth: info.zuluMonth,
            zuluYear: info.zuluYear
        };
    }

    /**
     * Get just the local time components.
     */
    function getLocalTime() {
        const info = getDepartureInfo();
        if (!info) return null;
        return {
            hours: info.localHours,
            minutes: info.localMinutes,
            military: info.localMilitary,
            year: info.year,
            month: info.month,
            day: info.day
        };
    }

    /**
     * Get just the selected departure date.
     */
    function getDepartureDate() {
        return getSelectedDate();
    }

    /**
     * Get the current timezone IANA name.
     */
    function getTimezoneIANA() {
        return currentTimezone;
    }

    /**
     * Convert a Zulu arrival time back to local for the arrival airport.
     * Useful for showing local arrival time.
     * @param {Date} zuluDate - UTC date/time of arrival
     * @param {object} arrivalAirport - { icao, lat, lon }
     * @returns {object} { localString, localMilitary, dayOfWeek, timezone }
     */
    function getArrivalLocal(zuluDate, arrivalAirport) {
        if (!arrivalAirport || !arrivalAirport.lat || !arrivalAirport.lon) return null;

        const icao = arrivalAirport.icao || arrivalAirport.ident || '';
        const arrTz = TimezoneModule.getTimezone(
            parseFloat(arrivalAirport.lat),
            parseFloat(arrivalAirport.lon),
            icao
        );

        const local = TimezoneModule.zuluToLocal(zuluDate, arrTz);

        return {
            localString: local.localString,
            localMilitary: local.localMilitary,
            dayOfWeek: local.dayOfWeek,
            timezone: arrTz,
            hour: local.hour,
            minute: local.minute
        };
    }

    // ---------------------------------------------------------
    // Public API
    // ---------------------------------------------------------
    return {
        init,
        setAirport,
        getDepartureInfo,
        getZuluTime,
        getLocalTime,
        getDepartureDate,
        getTimezoneIANA,
        getArrivalLocal,
        updateZuluDisplay,
        buildDayPills
    };

})();

// Make available globally
if (typeof window !== 'undefined') {
    window.DepartureTime = DepartureTime;
}
