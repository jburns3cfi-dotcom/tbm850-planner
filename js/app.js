// ============================================================
// APP MODULE — TBM850 Apple Flight Planner
// UI wiring, state management, event handlers
// Requires: airports.js, performance.js, route.js,
//           flight-calc.js, gfs-winds.js, fuel-stops.js
// ============================================================

var appState = {
    departure: null,
    destination: null,
    lastResults: null,
    gfsWindData: null
};

// ============================================================
// WIND UTILITY FUNCTIONS
// Called by gfs-winds.js — must be global
// ============================================================

// Break wind into headwind/crosswind components relative to course
function windComponents(windDir, windSpeed, courseDeg) {
    var angle = (windDir - courseDeg) * DEG2RAD;
    return {
        headwind:  Math.round(windSpeed * Math.cos(angle)),
        crosswind: Math.round(windSpeed * Math.sin(angle))
    };
}

// Wind triangle: compute ground speed given TAS, wind, and course
function windTriangleGS(tas, windDir, windSpeed, courseDeg) {
    var windAngle = (windDir - courseDeg) * DEG2RAD;
    var headwind = windSpeed * Math.cos(windAngle);
    var crosswind = windSpeed * Math.sin(windAngle);
    var gs = Math.sqrt(Math.max(0, tas * tas - crosswind * crosswind)) - headwind;
    return Math.max(Math.round(gs), 50);
}

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
// CALCULATION — async for GFS wind fetch
// ============================================================
function checkReady() {
    var btn = document.getElementById('btn-calc');
    btn.disabled = !(appState.departure && appState.destination);
}

