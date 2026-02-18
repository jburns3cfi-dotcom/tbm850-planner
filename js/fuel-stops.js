// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Module v8
// ============================================================
// CAA-first fuel pricing with AirNav fallback
// Ranking: Fastest / Cheapest / Best
// 2-stop strategy for long routes
// v8: Tighter spacing, darker text, FROM DEP column, CAA badges in 2-stop
// CAA and AirNav called DIRECTLY — NEVER through proxy
// ============================================================

const FuelStops = (() => {
  console.log('[FuelStops] v8 loaded — refined display, darker colors, CAA/FBO/price visible');

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
  const GROUND_STOP_MIN = 30;         // Minutes on ground at fuel stop

  // Workers — called DIRECTLY, never through proxy
  const CAA_URL = 'https://caa-fuel.jburns3cfi.workers.dev';
  const AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';

  // ---- STATE ----
  let caaAirports = null;
  let caaLoaded = false;
  let lastCandidates = [];
  let lastDepIdent = '';
  let lastDestIdent = '';
  let lastTotalDist = 0;

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
  function resolveIdent(input) {
    if (!input) return null;
    if (typeof input === 'string') {
      const dash = input.indexOf(' - ');
      if (dash > 0) return input.substring(0, dash).trim().toUpperCase();
      return input.trim().toUpperCase();
    }
    if (typeof input === 'object') {
      return (input.ident || input.icao || input.gps_code || input.id || '').toUpperCase();
    }
    return null;
  }

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

  function maxRangeNM(gs) {
    return maxFlightTime(MAX_FUEL_GAL) * gs;
  }

  function isLegSafe(distNM, gs) {
    if (gs <= 0) return false;
    const timeHrs = distNM / gs;
    const burn = calcFuelBurn(timeHrs);
    return (MAX_FUEL_GAL - burn) >= MIN_LANDING_GAL;
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

  async function getAirportFuel(icao) {
    const caa = getCAAData(icao);
    if (caa) return caa;
    return await fetchAirNavFuel(icao);
  }

  // ========================================
  // DOM PARSING — Read altitude data from app.js table
  // ========================================
  function parseAltitudeOptions() {
    const altitudes = [];
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;
      const headerText = headerRow.textContent.toUpperCase();
      if (!headerText.includes('ALTITUDE') || !headerText.includes('GS')) continue;

      // Find column indices
      const headers = [];
      headerRow.querySelectorAll('th, td').forEach(cell => {
        headers.push(cell.textContent.trim().toUpperCase());
      });

      const altIdx = headers.findIndex(h => h.includes('ALT'));
      const timeIdx = headers.findIndex(h => h === 'TIME' || h.includes('TIME'));
      const fuelIdx = headers.findIndex(h => h.includes('FUEL'));
      const tasIdx = headers.findIndex(h => h === 'TAS');
      const gsIdx = headers.findIndex(h => h === 'GS');
      const windIdx = headers.findIndex(h => h.includes('WIND'));

      const rows = table.querySelectorAll('tr');
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('th, td');
        if (cells.length < 4) continue;

        const altText = cells[altIdx >= 0 ? altIdx : 0].textContent.trim();
        if (!altText.match(/FL\d+/)) continue;

        const flLevel = parseInt(altText.replace('FL', ''));
        const altitude = flLevel * 100;

        const timeText = cells[timeIdx >= 0 ? timeIdx : 1].textContent.trim();
        const timeParts = timeText.split(':');
        const timeHrs = timeParts.length === 2
          ? parseInt(timeParts[0]) + parseInt(timeParts[1]) / 60
          : parseFloat(timeText);

        const fuel = parseFloat(cells[fuelIdx >= 0 ? fuelIdx : 2].textContent);
        const tas = parseFloat(cells[tasIdx >= 0 ? tasIdx : 3].textContent);
        const gs = parseFloat(cells[gsIdx >= 0 ? gsIdx : 4].textContent);

        let wind = 0;
        if (windIdx >= 0 && cells[windIdx]) {
          wind = parseFloat(cells[windIdx].textContent.replace(/[^0-9.\-+]/g, ''));
        }

        if (!isNaN(altitude) && !isNaN(gs) && gs > 0) {
          altitudes.push({ altitude, flLevel, timeHrs, fuel, tas, gs, wind, label: altText });
        }
      }

      if (altitudes.length > 0) break;
    }

    if (altitudes.length === 0) {
      console.warn('[FuelStops] Could not parse altitude table from DOM');
    } else {
      console.log(`[FuelStops] Parsed ${altitudes.length} altitude options from DOM`);
    }
    return altitudes;
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
      console.error('[FuelStops] findCandidates: airport not found', depIdent, destIdent);
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

    // Save for ranking phase
    lastDepIdent = depIdent;
    lastDestIdent = destIdent;
    lastTotalDist = routeDist;

    const minLat = Math.min(depLat, destLat) - 1.5;
    const maxLat = Math.max(depLat, destLat) + 1.5;
    const minLon = Math.min(depLon, destLon) - 2.0;
    const maxLon = Math.max(depLon, destLon) + 2.0;

    const candidates = [];
    let corridorCount = 0;

    for (const apt of airportDB) {
      if (apt.type !== 'medium_airport' && apt.type !== 'large_airport') continue;
      const lat = getLat(apt);
      const lon = getLon(apt);
      if (lat === null || lon === null) continue;
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      const ident = (apt.ident || '').toUpperCase();
      if (ident === depIdent || ident === destIdent) continue;

      const xtDist = crossTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (xtDist > CORRIDOR_WIDTH_NM) continue;

      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (atDist < 0 || atDist > routeDist) continue;

      corridorCount++;
      if (atDist < MIN_STOP_SPACING_NM) continue;
      if ((routeDist - atDist) < DESCENT_BUFFER_NM) continue;

      candidates.push({
        airport: {
          ident: ident,
          name: apt.name || '',
          municipality: apt.municipality || '',
          region: apt.iso_region || apt.region || ''
        },
        lat, lon,
        distFromDep: Math.round(atDist),
        distFromDest: Math.round(routeDist - atDist),
        distOffRoute: Math.round(xtDist * 10) / 10,
        type: apt.type,
        isCaa: isCAA(ident)
      });
    }

    // Sort: CAA first, then by distance from departure
    candidates.sort((a, b) => {
      if (caaLoaded && a.isCaa !== b.isCaa) return a.isCaa ? -1 : 1;
      return a.distFromDep - b.distFromDep;
    });

    const results = candidates.slice(0, 8);
    lastCandidates = results;
    console.log(`[FuelStops] Found ${results.length} fuel stop candidates from ${corridorCount} in corridor`);

    // Run ranking analysis after app.js renders
    setTimeout(() => runRankingAnalysis(), 250);

    return results;
  }

  // ========================================
  // RANKING ANALYSIS — async, runs after DOM render
  // ========================================
  async function runRankingAnalysis() {
    console.log('[FuelStops] Starting ranking analysis...');

    const candidates = lastCandidates;
    if (candidates.length === 0) return;

    // 1. Parse altitude options from DOM
    const altitudes = parseAltitudeOptions();
    if (altitudes.length === 0) {
      enhanceFuelTableBasic(candidates);
      return;
    }

    // 2. Get departure airport fuel price
    const depFuel = await getAirportFuel(lastDepIdent);
    const depPrice = depFuel ? (depFuel.caaPrice || depFuel.retailPrice || 6.00) : 6.00;
    const depFBO = depFuel ? depFuel.fbo : '';

    // 3. Fetch fuel prices for all candidates in parallel
    const priceMap = {};
    await Promise.all(candidates.map(async (c) => {
      const icao = c.airport.ident;
      priceMap[icao] = getCAAData(icao) || await fetchAirNavFuel(icao);
    }));

    // 4. Score 1-stop options: each candidate × each altitude
    const singleStops = [];
    for (const cand of candidates) {
      const icao = cand.airport.ident;
      const fuel = priceMap[icao];
      const stopPrice = fuel ? (fuel.caaPrice || fuel.retailPrice || 6.00) : 6.00;

      for (const alt of altitudes) {
        const leg1Dist = cand.distFromDep + (cand.distOffRoute * 2);
        const leg2Dist = cand.distFromDest + (cand.distOffRoute * 2);

        if (!isLegSafe(leg1Dist, alt.gs) || !isLegSafe(leg2Dist, alt.gs)) continue;

        const leg1Time = leg1Dist / alt.gs;
        const leg2Time = leg2Dist / alt.gs;
        const totalTime = leg1Time + leg2Time + (GROUND_STOP_MIN / 60);

        const leg1Fuel = calcFuelBurn(leg1Time);
        const leg2Fuel = calcFuelBurn(leg2Time);
        const totalCost = (leg1Fuel * depPrice) + (leg2Fuel * stopPrice);

        singleStops.push({
          stop: cand, icao, fbo: fuel ? fuel.fbo : '—',
          stopPrice, isCaa: cand.isCaa, fuelData: fuel,
          altitude: alt.label, flLevel: alt.flLevel, gs: alt.gs,
          leg1Dist: Math.round(leg1Dist), leg2Dist: Math.round(leg2Dist),
          leg1Time, leg2Time,
          leg1Fuel: Math.round(leg1Fuel), leg2Fuel: Math.round(leg2Fuel),
          leg1Landing: Math.round(MAX_FUEL_GAL - leg1Fuel),
          leg2Landing: Math.round(MAX_FUEL_GAL - leg2Fuel),
          totalTime, totalFuel: Math.round(leg1Fuel + leg2Fuel), totalCost,
          safe: true
        });
      }
    }

    console.log(`[FuelStops] ${singleStops.length} safe 1-stop options scored`);

    // 5. 2-stop analysis
    const twoStops = await analyze2Stop(candidates, altitudes, depPrice, priceMap);

    // 6. Render
    renderRankedResults(singleStops, twoStops, altitudes, depPrice, depFBO, priceMap);
  }

  // ========================================
  // 2-STOP ANALYSIS
  // ========================================
  async function analyze2Stop(candidates, altitudes, depPrice, priceMap) {
    const results = [];
    const bestGS = Math.max(...altitudes.map(a => a.gs));

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const stop1 = candidates[i];
        const stop2 = candidates[j];
        if (stop1.distFromDep >= stop2.distFromDep) continue;

        const stopSpacing = stop2.distFromDep - stop1.distFromDep;
        if (stopSpacing < MIN_STOP_SPACING_NM) continue;

        const fuel1 = priceMap[stop1.airport.ident];
        const fuel2 = priceMap[stop2.airport.ident];
        const price1 = fuel1 ? (fuel1.caaPrice || fuel1.retailPrice || 6.00) : 6.00;
        const price2 = fuel2 ? (fuel2.caaPrice || fuel2.retailPrice || 6.00) : 6.00;

        for (const alt of altitudes) {
          const leg1Dist = stop1.distFromDep + (stop1.distOffRoute * 2);
          const leg2Dist = stopSpacing + (stop1.distOffRoute + stop2.distOffRoute);
          const leg3Dist = stop2.distFromDest + (stop2.distOffRoute * 2);

          if (!isLegSafe(leg1Dist, alt.gs)) continue;
          if (!isLegSafe(leg2Dist, alt.gs)) continue;
          if (!isLegSafe(leg3Dist, alt.gs)) continue;

          const leg1Time = leg1Dist / alt.gs;
          const leg2Time = leg2Dist / alt.gs;
          const leg3Time = leg3Dist / alt.gs;
          const totalTime = leg1Time + leg2Time + leg3Time + (GROUND_STOP_MIN * 2 / 60);

          const leg1Fuel = calcFuelBurn(leg1Time);
          const leg2Fuel = calcFuelBurn(leg2Time);
          const leg3Fuel = calcFuelBurn(leg3Time);
          const totalCost = (leg1Fuel * depPrice) + (leg2Fuel * price1) + (leg3Fuel * price2);

          results.push({
            stop1, stop2,
            icao1: stop1.airport.ident, icao2: stop2.airport.ident,
            fbo1: fuel1 ? fuel1.fbo : '—', fbo2: fuel2 ? fuel2.fbo : '—',
            price1, price2,
            isCaa1: stop1.isCaa, isCaa2: stop2.isCaa,
            altitude: alt.label, flLevel: alt.flLevel, gs: alt.gs,
            leg1Dist: Math.round(leg1Dist), leg2Dist: Math.round(leg2Dist), leg3Dist: Math.round(leg3Dist),
            leg1Time, leg2Time, leg3Time,
            leg1Fuel: Math.round(leg1Fuel), leg2Fuel: Math.round(leg2Fuel), leg3Fuel: Math.round(leg3Fuel),
            totalTime, totalFuel: Math.round(leg1Fuel + leg2Fuel + leg3Fuel), totalCost
          });
        }
      }
    }

    results.sort((a, b) => a.totalCost - b.totalCost);
    console.log(`[FuelStops] ${results.length} valid 2-stop options analyzed`);
    return results;
  }

  // ========================================
  // RENDER RANKED RESULTS
  // ========================================
  function renderRankedResults(singleStops, twoStops, altitudes, depPrice, depFBO, priceMap) {
    console.log('[FuelStops] Rendering ranked results');

    // Find existing fuel stops area
    let container = document.querySelector('#fuel-stops-table') ||
                    document.querySelector('.fuel-stops') ||
                    document.querySelector('[data-fuel-table]');

    if (!container && lastCandidates.length > 0) {
      const allTables = document.querySelectorAll('table');
      for (const t of allTables) {
        if (t.textContent.includes(lastCandidates[0].airport.ident)) {
          container = t.parentElement || t;
          break;
        }
      }
    }
    if (!container) {
      console.warn('[FuelStops] No container found for ranked results');
      return;
    }

    const bestGS = Math.max(...altitudes.map(a => a.gs));
    const maxLeg = maxRangeNM(bestGS);
    const needs2Stops = singleStops.length === 0;

    // Find fastest and cheapest 1-stop
    let fastest1 = null, cheapest1 = null;
    if (singleStops.length > 0) {
      fastest1 = singleStops.reduce((a, b) => a.totalTime < b.totalTime ? a : b);
      cheapest1 = singleStops.reduce((a, b) => a.totalCost < b.totalCost ? a : b);
    }

    // Best 2-stop options
    const cheapest2 = twoStops.length > 0 ? twoStops[0] : null;
    const fastest2 = twoStops.length > 0
      ? twoStops.reduce((a, b) => a.totalTime < b.totalTime ? a : b) : null;

    // Group 1-stop by airport, keeping cheapest alt per airport
    const bestPerAirport = {};
    const fastPerAirport = {};
    for (const opt of singleStops) {
      if (!bestPerAirport[opt.icao] || opt.totalCost < bestPerAirport[opt.icao].totalCost) {
        bestPerAirport[opt.icao] = opt;
      }
      if (!fastPerAirport[opt.icao] || opt.totalTime < fastPerAirport[opt.icao].totalTime) {
        fastPerAirport[opt.icao] = opt;
      }
    }

    const rankedAirports = Object.values(bestPerAirport);
    rankedAirports.sort((a, b) => a.totalCost - b.totalCost);

    // ---- BUILD HTML ----
    let html = '';

    // 2-STOP REQUIRED banner
    if (needs2Stops) {
      html += `<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <strong style="color:#92400e;font-size:15px;">⛽ 2 FUEL STOPS REQUIRED</strong>
        <div style="color:#78350f;font-size:13px;margin-top:4px;">
          Route ${Math.round(lastTotalDist)}nm exceeds single-stop range (~${Math.round(maxLeg)}nm max per leg)
        </div>
      </div>`;
    }

    // 1-STOP RANKED TABLE
    if (singleStops.length > 0) {
      html += build1StopTable(rankedAirports, singleStops, fastest1, cheapest1, depPrice, priceMap);
    }

    // 2-STOP SECTION
    if (twoStops.length > 0) {
      html += build2StopSection(twoStops, cheapest2, fastest2, cheapest1, needs2Stops);
    }

    // Inject
    if (html) {
      const wrapper = document.createElement('div');
      wrapper.id = 'fuel-stops-ranked';
      wrapper.innerHTML = html;

      const old = document.querySelector('#fuel-stops-ranked');
      if (old) old.remove();

      if (container.tagName === 'TABLE') {
        container.parentElement.insertBefore(wrapper, container.nextSibling);
      } else {
        container.appendChild(wrapper);
      }
      console.log('[FuelStops] Ranked results rendered');
    }
  }

  // ---- 1-STOP TABLE BUILDER ----
  function build1StopTable(rankedAirports, allOptions, fastest1, cheapest1, depPrice, priceMap) {
    let html = `<div style="margin-bottom:20px;">
      <div style="font-weight:700;font-size:16px;margin-bottom:4px;color:#1e3a5f;">
        ⛽ RANKED FUEL STOP OPTIONS
      </div>
      <div style="font-size:12px;color:#374151;margin-bottom:10px;">
        Sorted by total trip cost · Departure fuel @ $${depPrice.toFixed(2)}/gal
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#1e3a5f;color:#fff;">
            <th style="padding:6px 4px;text-align:center;width:32px;"></th>
            <th style="padding:6px 5px;text-align:left;">FUEL STOP</th>
            <th style="padding:6px 5px;text-align:right;">FROM DEP</th>
            <th style="padding:6px 5px;text-align:left;">FBO</th>
            <th style="padding:6px 5px;text-align:right;">JET A $/GAL</th>
            <th style="padding:6px 5px;text-align:center;">ALT</th>
            <th style="padding:6px 5px;text-align:right;">TIME</th>
            <th style="padding:6px 5px;text-align:right;">COST</th>
            <th style="padding:6px 5px;text-align:left;"></th>
          </tr>
        </thead>
        <tbody>`;

    const rankIcons = ['🥇', '🥈', '🥉'];

    rankedAirports.forEach((opt, idx) => {
      const fastOpt = allOptions
        .filter(o => o.icao === opt.icao)
        .reduce((a, b) => a.totalTime < b.totalTime ? a : b);

      // Determine tags
      const tags = [];
      if (cheapest1 && opt.icao === cheapest1.icao && opt.altitude === cheapest1.altitude) tags.push('💰 CHEAPEST');
      if (fastest1 && fastOpt.icao === fastest1.icao && fastOpt.altitude === fastest1.altitude) tags.push('⚡ FASTEST');

      const rankIcon = idx < 3 ? rankIcons[idx] : `#${idx + 1}`;
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';

      const caaBadge = opt.isCaa
        ? ' <span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;vertical-align:middle;">CAA</span>' : '';

      const priceHtml = formatPriceCell(opt.icao, opt.fuelData);
      const region = (opt.stop.airport.region || '').replace('US-', '');
      const cityRegion = opt.stop.airport.municipality
        ? opt.stop.airport.municipality + (region ? ', ' + region : '')
        : region;

      html += `<tr style="background:${bg};border-bottom:1px solid #e2e8f0;">
        <td style="padding:6px 4px;text-align:center;font-size:16px;">${rankIcon}</td>
        <td style="padding:6px 5px;white-space:nowrap;">
          <strong style="font-size:14px;">${opt.icao}</strong>${caaBadge}<br>
          <span style="font-size:11px;color:#374151;">${opt.stop.airport.name}</span><br>
          <span style="font-size:11px;color:#6b7280;">${cityRegion}</span>
        </td>
        <td style="padding:6px 5px;text-align:right;color:#374151;white-space:nowrap;">${opt.stop.distFromDep}nm</td>
        <td style="padding:6px 5px;font-size:12px;color:#1f2937;max-width:120px;overflow:hidden;text-overflow:ellipsis;">${opt.fbo || '—'}</td>
        <td style="padding:6px 5px;text-align:right;white-space:nowrap;">${priceHtml}</td>
        <td style="padding:6px 5px;text-align:center;color:#1f2937;">${opt.altitude}</td>
        <td style="padding:6px 5px;text-align:right;color:#1f2937;">${formatTime(opt.totalTime)}</td>
        <td style="padding:6px 5px;text-align:right;"><strong>$${opt.totalCost.toFixed(0)}</strong></td>
        <td style="padding:6px 5px;font-size:12px;white-space:nowrap;">${tags.join(' ')}</td>
      </tr>`;

      // Alternate altitudes for same airport
      const altOptions = allOptions
        .filter(o => o.icao === opt.icao && o.altitude !== opt.altitude)
        .sort((a, b) => a.totalCost - b.totalCost)
        .slice(0, 2);

      for (const altOpt of altOptions) {
        const altTags = [];
        if (fastest1 && altOpt.icao === fastest1.icao && altOpt.altitude === fastest1.altitude) altTags.push('⚡ FASTEST');

        html += `<tr style="background:${bg};border-bottom:1px solid #f1f5f9;">
          <td style="padding:2px 4px;"></td>
          <td style="padding:2px 5px;color:#6b7280;font-size:11px;">↳ alt option</td>
          <td style="padding:2px 5px;"></td>
          <td style="padding:2px 5px;"></td>
          <td style="padding:2px 5px;text-align:right;font-size:12px;color:#4b5563;">${priceHtml}</td>
          <td style="padding:2px 5px;text-align:center;font-size:13px;color:#1f2937;">${altOpt.altitude}</td>
          <td style="padding:2px 5px;text-align:right;font-size:13px;color:#1f2937;">${formatTime(altOpt.totalTime)}</td>
          <td style="padding:2px 5px;text-align:right;font-size:13px;color:#1f2937;">$${altOpt.totalCost.toFixed(0)}</td>
          <td style="padding:2px 5px;font-size:11px;">${altTags.join(' ')}</td>
        </tr>`;
      }
    });

    html += `</tbody></table></div>`;
    return html;
  }

  // ---- 2-STOP SECTION BUILDER ----
  function build2StopSection(twoStops, cheapest2, fastest2, cheapest1, needs2Stops) {
    const title = needs2Stops ? '⛽ 2-STOP ROUTE OPTIONS' : '💡 2-STOP STRATEGY RECOMMENDATION';
    const borderColor = needs2Stops ? '#93c5fd' : '#6ee7b7';
    const bgColor = needs2Stops ? '#f0f9ff' : '#ecfdf5';
    const titleColor = needs2Stops ? '#1e3a5f' : '#065f46';

    let html = `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:16px;margin-top:16px;">
      <div style="font-weight:700;font-size:16px;color:${titleColor};margin-bottom:12px;">${title}</div>`;

    // Cheapest 2-stop card
    html += build2StopCard(cheapest2, '💰 CHEAPEST', cheapest1, needs2Stops);

    // Fastest 2-stop if different
    if (fastest2 && (fastest2.icao1 !== cheapest2.icao1 || fastest2.icao2 !== cheapest2.icao2 || fastest2.altitude !== cheapest2.altitude)) {
      html += build2StopCard(fastest2, '⚡ FASTEST', cheapest1, needs2Stops);
    }

    // Compact table of more options
    const shown = new Set();
    shown.add(`${cheapest2.icao1}-${cheapest2.icao2}-${cheapest2.altitude}`);
    if (fastest2) shown.add(`${fastest2.icao1}-${fastest2.icao2}-${fastest2.altitude}`);

    const moreOptions = twoStops.filter(o => !shown.has(`${o.icao1}-${o.icao2}-${o.altitude}`)).slice(0, 6);

    if (moreOptions.length > 0) {
      html += `<div style="margin-top:12px;">
        <div style="font-size:13px;font-weight:600;color:#1f2937;margin-bottom:6px;">More 2-Stop Options:</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#cbd5e1;">
              <th style="padding:6px;text-align:left;color:#1e293b;">STOP 1</th>
              <th style="padding:6px;text-align:left;color:#1e293b;">STOP 2</th>
              <th style="padding:6px;text-align:center;color:#1e293b;">ALT</th>
              <th style="padding:6px;text-align:right;color:#1e293b;">TIME</th>
              <th style="padding:6px;text-align:right;color:#1e293b;">FUEL</th>
              <th style="padding:6px;text-align:right;color:#1e293b;">COST</th>
            </tr>
          </thead><tbody>`;

      for (const opt of moreOptions) {
        const c1 = opt.isCaa1 ? ' <span style="background:#22c55e;color:#fff;font-size:9px;padding:0 3px;border-radius:2px;">CAA</span>' : '';
        const c2 = opt.isCaa2 ? ' <span style="background:#22c55e;color:#fff;font-size:9px;padding:0 3px;border-radius:2px;">CAA</span>' : '';
        html += `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:5px 6px;color:#1f2937;">${opt.icao1}${c1}</td>
          <td style="padding:5px 6px;color:#1f2937;">${opt.icao2}${c2}</td>
          <td style="padding:5px 6px;text-align:center;color:#1f2937;">${opt.altitude}</td>
          <td style="padding:5px 6px;text-align:right;color:#1f2937;">${formatTime(opt.totalTime)}</td>
          <td style="padding:5px 6px;text-align:right;color:#1f2937;">${opt.totalFuel}g</td>
          <td style="padding:5px 6px;text-align:right;color:#1f2937;"><strong>$${opt.totalCost.toFixed(0)}</strong></td>
        </tr>`;
      }

      html += `</tbody></table></div>`;
    }

    html += `</div>`;
    return html;
  }

  function build2StopCard(opt, label, cheapest1, needs2Stops) {
    const caaTag = (icao) => isCAA(icao)
      ? ' <span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;">CAA</span>' : '';

    let savingsNote = '';
    if (cheapest1 && !needs2Stops) {
      const savings = cheapest1.totalCost - opt.totalCost;
      if (savings > 0) {
        savingsNote = `<div style="color:#16a34a;font-size:13px;margin-top:6px;font-weight:600;">
          Saves $${Math.round(savings)} vs cheapest single stop (${cheapest1.icao} @ ${cheapest1.altitude})
        </div>`;
      }
    }

    return `<div style="background:#fff;border-radius:6px;padding:12px;margin-bottom:10px;border:1px solid #e2e8f0;">
      <div style="font-weight:600;font-size:14px;margin-bottom:6px;color:#1f2937;">
        ${label}: ${lastDepIdent} → ${opt.icao1}${caaTag(opt.icao1)} → ${opt.icao2}${caaTag(opt.icao2)} → ${lastDestIdent}
      </div>
      <div style="font-size:14px;color:#1f2937;">
        ${opt.altitude} · ${formatTime(opt.totalTime)} · ${opt.totalFuel} gal · <strong>$${opt.totalCost.toFixed(0)}</strong>
      </div>
      <div style="font-size:12px;color:#4b5563;margin-top:4px;">
        Leg 1: ${opt.leg1Dist}nm (${formatTime(opt.leg1Time)}, ${opt.leg1Fuel}g)
        → Leg 2: ${opt.leg2Dist}nm (${formatTime(opt.leg2Time)}, ${opt.leg2Fuel}g)
        → Leg 3: ${opt.leg3Dist}nm (${formatTime(opt.leg3Time)}, ${opt.leg3Fuel}g)
      </div>
      ${savingsNote}
    </div>`;
  }

  // ========================================
  // BASIC TABLE ENHANCEMENT (fallback)
  // ========================================
  function enhanceFuelTableBasic(candidates) {
    let table = document.querySelector('#fuel-stops-table') ||
                document.querySelector('.fuel-stops table') ||
                document.querySelector('[data-fuel-table]');

    if (!table && candidates.length > 0) {
      for (const t of document.querySelectorAll('table')) {
        if (t.textContent.includes(candidates[0].airport.ident)) { table = t; break; }
      }
    }
    if (!table) return;

    console.log('[FuelStops] Enhancing fuel table with JET A + FBO columns (basic mode)');

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

    const rows = table.querySelectorAll('tbody tr') || table.querySelectorAll('tr:not(:first-child)');
    rows.forEach((row, idx) => {
      if (row.querySelector('.fuel-jeta-col')) return;
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
        const caa = caaAirports[icao];
        tdPrice.innerHTML = formatPriceCell(icao, getCAAData(icao));
        tdFBO.textContent = caa.fbo || '';
      } else {
        tdPrice.textContent = 'loading…';
        fetchAirNavFuel(icao).then(fuel => {
          tdPrice.innerHTML = fuel ? `<strong>$${fuel.retailPrice.toFixed(2)}</strong>` : '—';
          tdFBO.textContent = fuel ? fuel.fbo : '—';
        });
      }
      row.appendChild(tdPrice);
      row.appendChild(tdFBO);
    });
  }

  // ========================================
  // HELPERS
  // ========================================
  function formatTime(hours) {
    if (hours <= 0 || isNaN(hours)) return '—';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}:${m.toString().padStart(2, '0')}`;
  }

  function formatPriceCell(icao, fuelData) {
    if (fuelData && fuelData.caaPrice) {
      return `<span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;margin-right:3px;">CAA</span>` +
        `<strong style="color:#16a34a;">$${fuelData.caaPrice.toFixed(2)}</strong> ` +
        `<span style="text-decoration:line-through;color:#6b7280;font-size:11px;">$${fuelData.retailPrice.toFixed(2)}</span>`;
    }
    if (fuelData && fuelData.retailPrice) {
      return `<strong style="color:#1f2937;">$${fuelData.retailPrice.toFixed(2)}</strong>`;
    }
    return '—';
  }

  // ========================================
  // PUBLIC API
  // ========================================
  return {
    findCandidates,
    getAirportFuel,
    isCAA,
    calcFuelBurn,
    fuelRemaining,
    maxFlightTime,
    fetchAirNavFuel,
    MAX_FUEL: MAX_FUEL_GAL,
    MIN_LANDING: MIN_LANDING_GAL,
    TRIGGER_HOURS: FUEL_STOP_TRIGGER_HRS
  };

})();
