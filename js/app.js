// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js, flight-calc.js,
//           timezone.js, departure-time.js, winds-aloft.js, fuel-stops.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    departureInfo: null,
    windData: null,
    fuelStopCandidates: null
};

// ============================================================
// INITIALIZATION
// ============================================================
function initApp() {
    updateStatus('loading', 'Loading airports...');

    // CSV is in REPO ROOT. Fallback uses apple branch.
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
            if (apt && typeof DepartureTime !== 'undefined') {
                DepartureTime.setAirport({
                    icao: apt.ident,
                    lat: apt.lat,
                    lon: apt.lon,
                    name: apt.name
                });
            }
            checkReady();
        });
        setupAutocomplete('dest-input', 'dest-dropdown', 'dest-info', function(apt) {
            appState.destination = apt;
            checkReady();
        });
        document.getElementById('btn-calc').addEventListener('click', runCalculation);

        // Initialize departure time module
        if (typeof DepartureTime !== 'undefined') {
            DepartureTime.init();
        }

        // Listen for departure time/day changes
        document.addEventListener('departureTimeChanged', function(e) {
            appState.departureInfo = e.detail;
        });

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
// CALCULATION — with winds aloft
// ============================================================
function checkReady() {
    var btn = document.getElementById('btn-calc');
    btn.disabled = !(appState.departure && appState.destination);
}

function runCalculation() {
    if (!appState.departure || !appState.destination) return;

    var dep = appState.departure;
    var dest = appState.destination;
    var btn = document.getElementById('btn-calc');
    btn.disabled = true;
    btn.textContent = 'Fetching winds...';
    updateStatus('loading', 'Fetching winds aloft...');

    fetchWindsForRoute(function(windData) {
        appState.windData = windData;

        var results = calculateAltitudeOptions(dep, dest, windData);
        appState.lastResults = results;

        // Find fuel stop candidates if needed
        appState.fuelStopCandidates = null;
        if (needsFuelStop(results) && typeof FuelStops !== 'undefined') {
            var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);
            appState.fuelStopCandidates = FuelStops.findCandidates(dep, dest, totalDist);
        }

        displayResults(results, dep, dest);

        btn.disabled = false;
        btn.textContent = 'Calculate Flight Plan';
        updateStatus('ok', airportDB.length + ' airports loaded');
        updateWindStatus(!!windData);
    });
}

function fetchWindsForRoute(callback) {
    if (typeof WindsAloft === 'undefined') {
        callback(null);
        return;
    }

    var fcstHours = 6;

    WindsAloft.fetchAllWinds(fcstHours)
        .then(function(data) {
            var stationCount = 0;
            for (var s in data) stationCount++;
            if (stationCount < 5) {
                console.warn('Wind data too sparse: ' + stationCount + ' stations');
                callback(null);
                return;
            }
            console.log('Winds loaded: ' + stationCount + ' stations');
            callback(data);
        })
        .catch(function(err) {
            console.warn('Wind fetch failed:', err);
            callback(null);
        });
}

// ============================================================
// RESULTS DISPLAY
// ============================================================
function displayResults(results, dep, dest) {
    var section = document.getElementById('results-section');
    section.classList.add('visible');

    var totalDist = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

    document.getElementById('sum-route').textContent = dep.ident + ' \u2192 ' + dest.ident;
    document.getElementById('sum-dist').textContent = Math.round(totalDist);
    document.getElementById('sum-course').textContent = results.trueCourse + '\u00B0';
    document.getElementById('sum-dir').textContent = results.direction;

    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    if (needsFuelStop(results)) {
        fuelStopEl.innerHTML = '<span class="fuel-stop-badge">Fuel Stop Required</span>';
    } else {
        fuelStopEl.innerHTML = '';
    }

    // Altitude options table
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

        var windCol = '';
        if (plan.wind) {
            var ht = plan.wind.headTail;
            if (ht > 0) {
                windCol = '<span style="color:#4caf50;">+' + ht + '</span>';
            } else if (ht < 0) {
                windCol = '<span style="color:#f44336;">' + ht + '</span>';
            } else {
                windCol = '0';
            }
        } else {
            windCol = '\u2014';
        }

        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td>' + plan.cruise.groundSpeed + '</td>' +
            '<td>' + windCol + '</td>';

        tr.addEventListener('click', (function(p) {
            return function() { displayPhaseDetail(p); };
        })(plan));
        tbody.appendChild(tr);
    }

    displayPhaseDetail(results.options[bestIdx]);
    displayFuelStops();
    section.scrollIntoView({ behavior: 'smooth' });
}

