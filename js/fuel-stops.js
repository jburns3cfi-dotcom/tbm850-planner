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
      caaLoaded = true; // Mark loaded so we don't retry forever
      return false;
    }
  }

  // ========================================
  // FUEL PRICING LOOKUP
  // ========================================

  // Check if airport is a CAA member
  function isCAA(icao) {
    return caaAirports && caaAirports[icao] ? true : false;
  }

  // Get CAA data for an airport (or null)
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

  // Fetch AirNav fuel data for a single airport
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

  // Get fuel pricing for any airport — CAA first, AirNav fallback
  async function getAirportFuel(icao) {
    await init();

    // Try CAA first
    const caa = getCAAData(icao);
    if (caa) return caa;

    // Fall back to AirNav
    return await fetchAirNavFuel(icao);
  }

  // ========================================
  // FUEL BURN CALCULATIONS
  // ========================================

  // Calculate fuel burn for a given flight time (hours)
  // Uses fltplan.com validated hourly method: 75 gal first hr, 65 gal each after
  function calcFuelBurn(hours) {
    if (hours <= 0) return 0;
    if (hours <= 1) return FUEL_HOUR1 * hours;
    return FUEL_HOUR1 + FUEL_HOURX * (hours - 1);
  }

  // Calculate fuel remaining after a leg
  function fuelRemaining(startFuel, flightHours) {
    return startFuel - calcFuelBurn(flightHours);
  }

  // Calculate max flight time before hitting minimum fuel
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
  const NM_PER_RAD = 3440.065; // Earth radius in nm

  function toRad(d) { return d * DEG2RAD; }
  function toDeg(r) { return r * RAD2DEG; }

  // Great-circle distance in nm
  function gcDist(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.asin(Math.sqrt(a)) * NM_PER_RAD;
  }

  // Initial bearing from point 1 to point 2 (degrees true)
  function bearing(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Cross-track distance: perpendicular distance from a point to a great-circle route
  // Returns distance in nm (absolute value)
  function crossTrackDist(pLat, pLon, startLat, startLon, endLat, endLon) {
    const d13 = gcDist(startLat, startLon, pLat, pLon) / NM_PER_RAD; // angular dist
    const brng13 = toRad(bearing(startLat, startLon, pLat, pLon));
    const brng12 = toRad(bearing(startLat, startLon, endLat, endLon));
    const xt = Math.asin(Math.sin(d13) * Math.sin(brng13 - brng12));
    return Math.abs(xt * NM_PER_RAD);
  }

  // Along-track distance: how far along the route (from start) is the closest point
  // Returns distance in nm
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

  // Get descent distance for a given cruise altitude (feet)
  // Returns distance in nm (real-world corrected)
  function getDescentDist(altitudeFt) {
    // Find closest altitude in table
    const alts = Object.keys(DESCENT_DIST_NM).map(Number).sort((a, b) => b - a);
    for (const alt of alts) {
      if (altitudeFt >= alt) return DESCENT_DIST_NM[alt];
    }
    return 27 * DESCENT_FACTOR; // fallback: FL100 descent
  }

  // ========================================
  // AIRPORT FILTERING
  // ========================================

  // Filter airports for fuel stop candidates along a route
  function findCorridorAirports(allAirports, depLat, depLon, destLat, destLon, routeDist) {
    const candidates = [];
    const descentDist = 113; // Conservative: FL310 descent (~113nm with factor)

    // Quick bounding box filter first (saves heavy trig on thousands of airports)
    const minLat = Math.min(depLat, destLat) - 1.5; // ~90nm buffer
    const maxLat = Math.max(depLat, destLat) + 1.5;
    const minLon = Math.min(depLon, destLon) - 2.0;
    const maxLon = Math.max(depLon, destLon) + 2.0;

    for (const apt of allAirports) {
      // Only medium and large airports
      if (apt.type !== 'medium_airport' && apt.type !== 'large_airport') continue;

      const lat = parseFloat(apt.latitude_deg);
      const lon = parseFloat(apt.longitude_deg);
      if (isNaN(lat) || isNaN(lon)) continue;

      // Quick bounding box check
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      // Cross-track distance (perpendicular to route)
      const xtDist = crossTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (xtDist > CORRIDOR_WIDTH_NM) continue;

      // Along-track distance (how far from departure along route)
      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);

      // Must be ≥200nm from departure
      if (atDist < MIN_STOP_SPACING_NM) continue;

      // Must not be behind us or past the destination
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

    // Sort by along-track distance (closest to midpoint preferred for single-stop)
    candidates.sort((a, b) => a.alongTrackNM - b.alongTrackNM);
    return candidates;
  }

  // ========================================
  // MAIN FUEL STOP LOGIC
  // ========================================

  /**
   * findFuelStops — Main entry point
   *
   * @param {Object} params
   * @param {Object} params.departure    — {icao, lat, lon, elev}
   * @param {Object} params.destination  — {icao, lat, lon, elev}
   * @param {number} params.routeDistance — Total route distance in nm
   * @param {Array}  params.topAltitudes — Top 3 altitude options from wind optimization
   *   Each: {altitude, flightTimeHours, cruiseTAS}
   * @param {Array}  params.allAirports  — Full airport array (from CSV)
   *
   * @returns {Object} Fuel stop results
   */
  async function findFuelStops(params) {
    const { departure, destination, routeDistance, topAltitudes, allAirports } = params;

    // Make sure CAA data is loaded
    await init();

    // ---- Step 1: Do we need a fuel stop? ----
    // Check if ANY of the top 3 altitudes has flight time ≥3:30
    const needsStop = topAltitudes.some(a => a.flightTimeHours >= FUEL_STOP_TRIGGER_HRS);

    // Get fuel pricing for departure and destination regardless
    const depFuel = await getAirportFuel(departure.icao);
    const destFuel = await getAirportFuel(destination.icao);

    if (!needsStop) {
      // Verify we actually land with ≥75 gal for each altitude
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

      // Double-check: even if under 3:30, verify fuel is safe
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
      // If somehow fuel is tight even under 3:30, fall through to find stops
    }

    // ---- Step 2: Find candidate airports in corridor ----
    const corridorAirports = findCorridorAirports(
      allAirports,
      departure.lat, departure.lon,
      destination.lat, destination.lon,
      routeDistance
    );

    console.log(`[FuelStops] Found ${corridorAirports.length} corridor candidates`);

    // ---- Step 3: Get the highest altitude's descent distance ----
    // Use the highest altitude among top 3 for descent profile exclusion
    const maxAlt = Math.max(...topAltitudes.map(a => a.altitude));
    const descentDist = getDescentDist(maxAlt);

    // ---- Step 4: Filter out airports in the destination descent profile ----
    // Unless we absolutely need one there (fuel critical)
    const descentThreshold = routeDistance - descentDist;

    // ---- Step 5: Determine stop placement per altitude ----
    // We plan fuel stops for the WORST case (longest flight time) among top 3
    const worstAlt = topAltitudes.reduce((a, b) =>
      a.flightTimeHours > b.flightTimeHours ? a : b
    );

    // Calculate max leg time (hours) before hitting 75 gal reserve
    const maxLegTime = maxFlightTime(MAX_FUEL_GAL);
    console.log(`[FuelStops] Max leg time: ${maxLegTime.toFixed(2)} hrs, worst route: ${worstAlt.flightTimeHours.toFixed(2)} hrs`);

    // Estimate leg distance based on worst-case TAS
    const cruiseTAS = worstAlt.cruiseTAS || 280; // fallback TAS
    const maxLegDist = maxLegTime * cruiseTAS;

    // ---- Step 6: How many stops do we need? ----
    // Rough estimate: divide route by max leg distance
    const numStops = Math.ceil(routeDistance / maxLegDist) - 1;
    console.log(`[FuelStops] Estimated stops needed: ${numStops}`);

    // ---- Step 7: Find best stop candidates ----
    // Ideal placement: divide route into equal legs
    const stops = [];

    for (let s = 0; s < numStops; s++) {
      const idealDist = routeDistance * (s + 1) / (numStops + 1);
      const minDist = (s === 0) ? MIN_STOP_SPACING_NM : stops[s - 1].alongTrackNM + MIN_STOP_SPACING_NM;

      // Filter candidates for this stop position
      let viable = corridorAirports.filter(apt => {
        // Must be past minimum distance
        if (apt.alongTrackNM < minDist) return false;

        // Check if in descent profile — skip if we can make it without
        if (apt.alongTrackNM > descentThreshold) {
          // Airport is in descent profile zone
          // Only allow if we truly cannot reach destination
          const legTimeToHere = apt.alongTrackNM / cruiseTAS;
          const fuelAtThisPoint = fuelRemaining(MAX_FUEL_GAL, legTimeToHere);
          const remainingDist = routeDistance - apt.alongTrackNM;
          const remainingTime = remainingDist / cruiseTAS;
          const fuelAtDest = fuelRemaining(MAX_FUEL_GAL, legTimeToHere + remainingTime);
          if (fuelAtDest >= MIN_LANDING_GAL) return false; // Can make it, skip this stop
        }

        // Must leave enough distance to reach destination
        if (apt.distFromDest < 50) return false; // Too close to destination

        return true;
      });

      if (viable.length === 0) continue;

      // ---- Step 8: Score and rank candidates ----
      // Prefer CAA airports, then closest to ideal placement, then lowest off-route penalty
      const scored = await scoreAndRankCandidates(viable, idealDist);

      if (scored.length > 0) {
        stops.push(scored[0]); // Best candidate for this stop position
      }
    }

    // ---- Step 9: Build final results with fuel analysis ----
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

      // If not CAA, we'll note it but won't fetch AirNav yet for all candidates
      // (too many network calls) — we'll fetch AirNav only for top candidates
      const isCaa = !!caaData;

      // Distance from ideal placement (penalty for being far from optimal)
      const placementError = Math.abs(apt.alongTrackNM - idealDistNM);

      // Score: lower is better
      // CAA airports get a big bonus (subtract 500 from score)
      // Off-route penalty (crossTrackNM * 10)
      // Placement error penalty
      let score = placementError + (apt.crossTrackNM * 10);
      if (isCaa) score -= 500; // Strong preference for CAA

      scored.push({
        ...apt,
        isCaa: isCaa,
        fuelData: fuelData,
        score: score,
        placementError: Math.round(placementError)
      });
    }

    // Sort by score (lowest = best)
    scored.sort((a, b) => a.score - b.score);

    // For the top 5 non-CAA candidates, fetch AirNav data
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
    // Calculate leg-by-leg fuel analysis for each altitude
    const altitudeAnalysis = [];

    for (const alt of topAltitudes) {
      const cruiseTAS = alt.cruiseTAS || 280;
      const legs = [];
      let prevPoint = departure;
      let prevDistAlong = 0;

      // Build legs through each stop
      for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const legDist = stop.alongTrackNM - prevDistAlong;
        const legTime = legDist / cruiseTAS; // Simplified — main app should recalc with winds
        const legFuel = calcFuelBurn(legTime);

        legs.push({
          from: prevPoint.icao,
          to: stop.icao,
          distNM: Math.round(legDist),
          timeHrs: Math.round(legTime * 100) / 100,
          fuelBurn: Math.round(legFuel),
          fuelRemaining: Math.round(MAX_FUEL_GAL - legFuel),
          departFuel: MAX_FUEL_GAL // Always fill to capacity
        });

        prevPoint = stop;
        prevDistAlong = stop.alongTrackNM;
      }

      // Final leg: last stop (or departure) to destination
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

    // Build stop details with all fuel info
    const stopDetails = [];
    for (const stop of stops) {
      // Get fuel data — should already have it from scoring, but ensure
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
  // ALTERNATIVE STOPS — Get runner-up options
  // ========================================

  /**
   * getAlternateStops — Returns additional fuel stop options beyond the primary pick
   * Useful for showing pilot 2-3 choices along the route
   *
   * @param {Object} params — Same as findFuelStops
   * @param {number} count — How many alternates to return (default 3)
   */
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

    // Return top N with full fuel data
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
    init,                  // Call once on app load to prefetch CAA data
    findFuelStops,         // Main function — determines if stop needed, finds best options
    getAlternateStops,     // Get additional stop options for pilot choice
    getAirportFuel,        // Get fuel pricing for any single airport
    isCAA,                 // Quick check if an airport is CAA member
    calcFuelBurn,          // Calculate fuel burn for a given flight time
    fuelRemaining,         // Calculate remaining fuel after a leg
    maxFlightTime,         // Max flight time from a given fuel load

    // Constants exposed for display
    MAX_FUEL: MAX_FUEL_GAL,
    MIN_LANDING: MIN_LANDING_GAL,
    TRIGGER_HOURS: FUEL_STOP_TRIGGER_HRS
  };

})();
