// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js,
//           winds.js, gfs-winds.js, flight-calc.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    lastGfsData: null,
    selectedDay: 0,       // 0=today, 1=tomorrow, etc.
    departureTimeZ: null,  // Date object in UTC
    calculating: false
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    // Try loading CSV from relative path first, then GitHub raw
    var csvUrls = [
        'data/us-airports.csv',
        'us-airports.csv',
        'https://raw.githubusercontent.com/jburns3cfi-dotcom/tbm850-planner/main/us-airports.csv'
    ];

    tryLoadAirports(csvUrls, 0, function(err) {
        if (err) {
            updateStatus('error', 'Airport data failed to load');
            return;
        }
        updateStatus('ok', airportDB.length + ' airports loaded');
        setupAutocomplete('dep-input', 'dep-dropdown', 'dep-info', function(apt) {
            appState.departure = apt;
            checkReady();
        });
        setupAutocomplete('dest-input', 'dest-dropdown', 'dest-info', function(apt) {
            appState.destination = apt;
            checkReady();
        });

        document.getElementById('btn-calc').addEventListener('click', function() {
            runCalculation();
        });

        // Initialize day/time selectors
        initDaySelector();
        initTimeSelector();

        // Focus departure field
        document.getElementById('dep-input').focus();
    });
}

function tryLoadAirports(urls, idx, callback) {
    if (idx >= urls.length) {
        callback('All sources failed');
        return;
    }
    loadAirports(urls[idx], function(err) {
        if (err) {
            console.log('CSV source ' + idx + ' failed, trying next...');
            tryLoadAirports(urls, idx + 1, callback);
        } else {
            callback(null);
        }
    });
}


// ============================================================
// DAY & TIME SELECTORS
// ============================================================

function initDaySelector() {
    var container = document.getElementById('day-selector');
    if (!container) return;

    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var today = new Date();

    container.innerHTML = '';
    for (var i = 0; i < 7; i++) {
        var d = new Date(today);
        d.setDate(d.getDate() + i);
        var btn = document.createElement('button');
        btn.className = 'day-btn' + (i === 0 ? ' active' : '');
        btn.textContent = i === 0 ? 'Today' : (i === 1 ? 'Tmrw' : dayNames[d.getDay()]);
        btn.dataset.dayOffset = i;
        btn.addEventListener('click', function() {
            var btns = container.querySelectorAll('.day-btn');
            for (var j = 0; j < btns.length; j++) btns[j].classList.remove('active');
            this.classList.add('active');
            appState.selectedDay = parseInt(this.dataset.dayOffset);
            updateDepartureTime();
        });
        container.appendChild(btn);
    }
}

function initTimeSelector() {
    var input = document.getElementById('dep-time-local');
    if (!input) return;

    // Default to next whole hour
    var now = new Date();
    var nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    var hh = String(nextHour.getHours()).padStart(2, '0');
    var mm = '00';
    input.value = hh + mm;

    input.addEventListener('input', updateDepartureTime);
    input.addEventListener('change', updateDepartureTime);

    updateDepartureTime();
}

function updateDepartureTime() {
    var input = document.getElementById('dep-time-local');
    var zuluDisplay = document.getElementById('dep-time-zulu');
    var fcstDisplay = document.getElementById('dep-fcst-info');
    if (!input) return;

    // Parse local time
    var val = input.value.replace(/[^0-9]/g, '');
    if (val.length < 3) {
        if (zuluDisplay) zuluDisplay.textContent = '';
        return;
    }
    if (val.length === 3) val = '0' + val;

    var localHour = parseInt(val.substring(0, 2));
    var localMin = parseInt(val.substring(2, 4));
    if (localHour > 23 || localMin > 59) return;

    // Build local departure date/time
    var depDate = new Date();
    depDate.setDate(depDate.getDate() + appState.selectedDay);
    depDate.setHours(localHour, localMin, 0, 0);

    // Convert to UTC
    appState.departureTimeZ = depDate;
    var zuluHH = String(depDate.getUTCHours()).padStart(2, '0');
    var zuluMM = String(depDate.getUTCMinutes()).padStart(2, '0');

    if (zuluDisplay) {
        zuluDisplay.textContent = 'local→' + zuluHH + zuluMM + 'Z';
    }

    // Check forecast period
    if (fcstDisplay) {
        var now = new Date();
        var hoursFromNow = (depDate.getTime() - now.getTime()) / 3600000;
        if (hoursFromNow < 0) {
            fcstDisplay.textContent = 'PAST';
            fcstDisplay.className = 'fcst-info warn';
        } else if (hoursFromNow <= 12) {
            fcstDisplay.textContent = Math.round(hoursFromNow) + 'HR FCST';
            fcstDisplay.className = 'fcst-info';
        } else if (hoursFromNow <= 30) {
            fcstDisplay.textContent = Math.round(hoursFromNow) + 'HR FCST';
            fcstDisplay.className = 'fcst-info';
        } else {
            fcstDisplay.textContent = '>' + Math.round(hoursFromNow) + 'HR — BEYOND FORECAST';
            fcstDisplay.className = 'fcst-info warn';
        }
    }
}


