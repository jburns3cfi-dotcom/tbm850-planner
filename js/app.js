// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js, flight-calc.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    depTime: null,
    lastResults: null
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    // Set departure time to current local time (rounded to next 15 min)
    initDepTime();

    // Try loading CSV from relative path first, then GitHub raw
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
            updateDepTimezone();
            checkReady();
        });
        setupAutocomplete('dest-input', 'dest-dropdown', 'dest-info', function(apt) {
            appState.destination = apt;
            checkReady();
        });

        // Departure time change handler
        document.getElementById('dep-time').addEventListener('change', function() {
            appState.depTime = this.value || null;
            updateZuluDisplay();
            checkReady();
        });

        document.getElementById('btn-calc').addEventListener('click', runCalculation);

        // Focus departure field
        document.getElementById('dep-input').focus();
    });
}

function initDepTime() {
    var now = new Date();
    // Round up to next 15 minutes
    var mins = now.getMinutes();
    var roundUp = Math.ceil(mins / 15) * 15;
    if (roundUp >= 60) {
        now.setHours(now.getHours() + 1);
        now.setMinutes(0);
    } else {
        now.setMinutes(roundUp);
    }
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var timeStr = hh + ':' + mm;
    document.getElementById('dep-time').value = timeStr;
    appState.depTime = timeStr;
}

// Show timezone label based on departure airport location
function updateDepTimezone() {
    var tzLabel = document.getElementById('dep-tz');
    if (!appState.departure) {
        tzLabel.textContent = '';
        return;
    }
    var tz = estimateTimezone(appState.departure.lon);
    tzLabel.textContent = tz;
    updateZuluDisplay();
}

// Estimate US timezone from longitude
function estimateTimezone(lon) {
    if (lon > -67.5) return 'AST';
    if (lon > -82.5) return 'EST';
    if (lon > -97.5) return 'CST';
    if (lon > -112.5) return 'MST';
    if (lon > -127.5) return 'PST';
    if (lon > -142.5) return 'AKST';
    return 'HST';
}

// Get UTC offset hours for timezone abbreviation
function tzOffsetHours(tz) {
    var offsets = { 'AST': -4, 'EST': -5, 'CST': -6, 'MST': -7, 'PST': -8, 'AKST': -9, 'HST': -10 };
    // Check if DST is in effect
    var now = new Date();
    var jan = new Date(now.getFullYear(), 0, 1);
    var jul = new Date(now.getFullYear(), 6, 1);
    var isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    var base = offsets[tz] || -6;
    // HST and AST don't observe DST
    if (isDST && tz !== 'HST' && tz !== 'AST') base += 1;
    return base;
}

// Display Zulu time below the local time input
function updateZuluDisplay() {
    var zuluEl = document.getElementById('dep-time-zulu');
    if (!appState.depTime || !appState.departure) {
        zuluEl.textContent = '';
        return;
    }
    var parts = appState.depTime.split(':');
    var localHrs = parseInt(parts[0]);
    var localMins = parseInt(parts[1]);
    var tz = estimateTimezone(appState.departure.lon);
    var offset = tzOffsetHours(tz);
    var zuluHrs = (localHrs - offset + 24) % 24;
    var zuluStr = String(zuluHrs).padStart(2, '0') + String(localMins).padStart(2, '0') + 'Z';
    zuluEl.textContent = zuluStr;
    zuluEl.className = 'airport-info valid';
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

// ============================================================
// CALCULATION
// ============================================================
function checkReady() {
    var btn = document.getElementById('btn-calc');
    btn.disabled = !(appState.departure && appState.destination && appState.depTime);
}

function runCalculation() {
    if (!appState.departure || !appState.destination || !appState.depTime) return;

    var dep = appState.departure;
    var dest = appState.destination;
    var results = calculateAltitudeOptions(dep, dest);
    appState.lastResults = results;

    displayResults(results, dep, dest);
}

// ============================================================
// RESULTS DISPLAY
// ============================================================
function displayResults(results, dep, dest) {
    var section = document.getElementById('results-section');
    section.classList.add('visible');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    // Route summary
    document.getElementById('sum-route').textContent = dep.ident + ' → ' + dest.ident;
    document.getElementById('sum-dist').textContent = Math.round(totalDist);
    document.getElementById('sum-course').textContent = results.trueCourse + '°';
    document.getElementById('sum-dir').textContent = results.direction;

    // Fuel stop check
    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (needsFuelStop(results)) {
        fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
    } else {
        fuelStopEl.innerHTML = '';
    }

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
        var tr = document.createElement('tr');
        if (i === bestIdx) tr.className = 'best';
        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td>' + Math.round(plan.cruise.groundSpeed) + '</td>';
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
    el.innerHTML =
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        '<div class="phase-row header">' +
            '<div>Phase</div><div class="phase-value">Time</div>' +
            '<div class="phase-value">Fuel</div><div class="phase-value">Dist</div>' +
        '</div>' +
        phaseRow('Taxi', '—', plan.totals.taxiFuel + 'g', '—') +
        phaseRow('Climb', formatTime(plan.climb.timeMin), plan.climb.fuelGal + 'g', plan.climb.distanceNM + 'nm') +
        phaseRow('Cruise', formatTime(plan.cruise.timeMin), plan.cruise.fuelGal + 'g', plan.cruise.distanceNM + 'nm') +
        phaseRow('Descent', formatTime(plan.descent.timeMin), plan.descent.fuelGal + 'g', plan.descent.distanceNM + 'nm') +
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
