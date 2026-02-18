// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js, flight-calc.js
// Optional: gfs-winds.js (for wind-corrected calculations)
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    gfsData: null,
    selectedDay: 0
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    var csvUrls = [
        'us-airports.csv',
        'https://raw.githubusercontent.com/jburns3cfi-dotcom/tbm850-planner/apple/us-airports.csv'
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

        document.getElementById('dep-input').focus();
    });

    // Day pills and time input — always init regardless of airport load
    initDayPills();

    var depTimeInput = document.getElementById('dep-time');
    if (depTimeInput) {
        depTimeInput.addEventListener('input', updateZuluDisplay);
        updateZuluDisplay();
    }
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
// DAY-OF-WEEK PILLS
// ============================================================
function initDayPills() {
    var container = document.getElementById('dow-pills');
    if (!container) return;

    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var today = new Date();

    container.innerHTML = '';
    for (var i = 0; i < 7; i++) {
        var d = new Date(today);
        d.setDate(today.getDate() + i);

        var pill = document.createElement('div');
        pill.className = 'dow-pill' + (i === 0 ? ' active' : '');
        pill.setAttribute('data-offset', i);

        var dayLabel = i === 0 ? 'Today' : dayNames[d.getDay()];
        var dateLabel = monthNames[d.getMonth()] + ' ' + d.getDate();

        pill.innerHTML = '<span class="dow-day">' + dayLabel + '</span>' +
                         '<span class="dow-date">' + dateLabel + '</span>';

        (function(offset) {
            pill.addEventListener('click', function() {
                selectDay(offset);
            });
        })(i);

        container.appendChild(pill);
    }
}

function selectDay(offset) {
    appState.selectedDay = offset;
    var pills = document.querySelectorAll('.dow-pill');
    for (var i = 0; i < pills.length; i++) {
        pills[i].classList.toggle('active', parseInt(pills[i].getAttribute('data-offset')) === offset);
    }
    updateZuluDisplay();
}

// ============================================================
// LOCAL → ZULU CONVERSION
// ============================================================
function getDepartureTimeZulu() {
    var timeInput = document.getElementById('dep-time');
    if (!timeInput || !timeInput.value) return null;

    var raw = timeInput.value.replace(/[^0-9]/g, '');
    if (raw.length < 3 || raw.length > 4) return null;
    if (raw.length === 3) raw = '0' + raw; // "900" → "0900"

    var hours = parseInt(raw.substring(0, 2));
    var mins = parseInt(raw.substring(2, 4));
    if (hours > 23 || mins > 59) return null;

    var today = new Date();
    var depDate = new Date(today);
    depDate.setDate(today.getDate() + appState.selectedDay);
    depDate.setHours(hours, mins, 0, 0);

    return depDate;
}

function updateZuluDisplay() {
    var el = document.getElementById('zulu-display');
    if (!el) return;

    var depTime = getDepartureTimeZulu();
    if (!depTime) {
        el.textContent = '—Z';
        return;
    }

    var zh = String(depTime.getUTCHours()).padStart(2, '0');
    var zm = String(depTime.getUTCMinutes()).padStart(2, '0');
    el.textContent = zh + zm + 'Z';
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
// CALCULATION — async to allow GFS wind fetch
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
    btn.disabled = true;
    btn.textContent = 'Fetching winds...';

    var depTimeZ = getDepartureTimeZulu();

    var gfsData = null;
    if (typeof fetchGFSWinds === 'function') {
        try {
            updateStatus('loading', 'Fetching GFS winds...');
            gfsData = await fetchGFSWinds(dep, dest, depTimeZ);
            appState.gfsData = gfsData;
            if (gfsData) {
                updateStatus('ok', 'GFS winds loaded (' + gfsData.pointCount + ' pts)');
            } else {
                updateStatus('ok', 'No wind data — using still-air');
            }
        } catch (e) {
            console.error('[GFS] Wind fetch failed:', e.message);
            updateStatus('ok', 'Wind fetch failed — using still-air');
        }
    }

    btn.textContent = 'Calculating...';

    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);
    var altitudes = getTop3Altitudes(trueCourse);

    var results = [];
    for (var i = 0; i < altitudes.length; i++) {
        var alt = altitudes[i];
        var cruiseTAS = getPerformanceAtAltitude(alt).cruiseTAS;
        var cruiseGS = cruiseTAS;
        if (gfsData && typeof calculateGFSGroundSpeed === 'function') {
            cruiseGS = calculateGFSGroundSpeed(gfsData, alt, trueCourse, cruiseTAS);
        }
        var plan = calculateFlight(dep, dest, alt, cruiseGS, gfsData);
        if (plan.viable) {
            results.push(plan);
        }
    }

    if (results.length === 0) {
        console.log('[APP] All standard altitudes non-viable, trying lower FLs');
        var lowerAlts = [24000, 22000, 20000, 18000];
        for (var j = 0; j < lowerAlts.length; j++) {
            var cruiseTAS2 = getPerformanceAtAltitude(lowerAlts[j]).cruiseTAS;
            var cruiseGS2 = cruiseTAS2;
            if (gfsData && typeof calculateGFSGroundSpeed === 'function') {
                cruiseGS2 = calculateGFSGroundSpeed(gfsData, lowerAlts[j], trueCourse, cruiseTAS2);
            }
            var lowPlan = calculateFlight(dep, dest, lowerAlts[j], cruiseGS2, gfsData);
            if (lowPlan.viable) {
                results.push(lowPlan);
                if (results.length >= 3) break;
            }
        }
    }

    if (results.length === 0) {
        var minPlan = calculateFlight(dep, dest, 18000, getPerformanceAtAltitude(18000).cruiseTAS, gfsData);
        minPlan.viable = true;
        minPlan.warning = 'Route very short — climb/descent dominate';
        results.push(minPlan);
    }

    var output = {
        trueCourse: Math.round(trueCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: results
    };

    appState.lastResults = output;
    displayResults(output, dep, dest);

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

    document.getElementById('sum-route').textContent = dep.ident + ' → ' + dest.ident;
    document.getElementById('sum-dist').textContent = Math.round(totalDist);
    document.getElementById('sum-course').textContent = results.trueCourse + '°';
    document.getElementById('sum-dir').textContent = results.direction;

    var windSourceEl = document.getElementById('wind-source');
    if (windSourceEl) {
        if (appState.gfsData) {
            windSourceEl.textContent = 'Winds: ' + appState.gfsData.source +
                ' ' + appState.gfsData.cycle + ' (F+' + appState.gfsData.forecastHour + 'h)';
            windSourceEl.style.display = '';
        } else {
            windSourceEl.textContent = 'Winds: still-air (no GFS data)';
            windSourceEl.style.display = '';
        }
    }

    var statusWind = document.getElementById('status-wind');
    if (statusWind) {
        statusWind.textContent = appState.gfsData ? 'GFS winds active' : 'No wind correction';
    }

    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (needsFuelStop(results)) {
        fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
    } else {
        fuelStopEl.innerHTML = '';
    }

    var tbody = document.getElementById('alt-table-body');
    tbody.innerHTML = '';

    var bestIdx = 0;
    for (var i = 1; i < results.options.length; i++) {
        if (results.options[i].totals.timeMin < results.options[bestIdx].totals.timeMin) {
            bestIdx = i;
        }
    }

    for (var i = 0; i < results.options.length; i++) {
        var plan = results.options[i];
        var tr = document.createElement('tr');
        if (i === bestIdx) tr.className = 'best';

        var flLabel = 'FL' + (plan.cruiseAlt / 100);
        if (plan.warning) flLabel += ' ⚠';

        tr.innerHTML =
            '<td>' + flLabel + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td>' + Math.round(plan.cruise.groundSpeed) + '</td>';
        tr.addEventListener('click', (function(p) {
            return function() { displayPhaseDetail(p); };
        })(plan));
        tbody.appendChild(tr);
    }

    displayPhaseDetail(results.options[bestIdx]);
    section.scrollIntoView({ behavior: 'smooth' });
}

