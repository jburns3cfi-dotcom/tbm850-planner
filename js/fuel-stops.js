// ============================================================
// FUEL STOPS MODULE — TBM850 Apple Flight Planner
// Finds optimal CAA fuel stops along a route when any leg
// exceeds 3:30.  Uses existing globals from route.js,
// flight-calc.js, and airports.js.
// Requires: airports.js, route.js, flight-calc.js loaded first
// ============================================================

var FuelStops = (function () {

    // ── Constants ──────────────────────────────────────────────
    var USABLE_FUEL_GAL      = 282;
    var MIN_LANDING_FUEL_GAL = 75;
    var MAX_LEG_TIME_MIN     = 210;       // 3 h 30 m
    var MIN_STOP_DIST_NM     = 200;       // from previous departure
    var CORRIDOR_NM          = 30;        // each side of course line
    var GROUND_TIME_MIN      = 30;        // refuel time per stop

    var CAA_WORKER    = 'https://caa-fuel.jburns3cfi.workers.dev';
    var AIRNAV_WORKER = 'https://airnav-grab.jburns3cfi.workers.dev';

    // ── Caches ─────────────────────────────────────────────────
    var _caaData      = null;
    var _caaTimestamp  = 0;
    var _caaTTL       = 3600000;          // 1 hour
    var _airnavCache  = {};

    // ── Data Fetchers ──────────────────────────────────────────

    function fetchCAAData() {
        if (_caaData && (Date.now() - _caaTimestamp) < _caaTTL) {
            return Promise.resolve(_caaData);
        }
        return fetch(CAA_WORKER)
            .then(function (r) {
                if (!r.ok) throw new Error('CAA HTTP ' + r.status);
                return r.json();
            })
            .then(function (d) {
                if (d.success && d.airports) {
                    _caaData = d.airports;
                    _caaTimestamp = Date.now();
                    return _caaData;
                }
                throw new Error('Bad CAA response');
            })
            .catch(function (e) {
                console.error('CAA fetch error:', e);
                return null;
            });
    }

    function fetchAirNavPrice(icao) {
        if (_airnavCache[icao]) return Promise.resolve(_airnavCache[icao]);
        return fetch(AIRNAV_WORKER + '?id=' + encodeURIComponent(icao))
            .then(function (r) {
                if (!r.ok) return null;
                return r.json();
            })
            .then(function (d) {
                if (d && d.jetA && d.jetA.price) {
                    var info = { price: d.jetA.price, fbo: d.jetA.fbo || 'Unknown', source: 'AirNav' };
                    _airnavCache[icao] = info;
                    return info;
                }
                return null;
            })
            .catch(function (e) {
                console.error('AirNav fetch ' + icao + ':', e);
                return null;
            });
    }

    // ── Geometry Helpers ───────────────────────────────────────
    //  Uses greatCircleDistance, initialBearing, DEG2RAD,
    //  EARTH_RADIUS_NM from route.js (globals)

    function crossTrackNM(depLat, depLon, destLat, destLon, ptLat, ptLon) {
        var d13 = greatCircleDistance(depLat, depLon, ptLat, ptLon);
        var b12 = initialBearing(depLat, depLon, destLat, destLon) * DEG2RAD;
        var b13 = initialBearing(depLat, depLon, ptLat, ptLon) * DEG2RAD;
        return Math.abs(
            Math.asin(Math.sin(d13 / EARTH_RADIUS_NM) * Math.sin(b13 - b12))
            * EARTH_RADIUS_NM
        );
    }

    function alongTrackNM(depLat, depLon, destLat, destLon, ptLat, ptLon) {
        var d13 = greatCircleDistance(depLat, depLon, ptLat, ptLon);
        var b12 = initialBearing(depLat, depLon, destLat, destLon) * DEG2RAD;
        var b13 = initialBearing(depLat, depLon, ptLat, ptLon) * DEG2RAD;
        var dxt = Math.asin(Math.sin(d13 / EARTH_RADIUS_NM) * Math.sin(b13 - b12));
        return Math.acos(Math.cos(d13 / EARTH_RADIUS_NM) / Math.cos(dxt)) * EARTH_RADIUS_NM;
    }

    // ── Airport Lookup ─────────────────────────────────────────
    //  Uses getAirport() from airports.js (global)

    function lookupAirport(code) {
        var apt = getAirport(code);
        if (apt) return apt;
        // Some CAA entries use FAA codes without K prefix (M22, X60, 0A9)
        if (code.length === 3 && /^[A-Z]/.test(code)) {
            apt = getAirport('K' + code);
            if (apt) return apt;
        }
        return null;
    }

    // ── Candidate Search ───────────────────────────────────────

    function findCandidates(dep, dest, routeDistNM, caaData, corridorNM) {
        var candidates = [];
        var codes = Object.keys(caaData);

        for (var i = 0; i < codes.length; i++) {
            var code = codes[i];
            var apt = lookupAirport(code);
            if (!apt) continue;
            if (apt.ident === dep.ident || apt.ident === dest.ident) continue;

            var xtk = crossTrackNM(dep.lat, dep.lon, dest.lat, dest.lon, apt.lat, apt.lon);
            if (xtk > corridorNM) continue;

            var atk = alongTrackNM(dep.lat, dep.lon, dest.lat, dest.lon, apt.lat, apt.lon);
            if (atk < MIN_STOP_DIST_NM) continue;
            if (atk > routeDistNM - 50) continue;

            var caa = caaData[code];
            candidates.push({
                icao:        apt.ident,
                name:        apt.name,
                lat:         apt.lat,
                lon:         apt.lon,
                elevation:   apt.elevation || 0,
                city:        apt.municipality || caa.city || '',
                state:       apt.region ? apt.region.replace('US-', '') : (caa.state || ''),
                fbo:         caa.fbo,
                caaPrice:    caa.caa_price,
                retailPrice: caa.retail,
                isCAA:       true,
                atk:         Math.round(atk),
                xtk:         Math.round(xtk * 10) / 10
            });
        }

        candidates.sort(function (a, b) { return a.atk - b.atk; });
        return candidates;
    }

    // ── Leg Evaluator ──────────────────────────────────────────
    //  Uses calculateFlight() from flight-calc.js (global)

    function evalLeg(fromApt, toApt, cruiseAlt, groundSpeed) {
        var plan = calculateFlight(fromApt, toApt, cruiseAlt, groundSpeed);
        return {
            distNM:   plan.distance,
            timeMin:  plan.totals.timeMin,
            fuelGal:  plan.totals.fuelGal,
            timeHrs:  plan.totals.timeHrs,
            cruiseGS: plan.cruise.groundSpeed,
            viable:   plan.cruise.distanceNM >= 10
        };
    }

    // ── Single-Stop Solver ─────────────────────────────────────

    function solveSingleStop(candidates, dep, dest, cruiseAlt, groundSpeed) {
        var maxBurn = USABLE_FUEL_GAL - MIN_LANDING_FUEL_GAL;
        var options = [];

        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            var stopApt = { ident: c.icao, lat: c.lat, lon: c.lon, elevation: c.elevation };

            var leg1 = evalLeg(dep, stopApt, cruiseAlt, groundSpeed);
            if (!leg1.viable)                    continue;
            if (leg1.timeMin > MAX_LEG_TIME_MIN) continue;
            if (leg1.fuelGal > maxBurn)          continue;

            var leg2 = evalLeg(stopApt, dest, cruiseAlt, groundSpeed);
            if (!leg2.viable)                    continue;
            if (leg2.timeMin > MAX_LEG_TIME_MIN) continue;
            if (leg2.fuelGal > maxBurn)          continue;

            var totalTimeMin = leg1.timeMin + GROUND_TIME_MIN + leg2.timeMin;
            var fuelToBuy = leg1.fuelGal;
            var fuelCost  = fuelToBuy * c.caaPrice;

            options.push({
                stop:     c,
                numStops: 1,
                legs: [
                    { from: dep.ident,   to: c.icao,     data: leg1 },
                    { from: c.icao,      to: dest.ident, data: leg2 }
                ],
                totalTimeMin: Math.round(totalTimeMin * 10) / 10,
                totalTimeHrs: formatTime(totalTimeMin),
                fuelToBuyGal: Math.round(fuelToBuy * 10) / 10,
                fuelCost:     Math.round(fuelCost * 100) / 100
            });
        }
        return options;
    }

    // ── Two-Stop Solver ────────────────────────────────────────

    function solveTwoStops(candidates, dep, dest, routeDistNM, cruiseAlt, groundSpeed) {
        var maxBurn = USABLE_FUEL_GAL - MIN_LANDING_FUEL_GAL;
        var options = [];
        var mid = routeDistNM / 2;

        var pool1 = candidates.filter(function (c) { return c.atk < mid + 150; });
        var pool2 = candidates.filter(function (c) { return c.atk > mid - 150; });

        for (var i = 0; i < pool1.length; i++) {
            var c1 = pool1[i];
            var stop1 = { ident: c1.icao, lat: c1.lat, lon: c1.lon, elevation: c1.elevation };

            var leg1 = evalLeg(dep, stop1, cruiseAlt, groundSpeed);
            if (!leg1.viable || leg1.timeMin > MAX_LEG_TIME_MIN || leg1.fuelGal > maxBurn) continue;

            for (var j = 0; j < pool2.length; j++) {
                var c2 = pool2[j];
                if (c2.icao === c1.icao) continue;

                var stop1to2dist = greatCircleDistance(c1.lat, c1.lon, c2.lat, c2.lon);
                if (stop1to2dist < MIN_STOP_DIST_NM) continue;

                var stop2 = { ident: c2.icao, lat: c2.lat, lon: c2.lon, elevation: c2.elevation };

                var leg2 = evalLeg(stop1, stop2, cruiseAlt, groundSpeed);
                if (!leg2.viable || leg2.timeMin > MAX_LEG_TIME_MIN || leg2.fuelGal > maxBurn) continue;

                var leg3 = evalLeg(stop2, dest, cruiseAlt, groundSpeed);
                if (!leg3.viable || leg3.timeMin > MAX_LEG_TIME_MIN || leg3.fuelGal > maxBurn) continue;

                var totalTimeMin = leg1.timeMin + GROUND_TIME_MIN + leg2.timeMin + GROUND_TIME_MIN + leg3.timeMin;
                var buy1 = leg1.fuelGal;
                var buy2 = leg2.fuelGal;
                var cost = (buy1 * c1.caaPrice) + (buy2 * c2.caaPrice);

                options.push({
                    stops:    [c1, c2],
                    numStops: 2,
                    legs: [
                        { from: dep.ident,  to: c1.icao,     data: leg1 },
                        { from: c1.icao,    to: c2.icao,     data: leg2 },
                        { from: c2.icao,    to: dest.ident,  data: leg3 }
                    ],
                    totalTimeMin: Math.round(totalTimeMin * 10) / 10,
                    totalTimeHrs: formatTime(totalTimeMin),
                    fuelToBuyGal: Math.round((buy1 + buy2) * 10) / 10,
                    fuelCost:     Math.round(cost * 100) / 100
                });
            }
        }
        return options;
    }

    // ── Rank & Tag Top 3 ───────────────────────────────────────

    function rankOptions(options) {
        if (options.length === 0) return [];

        var byTime = options.slice().sort(function (a, b) { return a.totalTimeMin - b.totalTimeMin; });
        var byCost = options.slice().sort(function (a, b) { return a.fuelCost - b.fuelCost; });

        var top = [];
        var used = {};

        byTime[0].tag = 'Fastest';
        top.push(byTime[0]);
        used[optKey(byTime[0])] = true;

        var cheapKey = optKey(byCost[0]);
        if (!used[cheapKey]) {
            byCost[0].tag = 'Cheapest Fuel';
            top.push(byCost[0]);
            used[cheapKey] = true;
        } else {
            top[0].tag = 'Fastest & Cheapest';
        }

        var remaining = options.filter(function (o) { return !used[optKey(o)]; });
        remaining.sort(function (a, b) {
            var sa = (a.totalTimeMin / byTime[0].totalTimeMin) + (a.fuelCost / Math.max(byCost[0].fuelCost, 1));
            var sb = (b.totalTimeMin / byTime[0].totalTimeMin) + (b.fuelCost / Math.max(byCost[0].fuelCost, 1));
            return sa - sb;
        });
        for (var i = 0; i < remaining.length && top.length < 3; i++) {
            remaining[i].tag = 'Best Value';
            top.push(remaining[i]);
        }

        return top;
    }

    function optKey(opt) {
        if (opt.stop) return opt.stop.icao;
        if (opt.stops) return opt.stops.map(function (s) { return s.icao; }).join('-');
        return '';
    }

    // ══════════════════════════════════════════════════════════
    //  PUBLIC: planFuelStops(dep, dest, bestOption)
    //
    //  dep/dest: airport objects { ident, lat, lon, elevation }
    //  bestOption: best plan from calculateAltitudeOptions()
    //      needs .cruiseAlt and .cruise.groundSpeed
    //
    //  Returns Promise → { success, error?, options[], ... }
    // ══════════════════════════════════════════════════════════

    function planFuelStops(dep, dest, bestOption) {
        var cruiseAlt   = bestOption.cruiseAlt;
        var groundSpeed = bestOption.cruise.groundSpeed;
        var routeDistNM = greatCircleDistance(dep.lat, dep.lon, dest.lat, dest.lon);

        return fetchCAAData().then(function (caaData) {
            if (!caaData) return { success: false, error: 'Could not load CAA fuel prices' };

            var corridors = [CORRIDOR_NM, 50, 75];
            var candidates = [];
            for (var ci = 0; ci < corridors.length; ci++) {
                candidates = findCandidates(dep, dest, routeDistNM, caaData, corridors[ci]);
                if (candidates.length >= 3) break;
            }

            if (candidates.length === 0) {
                return { success: false, error: 'No CAA airports found along this route' };
            }

            var options = solveSingleStop(candidates, dep, dest, cruiseAlt, groundSpeed);
            if (options.length === 0) {
                options = solveTwoStops(candidates, dep, dest, routeDistNM, cruiseAlt, groundSpeed);
            }

            if (options.length === 0) {
                return { success: false, error: 'No viable fuel stop combinations found — route may need manual planning' };
            }

            return {
                success:         true,
                options:         rankOptions(options),
                totalCandidates: candidates.length,
                altitude:        cruiseAlt
            };
        });
    }

    // ══════════════════════════════════════════════════════════
    //  PUBLIC: getFuelInfo(icao)
    //  Returns Promise → { price, fbo, source, isCAA }
    // ══════════════════════════════════════════════════════════

    function getFuelInfo(icao) {
        return fetchCAAData().then(function (caa) {
            if (caa && caa[icao]) {
                return { price: caa[icao].caa_price, fbo: caa[icao].fbo, source: 'CAA', isCAA: true };
            }
            return fetchAirNavPrice(icao);
        }).then(function (result) {
            if (result && result.source) return result;
            return { price: null, fbo: null, source: null, isCAA: false };
        });
    }

    // ── Exports ────────────────────────────────────────────────
    return {
        planFuelStops:        planFuelStops,
        getFuelInfo:          getFuelInfo,
        fetchCAAData:         fetchCAAData,
        fetchAirNavPrice:     fetchAirNavPrice,
        USABLE_FUEL_GAL:      USABLE_FUEL_GAL,
        MIN_LANDING_FUEL_GAL: MIN_LANDING_FUEL_GAL,
        MAX_LEG_TIME_MIN:     MAX_LEG_TIME_MIN,
        GROUND_TIME_MIN:      GROUND_TIME_MIN
    };

})();