function displayPhaseDetail(plan) {
    var el = document.getElementById('phase-detail');

    var timeDisplay = '';
    if (appState.departureInfo && appState.departureInfo.zuluDate && appState.destination) {
        var depInfo = appState.departureInfo;
        var depLocal = depInfo.localMilitary;

        var flightTimeMs = plan.totals.timeMin * 60 * 1000;
        var arrivalZulu = new Date(depInfo.zuluDate.getTime() + flightTimeMs);

        var arrLocal = null;
        if (typeof DepartureTime !== 'undefined') {
            arrLocal = DepartureTime.getArrivalLocal(arrivalZulu, {
                icao: appState.destination.ident,
                lat: appState.destination.lat,
                lon: appState.destination.lon
            });
        }

        timeDisplay =
            '<div class="phase-row" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px;">' +
                '<div class="phase-name" style="font-weight:600;">Depart</div>' +
                '<div class="phase-value">' + depLocal + '</div>' +
                '<div class="phase-name" style="font-weight:600;">Arrive</div>' +
                '<div class="phase-value">' + (arrLocal ? arrLocal.localMilitary : '\u2014') + '</div>' +
            '</div>';
    }

    var windLine = '';
    if (plan.wind && plan.wind.spd > 0) {
        var htLabel = plan.wind.headTail >= 0 ? 'Tailwind' : 'Headwind';
        var htValue = Math.abs(plan.wind.headTail);
        windLine =
            '<div class="phase-row" style="border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px;color:#4da6ff;">' +
                '<div class="phase-name">Wind</div>' +
                '<div class="phase-value">' + plan.wind.dir + '\u00B0/' + plan.wind.spd + 'kt</div>' +
                '<div class="phase-name">' + htLabel + '</div>' +
                '<div class="phase-value">' + htValue + 'kt</div>' +
            '</div>';
    }

    el.innerHTML =
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        timeDisplay +
        windLine +
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
// FUEL STOP DISPLAY
// ============================================================
function displayFuelStops() {
    var container = document.getElementById('fuel-stops-section');
    if (!container) return;

    if (!appState.fuelStopCandidates || appState.fuelStopCandidates.length === 0) {
        container.innerHTML = '';
        container.classList.remove('visible');
        return;
    }

    var html = '<div class="card"><div class="card-title">Fuel Stop Options</div>';
    html += '<table class="alt-table"><thead><tr>' +
        '<th>Airport</th><th>From Dep</th><th>To Dest</th><th>Off Route</th>' +
        '</tr></thead><tbody>';

    for (var i = 0; i < appState.fuelStopCandidates.length; i++) {
        var fs = appState.fuelStopCandidates[i];
        var apt = fs.airport;
        var rowClass = i === 0 ? ' class="best"' : '';

        html += '<tr' + rowClass + '>' +
            '<td><strong>' + escHTML(apt.ident) + '</strong><br>' +
            '<span style="font-size:0.75rem;color:var(--text-label);">' + escHTML(apt.name) + '</span><br>' +
            '<span style="font-size:0.7rem;color:var(--text-label);">' +
                escHTML(apt.municipality || '') +
                (apt.region ? ', ' + escHTML(apt.region.replace('US-', '')) : '') +
            '</span></td>' +
            '<td>' + fs.distFromDep + 'nm</td>' +
            '<td>' + fs.distFromDest + 'nm</td>' +
            '<td>' + fs.distOffRoute + 'nm</td>' +
            '</tr>';
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
    container.classList.add('visible');
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

function updateWindStatus(hasWind) {
    var windStatus = document.getElementById('wind-status');
    if (windStatus) {
        windStatus.textContent = hasWind ? 'Winds applied' : 'No wind correction';
        windStatus.style.color = hasWind ? '#4caf50' : '';
    }
}

// ============================================================
// INIT ON LOAD
// ============================================================
document.addEventListener('DOMContentLoaded', initApp);