async function runCalculation() {
    if (!appState.departure || !appState.destination) return;

    var dep = appState.departure;
    var dest = appState.destination;
    var trueCourse = initialBearing(dep.lat, dep.lon, dest.lat, dest.lon);

    // Show loading state
    updateStatus('loading', 'Fetching GFS winds…');
    var btn = document.getElementById('btn-calc');
    btn.disabled = true;
    btn.textContent = 'Fetching Winds…';

    // Fetch GFS winds
    var gfsData = null;
    try {
        gfsData = await fetchGFSWinds(
            { icao: dep.ident, lat: dep.lat, lon: dep.lon },
            { icao: dest.ident, lat: dest.lat, lon: dest.lon },
            null
        );
    } catch (e) {
        console.error('GFS wind fetch error:', e);
    }
    appState.gfsWindData = gfsData;

    // Calculate altitude options with wind correction
    var altitudes = getTop3Altitudes(trueCourse);
    var options = [];

    for (var i = 0; i < altitudes.length; i++) {
        var alt = altitudes[i];
        var perf = getPerformanceAtAltitude(alt);
        var tas = perf.cruiseTAS;
        var gs = tas;
        var windSummary = null;

        if (gfsData) {
            gs = calculateGFSGroundSpeed(gfsData, alt, trueCourse, tas);
            windSummary = getGFSWindSummary(gfsData, alt, trueCourse, tas);
        }

        var plan = calculateFlight(dep, dest, alt, gs);
        plan.windSummary = windSummary;
        options.push(plan);
    }

    // Sort by shortest time (best wind-corrected option first)
    options.sort(function(a, b) { return a.totals.timeMin - b.totals.timeMin; });

    var results = {
        trueCourse: Math.round(trueCourse),
        direction: trueCourse < 180 ? 'Eastbound' : 'Westbound',
        options: options
    };

    appState.lastResults = results;

    // Update status
    if (gfsData) {
        var windSourceEl = document.getElementById('wind-source');
        if (windSourceEl) {
            windSourceEl.textContent = 'GFS ' + gfsData.cycle + ' · ' + gfsData.pointCount + ' pts';
        }
        updateStatus('ok', airportDB.length + ' airports · GFS winds active');
    } else {
        updateStatus('ok', airportDB.length + ' airports · No wind data');
    }

    btn.disabled = false;
    btn.textContent = 'Calculate Flight Plan';

    displayResults(results, dep, dest);
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

    // Fuel stop check
    var fuelStopEl = document.getElementById('fuel-stop-indicator');
    var fuelResultsEl = document.getElementById('fuel-stop-results');

    if (needsFuelStop(results)) {
        fuelStopEl.innerHTML = '<span class="fuel-stop-badge">⛽ Fuel Stop Required — Searching CAA Airports…</span>';
        fuelResultsEl.style.display = 'block';
        document.getElementById('fuel-stop-cards').innerHTML =
            '<div style="text-align:center;color:var(--text-label);padding:20px;">' +
            '⏳ Loading CAA fuel prices and finding best stops…</div>';

        var bestOption = results.options[0];
        FuelStops.planFuelStops(dep, dest, bestOption)
            .then(function(fsResult) {
                fuelStopEl.innerHTML = '<span class="fuel-stop-badge">⛽ Fuel Stop Required</span>';
                renderFuelStopCards(fsResult);
            })
            .catch(function(err) {
                console.error('Fuel stop error:', err);
                fuelStopEl.innerHTML = '<span class="fuel-stop-badge">⛽ Fuel Stop Required</span>';
                document.getElementById('fuel-stop-cards').innerHTML =
                    '<div style="color:#ff9944;padding:8px;">⚠ Error searching for fuel stops</div>';
            });
    } else {
        fuelStopEl.innerHTML = '';
        fuelResultsEl.style.display = 'none';
    }

    // Altitude options table
    var tbody = document.getElementById('alt-table-body');
    tbody.innerHTML = '';

    for (var i = 0; i < results.options.length; i++) {
        var plan = results.options[i];
        var tr = document.createElement('tr');
        if (i === 0) tr.className = 'best';

        var gsText = Math.round(plan.cruise.groundSpeed);
        var windNote = '';
        if (plan.windSummary && plan.windSummary.available) {
            var wc = plan.windSummary.windComponent;
            if (wc > 0) {
                windNote = ' <span style="color:#ff9944;font-size:0.75em;">(' + wc + 'kt HW)</span>';
            } else if (wc < 0) {
                windNote = ' <span style="color:#44cc88;font-size:0.75em;">(' + Math.abs(wc) + 'kt TW)</span>';
            }
        }

        tr.innerHTML =
            '<td>FL' + (plan.cruiseAlt / 100) + '</td>' +
            '<td>' + plan.totals.timeHrs + '</td>' +
            '<td>' + plan.totals.fuelGal + '</td>' +
            '<td>' + plan.cruise.tas + '</td>' +
            '<td>' + gsText + windNote + '</td>';
        tr.addEventListener('click', (function(p) {
            return function() { displayPhaseDetail(p); };
        })(plan));
        tbody.appendChild(tr);
    }

    displayPhaseDetail(results.options[0]);
    section.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// FUEL STOP CARDS RENDERER
// ============================================================
function renderFuelStopCards(result) {
    var container = document.getElementById('fuel-stop-cards');

    if (!result.success) {
        container.innerHTML = '<div style="color:#ff9944;padding:12px;">⚠ ' + result.error + '</div>';
        return;
    }

    var html = '<div style="color:var(--text-label);font-size:0.8em;margin-bottom:10px;">' +
               result.totalCandidates + ' CAA airports evaluated along route · FL' +
               (result.altitude / 100) + '</div>';

    for (var idx = 0; idx < result.options.length; idx++) {
        var opt = result.options[idx];

        var tagBg, tagColor;
        if (opt.tag.indexOf('Cheapest') >= 0 && opt.tag.indexOf('Fastest') >= 0) {
            tagBg = 'rgba(255,204,68,0.15)'; tagColor = '#ffcc44';
        } else if (opt.tag.indexOf('Fastest') >= 0) {
            tagBg = 'rgba(91,190,245,0.15)'; tagColor = '#5bbef5';
        } else if (opt.tag.indexOf('Cheapest') >= 0) {
            tagBg = 'rgba(68,204,136,0.15)'; tagColor = '#44cc88';
        } else {
            tagBg = 'rgba(160,160,200,0.12)'; tagColor = '#aab';
        }

        html += '<div style="background:var(--card-bg);border:1px solid ' +
                (idx === 0 ? 'var(--accent)' : 'var(--border)') +
                ';border-radius:10px;padding:14px;margin-bottom:10px;">';

        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
        html += '<span style="background:' + tagBg + ';color:' + tagColor +
                ';padding:3px 12px;border-radius:12px;font-size:0.8em;font-weight:600;">' + opt.tag + '</span>';
        html += '<span style="color:var(--text-label);font-size:0.8em;">Option ' + (idx + 1) + '</span>';
        html += '</div>';

        if (opt.numStops === 1) {
            var s = opt.stop;
            html += '<div style="margin-bottom:4px;">';
            html += '<span style="color:var(--text-primary);font-weight:700;font-size:1.1em;">' + s.icao + '</span>';
            html += ' <span style="color:var(--text-label);font-size:0.85em;">' + s.city + ', ' + s.state + '</span>';
            html += '</div>';
            html += '<div style="color:var(--accent);font-size:0.85em;margin-bottom:8px;">🏢 ' + s.fbo + '</div>';
            html += '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">';
            html += '<span style="background:rgba(68,204,136,0.15);color:#44cc88;padding:2px 10px;border-radius:6px;font-size:0.78em;font-weight:600;">✓ CAA Member</span>';
            html += '<span style="color:var(--text-primary);font-weight:700;">$' + s.caaPrice.toFixed(2) + '/gal</span>';
            html += '<span style="color:var(--text-label);font-size:0.85em;text-decoration:line-through;">$' + s.retailPrice.toFixed(2) + ' retail</span>';
            html += '<span style="color:#44cc88;font-size:0.8em;">Save $' + (s.retailPrice - s.caaPrice).toFixed(2) + '/gal</span>';
            html += '</div>';
        }

        if (opt.numStops === 2) {
            for (var si = 0; si < opt.stops.length; si++) {
                var s2 = opt.stops[si];
                html += '<div style="' + (si > 0 ? 'margin-top:8px;padding-top:8px;border-top:1px solid var(--border);' : '') + 'margin-bottom:4px;">';
                html += '<span style="color:var(--text-label);font-size:0.75em;">Stop ' + (si + 1) + ':</span> ';
                html += '<span style="color:var(--text-primary);font-weight:700;">' + s2.icao + '</span>';
                html += ' <span style="color:var(--text-label);font-size:0.85em;">' + s2.city + ', ' + s2.state + '</span>';
                html += '</div>';
                html += '<div style="color:var(--accent);font-size:0.85em;">🏢 ' + s2.fbo +
                         ' · <span style="color:#44cc88;">$' + s2.caaPrice.toFixed(2) + '/gal</span>' +
                         ' <span style="color:var(--text-label);text-decoration:line-through;font-size:0.85em;">$' + s2.retailPrice.toFixed(2) + '</span></div>';
            }
            html += '<div style="margin-bottom:10px;"></div>';
        }

        html += '<div style="border-top:1px solid var(--border);padding-top:8px;">';
        for (var li = 0; li < opt.legs.length; li++) {
            var leg = opt.legs[li];
            html += '<div style="display:flex;justify-content:space-between;color:var(--text-secondary);font-size:0.85em;padding:3px 0;">';
            html += '<span>✈ ' + leg.from + ' → ' + leg.to + '</span>';
            html += '<span>' + leg.data.distNM + ' nm · ' + leg.data.timeHrs + ' · ' + leg.data.fuelGal + ' gal</span>';
            html += '</div>';
        }
        var groundMin = opt.numStops * FuelStops.GROUND_TIME_MIN;
        html += '<div style="display:flex;justify-content:space-between;color:#ffcc44;font-size:0.85em;padding:3px 0;">';
        html += '<span>⏱ Ground time (' + opt.numStops + ' stop' + (opt.numStops > 1 ? 's' : '') + ')</span>';
        html += '<span>' + groundMin + ' min</span>';
        html += '</div>';
        html += '</div>';

        html += '<div style="display:flex;justify-content:space-between;margin-top:10px;padding-top:8px;border-top:1px solid var(--border);">';
        html += '<span style="color:var(--accent);font-weight:700;">Total: ' + opt.totalTimeHrs + '</span>';
        html += '<span style="color:#44cc88;font-weight:700;">Fuel: ' + opt.fuelToBuyGal + ' gal · $' + opt.fuelCost.toFixed(2) + '</span>';
        html += '</div>';

        html += '</div>';
    }

    container.innerHTML = html;
}

// ============================================================
// PHASE DETAIL DISPLAY
// ============================================================
function displayPhaseDetail(plan) {
    var el = document.getElementById('phase-detail');

    var windInfo = '';
    if (plan.windSummary && plan.windSummary.available) {
        var ws = plan.windSummary;
        var windColor = ws.windComponent > 0 ? '#ff9944' : '#44cc88';
        windInfo = '<div style="color:' + windColor + ';font-size:0.85em;margin-bottom:8px;">' +
                   '💨 ' + ws.description + ' · GS ' + ws.gs + 'kt (TAS ' + plan.cruise.tas + ')' +
                   '</div>';
    }

    el.innerHTML =
        '<div class="card-title">FL' + (plan.cruiseAlt / 100) + ' Phase Breakdown</div>' +
        windInfo +
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
