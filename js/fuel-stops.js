// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Candidate Finder + Pricing
// Must load BEFORE app.js in index.html
// ============================================================

const FuelStops = (() => {
    'use strict';

    // ----- Internal state -----
    let caaData = null;        // {KXXX: {fbo, city, state, retail, caa_price}}
    let caaLoaded = false;
    let lastCandidates = [];   // Store last findCandidates result for enrichment
    let fuelCache = {};        // Per-airport fuel cache {KXXX: {fbo, price, caaPrice, isCAA}}

    // ----- Constants -----
    const CAA_URL = 'https://caa-fuel.jburns3cfi.workers.dev';
    const AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';
    const CORRIDOR_NM = 30;
    const MIN_FROM_DEP_NM = 200;
    const DESCENT_BUFFER_NM = 60;   // Exclude airports this close to destination

    // =========================================================
    // AUTO-FETCH CAA DATA ON SCRIPT LOAD
    // =========================================================
    (function autoFetchCAA() {
        fetch(CAA_URL)
            .then(r => r.json())
            .then(data => {
                if (data.success && data.airports) {
                    caaData = data.airports;
                    caaLoaded = true;
                    // Pre-populate fuelCache with CAA data
                    for (const ident in caaData) {
                        const a = caaData[ident];
                        fuelCache[ident] = {
                            fbo: a.fbo,
                            price: a.caa_price,
                            retailPrice: a.retail,
                            caaPrice: a.caa_price,
                            isCAA: true,
                            source: 'CAA'
                        };
                    }
                    console.log(`[FuelStops] CAA data loaded: ${data.count} airports`);
                    // If table is already rendered, enhance it now
                    enhanceFuelTable();
                }
            })
            .catch(err => console.warn('[FuelStops] CAA fetch failed:', err));
    })();

    // =========================================================
    // MATH HELPERS
    // =========================================================
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    function haversineNM(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // Earth radius in nautical miles
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    function crossTrackDistNM(aptLat, aptLon, depLat, depLon, destLat, destLon) {
        // Cross-track distance from a point to the great circle path dep→dest
        const R = 3440.065;
        const d13 = haversineNM(depLat, depLon, aptLat, aptLon) / R; // angular dist dep→apt
        const brng13 = bearingRad(depLat, depLon, aptLat, aptLon);
        const brng12 = bearingRad(depLat, depLon, destLat, destLon);
        const xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
        return Math.abs(xt * R);
    }

    function bearingRad(lat1, lon1, lat2, lon2) {
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                  Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return Math.atan2(y, x);
    }

    // =========================================================
    // findCandidates — SYNCHRONOUS (app.js calls without await)
    // =========================================================
    function findCandidates(dep, dest, totalDist) {
        if (typeof airportDB === 'undefined' || !airportDB || airportDB.length === 0) {
            console.warn('[FuelStops] airportDB not loaded');
            return [];
        }

        // Get dep/dest coordinates from airportDB
        const depApt = airportDB.find(a => a.ident === dep);
        const destApt = airportDB.find(a => a.ident === dest);
        if (!depApt || !destApt) {
            console.warn('[FuelStops] Could not find dep or dest in airportDB');
            return [];
        }

        const depLat = parseFloat(depApt.latitude_deg);
        const depLon = parseFloat(depApt.longitude_deg);
        const destLat = parseFloat(destApt.latitude_deg);
        const destLon = parseFloat(destApt.longitude_deg);

        // Filter candidates
        const inCorridor = [];
        for (const apt of airportDB) {
            // Skip departure, destination
            if (apt.ident === dep || apt.ident === dest) continue;

            // Medium and large airports only
            const t = (apt.type || '').toLowerCase();
            if (t.indexOf('medium') === -1 && t.indexOf('large') === -1) continue;

            // Must be in the US (ident starts with K and is 4 chars, or starts with P for Alaska/Hawaii)
            const id = apt.ident || '';
            if (id.length !== 4) continue;
            if (id[0] !== 'K' && id[0] !== 'P') continue;

            const aptLat = parseFloat(apt.latitude_deg);
            const aptLon = parseFloat(apt.longitude_deg);
            if (isNaN(aptLat) || isNaN(aptLon)) continue;

            const distFromDep = haversineNM(depLat, depLon, aptLat, aptLon);
            const distFromDest = haversineNM(aptLat, aptLon, destLat, destLon);

            // Must be ≥200nm from departure
            if (distFromDep < MIN_FROM_DEP_NM) continue;

            // Skip if in descent profile (too close to destination)
            if (distFromDest < DESCENT_BUFFER_NM) continue;

            // Cross-track (off-route) distance
            const offRoute = crossTrackDistNM(aptLat, aptLon, depLat, depLon, destLat, destLon);

            // Must be within corridor
            if (offRoute > CORRIDOR_NM) continue;

            inCorridor.push({
                airport: {
                    ident: apt.ident,
                    name: apt.name,
                    municipality: apt.municipality || '',
                    region: (apt.iso_region || '').replace('US-', '')
                },
                distFromDep: Math.round(distFromDep * 10) / 10,
                distFromDest: Math.round(distFromDest * 10) / 10,
                distOffRoute: Math.round(offRoute * 10) / 10
            });
        }

        // Sort: CAA airports first (if data loaded), then by off-route distance
        inCorridor.sort((a, b) => {
            if (caaLoaded) {
                const aCAA = caaData[a.airport.ident] ? 1 : 0;
                const bCAA = caaData[b.airport.ident] ? 1 : 0;
                if (aCAA !== bCAA) return bCAA - aCAA; // CAA first
            }
            return a.distOffRoute - b.distOffRoute;
        });

        // Take top 8
        const results = inCorridor.slice(0, 8);

        console.log(`[FuelStops] Found ${results.length} fuel stop candidates from ${inCorridor.length} in corridor`);

        // Store for enrichment
        lastCandidates = results;

        // Schedule async fuel enrichment after app.js renders the table
        setTimeout(() => enhanceFuelTable(), 150);

        return results;
    }

    // =========================================================
    // FUEL DATA FETCHING
    // =========================================================
    async function fetchAirNavFuel(ident) {
        if (fuelCache[ident]) return fuelCache[ident];
        try {
            const resp = await fetch(`${AIRNAV_URL}?id=${ident}`);
            const data = await resp.json();
            if (data.jetA && data.jetA.price) {
                const info = {
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
        } catch (err) {
            console.warn(`[FuelStops] AirNav fetch failed for ${ident}:`, err);
        }
        return null;
    }

    function getCachedFuel(ident) {
        return fuelCache[ident] || null;
    }

    // =========================================================
    // TABLE ENHANCEMENT — Self-contained, no app.js changes
    // =========================================================
    function findFuelStopTable() {
        // Strategy: find the table inside the fuel stops section
        // Look for a table that has "FROM DEP" in a header cell
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            const headerText = (table.querySelector('thead') || table).textContent || '';
            if (headerText.indexOf('FROM DEP') !== -1 || headerText.indexOf('FUEL') !== -1) {
                return table;
            }
        }
        // Fallback: look for section/div with "fuel" in id or heading
        const sections = document.querySelectorAll('[id*="fuel" i], [id*="stop" i]');
        for (const sec of sections) {
            const t = sec.querySelector('table');
            if (t) return t;
        }
        return null;
    }

    function enhanceFuelTable() {
        if (lastCandidates.length === 0) return;

        const table = findFuelStopTable();
        if (!table) {
            // Table not rendered yet, retry
            setTimeout(() => enhanceFuelTable(), 300);
            return;
        }

        // Check if already enhanced
        if (table.dataset.fuelEnhanced === 'true') {
            // Already enhanced — just update pricing cells
            updatePricingCells();
            return;
        }

        // Mark as enhanced
        table.dataset.fuelEnhanced = 'true';

        // Add header columns
        const thead = table.querySelector('thead');
        if (thead) {
            const headerRow = thead.querySelector('tr');
            if (headerRow) {
                const thFuel = document.createElement('th');
                thFuel.textContent = 'JET A';
                thFuel.style.cssText = 'text-align:right; white-space:nowrap;';
                headerRow.appendChild(thFuel);

                const thFBO = document.createElement('th');
                thFBO.textContent = 'FBO';
                thFBO.style.cssText = 'text-align:left;';
                headerRow.appendChild(thFBO);
            }
        }

        // Add data cells to each row
        const tbody = table.querySelector('tbody') || table;
        const rows = tbody.querySelectorAll('tr');
        let candidateIdx = 0;

        for (const row of rows) {
            // Skip header rows
            if (row.querySelector('th')) continue;
            if (candidateIdx >= lastCandidates.length) break;

            const candidate = lastCandidates[candidateIdx];
            const ident = candidate.airport.ident;

            // Fuel price cell
            const tdFuel = document.createElement('td');
            tdFuel.id = `fuel-price-${ident}`;
            tdFuel.style.cssText = 'text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums;';

            // FBO cell
            const tdFBO = document.createElement('td');
            tdFBO.id = `fuel-fbo-${ident}`;
            tdFBO.style.cssText = 'text-align:left; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

            const cached = getCachedFuel(ident);
            if (cached) {
                fillFuelCells(tdFuel, tdFBO, cached);
            } else {
                tdFuel.innerHTML = '<span style="color:#888; font-size:0.85em;">loading…</span>';
                tdFBO.textContent = '';
                // Fetch from AirNav
                fetchAirNavFuel(ident).then(info => {
                    if (info) {
                        fillFuelCells(tdFuel, tdFBO, info);
                    } else {
                        tdFuel.innerHTML = '<span style="color:#999; font-size:0.85em;">—</span>';
                        tdFBO.textContent = '';
                    }
                });
            }

            row.appendChild(tdFuel);
            row.appendChild(tdFBO);
            candidateIdx++;
        }
    }

    function fillFuelCells(tdFuel, tdFBO, info) {
        if (info.isCAA) {
            // CAA airport — show CAA price with badge, retail crossed out, savings
            const savings = (info.retailPrice - info.caaPrice).toFixed(2);
            tdFuel.innerHTML =
                `<span style="background:#1a7f37; color:#fff; font-size:0.7em; padding:1px 4px; border-radius:3px; vertical-align:middle; margin-right:4px;">CAA</span>` +
                `<strong style="color:#1a7f37;">$${info.caaPrice.toFixed(2)}</strong>` +
                `<br><span style="color:#888; font-size:0.8em; text-decoration:line-through;">$${info.retailPrice.toFixed(2)}</span>` +
                ` <span style="color:#1a7f37; font-size:0.8em;">save $${savings}</span>`;
        } else {
            // Non-CAA — show retail price
            tdFuel.innerHTML = `<strong>$${info.price.toFixed(2)}</strong>`;
        }
        tdFBO.textContent = info.fbo || '';
        tdFBO.title = info.fbo || ''; // Tooltip for truncated names
    }

    function updatePricingCells() {
        // Called when CAA data arrives after table was already enhanced
        for (const candidate of lastCandidates) {
            const ident = candidate.airport.ident;
            const tdFuel = document.getElementById(`fuel-price-${ident}`);
            const tdFBO = document.getElementById(`fuel-fbo-${ident}`);
            if (!tdFuel || !tdFBO) continue;

            const cached = getCachedFuel(ident);
            if (cached) {
                fillFuelCells(tdFuel, tdFBO, cached);
            }
        }
    }

    // =========================================================
    // PUBLIC API
    // =========================================================
    return {
        findCandidates,
        getCachedFuel,
        fetchAirNavFuel,
        enhanceFuelTable,
        init() {
            // CAA data already auto-fetches on load
            // This is here for compatibility if app.js calls FuelStops.init()
            console.log('[FuelStops] init called — CAA auto-fetch already in progress');
        },
        get caaLoaded() { return caaLoaded; },
        get caaAirports() { return caaData; }
    };
})();
