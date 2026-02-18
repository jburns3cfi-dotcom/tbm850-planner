// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Module
// ============================================================
// CAA-first fuel pricing with AirNav fallback
// Integrates with main flight planner
// ============================================================

const FuelStops = (() => {
  // ---- CONSTANTS ----
  const MAX_FUEL_GAL = 282;        // Max usable fuel
  const MIN_LANDING_GAL = 75;      // Never land with less
  const FUEL_STOP_TRIGGER_HRS = 3.5; // 3:30 flight time trigger
  const CORRIDOR_WIDTH_NM = 30;    // Search 30nm each side of route
  const MIN_STOP_SPACING_NM = 200; // Stops must be ≥200nm apart
  const FUEL_HOUR1 = 75;           // First hour burn (gal) — fltplan.com validated
  const FUEL_HOURX = 65;           // Subsequent hours burn (gal) — fltplan.com validated
  const CLIMB_FACTOR = 1.40;       // Real-world climb correction
  const DESCENT_FACTOR = 1.12;     // Real-world descent correction

  // CAA Worker
  const CAA_URL = 'https://caa-fuel.jburns3cfi.workers.dev';
  // AirNav Worker
  const AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';

  // Descent distances (nm) from POH at 1500 fpm, CAS 230
  // Multiplied by DESCENT_FACTOR for real-world
  const DESCENT_DIST_NM = {
    31000: 101 * DESCENT_FACTOR,  // ~113nm
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

  // ---- STATE ----
  let caaAirports = null;   // {ICAO: {fbo, city, state, retail, caa_price}}
  let caaLoaded = false;
  let caaLoadPromise = null;

  // ========================================
  // INITIALIZATION — Fetch CAA data in bulk
  // ========================================
  async function init() {
    if (caaLoaded) return true;
    if (caaLoadPromise) return caaLoadPromise;

    caaLoadPromise = _fetchCAA();
    return caaLoadPromise;
  }

  async function _fetchCAA() {
    try {
      console.log('[FuelStops] Fetching CAA fuel data...');
      const resp = await fetch(CAA_URL);
      if (!resp.ok) throw new Error(`CAA fetch failed: ${resp.status}`);
      const data = await resp.json();

      if (data.success && data.airports) {
        caaAirports = data.airports;
        caaLoaded = true;
        console.log(`[FuelStops] CAA loaded: ${data.count} airports`);
        return true;
      } else {
        throw new Error('CAA response missing airports');
      }
    } catch (err) {
      console.error('[FuelStops] CAA load failed:', err);
      caaAirports = {};
      caaLoaded = true;
      return false;
    }
  }

  // ========================================
  // FUEL PRICING LOOKUP
  // ========================================

  function isCAA(icao) {
    return caaAirports && caaAirports[icao] ? true : false;
  }

  function getCAAData(icao) {
    if (!caaAirports || !caaAirports[icao]) return null;
    const d = caaAirports[icao];
    return {
      fbo: d.fbo,
      city: d.city,
      state: d.state,
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
          source: 'AirNav',
          allFBOs: data.all || []
        };
      }
      return null;
    } catch (err) {
      console.warn(`[FuelStops] AirNav fetch failed for ${icao}:`, err);
      return null;
    }
  }

  async function getAirportFuel(icao) {
    await init();
    const caa = getCAAData(icao);
    if (caa) return caa;
    return await fetchAirNavFuel(icao);
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
  // DESCENT PROFILE
  // ========================================

  function getDescentDist(altitudeFt) {
    const alts = Object.keys(DESCENT_DIST_NM).map(Number).sort((a, b) => b - a);
    for (const alt of alts) {
      if (altitudeFt >= alt) return DESCENT_DIST_NM[alt];
    }
    return 27 * DESCENT_FACTOR;
  }

  // ========================================
  // findCandidates — SYNCHRONOUS
  // ========================================
  // Called by app.js: FuelStops.findCandidates(dep, dest, totalDist)
  //
  // dep/dest = airport objects from autocomplete
  //   (.ident, .lat, .lon, .name, .municipality, .region, .elevation)
  // totalDist = route distance in nm
  //
  // Returns array of:
  //   { airport: {ident, name, municipality, region, ...},
  //     distFromDep, distFromDest, distOffRoute }
  //
  // Uses global airportDB loaded by airports.js
  // ========================================
  function findCandidates(dep, dest, totalDist) {
    if (typeof airportDB === 'undefined' || !airportDB || airportDB.length === 0) {
      console.warn('[FuelStops] airportDB not available');
      return [];
    }

    const depLat = parseFloat(dep.lat);
    const depLon = parseFloat(dep.lon);
    const destLat = parseFloat(dest.lat);
    const destLon = parseFloat(dest.lon);

    if (isNaN(depLat) || isNaN(depLon) || isNaN(destLat) || isNaN(destLon)) {
      console.warn('[FuelStops] Invalid departure or destination coordinates');
      return [];
    }

    // Conservative descent profile exclusion: FL310 worst case
    const descentDist = DESCENT_DIST_NM[31000] || (101 * DESCENT_FACTOR);
    const descentThreshold = totalDist - descentDist;

    // Bounding box for quick filter
    const minLat = Math.min(depLat, destLat) - 1.5;
    const maxLat = Math.max(depLat, destLat) + 1.5;
    const minLon = Math.min(depLon, destLon) - 2.0;
    const maxLon = Math.max(depLon, destLon) + 2.0;

    const candidates = [];

    for (let i = 0; i < airportDB.length; i++) {
      const apt = airportDB[i];

      // Only medium and large airports — no grass strips
      if (apt.type !== 'medium_airport' && apt.type !== 'large_airport') continue;

      // Skip departure and destination
      if (apt.ident === dep.ident || apt.ident === dest.ident) continue;

      const lat = parseFloat(apt.latitude_deg || apt.lat);
      const lon = parseFloat(apt.longitude_deg || apt.lon);
      if (isNaN(lat) || isNaN(lon)) continue;

      // Quick bounding box
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      // Cross-track distance (how far off the route centerline)
      const xtDist = crossTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (xtDist > CORRIDOR_WIDTH_NM) continue;

      // Along-track distance (how far from departure along the route)
      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);

      // Must be ≥200nm from departure
      if (atDist < MIN_STOP_SPACING_NM) continue;

      // Must not be behind us or past destination
      if (atDist < 0 || atDist > totalDist) continue;

      // Skip airports inside descent profile
      if (atDist > descentThreshold) continue;

      candidates.push({
        airport: {
          ident: apt.ident,
          name: apt.name || '',
          municipality: apt.municipality || '',
          region: apt.iso_region || apt.region || '',
          elevation: apt.elevation_ft || apt.elevation || 0,
          lat: lat,
          lon: lon,
          type: apt.type
        },
        distFromDep: Math.round(atDist),
        distFromDest: Math.round(totalDist - atDist),
        distOffRoute: Math.round(xtDist * 10) / 10
      });
    }

    // Sort: CAA airports first (if loaded), then closest to route centerline
    candidates.sort((a, b) => {
      const aCaa = (caaAirports && caaAirports[a.airport.ident]) ? 1 : 0;
      const bCaa = (caaAirports && caaAirports[b.airport.ident]) ? 1 : 0;
      if (bCaa !== aCaa) return bCaa - aCaa;
      return a.distOffRoute - b.distOffRoute;
    });

    // Return top 8 candidates
    const result = candidates.slice(0, 8);
    console.log('[FuelStops] Found ' + result.length + ' fuel stop candidates from ' + candidates.length + ' in corridor');
    return result;
  }

  // ========================================
  // CORRIDOR SEARCH (internal, for advanced functions)
  // ========================================
  function findCorridorAirports(allAirports, depLat, depLon, destLat, destLon, routeDist) {
    const candidates = [];

    const minLat = Math.min(depLat, destLat) - 1.5;
    const maxLat = Math.max(depLat, destLat) + 1.5;
    const minLon = Math.min(depLon, destLon) - 2.0;
    const maxLon = Math.max(depLon, destLon) + 2.0;

    for (const apt of allAirports) {
      if (apt.type !== 'medium_airport' && apt.type !== 'large_airport') continue;

      const lat = parseFloat(apt.latitude_deg || apt.lat);
      const lon = parseFloat(apt.longitude_deg || apt.lon);
      if (isNaN(lat) || isNaN(lon)) continue;

      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      const xtDist = crossTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (xtDist > CORRIDOR_WIDTH_NM) continue;

      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);

      if (atDist < MIN_STOP_SPACING_NM) continue;
      if (atDist < 0 || atDist > routeDist) continue;

      candidates.push({
        icao: apt.ident,
        name: apt.name,
        lat: lat,
        lon: lon,
        elev: parseFloat(apt.elevation_ft) || 0,
        type: apt.type,
        municipality: apt.municipality || '',
        region: apt.iso_region || '',
        alongTrackNM: Math.round(atDist),
        crossTrackNM: Math.round(xtDist * 10) / 10,
        distFromDest: Math.round(routeDist - atDist)
      });
    }

    candidates.sort((a, b) => a.alongTrackNM - b.alongTrackNM);
    return candidates;
  }

  // ========================================
  // ADVANCED: findFuelStops (async, full analysis)
  // ========================================
  async function findFuelStops(params) {
    const { departure, destination, routeDistance, topAltitudes, allAirports } = params;

    await init();

    const needsStop = topAltitudes.some(a => a.flightTimeHours >= FUEL_STOP_TRIGGER_HRS);

    const depFuel = await getAirportFuel(departure.icao);
    const destFuel = await getAirportFuel(destination.icao);

    if (!needsStop) {
      const altResults = topAltitudes.map(a => {
        const burn = calcFuelBurn(a.flightTimeHours);
        const remaining = MAX_FUEL_GAL - burn;
        return {
          altitude: a.altitude,
          flightTime: a.flightTimeHours,
          fuelBurn: Math.round(burn),
          fuelRemaining: Math.round(remaining),
          safeToFly: remaining >= MIN_LANDING_GAL
        };
      });

      const anyUnsafe = altResults.some(a => !a.safeToFly);

      if (!anyUnsafe) {
        return {
          needed: false,
          reason: 'All top 3 altitudes under 3:30 with safe fuel reserves',
          departureFuel: depFuel,
          destinationFuel: destFuel,
          altitudeAnalysis: altResults,
          stops: []
        };
      }
    }

    const corridorAirports = findCorridorAirports(
      allAirports,
      departure.lat, departure.lon,
      destination.lat, destination.lon,
      routeDistance
    );

    console.log(`[FuelStops] Found ${corridorAirports.length} corridor candidates`);

    const maxAlt = Math.max(...topAltitudes.map(a => a.altitude));
    const descentDist = getDescentDist(maxAlt);
    const descentThreshold = routeDistance - descentDist;

    const worstAlt = topAltitudes.reduce((a, b) =>
      a.flightTimeHours > b.flightTimeHours ? a : b
    );

    const maxLegTime = maxFlightTime(MAX_FUEL_GAL);
    const cruiseTAS = worstAlt.cruiseTAS || 280;
    const maxLegDist = maxLegTime * cruiseTAS;
    const numStops = Math.ceil(routeDistance / maxLegDist) - 1;

    const stops = [];

    for (let s = 0; s < numStops; s++) {
      const idealDist = routeDistance * (s + 1) / (numStops + 1);
      const minDist = (s === 0) ? MIN_STOP_SPACING_NM : stops[s - 1].alongTrackNM + MIN_STOP_SPACING_NM;

      let viable = corridorAirports.filter(apt => {
        if (apt.alongTrackNM < minDist) return false;

        if (apt.alongTrackNM > descentThreshold) {
          const legTimeToHere = apt.alongTrackNM / cruiseTAS;
          const remainingDist = routeDistance - apt.alongTrackNM;
          const remainingTime = remainingDist / cruiseTAS;
          const fuelAtDest = fuelRemaining(MAX_FUEL_GAL, legTimeToHere + remainingTime);
          if (fuelAtDest >= MIN_LANDING_GAL) return false;
        }

        if (apt.distFromDest < 50) return false;

        return true;
      });

      if (viable.length === 0) continue;

      const scored = await scoreAndRankCandidates(viable, idealDist);

      if (scored.length > 0) {
        stops.push(scored[0]);
      }
    }

    const result = await buildFuelPlan(departure, destination, stops, topAltitudes, routeDistance, depFuel, destFuel);

    return result;
  }

  // ========================================
  // SCORING & RANKING
  // ========================================
  async function scoreAndRankCandidates(candidates, idealDistNM) {
    const scored = [];

    for (const apt of candidates) {
      const caaData = getCAAData(apt.icao);
      let fuelData = caaData;
      const isCaa = !!caaData;

      const placementError = Math.abs(apt.alongTrackNM - idealDistNM);

      let score = placementError + (apt.crossTrackNM * 10);
      if (isCaa) score -= 500;

      scored.push({
        ...apt,
        isCaa: isCaa,
        fuelData: fuelData,
        score: score,
        placementError: Math.round(placementError)
      });
    }

    scored.sort((a, b) => a.score - b.score);

    let airnavFetches = 0;
    for (const s of scored) {
      if (!s.isCaa && airnavFetches < 5) {
        s.fuelData = await fetchAirNavFuel(s.icao);
        airnavFetches++;
      }
    }

    return scored;
  }

  // ========================================
  // BUILD FINAL FUEL PLAN
  // ========================================
  async function buildFuelPlan(departure, destination, stops, topAltitudes, routeDistance, depFuel, destFuel) {
    const altitudeAnalysis = [];

    for (const alt of topAltitudes) {
      const cruiseTAS = alt.cruiseTAS || 280;
      const legs = [];
      let prevPoint = departure;
      let prevDistAlong = 0;

      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const legDist = stop.alongTrackNM - prevDistAlong;
        const legTime = legDist / cruiseTAS;
        const legFuel = calcFuelBurn(legTime);

        legs.push({
          from: prevPoint.icao,
          to: stop.icao,
          distNM: Math.round(legDist),
          timeHrs: Math.round(legTime * 100) / 100,
          fuelBurn: Math.round(legFuel),
          fuelRemaining: Math.round(MAX_FUEL_GAL - legFuel),
          departFuel: MAX_FUEL_GAL
        });

        prevPoint = stop;
        prevDistAlong = stop.alongTrackNM;
      }

      const finalDist = routeDistance - prevDistAlong;
      const finalTime = finalDist / cruiseTAS;
      const finalFuel = calcFuelBurn(finalTime);

      legs.push({
        from: prevPoint.icao || departure.icao,
        to: destination.icao,
        distNM: Math.round(finalDist),
        timeHrs: Math.round(finalTime * 100) / 100,
        fuelBurn: Math.round(finalFuel),
        fuelRemaining: Math.round(MAX_FUEL_GAL - finalFuel),
        departFuel: MAX_FUEL_GAL
      });

      altitudeAnalysis.push({
        altitude: alt.altitude,
        totalFlightTime: alt.flightTimeHours,
        legs: legs,
        fuelAtDestination: legs[legs.length - 1].fuelRemaining,
        safe: legs.every(l => l.fuelRemaining >= MIN_LANDING_GAL)
      });
    }

    const stopDetails = [];
    for (const stop of stops) {
      let fuelInfo = stop.fuelData;
      if (!fuelInfo) {
        fuelInfo = await getAirportFuel(stop.icao);
      }

      stopDetails.push({
        icao: stop.icao,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon,
        elev: stop.elev,
        municipality: stop.municipality,
        region: stop.region,
        type: stop.type,
        alongRouteNM: stop.alongTrackNM,
        offRouteNM: stop.crossTrackNM,
        distFromDest: stop.distFromDest,
        isCaa: stop.isCaa,
        fbo: fuelInfo ? fuelInfo.fbo : 'Unknown',
        retailPrice: fuelInfo ? fuelInfo.retailPrice : null,
        caaPrice: fuelInfo ? fuelInfo.caaPrice : null,
        savings: fuelInfo ? fuelInfo.savings : 0,
        priceSource: fuelInfo ? fuelInfo.source : 'Unknown'
      });
    }

    return {
      needed: true,
      reason: `Flight time ≥${FUEL_STOP_TRIGGER_HRS} hrs — fuel stop required`,
      departureFuel: depFuel,
      destinationFuel: destFuel,
      stops: stopDetails,
      altitudeAnalysis: altitudeAnalysis,
      routeDistance: routeDistance,
      maxFuel: MAX_FUEL_GAL,
      minLanding: MIN_LANDING_GAL
    };
  }

  // ========================================
  // ALTERNATIVE STOPS
  // ========================================
  async function getAlternateStops(params, count = 3) {
    const { departure, destination, routeDistance, topAltitudes, allAirports } = params;
    await init();

    const corridorAirports = findCorridorAirports(
      allAirports,
      departure.lat, departure.lon,
      destination.lat, destination.lon,
      routeDistance
    );

    const idealDist = routeDistance / 2;
    const scored = await scoreAndRankCandidates(corridorAirports, idealDist);

    const alternates = [];
    for (let i = 0; i < Math.min(count + 1, scored.length); i++) {
      const s = scored[i];
      let fuelInfo = s.fuelData;
      if (!fuelInfo) {
        fuelInfo = await getAirportFuel(s.icao);
      }

      alternates.push({
        icao: s.icao,
        name: s.name,
        municipality: s.municipality,
        alongRouteNM: s.alongTrackNM,
        offRouteNM: s.crossTrackNM,
        distFromDest: s.distFromDest,
        isCaa: s.isCaa,
        fbo: fuelInfo ? fuelInfo.fbo : 'Unknown',
        retailPrice: fuelInfo ? fuelInfo.retailPrice : null,
        caaPrice: fuelInfo ? fuelInfo.caaPrice : null,
        savings: fuelInfo ? fuelInfo.savings : 0,
        priceSource: fuelInfo ? fuelInfo.source : 'Unknown'
      });
    }

    return alternates;
  }

  // ========================================
  // PUBLIC API
  // ========================================
  return {
    // Called by app.js — synchronous, returns candidate array
    findCandidates,

    // Advanced async functions for future use
    init,
    findFuelStops,
    getAlternateStops,
    getAirportFuel,
    isCAA,
    calcFuelBurn,
    fuelRemaining,
    maxFlightTime,

    // Constants
    MAX_FUEL: MAX_FUEL_GAL,
    MIN_LANDING: MIN_LANDING_GAL,
    TRIGGER_HOURS: FUEL_STOP_TRIGGER_HRS
  };

})();
