// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js, winds.js,
//           flight-calc.js, timezone.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    selectedDay: null,
    departureTimezone: null,
    forecastPeriod: '06',
    departureInfo: null
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    var csvUrls = [
        'us-airports.csv',
        'https://raw.githubusercontent.com/jburns3cfi-dotcom/tbm850-planner/apple/us-airports.csv',
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
            if (apt) {
                resolveDepTimezone(apt);
            } else {
                appState.departureTimezone = null;
                document.getElementById('depTimezoneLabel').textContent = 'local';
            }
            checkReady();
        });
        setupAutocomplete('dest-input', 'dest-dropdown', 'dest-info', function(apt) {
            appState.destination = apt;
            checkReady();
        });

        initDaySelector();
        initTimeInput();

        document.getElementById('btn-calc').addEventListener('click', runCalculation);
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
// DAY SELECTOR — 7 pills starting from Today
// ============================================================
function initDaySelector() {
    var row = document.getElementById('daySelectorRow');
    if (!row) return;

    var days = getDayOptions();
    row.innerHTML = '';

    for (var i = 0; i < days.length; i++) {
        var btn = document.createElement('button');
        btn.className = 'day-pill' + (i === 0 ? ' active' : '');
        btn.textContent = days[i].label;
        btn.setAttribute('data-day-index', i);

        (function(dayObj, button) {
            button.addEventListener('click', function() {
                var pills = row.querySelectorAll('.day-pill');
                for (var p = 0; p < pills.length; p++) {
                    pills[p].classList.remove('active');
                }
                button.classList.add('active');
                appState.selectedDay = dayObj.date;
                updateZuluDisplay();
            });
        })(days[i], btn);

        row.appendChild(btn);
    }

    appState.selectedDay = days[0].date;
}

// ============================================================
// TIME INPUT — Military time entry + Zulu conversion
// ============================================================
function initTimeInput() {
    var input = document.getElementById('depTimeInput');
    if (!input) return;

    input.addEventListener('input', function() {
        var val = input.value.replace(/[^0-9]/g, '');
        if (val.length > 4) val = val.substring(0, 4);
        input.value = val;

        if (val.length === 4) {
            var hrs = parseInt(val.substring(0, 2));
            var mins = parseInt(val.substring(2, 4));
            if (hrs > 23 || mins > 59) {
                input.classList.add('invalid');
                document.getElementById('depZuluDisplay').textContent = '----Z';
                return;
            }
            input.classList.remove('invalid');
            updateZuluDisplay();
        } else {
            document.getElementById('depZuluDisplay').textContent = '----Z';
            updateForecastIndicator(null);
        }
    });

    input.addEventListener('blur', function() {
        var val = input.value.replace(/[^0-9]/g, '');
        if (val.length > 0 && val.length < 4) {
            while (val.length < 4) val = '0' + val;
            input.value = val;
            updateZuluDisplay();
        }
    });
}

// ============================================================
// TIMEZONE RESOLUTION
// ============================================================
async function resolveDepTimezone(apt) {
    var tzLabel = document.getElementById('depTimezoneLabel');
    tzLabel.textContent = '...';

    try {
        var tz = await getAirportTimezone(apt.ident, apt.lat, apt.lon);
        appState.departureTimezone = tz;
        var abbr = getTimezoneAbbr(tz, appState.selectedDay || new Date());
        tzLabel.textContent = abbr || 'local';
        updateZuluDisplay();
    } catch (err) {
        console.warn('Timezone detection failed:', err);
        appState.departureTimezone = null;
        tzLabel.textContent = 'local';
    }
}

// ============================================================
// ZULU DISPLAY + FORECAST PERIOD
// ============================================================
function updateZuluDisplay() {
    var input = document.getElementById('depTimeInput');
    var zuluEl = document.getElementById('depZuluDisplay');
    var timeVal = (input ? input.value : '').replace(/[^0-9]/g, '');

    if (timeVal.length < 4 || !appState.departureTimezone || !appState.selectedDay) {
        zuluEl.textContent = '----Z';
        updateForecastIndicator(null);
        return;
    }

    var hrs = parseInt(timeVal.substring(0, 2));
    var mins = parseInt(timeVal.substring(2, 4));
    if (hrs > 23 || mins > 59) {
        zuluEl.textContent = '----Z';
        updateForecastIndicator(null);
        return;
    }

    var info = computeDepartureInfo(timeVal, appState.selectedDay, appState.departureTimezone);
    appState.departureInfo = info;
    appState.forecastPeriod = info.forecastPeriod;

    zuluEl.textContent = info.zuluString;
    updateForecastIndicator(info);
}