function displayPhaseDetail(plan) {
    var el = document.getElementById('phase-detail');

    var climbAnnotation = '';
    var descentAnnotation = '';
    if (plan.climb.distanceNM_nowind !== undefined &&
        plan.climb.distanceNM !== plan.climb.distanceNM_nowind) {
        var climbDelta = plan.climb.distanceNM - plan.climb.distanceNM_nowind;
        var climbSign = climbDelta >= 0 ? '+' : '';
        climbAnnotation = ' <span class="wind-annotation">(' +
            climbSign + climbDelta.toFixed(1) + ' wind)</span>';
    }
    if (plan.descent.distanceNM_nowind !== undefined &&
        plan.descent.distanceNM !== plan.descent.distanceNM_nowind) {
        var desDelta = plan.descent.distanceNM - plan.descent.distanceNM_nowind;
        var desSign = desDelta >= 0 ? '+' : '';
        descentAnnotation = ' <span class="wind-annotation">(' +
            desSign + desDelta.toFixed(1) + ' wind)</span>';
    }

    var cruiseWindNote = '';
    if (plan.cruise.groundSpeed !== plan.cruise.tas) {
        var delta = plan.cruise.groundSpeed - plan.cruise.tas;
        var windType = delta >= 0 ? 'tailwind' : 'headwind';
        cruiseWindNote = ' <span class="wind-annotation">(' +
            Math.abs(Math.round(delta)) + 'kt ' + windType + ')</span>';
    }

    var warningBanner = '';
    if (plan.warning) {
        warningBanner = '<div class="phase-warning">⚠ ' + plan.warning + '</div>';
    }

    el.innerHTML =
        warningBanner +
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        '<div class="phase-row header">' +
            '<div>Phase</div><div class="phase-value">Time</div>' +
            '<div class="phase-value">Fuel</div><div class="phase-value">Dist</div>' +
        '</div>' +
        phaseRow('Taxi', '—', plan.totals.taxiFuel + 'g', '—') +
        phaseRow('Climb', formatTime(plan.climb.timeMin),
            plan.climb.fuelGal + 'g',
            plan.climb.distanceNM + 'nm' + climbAnnotation) +
        phaseRow('Cruise', formatTime(plan.cruise.timeMin),
            plan.cruise.fuelGal + 'g',
            plan.cruise.distanceNM + 'nm' + cruiseWindNote) +
        phaseRow('Descent', formatTime(plan.descent.timeMin),
            plan.descent.fuelGal + 'g',
            plan.descent.distanceNM + 'nm' + descentAnnotation) +
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
// STATUS BAR
// ============================================================
function updateStatus(state, msg) {
    var dot = document.getElementById('status-dot');
    var text = document.getElementById('status-text');
    dot.className = 'status-dot ' + state;
    text.textContent = msg;
}

// ============================================================
// INIT ON LOAD
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
