// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Candidate Finder + Pricing
// Must load BEFORE app.js in index.html
// ============================================================
console.log('[FuelStops] v5 loaded — CAA via proxy, AirNav direct');

var FuelStops = (function() {
    'use strict';

    // ----- Internal state -----
    var caaData = null;
    var caaLoaded = false;
    var lastCandidates = [];
    var fuelCache = {};

    // ----- URLs -----
    // CAA worker has doubled CORS header — route through proxy (now on allowed list)
    // AirNav worker has clean CORS — call directly
    var PROXY = 'https://tbm850-proxy.jburns3cfi.workers.dev/?url=';
    var CAA_URL = PROXY + encodeURIComponent('https://caa-fuel.jburns3cfi.workers.dev');
    var AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';
    var CORRIDOR_NM = 30;
    var MIN_FROM_DEP_NM = 200;
    var DESCENT_BUFFER_NM = 60;

    // =========================================================
    // AUTO-FETCH CAA DATA ON SCRIPT LOAD
    // =========================================================
    (function autoFetchCAA() {
        fetch(CAA_URL)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                if (data.success && data.airports) {
                    caaData = data.airports;
                    caaLoaded = true;
                    for (var ident in caaData) {
                        var a = caaData[ident];
                        fuelCache[ident] = {
                            fbo: a.fbo,
                            price: a.caa_price,
                            retailPrice: a.retail,
                            caaPrice: a.caa_price,
                            isCAA: true,
                            source: 'CAA'
                        };
                    }
                    console.log('[FuelStops] CAA data loaded: ' + data.count + ' airports');
                    enhanceFuelTable();
                }
            })
            .catch(function(err) {
                console.warn('[FuelStops] CAA fetch failed:', err.message || err);
            });
    })();

    // =========================================================
    // MATH HELPERS
    // =========================================================
    function toRad(d) { return d * Math.PI / 180; }

    function haversineNM(lat1, lon1, lat2, lon2) {
        var R = 3440.065;
        var dLat = toRad(lat2 - lat1);
        var dLon = toRad(lon2 - lon1);
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    function crossTrackDistNM(aptLat, aptLon, depLat, depLon, destLat, destLon) {
        var R = 3440.065;
        var d13 = haversineNM(depLat, depLon, aptLat, aptLon) / R;
        var brng13 = bearingRad(depLat, depLon, aptLat, aptLon);
        var brng12 = bearingRad(depLat, depLon, destLat, destLon);
        var xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
        return Math.abs(xt * R);
    }

    function bearingRad(lat1, lon1, lat2, lon2) {
        var dLon = toRad(lon2 - lon1);
        var y = Math.sin(dLon) * Math.cos(toRad(lat2));
        var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return Math.atan2(y, x);
    }

    // =========================================================
    // RESOLVE IDENT — handles any format app.js might pass
    // =========================================================
    function resolveIdent(val) {
        if (!val) return null;
        if (typeof val === 'object' && val.ident) return val.ident;
        if (typeof val === 'string') {
            var upper = val.toUpperCase();
            var match = upper.match(/\b([KP][A-Z0-9]{3})\b/);
            return match ? match[1] : upper.trim().substring(0, 4);
        }
        return String(val);
    }

    // =========================================================
    // FIND AIRPORT — tries multiple possible field names
    // =========================================================
    function findAirport(ident) {
        if (!ident || typeof airportDB === 'undefined' || !airportDB) return null;
        for (var i = 0; i < airportDB.length; i++) {
            var a = airportDB[i];
            if (a.ident === ident || a.icao === ident || a.gps_code === ident ||
                a.id === ident || a.icao_code === ident) {
                return a;
            }
        }
        return null;
    }

    function getLat(apt) { return parseFloat(apt.latitude_deg || apt.lat || apt.latitude || 0); }
    function getLon(apt) { return parseFloat(apt.longitude_deg || apt.lon || apt.longitude || 0); }

    // =========================================================
    // findCandidates — SYNCHRONOUS (app.js calls without await)
    // =========================================================
    function findCandidates(dep, dest, totalDist) {
        if (typeof airportDB === 'undefined' || !airportDB || airportDB.length === 0) {
            console.warn('[FuelStops] airportDB not loaded yet');
            return [];
        }

        var depIdent = resolveIdent(dep);
        var destIdent = resolveIdent(dest);
        console.log('[FuelStops] Searching candidates: ' + depIdent + ' -> ' + destIdent + ', totalDist=' + totalDist);

        var depApt = findAirport(depIdent);
        var destApt = findAirport(destIdent);

        if (!depApt || !destApt) {
            console.warn('[FuelStops] LOOKUP FAILED — dep=' + depIdent + ' found=' + !!depApt + ', dest=' + destIdent + ' found=' + !!destApt);
            if (airportDB.length > 0) {
                console.warn('[FuelStops] airportDB[0] keys: ' + Object.keys(airportDB[0]).join(', '));
            }
            return [];
        }

        var depLat = getLat(depApt);
        var depLon = getLon(depApt);
        var destLat = getLat(destApt);
        var destLon = getLon(destApt);

        var inCorridor = [];
        for (var i = 0; i < airportDB.length; i++) {
            var apt = airportDB[i];
            var aptIdent = apt.ident || apt.icao || apt.gps_code || apt.id || '';

            if (aptIdent === depIdent || aptIdent === destIdent) continue;

            var t = (apt.type || '').toLowerCase();
            if (t.indexOf('medium') === -1 && t.indexOf('large') === -1) continue;

            if (aptIdent.length !== 4) continue;
            if (aptIdent[0] !== 'K' && aptIdent[0] !== 'P') continue;

            var aptLat = getLat(apt);
            var aptLon = getLon(apt);
            if (isNaN(aptLat) || isNaN(aptLon) || aptLat === 0 || aptLon === 0) continue;

            var distFromDep = haversineNM(depLat, depLon, aptLat, aptLon);
            var distFromDest = haversineNM(aptLat, aptLon, destLat, destLon);

            if (distFromDep < MIN_FROM_DEP_NM) continue;
            if (distFromDest < DESCENT_BUFFER_NM) continue;

            var offRoute = crossTrackDistNM(aptLat, aptLon, depLat, depLon, destLat, destLon);
            if (offRoute > CORRIDOR_NM) continue;

            inCorridor.push({
                airport: {
                    ident: aptIdent,
                    name: apt.name || '',
                    municipality: apt.municipality || '',
                    region: (apt.iso_region || apt.region || '').replace('US-', '')
                },
                distFromDep: Math.round(distFromDep * 10) / 10,
                distFromDest: Math.round(distFromDest * 10) / 10,
                distOffRoute: Math.round(offRoute * 10) / 10
            });
        }

        // Sort: CAA airports first, then by off-route distance
        inCorridor.sort(function(a, b) {
            if (caaLoaded) {
                var aCAA = caaData[a.airport.ident] ? 1 : 0;
                var bCAA = caaData[b.airport.ident] ? 1 : 0;
                if (aCAA !== bCAA) return bCAA - aCAA;
            }
            return a.distOffRoute - b.distOffRoute;
        });

        var results = inCorridor.slice(0, 8);
        console.log('[FuelStops] Found ' + results.length + ' fuel stop candidates from ' + inCorridor.length + ' in corridor');

        lastCandidates = results;
        setTimeout(function() { enhanceFuelTable(); }, 200);

        return results;
    }

    // =========================================================
    // FUEL DATA FETCHING — AirNav called DIRECTLY (no proxy)
    // =========================================================
    function fetchAirNavFuel(ident) {
        if (fuelCache[ident]) return Promise.resolve(fuelCache[ident]);
        return fetch(AIRNAV_URL + '?id=' + ident)
            .then(function(resp) { return resp.json(); })
            .then(function(data) {
                if (data.jetA && data.jetA.price) {
                    var info = {
                        fbo: data.jetA.fbo || 'Unknown FBO',
                        price: data.jetA.price,
                        retailPrice: data.jetA.price,
                        caaPrice: null,
                        isCAA: false,
                        source: 'AirNav'
                    };
                    fuelCache[ident] = info;
                    return info;
                }
                return null;
            })
            .catch(function(err) {
                console.warn('[FuelStops] AirNav failed for ' + ident + ':', err.message || err);
                return null;
            });
    }

    function getCachedFuel(ident) {
        return fuelCache[ident] || null;
    }

    // =========================================================
    // TABLE ENHANCEMENT
    // =========================================================
    function findFuelStopTable() {
        var tables = document.querySelectorAll('table');
        for (var i = 0; i < tables.length; i++) {
            var hdr = tables[i].querySelector('thead');
            var txt = (hdr || tables[i]).textContent || '';
            if (txt.indexOf('FROM DEP') !== -1) return tables[i];
        }
        var secs = document.querySelectorAll('[id*="fuel" i], [id*="stop" i]');
        for (var j = 0; j < secs.length; j++) {
            var t = secs[j].querySelector('table');
            if (t) return t;
        }
        return null;
    }

    var enhanceRetries = 0;

    function enhanceFuelTable() {
        if (lastCandidates.length === 0) return;

        var table = findFuelStopTable();
        if (!table) {
            enhanceRetries++;
            if (enhanceRetries < 10) {
                setTimeout(function() { enhanceFuelTable(); }, 300);
            }
            return;
        }
        enhanceRetries = 0;

        if (table.dataset.fuelEnhanced === 'true') {
            updatePricingCells();
            return;
        }

        table.dataset.fuelEnhanced = 'true';
        console.log('[FuelStops] Enhancing fuel table with JET A + FBO columns');

        var thead = table.querySelector('thead');
        if (thead) {
            var headerRow = thead.querySelector('tr');
            if (headerRow) {
                var thFuel = document.createElement('th');
                thFuel.textContent = 'JET A';
                thFuel.style.cssText = 'text-align:right; white-space:nowrap;';
                headerRow.appendChild(thFuel);

                var thFBO = document.createElement('th');
                thFBO.textContent = 'FBO';
                thFBO.style.cssText = 'text-align:left;';
                headerRow.appendChild(thFBO);
            }
        }

        var tbody = table.querySelector('tbody') || table;
        var rows = tbody.querySelectorAll('tr');
        var idx = 0;

        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            if (row.querySelector('th')) continue;
            if (idx >= lastCandidates.length) break;

            var ident = lastCandidates[idx].airport.ident;

            var tdFuel = document.createElement('td');
            tdFuel.id = 'fuel-price-' + ident;
            tdFuel.style.cssText = 'text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums;';

            var tdFBO = document.createElement('td');
            tdFBO.id = 'fuel-fbo-' + ident;
            tdFBO.style.cssText = 'text-align:left; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85em;';

            var cached = getCachedFuel(ident);
            if (cached) {
                fillFuelCells(tdFuel, tdFBO, cached);
            } else {
                tdFuel.innerHTML = '<span style="color:#888; font-size:0.85em;">loading\u2026</span>';
                tdFBO.textContent = '';
                (function(id, pTd, fTd) {
                    fetchAirNavFuel(id).then(function(info) {
                        if (info) {
                            fillFuelCells(pTd, fTd, info);
                        } else {
                            pTd.innerHTML = '<span style="color:#999; font-size:0.85em;">\u2014</span>';
                        }
                    });
                })(ident, tdFuel, tdFBO);
            }

            row.appendChild(tdFuel);
            row.appendChild(tdFBO);
            idx++;
        }
    }

    function fillFuelCells(tdFuel, tdFBO, info) {
        if (info.isCAA) {
            var savings = (info.retailPrice - info.caaPrice).toFixed(2);
            tdFuel.innerHTML =
                '<span style="background:#1a7f37; color:#fff; font-size:0.7em; padding:1px 4px; border-radius:3px; vertical-align:middle; margin-right:4px;">CAA</span>' +
                '<strong style="color:#1a7f37;">$' + info.caaPrice.toFixed(2) + '</strong>' +
                '<br><span style="color:#888; font-size:0.8em; text-decoration:line-through;">$' + info.retailPrice.toFixed(2) + '</span>' +
                ' <span style="color:#1a7f37; font-size:0.8em;">save $' + savings + '</span>';
        } else {
            tdFuel.innerHTML = '<strong>$' + info.price.toFixed(2) + '</strong>';
        }
        tdFBO.textContent = info.fbo || '';
        tdFBO.title = info.fbo || '';
    }

    function updatePricingCells() {
        for (var i = 0; i < lastCandidates.length; i++) {
            var ident = lastCandidates[i].airport.ident;
            var tdFuel = document.getElementById('fuel-price-' + ident);
            var tdFBO = document.getElementById('fuel-fbo-' + ident);
            if (!tdFuel || !tdFBO) continue;
            var cached = getCachedFuel(ident);
            if (cached) fillFuelCells(tdFuel, tdFBO, cached);
        }
    }

    // =========================================================
    // PUBLIC API
    // =========================================================
    return {
        findCandidates: findCandidates,
        getCachedFuel: getCachedFuel,
        fetchAirNavFuel: fetchAirNavFuel,
        enhanceFuelTable: enhanceFuelTable,
        init: function() {
            console.log('[FuelStops] init called — CAA auto-fetch already in progress');
        },
        get caaLoaded() { return caaLoaded; },
        get caaAirports() { return caaData; }
    };
})();
