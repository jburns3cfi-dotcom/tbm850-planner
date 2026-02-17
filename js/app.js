// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js,
//           flight-calc.js, timezone.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    // Departure day/time state
    selectedDayIndex: 0,
    selectedDayDate: new Date(),
    departureTimezone: null,
    departureInfo: null
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    // CSV lives at root (not data/)
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
            if (apt) {
                resolveDepartureTimezone(apt);
            } else {
                appState.departureTimezone = null;
                updateDepartureDisplay();
            }
            checkReady();
        });
        setupAutocomplete('dest-input', 'dest-dropdown', 'dest-info', function(apt) {
            appState.destination = apt;
            checkReady();
        });
        document.getElementById('btn-calc').addEventListener('click', runCalculation);

        // Initialize departure day/time controls
        initDaySelector();
        setupTimeInput();

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
// DEPARTURE DAY SELECTOR
// ============================================================
function initDaySelector() {
    var container = document.getElementById('daySelectorRow');
    if (!container) return;

    var days = getDayOptions(); // from timezone.js
    container.innerHTML = '';

    days.forEach(function(day, i) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day-btn' + (i === 0 ? ' active' : '');
        btn.textContent = day.label;
        btn.setAttribute('data-index', i);

        btn.addEventListener('click', function() {
            selectDay(i, day.date);
        });

        container.appendChild(btn);
    });

    appState.selectedDayIndex = 0;
    appState.selectedDayDate = days[0].date;
}

function selectDay(index, date) {
    appState.selectedDayIndex = index;
    appState.selectedDayDate = date;

    var buttons = document.querySelectorAll('.day-btn');
    buttons.forEach(function(btn, i) {
        btn.classList.toggle('active', i === index);
    });

    updateDepartureDisplay();
}

// ============================================================
// DEPARTURE TIME INPUT
// ============================================================
function setupTimeInput() {
    var input = document.getElementById('depTimeInput');
    if (!input) return;

    // Filter to digits only
    input.addEventListener('input', function(e) {
        var val = e.target.value.replace(/[^0-9]/g, '');
        if (val.length > 4) val = val.substring(0, 4);
        e.target.value = val;

        if (val.length === 4) {
            var hours = parseInt(val.substring(0, 2));
            var mins = parseInt(val.substring(2, 4));
            if (hours <= 23 && mins <= 59) {
                updateDepartureDisplay();
            }
        }
    });

    input.addEventListener('blur', function() {
        updateDepartureDisplay();
    });
}

// ============================================================
// DEPARTURE DISPLAY UPDATE
// Called when day, time, or timezone changes
// ============================================================
function updateDepartureDisplay() {
    var timeInput = document.getElementById('depTimeInput');
    var zuluDisplay = document.getElementById('depZuluDisplay');
    var tzLabel = document.getElementById('depTimezoneLabel');
    var forecastDiv = document.getElementById('forecastIndicator');

    var militaryTime = timeInput ? timeInput.value : '';

    // Need timezone and valid 4-digit time
    if (!appState.departureTimezone || militaryTime.length < 4) {
        if (zuluDisplay) zuluDisplay.textContent = '----Z';
        if (forecastDiv) forecastDiv.innerHTML = '';
        appState.departureInfo = null;
        return;
    }

    // Validate time
    var hours = parseInt(militaryTime.substring(0, 2));
    var mins = parseInt(militaryTime.substring(2, 4));
    if (hours > 23 || mins > 59) {
        if (zuluDisplay) zuluDisplay.textContent = '----Z';
        if (forecastDiv) forecastDiv.innerHTML = '';
        appState.departureInfo = null;
        return;
    }

    // Compute departure info (from timezone.js)
    appState.departureInfo = computeDepartureInfo(
        militaryTime,
        appState.selectedDayDate,
        appState.departureTimezone
    );

    // Update timezone abbreviation
    if (tzLabel) {
        tzLabel.textContent = appState.departureInfo.localAbbr || 'local';
    }

    // Update Zulu display
    if (zuluDisplay) {
        zuluDisplay.textContent = appState.departureInfo.zuluString;
    }

    // Update forecast indicator
    if (forecastDiv) {
        var fc = appState.departureInfo.forecastPeriod;
        var tagClass = 'forecast-tag fc-' + fc;
        var label = appState.departureInfo.forecastLabel;
        var extra = '';

        if (appState.departureInfo.isPast) {
            tagClass = 'forecast-tag fc-past';
            label = 'Using Current Winds';
            extra = ' (departure time is in the past)';
        } else if (appState.departureInfo.hoursOut > 0) {
            extra = ' (~' + Math.round(appState.departureInfo.hoursOut) + 'hr out)';
        }

        forecastDiv.innerHTML =
            '<span class="' + tagClass + '">' + label + '</span>' + extra;
    }

    console.log('[DEP] ' + militaryTime + ' ' +
        (appState.departureInfo.localAbbr || '') + ' → ' +
        appState.departureInfo.zuluString +
        ' | Forecast: ' + appState.departureInfo.forecastPeriod +
        ' | ' + appState.departureInfo.hoursOut + 'hr out');
}

// ============================================================
// TIMEZONE RESOLUTION
// Called when departure airport is selected
// ============================================================
async function resolveDepartureTimezone(airport) {
    var tzLabel = document.getElementById('depTimezoneLabel');
    if (tzLabel) tzLabel.textContent = '...';

    try {
        appState.departureTimezone = await getAirportTimezone(
            airport.ident,
            airport.lat,
            airport.lon
        );
    } catch (e) {
        console.warn('[DEP] Timezone resolution failed:', e);
        appState.departureTimezone = estimateTimezoneFromLon(airport.lon);
    }

    updateDepartureDisplay();
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

    // Try exact match on blur
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
    btn.disabled = !(appState.departure && appState.destination);
}

function runCalculation() {
    if (!appState.departure || !appState.destination) return;

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
    document.getElementById('sum-route').textContent = dep.ident + ' \u2192 ' + dest.ident;
    document.getElementById('sum-dist').textContent = Math.round(totalDist);
    document.getElementById('sum-course').textContent = results.trueCourse + '\u00B0';
    document.getElementById('sum-dir').textContent = results.direction;

    // Mag course display
    var magEl = document.getElementById('sum-magcourse');
    if (magEl) {
        magEl.textContent = (results.magCourse != null)
            ? results.magCourse + '\u00B0'
            : '\u2014';
    }

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
        phaseRow('Taxi', '\u2014', plan.totals.taxiFuel + 'g', '\u2014') +
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