// ============================================================
// AUTOCOMPLETE
// ============================================================

function setupAutocomplete(inputId, dropdownId, infoId, onSelect) {
    var input = document.getElementById(inputId);
    var dropdown = document.getElementById(dropdownId);
    var info = document.getElementById(infoId);
    var selectedIdx = -1;

    input.addEventListener('input', function() {
        var query = input.value.trim();
        info.textContent = '';
        info.className = 'airport-info';
        onSelect(null);

        if (query.length < 2) {
            dropdown.classList.remove('active');
            return;
        }

        var results = searchAirports(query, 8);
        if (results.length === 0) {
            dropdown.classList.remove('active');
            return;
        }

        renderDropdown(dropdown, results, function(apt) {
            input.value = apt.ident;
            info.textContent = formatAirport(apt);
            info.className = 'airport-info valid';
            dropdown.classList.remove('active');
            onSelect(apt);
        });
        selectedIdx = -1;
        dropdown.classList.add('active');
    });

    // Keyboard navigation
    input.addEventListener('keydown', function(e) {
        if (!dropdown.classList.contains('active')) return;
        var items = dropdown.querySelectorAll('.autocomplete-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
            updateSelection(items, selectedIdx);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIdx = Math.max(selectedIdx - 1, 0);
            updateSelection(items, selectedIdx);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (selectedIdx >= 0 && selectedIdx < items.length) {
                items[selectedIdx].click();
            } else if (items.length === 1) {
                items[0].click();
            }
        } else if (e.key === 'Escape') {
            dropdown.classList.remove('active');
        }
    });

    // Close on outside tap
    document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('active');
        }
    });

    // Also try exact match on blur (user typed full code and tabbed away)
    input.addEventListener('blur', function() {
        setTimeout(function() {
            if (appState.departure && inputId === 'dep-input') return;
            if (appState.destination && inputId === 'dest-input') return;
            var apt = getAirport(input.value);
            if (apt) {
                input.value = apt.ident;
                info.textContent = formatAirport(apt);
                info.className = 'airport-info valid';
                onSelect(apt);
                dropdown.classList.remove('active');
            }
        }, 200);
    });
}

function renderDropdown(dropdown, airports, onPick) {
    dropdown.innerHTML = '';
    for (var i = 0; i < airports.length; i++) {
        var apt = airports[i];
        var item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML =
            '<span class="apt-code">' + escHTML(apt.ident) + '</span> ' +
            '<span class="apt-name">' + escHTML(apt.name) + '</span><br>' +
            '<span class="apt-detail">' +
                escHTML(apt.municipality || '') +
                (apt.region ? ', ' + escHTML(apt.region.replace('US-', '')) : '') +
                ' | ' + apt.elevation + 'ft' +
            '</span>';
        (function(a) {
            item.addEventListener('click', function() { onPick(a); });
        })(apt);
        dropdown.appendChild(item);
    }
}

function updateSelection(items, idx) {
    for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('selected', i === idx);
    }
}