function updateForecastIndicator(info) {
    var el = document.getElementById('forecastIndicator');
    if (!el) return;

    if (!info) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }

    el.style.display = 'block';

    if (info.isPast) {
        el.innerHTML = '<span class="forecast-warn">⚠ Departure time is in the past</span>';
    } else if (info.hoursOut > 30) {
        el.innerHTML = '<span class="forecast-warn">⚠ Beyond 30hr forecast window — winds may be less accurate</span>';
    } else {
        el.innerHTML = '<span class="forecast-ok">Using NOAA ' + info.forecastLabel +
            ' (' + info.hoursOut.toFixed(1) + 'hr out)</span>';
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
// CALCULATION
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
    btn.textContent = 'Calculating...';
    updateStatus('loading', 'Fetching winds aloft...');
    updateWindStatusFooter('loading');

    try {
        var forecastHr = appState.forecastPeriod || '06';
        var results = await calculateAltitudeOptions(dep, dest, forecastHr);
        appState.lastResults = results;

        if (results.windStatus === 'ok') {
            updateStatus('ok', 'Winds loaded (' + results.windStations + ' stations)');
            updateWindStatusFooter('ok', results.windStations);
        } else if (results.windStatus === 'error') {
            updateStatus('ok', 'Calculated (winds unavailable)');
            updateWindStatusFooter('error');
        } else if (results.windStatus === 'no-stations') {
            updateStatus('ok', 'Calculated (no wind stations on route)');
            updateWindStatusFooter('no-stations');
        } else {
            updateStatus('ok', 'Calculated (no wind correction)');
            updateWindStatusFooter('none');
        }

        displayResults(results, dep, dest);
    } catch (err) {
        console.error('Calculation error:', err);
        updateStatus('error', 'Calculation failed');
        updateWindStatusFooter('error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Calculate Flight Plan';
    }
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
    document.getElementById('sum-magcourse').textContent = results.magCourse + '°';
    document.getElementById('sum-dir').textContent = results.direction;

    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (needsFuelStop(results)) {
        fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
    } else {
        fuelStopEl.innerHTML = '';
    }

    var windBar = document.getElementById('wind-status-bar');
    if (windBar) {
        if (results.windStatus === 'ok') {
            windBar.innerHTML = '<span class="wind-ok">✓ Winds aloft active — ' +
                results.windStations + ' station' + (results.windStations > 1 ? 's' : '') +
                ' along route</span>';
            windBar.style.display = 'block';
        } else if (results.windStatus === 'error' || results.windStatus === 'no-stations') {
            windBar.innerHTML = '<span class="wind-warn">⚠ No wind data — GS = TAS (no correction)</span>';
            windBar.style.display = 'block';
        } else {
            windBar.innerHTML = '';
            windBar.style.display = 'none';
        }
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

        var gsText = Math.round(plan.cruise.groundSpeed);
        var gsClass = '';
        if (plan.cruise.wind && plan.cruise.wind.available) {
            if (plan.cruise.wind.windComponent > 0) {
                gsClass = ' class="gs-headwind"';
            } else if (plan.cruise.wind.windComponent < 0) {
                gsClass = ' class="gs-tailwind"';
            }
        }

        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td' + gsClass + '>' + gsText + '</td>';
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

    var windLine = '';
    if (plan.cruise.wind && plan.cruise.wind.available) {
        var w = plan.cruise.wind;
        windLine = '<div class="phase-wind-info">' +
            'Wind: ' + w.description +
            ' | TAS ' + plan.cruise.tas + 'kt → GS ' + Math.round(plan.cruise.groundSpeed) + 'kt' +
            ' (' + w.stationCount + ' stn' + (w.stationCount > 1 ? 's' : '') + ')' +
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
        phaseRow('Cruise', formatTime(plan.cruise.timeMin), plan.cruise.fuelGal + 'g', plan.cruise.distanceNM + 'nm') +
        phaseRow('Descent', formatTime(plan.descent.timeMin), plan.descent.fuelGal + 'g', plan.descent.distanceNM + 'nm') +
        '<div class="phase-row" style="border-top:1px solid var(--border);padding-top:8px;font-weight:700;">' +
            '<div class="phase-name">Total</div>' +
            '<div class="phase-value">' + plan.totals.timeHrs + '</div>' +
            '<div class="phase-value">' + plan.totals.fuelGal + 'g</div>' +
            '<div class="phase-value">' + plan.distance + 'nm</div>' +
        '</div>' +
        windLine;
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

function updateWindStatusFooter(status, stationCount) {
    var el = document.getElementById('wind-status-footer');
    if (!el) return;

    if (status === 'ok') {
        el.textContent = 'Winds: ' + stationCount + ' stations';
        el.className = 'wind-footer-ok';
    } else if (status === 'loading') {
        el.textContent = 'Fetching winds...';
        el.className = '';
    } else if (status === 'error') {
        el.textContent = 'Winds unavailable';
        el.className = 'wind-footer-warn';
    } else if (status === 'no-stations') {
        el.textContent = 'No wind stations';
        el.className = 'wind-footer-warn';
    } else {
        el.textContent = 'No wind correction';
        el.className = '';
    }
}

// ============================================================
// INIT ON LOAD
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
