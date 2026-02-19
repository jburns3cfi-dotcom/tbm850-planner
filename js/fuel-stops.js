// ============================================================
// fuel-stops.js — TBM850 Fuel Stop Module v11
// ============================================================
// CAA-first fuel pricing with AirNav fallback
// Ranking: Fastest / Cheapest / Best
// 2-stop strategy for long routes
// v11: NOTAM fix — uses airnav-grab worker (type=notam) like Windows
// CAA and AirNav called DIRECTLY — NEVER through proxy
// NOTAMs via airnav-grab worker (FAA NMS-API)
// ============================================================

const FuelStops = (() => {
  console.log('[FuelStops] v11 loaded — NOTAM via airnav-grab worker (FAA NMS)');

  // ---- CONSTANTS ----
  const MAX_FUEL_GAL = 282;
  const MIN_LANDING_GAL = 75;
  const FUEL_STOP_TRIGGER_HRS = 3.5;
  const CORRIDOR_WIDTH_NM = 30;
  const CAA_CORRIDOR_WIDTH_NM = 50;
  const MIN_STOP_SPACING_NM = 200;
  const DESCENT_BUFFER_NM = 60;
  const FUEL_HOUR1 = 75;
  const FUEL_HOURX = 65;
  const CLIMB_FACTOR = 1.40;
  const DESCENT_FACTOR = 1.12;
  const GROUND_STOP_MIN = 30;

  // Workers — called DIRECTLY, never through proxy
  const CAA_URL = 'https://caa-fuel.jburns3cfi.workers.dev';
  const AIRNAV_URL = 'https://airnav-grab.jburns3cfi.workers.dev';
  // NOTAMs now fetched via AIRNAV_URL with ?type=notam (same as Windows version)

  // ---- STATE ----
  let caaAirports = null;
  let caaLoaded = false;
  let lastCandidates = [];
  let lastDepIdent = '';
  let lastDestIdent = '';
  let lastTotalDist = 0;

  // ---- CACHES ----
  const metarCache = {};
  const tafCache = {};
  const notamCache = {};

  // ========================================
  // TAF POPUP MODAL
  // ========================================
  function ensureTafModal() {
    if (document.getElementById('taf-modal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'taf-modal-overlay';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;justify-content:center;align-items:center;padding:20px;box-sizing:border-box;';
    overlay.innerHTML = '<div id="taf-modal-box" style="background:#fff;border-radius:10px;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;position:relative;box-shadow:0 8px 30px rgba(0,0,0,0.25);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<div id="taf-modal-title" style="font-weight:700;font-size:16px;color:#1e3a5f;">TAF Forecast</div>' +
      '<button id="taf-modal-close" style="background:#e2e8f0;border:none;border-radius:6px;padding:6px 14px;font-size:14px;color:#1f2937;cursor:pointer;font-weight:600;-webkit-tap-highlight-color:transparent;">✕ Close</button>' +
      '</div>' +
      '<pre id="taf-modal-body" style="font-family:\'Courier New\',Courier,monospace;font-size:13px;color:#111827;white-space:pre-wrap;word-break:break-word;line-height:1.5;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin:0;">Loading TAF...</pre>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('taf-modal-close').addEventListener('click', closeTafModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTafModal(); });
  }

  function showTafModal(icao) {
    ensureTafModal();
    const overlay = document.getElementById('taf-modal-overlay');
    const title = document.getElementById('taf-modal-title');
    const body = document.getElementById('taf-modal-body');
    title.textContent = 'TAF Forecast \u2014 ' + icao;
    body.textContent = 'Loading TAF...';
    overlay.style.display = 'flex';
    if (tafCache[icao]) { body.textContent = tafCache[icao]; return; }
    fetch(AIRNAV_URL + '/?type=taf&id=' + icao)
      .then(resp => { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
      .then(data => {
        let txt = data.taf || data.raw || (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
        tafCache[icao] = txt || 'No TAF available for this airport.';
        body.textContent = tafCache[icao];
      })
      .catch(err => {
        console.warn('[FuelStops] TAF fetch failed for ' + icao + ':', err);
        tafCache[icao] = 'TAF not available for ' + icao + '.\n\nThis airport may not have a TAF issued.\nCheck nearby airports for the closest forecast.';
        body.textContent = tafCache[icao];
      });
  }

  function closeTafModal() {
    const o = document.getElementById('taf-modal-overlay');
    if (o) o.style.display = 'none';
  }

  // ========================================
  // NOTAM POPUP MODAL
  // ========================================
  function ensureNotamModal() {
    if (document.getElementById('notam-modal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'notam-modal-overlay';
    overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;justify-content:center;align-items:center;padding:20px;box-sizing:border-box;';
    overlay.innerHTML = '<div id="notam-modal-box" style="background:#fff;border-radius:10px;max-width:650px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;position:relative;box-shadow:0 8px 30px rgba(0,0,0,0.25);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '<div id="notam-modal-title" style="font-weight:700;font-size:16px;color:#1e3a5f;">NOTAMs</div>' +
      '<button id="notam-modal-close" style="background:#e2e8f0;border:none;border-radius:6px;padding:6px 14px;font-size:14px;color:#1f2937;cursor:pointer;font-weight:600;-webkit-tap-highlight-color:transparent;">✕ Close</button>' +
      '</div>' +
      '<pre id="notam-modal-body" style="font-family:\'Courier New\',Courier,monospace;font-size:12px;color:#111827;white-space:pre-wrap;word-break:break-word;line-height:1.5;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin:0;">Loading NOTAMs...</pre>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('notam-modal-close').addEventListener('click', closeNotamModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeNotamModal(); });
  }

  function showNotamModal(icao) {
    ensureNotamModal();
    const overlay = document.getElementById('notam-modal-overlay');
    const title = document.getElementById('notam-modal-title');
    const body = document.getElementById('notam-modal-body');
    title.textContent = 'NOTAMs \u2014 ' + icao;
    body.textContent = 'Loading NOTAMs from FAA NMS...';
    overlay.style.display = 'flex';
    if (notamCache[icao]) { body.textContent = notamCache[icao]; return; }
    fetch(AIRNAV_URL + '/?type=notam&id=' + icao)
      .then(resp => { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.text(); })
      .then(raw => {
        let txt = '';
        try {
          const data = JSON.parse(raw);
          // airnav-grab worker returns { airport, type, count, notams: [{classification, id, start, end, raw, text}] }
          if (data.notams && Array.isArray(data.notams)) {
            if (data.notams.length === 0) {
              txt = '\u2705 No active NOTAMs for ' + icao + '.';
            } else {
              txt = data.notams.map(n => {
                let header = '';
                if (n.classification) header += '[' + n.classification + '] ';
                if (n.id) header += n.id + ' ';
                if (n.start || n.end) header += '(' + (n.start || '?') + ' \u2014 ' + (n.end || '?') + ')';
                const body = n.raw || n.text || n.notam || '';
                return (header ? header.trim() + '\n' : '') + body;
              }).join('\n\n' + '\u2500'.repeat(50) + '\n\n');
              txt = data.count + ' active NOTAM' + (data.count !== 1 ? 's' : '') + ' for ' + icao + '\n\n' + txt;
            }
          } else if (data.notamList && Array.isArray(data.notamList)) {
            // Fallback: old notam-proxy format
            if (data.notamList.length === 0) {
              txt = 'No NOTAMs currently published for ' + icao + '.';
            } else {
              txt = data.notamList.map(n => typeof n === 'string' ? n : (n.text || n.raw || n.notam || JSON.stringify(n))).join('\n\n');
            }
          } else if (Array.isArray(data)) {
            txt = data.length === 0 ? ('No NOTAMs found for ' + icao + '.') :
              data.map(n => typeof n === 'string' ? n : (n.text || n.raw || n.notam || JSON.stringify(n))).join('\n\n');
          } else if (data.text || data.raw || data.notam) {
            txt = data.text || data.raw || data.notam;
          } else if (data.error) {
            txt = '\u274C Error: ' + data.error;
          } else {
            txt = 'No NOTAMs currently published for ' + (data.airport || icao) + '.';
          }
        } catch (e) {
          txt = raw;
        }
        notamCache[icao] = txt || ('No NOTAMs found for ' + icao + '.');
        body.textContent = notamCache[icao];
      })
      .catch(err => {
        console.warn('[FuelStops] NOTAM fetch failed for ' + icao + ':', err);
        notamCache[icao] = 'NOTAMs not available for ' + icao + '.';
        body.textContent = notamCache[icao];
      });
  }

  function closeNotamModal() {
    const o = document.getElementById('notam-modal-overlay');
    if (o) o.style.display = 'none';
  }

  // Expose popup functions globally for inline onclick
  window._fuelStopsTafPopup = showTafModal;
  window._fuelStopsNotamPopup = showNotamModal;

  // ========================================
  // METAR FETCH
  // ========================================
  async function fetchMetar(icao) {
    if (metarCache[icao]) return metarCache[icao];
    try {
      const resp = await fetch(AIRNAV_URL + '/?type=metar&id=' + icao);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      let txt = data.metar || data.raw || (typeof data === 'string' ? data : '');
      metarCache[icao] = txt || '';
      return metarCache[icao];
    } catch (err) {
      console.warn('[FuelStops] METAR fetch failed for ' + icao + ':', err);
      metarCache[icao] = '';
      return '';
    }
  }

  // ========================================
  // AUTO-FETCH CAA on script load
  // ========================================
  (async function loadCAA() {
    try {
      console.log('[FuelStops] Fetching CAA fuel data (direct)...');
      const resp = await fetch(CAA_URL);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (data.success && data.airports) {
        caaAirports = data.airports;
        caaLoaded = true;
        console.log('[FuelStops] CAA data loaded: ' + data.count + ' airports');
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
  function fuelRemaining(startFuel, flightHours) { return startFuel - calcFuelBurn(flightHours); }
  function maxFlightTime(startFuel) {
    const available = startFuel - MIN_LANDING_GAL;
    if (available <= 0) return 0;
    if (available <= FUEL_HOUR1) return available / FUEL_HOUR1;
    return 1 + (available - FUEL_HOUR1) / FUEL_HOURX;
  }
  function maxRangeNM(gs) { return maxFlightTime(MAX_FUEL_GAL) * gs; }
  function isLegSafe(distNM, gs) {
    if (gs <= 0) return false;
    const timeHrs = distNM / gs;
    const burn = calcFuelBurn(timeHrs);
    return (MAX_FUEL_GAL - burn) >= MIN_LANDING_GAL;
  }

  // ========================================
  // CAA / AIRNAV FUEL HELPERS
  // ========================================
  function isCAA(icao) { return caaAirports && caaAirports[icao] ? true : false; }

  function getCAAData(icao) {
    if (!caaAirports || !caaAirports[icao]) return null;
    const d = caaAirports[icao];
    return { fbo: d.fbo, retailPrice: d.retail, caaPrice: d.caa_price,
      savings: d.retail && d.caa_price ? +(d.retail - d.caa_price).toFixed(2) : 0, source: 'CAA' };
  }

  async function fetchAirNavFuel(icao) {
    try {
      const resp = await fetch(AIRNAV_URL + '/?id=' + icao);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data.jetA && data.jetA.price) {
        return { fbo: data.jetA.fbo || 'Unknown FBO', retailPrice: data.jetA.price, caaPrice: null, savings: 0, source: 'AirNav' };
      }
      return null;
    } catch (err) { console.warn('[FuelStops] AirNav fetch failed for ' + icao + ':', err); return null; }
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
      const headers = [];
      headerRow.querySelectorAll('th, td').forEach(cell => { headers.push(cell.textContent.trim().toUpperCase()); });
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
        const timeHrs = timeParts.length === 2 ? parseInt(timeParts[0]) + parseInt(timeParts[1]) / 60 : parseFloat(timeText);
        const fuel = parseFloat(cells[fuelIdx >= 0 ? fuelIdx : 2].textContent);
        const tas = parseFloat(cells[tasIdx >= 0 ? tasIdx : 3].textContent);
        const gs = parseFloat(cells[gsIdx >= 0 ? gsIdx : 4].textContent);
        let wind = 0;
        if (windIdx >= 0 && cells[windIdx]) { wind = parseFloat(cells[windIdx].textContent.replace(/[^0-9.\-+]/g, '')); }
        if (!isNaN(altitude) && !isNaN(gs) && gs > 0) {
          altitudes.push({ altitude, flLevel, timeHrs, fuel, tas, gs, wind, label: altText });
        }
      }
      if (altitudes.length > 0) break;
    }
    if (altitudes.length === 0) { console.warn('[FuelStops] Could not parse altitude table from DOM'); }
    else { console.log('[FuelStops] Parsed ' + altitudes.length + ' altitude options from DOM'); }
    return altitudes;
  }

  // ========================================
  // findCandidates — SYNCHRONOUS entry point
  // ========================================
  function findCandidates(dep, dest, totalDist) {
    const depIdent = resolveIdent(dep);
    const destIdent = resolveIdent(dest);
    if (!depIdent || !destIdent) { console.error('[FuelStops] findCandidates: missing dep or dest'); return []; }
    const depApt = findAirport(depIdent);
    const destApt = findAirport(destIdent);
    if (!depApt || !destApt) { console.error('[FuelStops] findCandidates: airport not found', depIdent, destIdent); return []; }
    const depLat = getLat(depApt), depLon = getLon(depApt);
    const destLat = getLat(destApt), destLon = getLon(destApt);
    if (depLat === null || depLon === null || destLat === null || destLon === null) { console.error('[FuelStops] findCandidates: missing lat/lon'); return []; }
    const routeDist = totalDist || gcDist(depLat, depLon, destLat, destLon);
    console.log('[FuelStops] Searching candidates: ' + depIdent + ' -> ' + destIdent + ', totalDist=' + routeDist);
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
      const aptIsCaa = isCAA(ident);
      const corridorLimit = aptIsCaa ? CAA_CORRIDOR_WIDTH_NM : CORRIDOR_WIDTH_NM;
      if (xtDist > corridorLimit) continue;
      const atDist = alongTrackDist(lat, lon, depLat, depLon, destLat, destLon);
      if (atDist < 0 || atDist > routeDist) continue;
      corridorCount++;
      if (atDist < MIN_STOP_SPACING_NM) continue;
      if ((routeDist - atDist) < DESCENT_BUFFER_NM) continue;
      candidates.push({
        airport: { ident: ident, name: apt.name || '', municipality: apt.municipality || '', region: apt.iso_region || apt.region || '' },
        lat, lon, distFromDep: Math.round(atDist), distFromDest: Math.round(routeDist - atDist),
        distOffRoute: Math.round(xtDist * 10) / 10, type: apt.type, isCaa: aptIsCaa
      });
    }
    candidates.sort((a, b) => {
      if (caaLoaded && a.isCaa !== b.isCaa) return a.isCaa ? -1 : 1;
      return a.distFromDep - b.distFromDep;
    });
    const results = candidates.slice(0, 8);
    lastCandidates = results;
    const caaCount = results.filter(c => c.isCaa).length;
    console.log('[FuelStops] Found ' + results.length + ' fuel stop candidates (' + caaCount + ' CAA) from ' + corridorCount + ' in corridor');
    setTimeout(() => runRankingAnalysis(), 250);
    return results;
  }

  // ========================================
  // RANKING ANALYSIS
  // ========================================
  async function runRankingAnalysis() {
    console.log('[FuelStops] Starting ranking analysis...');
    const candidates = lastCandidates;
    if (candidates.length === 0) return;
    const altitudes = parseAltitudeOptions();
    if (altitudes.length === 0) { enhanceFuelTableBasic(candidates); return; }
    const depFuel = await getAirportFuel(lastDepIdent);
    const depPrice = depFuel ? (depFuel.caaPrice || depFuel.retailPrice || 6.00) : 6.00;
    const depFBO = depFuel ? depFuel.fbo : '';
    const priceMap = {};
    const metarMap = {};
    const allIcaos = candidates.map(c => c.airport.ident);
    await Promise.all([
      ...candidates.map(async (c) => { const icao = c.airport.ident; priceMap[icao] = getCAAData(icao) || await fetchAirNavFuel(icao); }),
      ...allIcaos.map(async (icao) => { metarMap[icao] = await fetchMetar(icao); })
    ]);
    console.log('[FuelStops] METARs fetched for ' + Object.keys(metarMap).length + ' airports');
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
          stop: cand, icao, fbo: fuel ? fuel.fbo : '\u2014',
          stopPrice, isCaa: cand.isCaa, fuelData: fuel,
          altitude: alt.label, flLevel: alt.flLevel, gs: alt.gs,
          leg1Dist: Math.round(leg1Dist), leg2Dist: Math.round(leg2Dist),
          leg1Time, leg2Time,
          leg1Fuel: Math.round(leg1Fuel), leg2Fuel: Math.round(leg2Fuel),
          leg1Landing: Math.round(MAX_FUEL_GAL - leg1Fuel),
          leg2Landing: Math.round(MAX_FUEL_GAL - leg2Fuel),
          totalTime, totalFuel: Math.round(leg1Fuel + leg2Fuel), totalCost, safe: true
        });
      }
    }
    console.log('[FuelStops] ' + singleStops.length + ' safe 1-stop options scored');
    const twoStops = await analyze2Stop(candidates, altitudes, depPrice, priceMap);
    renderRankedResults(singleStops, twoStops, altitudes, depPrice, depFBO, priceMap, metarMap);
  }

  // ========================================
  // 2-STOP ANALYSIS
  // ========================================
  async function analyze2Stop(candidates, altitudes, depPrice, priceMap) {
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const s1 = candidates[i], s2 = candidates[j];
        if (s1.distFromDep >= s2.distFromDep) continue;
        const spacing = s2.distFromDep - s1.distFromDep;
        if (spacing < MIN_STOP_SPACING_NM) continue;
        const f1 = priceMap[s1.airport.ident], f2 = priceMap[s2.airport.ident];
        const p1 = f1 ? (f1.caaPrice || f1.retailPrice || 6.00) : 6.00;
        const p2 = f2 ? (f2.caaPrice || f2.retailPrice || 6.00) : 6.00;
        for (const alt of altitudes) {
          const l1d = s1.distFromDep + (s1.distOffRoute * 2);
          const l2d = spacing + (s1.distOffRoute + s2.distOffRoute);
          const l3d = s2.distFromDest + (s2.distOffRoute * 2);
          if (!isLegSafe(l1d, alt.gs) || !isLegSafe(l2d, alt.gs) || !isLegSafe(l3d, alt.gs)) continue;
          const l1t = l1d / alt.gs, l2t = l2d / alt.gs, l3t = l3d / alt.gs;
          const tt = l1t + l2t + l3t + (GROUND_STOP_MIN * 2 / 60);
          const l1f = calcFuelBurn(l1t), l2f = calcFuelBurn(l2t), l3f = calcFuelBurn(l3t);
          const tc = (l1f * depPrice) + (l2f * p1) + (l3f * p2);
          results.push({
            stop1: s1, stop2: s2, icao1: s1.airport.ident, icao2: s2.airport.ident,
            fbo1: f1 ? f1.fbo : '\u2014', fbo2: f2 ? f2.fbo : '\u2014', price1: p1, price2: p2,
            isCaa1: s1.isCaa, isCaa2: s2.isCaa,
            altitude: alt.label, flLevel: alt.flLevel, gs: alt.gs,
            leg1Dist: Math.round(l1d), leg2Dist: Math.round(l2d), leg3Dist: Math.round(l3d),
            leg1Time: l1t, leg2Time: l2t, leg3Time: l3t,
            leg1Fuel: Math.round(l1f), leg2Fuel: Math.round(l2f), leg3Fuel: Math.round(l3f),
            totalTime: tt, totalFuel: Math.round(l1f + l2f + l3f), totalCost: tc
          });
        }
      }
    }
    results.sort((a, b) => a.totalCost - b.totalCost);
    console.log('[FuelStops] ' + results.length + ' valid 2-stop options analyzed');
    return results;
  }

  // ========================================
  // METAR + TAF + NOTAM HTML HELPERS
  // ========================================
  function btnTaf(icao) {
    return '<button onclick="window._fuelStopsTafPopup(\'' + icao + '\')" style="display:inline-block;margin-left:6px;background:#3b82f6;color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;vertical-align:middle;-webkit-tap-highlight-color:transparent;">TAF</button>';
  }
  function btnNotam(icao) {
    return '<button onclick="window._fuelStopsNotamPopup(\'' + icao + '\')" style="display:inline-block;margin-left:4px;background:#f59e0b;color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;vertical-align:middle;-webkit-tap-highlight-color:transparent;">NOTAM</button>';
  }
  function btnTafSm(icao) {
    return '<button onclick="window._fuelStopsTafPopup(\'' + icao + '\')" style="display:inline-block;margin-left:4px;background:#3b82f6;color:#fff;border:none;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;cursor:pointer;vertical-align:middle;-webkit-tap-highlight-color:transparent;">TAF</button>';
  }
  function btnNotamSm(icao) {
    return '<button onclick="window._fuelStopsNotamPopup(\'' + icao + '\')" style="display:inline-block;margin-left:3px;background:#f59e0b;color:#fff;border:none;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;cursor:pointer;vertical-align:middle;-webkit-tap-highlight-color:transparent;">NOTAM</button>';
  }

  function buildMetarLine(icao, metarMap) {
    const metar = metarMap[icao] || '';
    const display = metar ? (metar.length > 120 ? metar.substring(0, 117) + '...' : metar) : 'METAR unavailable';
    return '<div style="margin-top:3px;"><span style="font-family:\'Courier New\',Courier,monospace;font-size:11px;color:#111827;line-height:1.3;">' + escapeHtml(display) + '</span>' + btnTaf(icao) + btnNotam(icao) + '</div>';
  }

  function buildMetarLineCompact(icao, metarMap) {
    const metar = metarMap[icao] || '';
    const display = metar ? (metar.length > 90 ? metar.substring(0, 87) + '...' : metar) : 'METAR unavailable';
    return '<div style="margin-top:2px;"><span style="font-family:\'Courier New\',Courier,monospace;font-size:10px;color:#111827;">' + escapeHtml(display) + '</span>' + btnTafSm(icao) + btnNotamSm(icao) + '</div>';
  }

  // Public helper for app.js dep/dest weather display
  // dark=true for dark-themed cards (dep/dest), dark=false for white backgrounds
  function buildAirportWeatherHtml(icao, metarText, dark) {
    const display = metarText ? (metarText.length > 140 ? metarText.substring(0, 137) + '...' : metarText) : 'METAR unavailable';
    const txtColor = dark ? '#e0e8f0' : '#111827';
    return '<div style="margin-top:4px;"><span style="font-family:\'Courier New\',Courier,monospace;font-size:12px;color:' + txtColor + ';line-height:1.4;">' + escapeHtml(display) + '</span>' + btnTaf(icao) + btnNotam(icao) + '</div>';
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ========================================
  // RENDER RANKED RESULTS
  // ========================================
  function renderRankedResults(singleStops, twoStops, altitudes, depPrice, depFBO, priceMap, metarMap) {
    console.log('[FuelStops] Rendering ranked results');
    let container = document.querySelector('#fuel-stops-table') || document.querySelector('.fuel-stops') || document.querySelector('[data-fuel-table]');
    if (!container && lastCandidates.length > 0) {
      const allTables = document.querySelectorAll('table');
      for (const t of allTables) { if (t.textContent.includes(lastCandidates[0].airport.ident)) { container = t.parentElement || t; break; } }
    }
    if (!container) { console.warn('[FuelStops] No container found for ranked results'); return; }
    const bestGS = Math.max(...altitudes.map(a => a.gs));
    const maxLeg = maxRangeNM(bestGS);
    const needs2Stops = singleStops.length === 0;
    let fastest1 = null, cheapest1 = null;
    if (singleStops.length > 0) {
      fastest1 = singleStops.reduce((a, b) => a.totalTime < b.totalTime ? a : b);
      cheapest1 = singleStops.reduce((a, b) => a.totalCost < b.totalCost ? a : b);
    }
    const cheapest2 = twoStops.length > 0 ? twoStops[0] : null;
    const fastest2 = twoStops.length > 0 ? twoStops.reduce((a, b) => a.totalTime < b.totalTime ? a : b) : null;
    const bestPerAirport = {};
    for (const opt of singleStops) {
      if (!bestPerAirport[opt.icao] || opt.totalCost < bestPerAirport[opt.icao].totalCost) bestPerAirport[opt.icao] = opt;
    }
    const rankedAirports = Object.values(bestPerAirport);
    rankedAirports.sort((a, b) => a.totalCost - b.totalCost);
    let html = '';
    if (needs2Stops) {
      html += '<div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:12px 16px;margin-bottom:16px;"><strong style="color:#92400e;font-size:15px;">\u26FD 2 FUEL STOPS REQUIRED</strong><div style="color:#78350f;font-size:13px;margin-top:4px;">Route ' + Math.round(lastTotalDist) + 'nm exceeds single-stop range (~' + Math.round(maxLeg) + 'nm max per leg)</div></div>';
    }
    if (singleStops.length > 0) html += build1StopTable(rankedAirports, singleStops, fastest1, cheapest1, depPrice, priceMap, metarMap);
    if (twoStops.length > 0) html += build2StopSection(twoStops, cheapest2, fastest2, cheapest1, needs2Stops, metarMap);
    if (html) {
      const wrapper = document.createElement('div');
      wrapper.id = 'fuel-stops-ranked';
      wrapper.innerHTML = html;
      const old = document.querySelector('#fuel-stops-ranked');
      if (old) old.remove();
      if (container.tagName === 'TABLE') {
        container.parentElement.insertBefore(wrapper, container.nextSibling);
        // Hide the raw candidate table — ranked results replace it
        container.style.display = 'none';
      } else {
        // Hide any raw candidate table inside the container
        const rawTable = container.querySelector('table');
        if (rawTable && !rawTable.closest('#fuel-stops-ranked')) rawTable.style.display = 'none';
        container.appendChild(wrapper);
      }
      console.log('[FuelStops] Ranked results rendered (raw candidate list hidden)');
    }
  }

  // ---- 1-STOP TABLE BUILDER ----
  function build1StopTable(rankedAirports, allOptions, fastest1, cheapest1, depPrice, priceMap, metarMap) {
    let html = '<div style="margin-bottom:20px;"><div style="font-weight:700;font-size:16px;margin-bottom:4px;color:#1e3a5f;">\u26FD RANKED FUEL STOP OPTIONS</div><div style="font-size:12px;color:#1f2937;margin-bottom:10px;">Sorted by total trip cost \u00B7 Departure fuel @ $' + depPrice.toFixed(2) + '/gal</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#1e3a5f;color:#fff;">';
    html += '<th style="padding:6px 4px;text-align:center;width:32px;"></th>';
    html += '<th style="padding:6px 5px;text-align:left;">FUEL STOP</th>';
    html += '<th style="padding:6px 5px;text-align:center;">CAA</th>';
    html += '<th style="padding:6px 5px;text-align:left;">FBO</th>';
    html += '<th style="padding:6px 5px;text-align:right;">JET A $/GAL</th>';
    html += '<th style="padding:6px 5px;text-align:right;">FROM DEP</th>';
    html += '<th style="padding:6px 5px;text-align:center;">ALT</th>';
    html += '<th style="padding:6px 5px;text-align:right;">TIME</th>';
    html += '<th style="padding:6px 5px;text-align:right;">COST</th>';
    html += '<th style="padding:6px 5px;text-align:left;"></th>';
    html += '</tr></thead><tbody>';
    const rankIcons = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    rankedAirports.forEach((opt, idx) => {
      const fastOpt = allOptions.filter(o => o.icao === opt.icao).reduce((a, b) => a.totalTime < b.totalTime ? a : b);
      const tags = [];
      if (cheapest1 && opt.icao === cheapest1.icao && opt.altitude === cheapest1.altitude) tags.push('\uD83D\uDCB0 CHEAPEST');
      if (fastest1 && fastOpt.icao === fastest1.icao && fastOpt.altitude === fastest1.altitude) tags.push('\u26A1 FASTEST');
      const rankIcon = idx < 3 ? rankIcons[idx] : '#' + (idx + 1);
      const bg = idx % 2 === 0 ? '#f8fafc' : '#ffffff';
      const caaBadge = opt.isCaa ? '<span style="background:#22c55e;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;font-weight:700;">CAA</span>' : '';
      const priceHtml = formatPriceCell(opt.icao, opt.fuelData);
      const region = (opt.stop.airport.region || '').replace('US-', '');
      const cityRegion = opt.stop.airport.municipality ? opt.stop.airport.municipality + (region ? ', ' + region : '') : region;
      const metarHtml = buildMetarLine(opt.icao, metarMap);
      html += '<tr style="background:' + bg + ';border-bottom:1px solid #e2e8f0;">';
      html += '<td style="padding:6px 4px;text-align:center;font-size:16px;">' + rankIcon + '</td>';
      html += '<td style="padding:6px 5px;color:#1f2937;"><strong style="font-size:14px;color:#111827;">' + opt.icao + '</strong><br><span style="font-size:11px;color:#1f2937;">' + opt.stop.airport.name + '</span><br><span style="font-size:11px;color:#1f2937;">' + cityRegion + '</span>' + metarHtml + '</td>';
      html += '<td style="padding:6px 5px;text-align:center;vertical-align:top;">' + caaBadge + '</td>';
      html += '<td style="padding:6px 5px;font-size:12px;color:#1f2937;max-width:130px;overflow:hidden;text-overflow:ellipsis;vertical-align:top;">' + (opt.fbo || '\u2014') + '</td>';
      html += '<td style="padding:6px 5px;text-align:right;white-space:nowrap;color:#1f2937;vertical-align:top;">' + priceHtml + '</td>';
      html += '<td style="padding:6px 5px;text-align:right;color:#1f2937;white-space:nowrap;vertical-align:top;">' + opt.stop.distFromDep + 'nm</td>';
      html += '<td style="padding:6px 5px;text-align:center;color:#1f2937;vertical-align:top;">' + opt.altitude + '</td>';
      html += '<td style="padding:6px 5px;text-align:right;color:#1f2937;vertical-align:top;">' + formatTime(opt.totalTime) + '</td>';
      html += '<td style="padding:6px 5px;text-align:right;color:#1f2937;vertical-align:top;"><strong>$' + opt.totalCost.toFixed(0) + '</strong></td>';
      html += '<td style="padding:6px 5px;font-size:12px;white-space:nowrap;color:#1f2937;vertical-align:top;">' + tags.join(' ') + '</td>';
      html += '</tr>';
      const altOptions = allOptions.filter(o => o.icao === opt.icao && o.altitude !== opt.altitude).sort((a, b) => a.totalCost - b.totalCost).slice(0, 2);
      for (const altOpt of altOptions) {
        const altTags = [];
        if (fastest1 && altOpt.icao === fastest1.icao && altOpt.altitude === fastest1.altitude) altTags.push('\u26A1 FASTEST');
        html += '<tr style="background:' + bg + ';border-bottom:1px solid #f1f5f9;"><td style="padding:2px 4px;"></td><td style="padding:2px 5px;color:#1f2937;font-size:11px;">\u21B3 alt option</td><td style="padding:2px 5px;"></td><td style="padding:2px 5px;"></td><td style="padding:2px 5px;"></td><td style="padding:2px 5px;"></td><td style="padding:2px 5px;text-align:center;font-size:13px;color:#1f2937;">' + altOpt.altitude + '</td><td style="padding:2px 5px;text-align:right;font-size:13px;color:#1f2937;">' + formatTime(altOpt.totalTime) + '</td><td style="padding:2px 5px;text-align:right;font-size:13px;color:#1f2937;">$' + altOpt.totalCost.toFixed(0) + '</td><td style="padding:2px 5px;font-size:11px;color:#1f2937;">' + altTags.join(' ') + '</td></tr>';
      }
    });
    html += '</tbody></table></div>';
    return html;
  }

  // ---- 2-STOP SECTION BUILDER ----
  function build2StopSection(twoStops, cheapest2, fastest2, cheapest1, needs2Stops, metarMap) {
    const title = needs2Stops ? '\u26FD 2-STOP ROUTE OPTIONS' : '\uD83D\uDCA1 2-STOP STRATEGY RECOMMENDATION';
    const borderColor = needs2Stops ? '#93c5fd' : '#6ee7b7';
    const bgColor = needs2Stops ? '#f0f9ff' : '#ecfdf5';
    const titleColor = needs2Stops ? '#1e3a5f' : '#065f46';
    let html = '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:16px;margin-top:16px;"><div style="font-weight:700;font-size:16px;color:' + titleColor + ';margin-bottom:12px;">' + title + '</div>';
    html += build2StopCard(cheapest2, '\uD83D\uDCB0 CHEAPEST', cheapest1, needs2Stops, metarMap);
    if (fastest2 && (fastest2.icao1 !== cheapest2.icao1 || fastest2.icao2 !== cheapest2.icao2 || fastest2.altitude !== cheapest2.altitude)) {
      html += build2StopCard(fastest2, '\u26A1 FASTEST', cheapest1, needs2Stops, metarMap);
    }
    const shown = new Set();
    shown.add(cheapest2.icao1 + '-' + cheapest2.icao2 + '-' + cheapest2.altitude);
    if (fastest2) shown.add(fastest2.icao1 + '-' + fastest2.icao2 + '-' + fastest2.altitude);
    const more = twoStops.filter(o => !shown.has(o.icao1 + '-' + o.icao2 + '-' + o.altitude)).slice(0, 6);
    if (more.length > 0) {
      html += '<div style="margin-top:12px;"><div style="font-size:13px;font-weight:600;color:#1f2937;margin-bottom:6px;">More 2-Stop Options:</div><table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr style="background:#cbd5e1;"><th style="padding:6px;text-align:left;color:#1e293b;">STOP 1</th><th style="padding:6px;text-align:left;color:#1e293b;">STOP 2</th><th style="padding:6px;text-align:center;color:#1e293b;">ALT</th><th style="padding:6px;text-align:right;color:#1e293b;">TIME</th><th style="padding:6px;text-align:right;color:#1e293b;">FUEL</th><th style="padding:6px;text-align:right;color:#1e293b;">COST</th></tr></thead><tbody>';
      for (const opt of more) {
        const c1 = opt.isCaa1 ? ' <span style="background:#22c55e;color:#fff;font-size:9px;padding:0 3px;border-radius:2px;">CAA</span>' : '';
        const c2 = opt.isCaa2 ? ' <span style="background:#22c55e;color:#fff;font-size:9px;padding:0 3px;border-radius:2px;">CAA</span>' : '';
        html += '<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:5px 6px;color:#1f2937;">' + opt.icao1 + c1 + '</td><td style="padding:5px 6px;color:#1f2937;">' + opt.icao2 + c2 + '</td><td style="padding:5px 6px;text-align:center;color:#1f2937;">' + opt.altitude + '</td><td style="padding:5px 6px;text-align:right;color:#1f2937;">' + formatTime(opt.totalTime) + '</td><td style="padding:5px 6px;text-align:right;color:#1f2937;">' + opt.totalFuel + 'g</td><td style="padding:5px 6px;text-align:right;color:#1f2937;"><strong>$' + opt.totalCost.toFixed(0) + '</strong></td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function build2StopCard(opt, label, cheapest1, needs2Stops, metarMap) {
    const caaTag = (icao) => isCAA(icao) ? ' <span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;">CAA</span>' : '';
    let savingsNote = '';
    if (cheapest1 && !needs2Stops) {
      const savings = cheapest1.totalCost - opt.totalCost;
      if (savings > 0) savingsNote = '<div style="color:#16a34a;font-size:13px;margin-top:6px;font-weight:600;">Saves $' + Math.round(savings) + ' vs cheapest single stop (' + cheapest1.icao + ' @ ' + cheapest1.altitude + ')</div>';
    }
    const m1 = buildMetarLineCompact(opt.icao1, metarMap);
    const m2 = buildMetarLineCompact(opt.icao2, metarMap);
    return '<div style="background:#fff;border-radius:6px;padding:12px;margin-bottom:10px;border:1px solid #e2e8f0;"><div style="font-weight:600;font-size:14px;margin-bottom:6px;color:#1f2937;">' + label + ': ' + lastDepIdent + ' \u2192 ' + opt.icao1 + caaTag(opt.icao1) + ' \u2192 ' + opt.icao2 + caaTag(opt.icao2) + ' \u2192 ' + lastDestIdent + '</div><div style="font-size:14px;color:#1f2937;">' + opt.altitude + ' \u00B7 ' + formatTime(opt.totalTime) + ' \u00B7 ' + opt.totalFuel + ' gal \u00B7 <strong>$' + opt.totalCost.toFixed(0) + '</strong></div><div style="font-size:12px;color:#1f2937;margin-top:4px;">Leg 1: ' + opt.leg1Dist + 'nm (' + formatTime(opt.leg1Time) + ', ' + opt.leg1Fuel + 'g) \u2192 Leg 2: ' + opt.leg2Dist + 'nm (' + formatTime(opt.leg2Time) + ', ' + opt.leg2Fuel + 'g) \u2192 Leg 3: ' + opt.leg3Dist + 'nm (' + formatTime(opt.leg3Time) + ', ' + opt.leg3Fuel + 'g)</div><div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;"><div style="font-size:11px;font-weight:600;color:#1e3a5f;">Stop 1: ' + opt.icao1 + '</div>' + m1 + '<div style="font-size:11px;font-weight:600;color:#1e3a5f;margin-top:4px;">Stop 2: ' + opt.icao2 + '</div>' + m2 + '</div>' + savingsNote + '</div>';
  }

  // ========================================
  // BASIC TABLE ENHANCEMENT (fallback)
  // ========================================
  function enhanceFuelTableBasic(candidates) {
    let table = document.querySelector('#fuel-stops-table') || document.querySelector('.fuel-stops table') || document.querySelector('[data-fuel-table]');
    if (!table && candidates.length > 0) {
      for (const t of document.querySelectorAll('table')) { if (t.textContent.includes(candidates[0].airport.ident)) { table = t; break; } }
    }
    if (!table) return;
    console.log('[FuelStops] Enhancing fuel table with JET A + FBO columns (basic mode)');
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    if (headerRow && !headerRow.querySelector('.fuel-jeta-col')) {
      const thJetA = document.createElement('th'); thJetA.className = 'fuel-jeta-col'; thJetA.textContent = 'JET A'; thJetA.style.cssText = 'padding:6px 8px;text-align:right;';
      const thFBO = document.createElement('th'); thFBO.className = 'fuel-fbo-col'; thFBO.textContent = 'FBO'; thFBO.style.cssText = 'padding:6px 8px;text-align:left;';
      headerRow.appendChild(thJetA); headerRow.appendChild(thFBO);
    }
    const rows = table.querySelectorAll('tbody tr') || table.querySelectorAll('tr:not(:first-child)');
    rows.forEach((row, idx) => {
      if (row.querySelector('.fuel-jeta-col')) return;
      const candidate = candidates[idx]; if (!candidate) return;
      const tdPrice = document.createElement('td'); tdPrice.className = 'fuel-jeta-col'; tdPrice.style.cssText = 'padding:6px 8px;text-align:right;white-space:nowrap;';
      const tdFBO = document.createElement('td'); tdFBO.className = 'fuel-fbo-col'; tdFBO.style.cssText = 'padding:6px 8px;text-align:left;';
      const icao = candidate.airport.ident;
      if (candidate.isCaa && caaAirports && caaAirports[icao]) {
        const caaData = getCAAData(icao);
        tdPrice.innerHTML = '<span style="background:#22c55e;color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-right:3px;">CAA</span>' + formatPriceCell(icao, caaData);
        tdFBO.textContent = caaData ? caaData.fbo : '';
      } else {
        tdPrice.textContent = 'loading\u2026';
        fetchAirNavFuel(icao).then(fuel => {
          tdPrice.innerHTML = fuel ? '<strong style="color:#1f2937;">$' + fuel.retailPrice.toFixed(2) + '</strong>' : '\u2014';
          tdFBO.textContent = fuel ? fuel.fbo : '\u2014';
        });
      }
      row.appendChild(tdPrice); row.appendChild(tdFBO);
    });
  }

  // ========================================
  // HELPERS
  // ========================================
  function formatTime(hours) {
    if (hours <= 0 || isNaN(hours)) return '\u2014';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return h + ':' + m.toString().padStart(2, '0');
  }

  function formatPriceCell(icao, fuelData) {
    if (fuelData && fuelData.caaPrice) {
      return '<strong style="color:#16a34a;">$' + fuelData.caaPrice.toFixed(2) + '</strong> <span style="text-decoration:line-through;color:#1f2937;font-size:11px;">$' + fuelData.retailPrice.toFixed(2) + '</span>';
    }
    if (fuelData && fuelData.retailPrice) {
      return '<strong style="color:#1f2937;">$' + fuelData.retailPrice.toFixed(2) + '</strong>';
    }
    return '\u2014';
  }

  // ========================================
  // PUBLIC API
  // ========================================
  return {
    findCandidates, getAirportFuel, isCAA, calcFuelBurn, fuelRemaining,
    maxFlightTime, fetchAirNavFuel, fetchMetar, buildAirportWeatherHtml,
    showTafModal, showNotamModal,
    MAX_FUEL: MAX_FUEL_GAL, MIN_LANDING: MIN_LANDING_GAL, TRIGGER_HOURS: FUEL_STOP_TRIGGER_HRS
  };
})();
