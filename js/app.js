// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js, winds.js,
//           gfs-winds.js, flight-calc.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    selectedDay: 0,       // 0 = today, 1 = tomorrow, etc.
    departureTime: '',    // military time string e.g. "1430"
    forecastHr: '06'      // NOAA forecast period: '06','12','24'
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    var csvUrls = [
        'us-airports.csv',
        'data/us-airports.csv'
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

        document.getElementById('btn-calc').addEventListener('click', runCalculation);

        initDaySelector();
        initTimeInput();

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
// DAY & TIME SELECTOR
// ============================================================
function initDaySelector() {
    var container = document.getElementById('day-pills');
    if (!container) return;

    var days = ['Today', 'Tmrw'];
    var now = new Date();
    for (var i = 2; i < 7; i++) {
        var d = new Date(now);
        d.setDate(d.getDate() + i);
        days.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
    }

    container.innerHTML = '';
    for (var j = 0; j < days.length; j++) {
        var pill = document.createElement('button');
        pill.className = 'day-pill' + (j === 0 ? ' active' : '');
        pill.textContent = days[j];
        pill.dataset.day = j;
        pill.addEventListener('click', function() {
            container.querySelectorAll('.day-pill').forEach(function(p) {
                p.classList.remove('active');
            });
            this.classList.add('active');
            appState.selectedDay = parseInt(this.dataset.day);
            updateForecastPeriod();
            updateZuluDisplay();
        });
        container.appendChild(pill);
    }
}

function initTimeInput() {
    var input = document.getElementById('dep-time');
    if (!input) return;

    // Default to current time rounded to next 30 min
    var now = new Date();
    var mins = now.getMinutes();
    var roundedMins = mins < 30 ? 30 : 0;
    var hrs = mins < 30 ? now.getHours() : now.getHours() + 1;
    if (hrs >= 24) hrs = 0;
    appState.departureTime = padTwo(hrs) + padTwo(roundedMins);
    input.value = appState.departureTime;

    input.addEventListener('input', function() {
        appState.departureTime = input.value.replace(/[^0-9]/g, '').substring(0, 4);
        updateForecastPeriod();
        updateZuluDisplay();
    });

    updateForecastPeriod();
    updateZuluDisplay();
}

function padTwo(n) {
    return (n < 10 ? '0' : '') + n;
}


// ============================================================
// ZULU TIME & FORECAST PERIOD
// ============================================================
function getDepDateTime() {
    var now = new Date();
    var depDate = new Date(now);
    depDate.setDate(depDate.getDate() + appState.selectedDay);

    var timeStr = appState.departureTime || '0000';
    while (timeStr.length < 4) timeStr = '0' + timeStr;
    var hrs = parseInt(timeStr.substring(0, 2)) || 0;
    var mins = parseInt(timeStr.substring(2, 4)) || 0;
    depDate.setHours(hrs, mins, 0, 0);

    return depDate;
}

function updateZuluDisplay() {
    var zuluEl = document.getElementById('zulu-display');
    if (!zuluEl) return;

    var depLocal = getDepDateTime();
    var zuluHrs = depLocal.getUTCHours();
    var zuluMins = depLocal.getUTCMinutes();
    zuluEl.textContent = padTwo(zuluHrs) + padTwo(zuluMins) + 'Z';
}

function updateForecastPeriod() {
    var depLocal = getDepDateTime();
    var now = new Date();
    var hoursOut = (depLocal - now) / (1000 * 60 * 60);

    // Pick best NOAA forecast period
    if (hoursOut <= 6) {
        appState.forecastHr = '06';
    } else if (hoursOut <= 12) {
        appState.forecastHr = '12';
    } else if (hoursOut <= 24) {
        appState.forecastHr = '24';
    } else {
        appState.forecastHr = '24'; // best we have
    }

    // Update forecast indicator
    var indEl = document.getElementById('forecast-indicator');
    if (indEl) {
        if (hoursOut > 30) {
            indEl.className = 'forecast-badge forecast-warn';
            indEl.textContent = appState.forecastHr + 'hr (>30hr out)';
        } else {
            indEl.className = 'forecast-badge forecast-ok';
            indEl.textContent = appState.forecastHr + 'hr fcst';
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

    document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.remove('active');
        }
    });

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


// ============================================================
// CALCULATION — Async with GFS wind integration
// ============================================================
function checkReady() {
    var btn = document.getElementById('btn-calc');
    btn.disabled = !(appState.departure && appState.destination);
}

async function runCalculation() {
    if (!appState.departure || !appState.destination) return;

    var dep = appState.departure;
    var dest = appState.destination;
    var btn = document.getElementById('btn-calc');

    // Show loading state
    btn.disabled = true;
    btn.textContent = 'Calculating...';
    updateWindStatus('loading', 'Fetching winds aloft...');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Magnetic variation (approximate for CONUS)
    var magVar = Math.round(-6.0 + (dep.lon + 90) * 0.19 + (dep.lat - 37) * 0.05);
    var magCourse = Math.round(((trueCourse + magVar) + 360) % 360);

    // Get departure time as UTC Date for GFS forecast hour selection
    var departureTimeZ = getDepDateTime();

    // ---- Step 1: Fetch GFS gridded winds ----
    // This also populates _gfsWindCache for climb/descent corrections
    var gfsData = null;
    var windPtCount = 0;

    try {
        gfsData = await fetchGFSWinds(
            { icao: dep.ident, lat: dep.lat, lon: dep.lon },
            { icao: dest.ident, lat: dest.lat, lon: dest.lon },
            departureTimeZ
        );
        if (gfsData && gfsData.pointCount) {
            windPtCount = gfsData.pointCount;
        }
    } catch (e) {
        console.warn('[APP] GFS fetch failed:', e.message);
    }

    // ---- Step 2: Calculate each altitude option ----
    var altitudes = getTop3Altitudes(trueCourse);
    var options = [];

    for (var i = 0; i < altitudes.length; i++) {
        var alt = altitudes[i];
        var perf = getPerformanceAtAltitude(alt);
        var tas = perf.cruiseTAS;
        var cruiseGS = tas;
        var windSummary = null;

        // Get wind-corrected cruise GS from GFS data
        if (gfsData) {
            cruiseGS = calculateGFSGroundSpeed(gfsData, alt, trueCourse, tas);
            windSummary = getGFSWindSummary(gfsData, alt, trueCourse, tas);
            if (windSummary && windSummary.available) {
                windSummary.stationCount = windPtCount;
            }
        }

        // Calculate full flight plan
        // Climb/descent wind corrections auto-detected via _gfsWindCache
        var plan = calculateFlight(dep, dest, alt, cruiseGS);

        // Attach wind info for display
        plan.windSummary = windSummary;
        plan.windPtCount = windPtCount;

        options.push(plan);
    }

    // Sort by total time ascending (best first)
    options.sort(function(a, b) { return a.totals.timeMin - b.totals.timeMin; });

    var results = {
        trueCourse: Math.round(trueCourse),
        magCourse: magCourse,
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: options,
        windStatus: gfsData ? 'ok' : 'failed',
        windStationCount: windPtCount
    };

    appState.lastResults = results;

    // Update wind status display
    if (gfsData) {
        updateWindStatus('ok', 'Winds applied (' + windPtCount + ' grid pts)');
    } else {
        updateWindStatus('warn', 'Wind fetch failed — using TAS only');
    }

    displayResults(results, dep, dest);

    btn.disabled = false;
    btn.textContent = 'Calculate Flight Plan';
}


// ============================================================
// RESULTS DISPLAY
// ============================================================
function displayResults(results, dep, dest) {
    var section = document.getElementById('results-section');
    section.classList.add('visible');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    // Route summary
    document.getElementById('sum-dist').textContent = Math.round(totalDist);

    var courseEl = document.getElementById('sum-course');
    if (courseEl) courseEl.textContent = results.trueCourse + '°';

    var magEl = document.getElementById('sum-mag-course');
    if (magEl) magEl.textContent = results.magCourse + '°M';

    var dirEl = document.getElementById('sum-dir');
    if (dirEl) dirEl.textContent = results.direction;

    // Fuel stop check
    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (fuelStopEl) {
        if (needsFuelStop(results)) {
            fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
        } else {
            fuelStopEl.innerHTML = '';
        }
    }

    // Altitude options table
    var tbody = document.getElementById('alt-table-body');
    tbody.innerHTML = '';

    // Best option is first (already sorted by time)
    for (var i = 0; i < results.options.length; i++) {
        var plan = results.options[i];
        var tr = document.createElement('tr');
        if (i === 0) tr.className = 'best';

        // Determine GS class based on wind
        var gsClass = '';
        var gsDelta = '';
        if (plan.windSummary && plan.windSummary.available) {
            var comp = plan.windSummary.windComponent;
            if (comp > 2) {
                gsClass = ' class="gs-headwind"';
                gsDelta = '<span class="gs-delta">−' + comp + '</span>';
            } else if (comp < -2) {
                gsClass = ' class="gs-tailwind"';
                gsDelta = '<span class="gs-delta">+' + Math.abs(comp) + '</span>';
            }
        }

        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td' + gsClass + '>' + Math.round(plan.cruise.groundSpeed) + gsDelta + '</td>';

        tr.addEventListener('click', (function(p) {
            return function() { displayPhaseDetail(p); };
        })(plan));
        tbody.appendChild(tr);
    }

    // Auto-show phase detail for best option
    displayPhaseDetail(results.options[0]);

    section.scrollIntoView({ behavior: 'smooth' });
}

function displayPhaseDetail(plan) {
    var el = document.getElementById('phase-detail');

    // Cruise wind info line
    var windLine = '';
    if (plan.windSummary && plan.windSummary.available) {
        var wc = plan.windSummary.windComponent;
        var windClass = wc > 0 ? 'headwind' : 'tailwind';
        var windArrow = wc > 0 ? '↑' : '↓';
        windLine = '<div class="phase-wind-info ' + windClass + '">' +
            '<span class="wind-arrow">' + windArrow + '</span>' +
            '<span class="wind-value">' + plan.windSummary.description + '</span>' +
            ' · GS ' + plan.windSummary.gs + 'kt' +
            ' (' + (plan.windPtCount || plan.windSummary.stationCount) + ' pts)' +
            '</div>';
    }

    // Climb wind correction annotation
    var climbWindLine = '';
    if (plan.climb.windCorrection && Math.abs(plan.climb.windCorrection) >= 0.5) {
        var clbCorr = plan.climb.windCorrection;
        var clbArrow = clbCorr > 0 ? '↓' : '↑';
        climbWindLine = '<div class="phase-wind-info ' + (clbCorr > 0 ? 'tailwind' : 'headwind') + '">' +
            '<span class="wind-arrow">' + clbArrow + '</span>' +
            Math.abs(Math.round(clbCorr)) + 'nm wind correction' +
            '</div>';
    }

    // Descent wind correction annotation
    var descentWindLine = '';
    if (plan.descent.windCorrection && Math.abs(plan.descent.windCorrection) >= 0.5) {
        var desCorr = plan.descent.windCorrection;
        var desArrow = desCorr > 0 ? '↓' : '↑';
        descentWindLine = '<div class="phase-wind-info ' + (desCorr > 0 ? 'tailwind' : 'headwind') + '">' +
            '<span class="wind-arrow">' + desArrow + '</span>' +
            Math.abs(Math.round(desCorr)) + 'nm wind correction' +
            '</div>';
    }

    el.innerHTML =
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        '<div class="phase-row header">' +
            '<div>Phase</div><div class="phase-value">Time</div>' +
            '<div class="phase-value">Fuel</div><div class="phase-value">Dist</div>' +
        '</div>' +
        phaseRow('Taxi', '—', plan.totals.taxiFuel + 'g', '—') +
        phaseRow('Climb', formatTime(plan.climb.timeMin), plan.climb.fuelGal + 'g', plan.climb.distanceNM + 'nm') +
        climbWindLine +
        phaseRow('Cruise', formatTime(plan.cruise.timeMin), plan.cruise.fuelGal + 'g', plan.cruise.distanceNM + 'nm') +
        windLine +
        phaseRow('Descent', formatTime(plan.descent.timeMin), plan.descent.fuelGal + 'g', plan.descent.distanceNM + 'nm') +
        descentWindLine +
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


// ============================================================
// STATUS BAR & WIND STATUS
// ============================================================
function updateStatus(state, msg) {
    var dot = document.getElementById('status-dot');
    var text = document.getElementById('status-text');
    if (dot) dot.className = 'status-dot ' + state;
    if (text) text.textContent = msg;
}

function updateWindStatus(state, msg) {
    // Top wind status bar (inside results card)
    var bar = document.getElementById('wind-status-bar');
    if (bar) {
        var dotClass = state === 'ok' ? 'ok' : (state === 'loading' ? 'loading' : 'error');
        var barClass = state === 'ok' ? 'wind-ok' : 'wind-warn';
        bar.className = 'wind-status-bar ' + barClass;
        bar.innerHTML = '<span class="status-dot ' + dotClass + '"></span>' + escHTML(msg);
        bar.style.display = 'flex';
    }

    // Bottom status bar footer
    var footer = document.getElementById('wind-status-footer');
    if (footer) {
        var footerClass = state === 'ok' ? 'wind-footer-ok' : 'wind-footer-warn';
        footer.className = 'wind-status-footer ' + footerClass;
        footer.innerHTML = '<span class="status-dot ' + (state === 'ok' ? 'ok' : 'error') + '"></span>' + escHTML(msg);
    }
}


// ============================================================
// INIT ON LOAD
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