function escHTML(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

function formatAirport(apt) {
    return apt.ident + ' - ' + apt.name +
        (apt.municipality ? ' (' + apt.municipality + ', ' + (apt.region || '').replace('US-','') + ')' : '') +
        ' ' + apt.elevation + 'ft';
}


// ============================================================
// CALCULATION — Main entry point (async for GFS fetch)
// ============================================================

function checkReady() {
    var btn = document.getElementById('btn-calc');
    btn.disabled = !(appState.departure && appState.destination);
}

async function runCalculation() {
    if (!appState.departure || !appState.destination) return;
    if (appState.calculating) return;
    appState.calculating = true;

    var dep = appState.departure;
    var dest = appState.destination;
    var btn = document.getElementById('btn-calc');
    btn.disabled = true;
    btn.textContent = 'Fetching winds...';

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Magnetic variation (approximate)
    var magVar = getMagneticVariation ? getMagneticVariation(dep.lat, dep.lon) : 0;
    var magCourse = ((trueCourse + magVar) + 360) % 360;

    // ---- Step 1: Fetch GFS winds ----
    var gfsData = null;
    var windStatus = 'No wind data';
    var windPtCount = 0;

    try {
        gfsData = await fetchGFSWinds(
            { icao: dep.ident, lat: dep.lat, lon: dep.lon },
            { icao: dest.ident, lat: dest.lat, lon: dest.lon },
            appState.departureTimeZ
        );
        if (gfsData && gfsData.pointCount) {
            windPtCount = gfsData.pointCount;
            windStatus = 'Winds applied (' + windPtCount + ' grid pts)';
        }
    } catch (e) {
        console.warn('[APP] GFS fetch failed:', e.message);
        windStatus = 'Wind fetch failed — using TAS only';
    }

    appState.lastGfsData = gfsData;

    // ---- Step 2: Get altitude options ----
    var altitudes = getTop3Altitudes(trueCourse);
    var options = [];

    for (var i = 0; i < altitudes.length; i++) {
        var alt = altitudes[i];
        var perf = getPerformanceAtAltitude(alt);
        var tas = perf.cruiseTAS;
        var cruiseGS = tas;
        var windSummary = null;

        // Get wind-corrected cruise GS
        if (gfsData) {
            cruiseGS = calculateGFSGroundSpeed(gfsData, alt, trueCourse, tas);
            windSummary = getGFSWindSummary(gfsData, alt, trueCourse, tas);
        }

        // Calculate flight plan with GS + gfsData for climb/descent corrections
        var plan = calculateFlight(dep, dest, alt, cruiseGS, gfsData);

        // Attach wind summary for display
        plan.windSummary = windSummary;
        plan.windPtCount = windPtCount;

        options.push(plan);
    }

    var results = {
        trueCourse: Math.round(trueCourse),
        magCourse: Math.round(magCourse),
        magVar: magVar,
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: options,
        windStatus: windStatus
    };

    appState.lastResults = results;

    // ---- Step 3: Display ----
    displayResults(results, dep, dest);
    updateStatus('ok', airportDB.length + ' airports loaded');
    updateWindStatus(windStatus);

    btn.disabled = false;
    btn.textContent = 'Calculate Flight Plan';
    appState.calculating = false;
}


// ============================================================
// RESULTS DISPLAY
// ============================================================

function displayResults(results, dep, dest) {
    var section = document.getElementById('results-section');
    section.classList.add('visible');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    // Route summary
    var sumRoute = document.getElementById('sum-route');
    if (sumRoute) sumRoute.textContent = dep.ident + ' → ' + dest.ident;

    var sumDist = document.getElementById('sum-dist');
    if (sumDist) sumDist.textContent = Math.round(totalDist);

    var sumCourse = document.getElementById('sum-course');
    if (sumCourse) sumCourse.textContent = results.trueCourse + '°';

    var sumMagCourse = document.getElementById('sum-mag-course');
    if (sumMagCourse) sumMagCourse.textContent = results.magCourse + '°M';

    var sumDir = document.getElementById('sum-dir');
    if (sumDir) sumDir.textContent = results.direction;

    // Fuel stop check
    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (fuelStopEl) {
        if (needsFuelStop(results)) {
            fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
        } else {
            fuelStopEl.innerHTML = '';
        }
    }

    // Wind status
    updateWindStatus(results.windStatus);

    // Altitude options table
    var tbody = document.getElementById('alt-table-body');
    tbody.innerHTML = '';

    // Find best (shortest time) option
    var bestIdx = 0;
    for (var i = 1; i < results.options.length; i++) {
        if (results.options[i].totals.timeMin < results.options[bestIdx].totals.timeMin) {
            bestIdx = i;
        }
    }

    for (var i = 0; i < results.options.length; i++) {
        var plan = results.options[i];
        var ws = plan.windSummary;
        var windDelta = '';

        if (ws && ws.available) {
            var comp = ws.windComponent;
            if (comp > 0) {
                windDelta = '−' + comp;  // headwind: GS < TAS
            } else if (comp < 0) {
                windDelta = '+' + Math.abs(comp);  // tailwind: GS > TAS
            } else {
                windDelta = '0';
            }
        }

        var tr = document.createElement('tr');
        if (i === bestIdx) tr.className = 'best';
        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td>' + Math.round(plan.cruise.groundSpeed) + '</td>' +
            '<td class="wind-delta">' + windDelta + '</td>';
        tr.addEventListener('click', (function(p) {
            return function() { displayPhaseDetail(p); };
        })(plan));
        tbody.appendChild(tr);
    }

    // Auto-show phase detail for best option
    displayPhaseDetail(results.options[bestIdx]);

    // Scroll to results
    section.scrollIntoView({ behavior: 'smooth' });
}


function displayPhaseDetail(plan) {
    var el = document.getElementById('phase-detail');

    // Build wind info string for cruise row
    var cruiseWindInfo = '';
    if (plan.windSummary && plan.windSummary.available) {
        var ws = plan.windSummary;
        var arrow = ws.windComponent > 0 ? '↑' : '↓';
        var label = ws.windComponent > 0 ? 'headwind' : 'tailwind';
        cruiseWindInfo = '<div class="phase-wind">' +
            arrow + Math.abs(ws.windComponent) + 'kt ' + label +
            '· GS ' + ws.gs + 'kt' +
            ' (' + (plan.windPtCount || '') + ' pts)</div>';
    }

    // Build wind info for climb
    var climbWindInfo = '';
    if (plan.climb.windCorrection && plan.climb.windCorrection !== 0) {
        var clbCorr = plan.climb.windCorrection;
        var clbLabel = clbCorr > 0 ? 'tailwind' : 'headwind';
        var clbArrow = clbCorr > 0 ? '↓' : '↑';
        climbWindInfo = '<div class="phase-wind">' +
            clbArrow + Math.abs(Math.round(clbCorr)) + 'nm wind correction' +
            '</div>';
    }

    // Build wind info for descent
    var descentWindInfo = '';
    if (plan.descent.windCorrection && plan.descent.windCorrection !== 0) {
        var desCorr = plan.descent.windCorrection;
        descentWindInfo = '<div class="phase-wind">' +
            (desCorr > 0 ? '↓' : '↑') + Math.abs(Math.round(desCorr)) + 'nm wind correction' +
            '</div>';
    }

    el.innerHTML =
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        '<div class="phase-row header">' +
            '<div>Phase</div><div class="phase-value">Time</div>' +
            '<div class="phase-value">Fuel</div><div class="phase-value">Dist</div>' +
        '</div>' +
        phaseRow('Taxi', '—', plan.totals.taxiFuel + 'g', '—') +
        phaseRowWithWind('Climb', formatTime(plan.climb.timeMin),
            plan.climb.fuelGal + 'g', plan.climb.distanceNM + 'nm', climbWindInfo) +
        phaseRowWithWind('Cruise', formatTime(plan.cruise.timeMin),
            plan.cruise.fuelGal + 'g', plan.cruise.distanceNM + 'nm', cruiseWindInfo) +
        phaseRowWithWind('Descent', formatTime(plan.descent.timeMin),
            plan.descent.fuelGal + 'g', plan.descent.distanceNM + 'nm', descentWindInfo) +
        '<div class="phase-row" style="border-top:1px solid var(--border);padding-top:8px;font-weight:700;">' +
            '<div class="phase-name">Total</div>' +
            '<div class="phase-value">' + plan.totals.timeHrs + '</div>' +
            '<div class="phase-value">' + plan.totals.fuelGal + 'g</div>' +
            '<div class="phase-value">' + plan.distance + 'nm</div>' +
        '</div>';
}

function phaseRow(name, time, fuel, dist) {
    return '<div class="phase-row">' +
        '<div class="phase-name">' + name + '</div>' +
        '<div class="phase-value">' + time + '</div>' +
        '<div class="phase-value">' + fuel + '</div>' +
        '<div class="phase-value">' + dist + '</div>' +
    '</div>';
}

function phaseRowWithWind(name, time, fuel, dist, windInfo) {
    return '<div class="phase-row">' +
        '<div class="phase-name">' + name + '</div>' +
        '<div class="phase-value">' + time + '</div>' +
        '<div class="phase-value">' + fuel + '</div>' +
        '<div class="phase-value">' + dist + '</div>' +
    '</div>' + (windInfo || '');
}


// ============================================================
// STATUS BAR
// ============================================================

function updateStatus(state, msg) {
    var dot = document.getElementById('status-dot');
    var text = document.getElementById('status-text');
    if (dot) dot.className = 'status-dot ' + state;
    if (text) text.textContent = msg;
}

function updateWindStatus(msg) {
    var windEl = document.getElementById('wind-status');
    if (windEl) windEl.textContent = msg || '';
}

// Simple magnetic variation approximation for CONUS
// Returns degrees (negative = west variation)
function getMagneticVariation(lat, lon) {
    // Very rough CONUS model — good enough for display
    // East coast ~-12°, central ~-4°, west coast ~+14°
    // Latitude factor is small in CONUS
    var magVar = -6.0 + (lon + 90) * 0.19 + (lat - 37) * 0.05;
    return Math.round(magVar);
}


// ============================================================
// INIT ON LOAD
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
