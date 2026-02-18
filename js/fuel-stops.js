// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Module
// ============================================================
// CAA-first fuel pricing with AirNav fallback
// Integrates with main flight planner
// CAA and AirNav called DIRECTLY — NEVER through proxy
// ============================================================

const FuelStops = (() => {
  console.log('[FuelStops] v6 loaded — CAA direct, AirNav direct');

  // ---- CONSTANTS ----
  const MAX_FUEL_GAL = 282;
  const MIN_LANDING_GAL = 75;
  const FUEL_STOP_TRIGGER_HRS = 3.5;
  const CORRIDOR_WIDTH_NM = 30;
  const MIN_STOP_SPACING_NM = 200;
  const DESCENT_BUFFER_NM = 60;
  const FUEL_HOUR1 = 75;
  const FUEL_HOURX = 65;
  const CLIMB_FACTOR = 1.40;
  const DESCENT_FACTOR = 1.12;

  // Workers — called DIRECTLY, never through proxy
  const CAA_URL = 'https://caa-fuel.jburns3cfi.workers.dev';
  const AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';

  // ---- STATE ----
  let caaAirports = null;
  let caaLoaded = false;

  // ========================================
  // AUTO-FETCH CAA on script load
  // ========================================
  (async function loadCAA() {
    try {
      console.log('[FuelStops] Fetching CAA fuel data (direct)...');
      const resp = await fetch(CAA_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.success && data.airports) {
        caaAirports = data.airports;
        caaLoaded = true;
        console.log(`[FuelStops] CAA data loaded: ${data.count} airports`);
      } else {
        throw new Error('CAA response missing airports');
      }
    } catch (err) {
      console.error('[FuelStops] CAA fetch failed:', err.message || err);
      caaAirports = {};
      caaLoaded = true;
    }
  })();

  // ========================================
  // AIRPORT RESOLUTION HELPERS
  // ========================================

  // Resolve flexible ident input: string, display string, or object
  function resolveIdent(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      // Handle display strings like "KSTE - Stevens Point Municipal"
      const dash = input.indexOf(' - ');
      if (dash > 0) return input.substring(0, dash).trim().toUpperCase();
      return input.trim().toUpperCase();
    }
    if (typeof input === 'object') {
      return (input.ident || input.icao || input.gps_code || input.id || '').toUpperCase();
    }
    return null;
  }

  // Find an airport in the global airportDB by ident
  function findAirport(ident) {
    if (!ident || typeof airportDB === 'undefined' || !Array.isArray(airportDB)) return null;
    const id = ident.toUpperCase();
    for (const apt of airportDB) {
      if ((apt.ident && apt.ident.toUpperCase() === id) ||
          (apt.icao && apt.icao.toUpperCase() === id) ||
          (apt.gps_code && apt.gps_code.toUpperCase() === id) ||
          (apt.id && apt.id.toUpperCase() === id) ||
          (apt.icao_code && apt.icao_code.toUpperCase() === id)) {
        return apt;
      }
    }
    return null;
  }

  // Flexible lat/lon getters
  function getLat(apt) {
    const v = parseFloat(apt.latitude_deg || apt.lat || apt.latitude);
    return isNaN(v) ? null : v;
  }
  function getLon(apt) {
    const v = parseFloat(apt.longitude_deg || apt.lon || apt.longitude);
    return isNaN(v) ? null : v;
  }

  // ========================================
  // GEOMETRY HELPERS
  // ========================================
  const DEG2RAD = Math.PI / 180;
  const RAD2DEG = 180 / Math.PI;
  const NM_PER_RAD = 3440.065;

  function toRad(d) { return d * DEG2RAD; }
  function toDeg(r) { return r * RAD2DEG; }

  function gcDist(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.asin(Math.sqrt(a)) * NM_PER_RAD;
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function crossTrackDist(pLat, pLon, startLat, startLon, endLat, endLon) {
    const d13 = gcDist(startLat, startLon, pLat, pLon) / NM_PER_RAD;
    const brng13 = toRad(bearing(startLat, startLon, pLat, pLon));
    const brng12 = toRad(bearing(startLat, startLon, endLat, endLon));
    const xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
    return Math.abs(xt * NM_PER_RAD);
  }

  function alongTrackDist(pLat, pLon, startLat, startLon, endLat, endLon) {
    const d13 = gcDist(startLat, startLon, pLat, pLon) / NM_PER_RAD;
    const brng13 = toRad(bearing(startLat, startLon, pLat, pLon));
    const brng12 = toRad(bearing(startLat, startLon, endLat, endLon));
    const xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
    const at = Math.acos(Math.cos(d13) / Math.cos(xt));
    return at * NM_PER_RAD;
  }

  // ========================================
  // FUEL BURN CALCULATIONS
  // ========================================
  function calcFuelBurn(hours) {
    if (hours <= 0) return 0;
    if (hours <= 1) return FUEL_HOUR1 * hours;
    return FUEL_HOUR1 + FUEL_HOURX * (hours - 1);
  }

  function fuelRemaining(startFuel, flightHours) {
    return startFuel - calcFuelBurn(flightHours);
  }

  function maxFlightTime(startFuel) {
    const available = startFuel - MIN_LANDING_GAL;
    if (available <= 0) return 0;
    if (available <= FUEL_HOUR1) return available / FUEL_HOUR1;
    return 1 + (available - FUEL_HOUR1) / FUEL_HOURX;
  }

  // ========================================
  // CAA / AIRNAV FUEL HELPERS
  // ========================================
  function isCAA(icao) {
    return caaAirports && caaAirports[icao] ? true : false;
  }

  function getCAAData(icao) {
    if (!caaAirports || !caaAirports[icao]) return null;
    const d = caaAirports[icao];
    return {
      fbo: d.fbo,
      retailPrice: d.retail,
      caaPrice: d.caa_price,
      savings: d.retail && d.caa_price ? +(d.retail - d.caa_price).toFixed(2) : 0,
      source: 'CAA'
    };
  }

  async function fetchAirNavFuel(icao) {
    try {
      const resp = await fetch(`${AIRNAV_URL}/?id=${icao}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.jetA && data.jetA.price) {
        return {
          fbo: data.jetA.fbo || 'Unknown FBO',
          retailPrice: data.jetA.price,
          caaPrice: null,
          savings: 0,
          source: 'AirNav'
        };
      }
      return null;
    } catch (err) {
      console.warn(`[FuelStops] AirNav fetch failed for ${icao}:`, err);
      return null;
    }
  }

  // ========================================
  // findCandidates — SYNCHRONOUS entry point
  // Called by app.js: FuelStops.findCandidates(dep, dest, totalDist)
  // ========================================
  function findCandidates(dep, dest, totalDist) {
    const depIdent = resolveIdent(dep);
    const destIdent = resolveIdent(dest);

    if (!depIdent || !destIdent) {
      console.error('[FuelStops] findCandidates: missing dep or dest');
      return [];
    }

    const depApt = findAirport(depIdent);
    const destApt = findAirport(destIdent);

    if (!depApt || !destApt) {
      console.error('[FuelStops] findCandidates: airport not found in DB', depIdent, destIdent);
      return [];
    }

    const depLat = getLat(depApt), depLon = getLon(depApt);
    const destLat = getLat(destApt), destLon = getLon(destApt);

    if (depLat === null || depLon === null || destLat === null || destLon === null) {
      console.error('[FuelStops] findCandidates: missing lat/lon');
      return [];
    }

    const routeDist = totalDist || gcDist(depLat, depLon, destLat, destLon);
    console.log(`[FuelStops] Searching candidates: ${depIdent} -> ${destIdent}, totalDist=${routeDist}`);

    // Bounding box for quick pre-filter
    const minLat = Math.min(depLat, destLat) - 1.5;
    const maxLat = Math.max(depLat, destLat) + 1.5;
    const minLon = Math.min(depLon, destLon) - 2.0;
    const maxLon = Math.max(depLon, destLon) + 2.0;

    const candidates = [];
    let corridorCount = 0;

    for (const apt of airportDB) {
      // Medium and large airports only — no grass strips
      if (apt.type !== 'medium_airport' && apt.type !== 'large_airport') continue;

      const lat = getLat(apt);
      const lon = getLon(apt);
      if (lat === null || lon === null) continue;

      // Bounding box quick check
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      // Skip departure and destination
      const ident = (apt.ident || '').toUpperCase();
      if (ident === depIdent || ident === destIdent) continue;

      // Cross-track: must be within corridor
      const xtDist = crossTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (xtDist > CORRIDOR_WIDTH_NM) continue;

      // Along-track distance from departure
      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (atDist < 0 || atDist > routeDist) continue;

      corridorCount++;

      // Must be ≥200nm from departure
      if (atDist < MIN_STOP_SPACING_NM) continue;

      // Descent buffer: skip airports too close to destination
      if ((routeDist - atDist) < DESCENT_BUFFER_NM) continue;

      const distFromDest = Math.round(routeDist - atDist);

      candidates.push({
        airport: {
          ident: ident,
          name: apt.name || '',
          municipality: apt.municipality || '',
          region: apt.iso_region || apt.region || ''
        },
        lat: lat,
        lon: lon,
        distFromDep: Math.round(atDist),
        distFromDest: distFromDest,
        distOffRoute: Math.round(xtDist * 10) / 10,
        type: apt.type,
        isCaa: isCAA(ident)
      });
    }

    // Sort: CAA airports first (when CAA data loaded), then by distance from departure
    candidates.sort((a, b) => {
      if (caaLoaded && a.isCaa !== b.isCaa) return a.isCaa ? -1 : 1;
      return a.distFromDep - b.distFromDep;
    });

    // Limit to top 8
    const results = candidates.slice(0, 8);

    console.log(`[FuelStops] Found ${results.length} fuel stop candidates from ${corridorCount} in corridor`);

    // Auto-enhance the fuel table after a short delay (let app.js render first)
    setTimeout(() => enhanceFuelTable(results), 200);

    return results;
  }

  // ========================================
  // TABLE ENHANCEMENT — Adds JET A + FBO columns
  // ========================================
  function enhanceFuelTable(candidates) {
    // Find the fuel stops table rendered by app.js
    const table = document.querySelector('#fuel-stops-table') ||
                  document.querySelector('.fuel-stops table') ||
                  document.querySelector('[data-fuel-table]');

    if (!table) {
      // Try finding any table that contains our candidate ICAOs
      const allTables = document.querySelectorAll('table');
      let fuelTable = null;
      for (const t of allTables) {
        if (candidates.length > 0 && t.textContent.includes(candidates[0].airport.ident)) {
          fuelTable = t;
          break;
        }
      }
      if (!fuelTable) {
        console.warn('[FuelStops] No fuel table found to enhance');
        return;
      }
      enhanceTableElement(fuelTable, candidates);
    } else {
      enhanceTableElement(table, candidates);
    }
  }

  function enhanceTableElement(table, candidates) {
    console.log('[FuelStops] Enhancing fuel table with JET A + FBO columns');

    // Add header columns if not already present
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (headerRow && !headerRow.querySelector('.fuel-jeta-col')) {
      const thJetA = document.createElement('th');
      thJetA.className = 'fuel-jeta-col';
      thJetA.textContent = 'JET A';
      thJetA.style.cssText = 'padding:6px 8px;text-align:right;';
      const thFBO = document.createElement('th');
      thFBO.className = 'fuel-fbo-col';
      thFBO.textContent = 'FBO';
      thFBO.style.cssText = 'padding:6px 8px;text-align:left;';
      headerRow.appendChild(thJetA);
      headerRow.appendChild(thFBO);
    }

    // Find data rows and add fuel cells
    const rows = table.querySelectorAll('tbody tr') || table.querySelectorAll('tr:not(:first-child)');
    rows.forEach((row, idx) => {
      if (row.querySelector('.fuel-jeta-col')) return; // Already enhanced

      const candidate = candidates[idx];
      if (!candidate) return;

      const tdPrice = document.createElement('td');
      tdPrice.className = 'fuel-jeta-col';
      tdPrice.style.cssText = 'padding:6px 8px;text-align:right;white-space:nowrap;';

      const tdFBO = document.createElement('td');
      tdFBO.className = 'fuel-fbo-col';
      tdFBO.style.cssText = 'padding:6px 8px;text-align:left;';

      const icao = candidate.airport.ident;

      if (candidate.isCaa && caaAirports && caaAirports[icao]) {
        // CAA airport — show green badge, member price, retail crossed out
        const caa = caaAirports[icao];
        tdPrice.innerHTML =
          '<span style="background:#22c55e;color:#fff;font-size:11px;padding:1px 5px;border-radius:3px;margin-right:4px;">CAA</span>' +
          '<strong style="color:#22c55e;">$' + (caa.caa_price || 0).toFixed(2) + '</strong> ' +
          '<span style="text-decoration:line-through;color:#999;font-size:12px;">$' + (caa.retail || 0).toFixed(2) + '</span>' +
          '<span style="color:#22c55e;font-size:11px;margin-left:3px;">(-$' + ((caa.retail || 0) - (caa.caa_price || 0)).toFixed(2) + ')</span>';
        tdFBO.textContent = caa.fbo || '';
      } else {
        // Non-CAA — fetch from AirNav, show loading
        tdPrice.textContent = 'loading…';
        tdFBO.textContent = '';
        fetchAirNavFuel(icao).then(fuel => {
          if (fuel) {
            tdPrice.innerHTML = '<strong>$' + fuel.retailPrice.toFixed(2) + '</strong>';
            tdFBO.textContent = fuel.fbo;
          } else {
            tdPrice.textContent = '—';
            tdFBO.textContent = '—';
          }
        });
      }

      row.appendChild(tdPrice);
      row.appendChild(tdFBO);
    });
  }

  // ========================================
  // ADVANCED FUNCTIONS (for future multi-stop optimization)
  // ========================================

  // Descent distances (nm) from POH, corrected by DESCENT_FACTOR
  const DESCENT_DIST_NM = {
    31000: 101 * DESCENT_FACTOR,
    30000: 97 * DESCENT_FACTOR,
    29000: 93 * DESCENT_FACTOR,
    28000: 89 * DESCENT_FACTOR,
    27000: 85 * DESCENT_FACTOR,
    26000: 81 * DESCENT_FACTOR,
    25000: 77 * DESCENT_FACTOR,
    24000: 74 * DESCENT_FACTOR,
    23000: 70 * DESCENT_FACTOR,
    22000: 66 * DESCENT_FACTOR,
    21000: 62 * DESCENT_FACTOR,
    20000: 59 * DESCENT_FACTOR,
    19000: 55 * DESCENT_FACTOR,
    18000: 53 * DESCENT_FACTOR,
    16000: 46 * DESCENT_FACTOR,
    14000: 40 * DESCENT_FACTOR,
    12000: 33 * DESCENT_FACTOR,
    10000: 27 * DESCENT_FACTOR,
  };

  function getDescentDist(altitudeFt) {
    const alts = Object.keys(DESCENT_DIST_NM).map(Number).sort((a, b) => b - a);
    for (const alt of alts) {
      if (altitudeFt >= alt) return DESCENT_DIST_NM[alt];
    }
    return 27 * DESCENT_FACTOR;
  }

  async function getAirportFuel(icao) {
    const caa = getCAAData(icao);
    if (caa) return caa;
    return await fetchAirNavFuel(icao);
  }

  // ========================================
  // PUBLIC API
  // ========================================
  return {
    findCandidates,        // SYNCHRONOUS — called by app.js
    getAirportFuel,        // Get fuel pricing for any airport
    isCAA,                 // Quick CAA check
    calcFuelBurn,          // Fuel burn for flight time
    fuelRemaining,         // Remaining fuel after a leg
    maxFlightTime,         // Max flight time from fuel load
    fetchAirNavFuel,       // Direct AirNav lookup

    // Constants for display
    MAX_FUEL: MAX_FUEL_GAL,
    MIN_LANDING: MIN_LANDING_GAL,
    TRIGGER_HOURS: FUEL_STOP_TRIGGER_HRS
  };

})();
