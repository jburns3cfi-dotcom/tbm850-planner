// ============================================================
// AIRPORTS MODULE — TBM850 Apple Flight Planner
// Loads CSV from data/, provides search/autocomplete
// ============================================================

var airportDB = [];
var airportIndex = {}; // keyed by ident for O(1) lookup
var airportsLoaded = false;

// Parse CSV text into airport objects
function parseAirportCSV(csvText) {
    var lines = csvText.split('\n');
    if (lines.length < 2) return [];

    // Parse header
    var headers = parseCSVLine(lines[0]);
    var identIdx = headers.indexOf('ident');
    var nameIdx = headers.indexOf('name');
    var latIdx = headers.indexOf('latitude_deg');
    var lonIdx = headers.indexOf('longitude_deg');
    var elevIdx = headers.indexOf('elevation_ft');
    var typeIdx = headers.indexOf('type');
    var muniIdx = headers.indexOf('municipality');
    var regionIdx = headers.indexOf('iso_region');
    var icaoIdx = headers.indexOf('gps_code');
    var iataIdx = headers.indexOf('iata_code');
    var localIdx = headers.indexOf('local_code');

    var airports = [];
    for (var i = 1; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var fields = parseCSVLine(line);
        if (fields.length < 5) continue;

        var elev = parseFloat(fields[elevIdx]);
        var lat = parseFloat(fields[latIdx]);
        var lon = parseFloat(fields[lonIdx]);
        if (isNaN(lat) || isNaN(lon)) continue;

        airports.push({
            ident:      (fields[identIdx] || '').trim(),
            name:       (fields[nameIdx] || '').trim(),
            lat:        lat,
            lon:        lon,
            elevation:  isNaN(elev) ? 0 : Math.round(elev),
            type:       (fields[typeIdx] || '').trim(),
            municipality: (fields[muniIdx] || '').trim(),
            region:     (fields[regionIdx] || '').trim(),
            icao:       (fields[icaoIdx] || '').trim(),
            iata:       (fields[iataIdx] || '').trim(),
            local_code: (fields[localIdx] || '').trim()
        });
    }
    return airports;
}

// Handle CSV fields with quotes and commas
function parseCSVLine(line) {
    var fields = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    fields.push(current);
    return fields;
}

// Load airports from CSV URL
function loadAirports(csvUrl, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', csvUrl, true);
    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
            if (xhr.status === 200 || xhr.status === 0) {
                airportDB = parseAirportCSV(xhr.responseText);
                buildIndex();
                airportsLoaded = true;
                console.log('Airports loaded: ' + airportDB.length);
                if (callback) callback(null, airportDB.length);
            } else {
                console.error('Airport load failed: HTTP ' + xhr.status);
                if (callback) callback('HTTP ' + xhr.status, 0);
            }
        }
    };
    xhr.onerror = function() {
        console.error('Airport load network error');
        if (callback) callback('Network error', 0);
    };
    xhr.send();
}

// Build lookup index by ident, icao, iata, local_code
function buildIndex() {
    airportIndex = {};
    for (var i = 0; i < airportDB.length; i++) {
        var apt = airportDB[i];
        if (apt.ident) airportIndex[apt.ident.toUpperCase()] = apt;
        if (apt.icao && apt.icao !== apt.ident) airportIndex[apt.icao.toUpperCase()] = apt;
        if (apt.iata) airportIndex[apt.iata.toUpperCase()] = apt;
        if (apt.local_code && apt.local_code !== apt.ident) airportIndex[apt.local_code.toUpperCase()] = apt;
    }
}

// Get airport by exact identifier (any code type)
function getAirport(code) {
    if (!code) return null;
    return airportIndex[code.toUpperCase().trim()] || null;
}

// Search airports — returns up to maxResults matches
// Searches: ident, icao, iata, local_code, name, municipality
// Prioritizes: exact code match first, then starts-with, then contains
function searchAirports(query, maxResults) {
    if (!query || query.length < 2) return [];
    maxResults = maxResults || 10;
    var q = query.toUpperCase().trim();

    var exact = [];
    var startsWith = [];
    var contains = [];

    for (var i = 0; i < airportDB.length; i++) {
        var apt = airportDB[i];
        var ident = (apt.ident || '').toUpperCase();
        var icao = (apt.icao || '').toUpperCase();
        var iata = (apt.iata || '').toUpperCase();
        var local = (apt.local_code || '').toUpperCase();
        var name = (apt.name || '').toUpperCase();
        var muni = (apt.municipality || '').toUpperCase();

        // Exact code match
        if (ident === q || icao === q || iata === q || local === q) {
            exact.push(apt);
            continue;
        }

        // Starts with (codes)
        if (ident.indexOf(q) === 0 || icao.indexOf(q) === 0 ||
            iata.indexOf(q) === 0 || local.indexOf(q) === 0) {
            startsWith.push(apt);
            continue;
        }

        // Contains in name or municipality
        if (name.indexOf(q) >= 0 || muni.indexOf(q) >= 0) {
            contains.push(apt);
        }
    }

    // Combine prioritized results
    var results = exact.concat(startsWith).concat(contains);
    return results.slice(0, maxResults);
}

// Format airport for display: "KSTE - Stevens Point Muni (Stevens Point, WI) 1110ft"
function formatAirport(apt) {
    if (!apt) return '';
    var parts = [apt.ident];
    if (apt.name) parts.push('- ' + apt.name);
    var loc = [];
    if (apt.municipality) loc.push(apt.municipality);
    if (apt.region) {
        var state = apt.region.replace('US-', '');
        loc.push(state);
    }
    if (loc.length) parts.push('(' + loc.join(', ') + ')');
    parts.push(apt.elevation + 'ft');
    return parts.join(' ');
}

// ============================================================
// For Node.js testing — inject test airports
// ============================================================
function loadTestAirports(airports) {
    airportDB = airports;
    buildIndex();
    airportsLoaded = true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseAirportCSV, parseCSVLine, loadAirports, loadTestAirports,
        getAirport, searchAirports, formatAirport,
        getDB: function() { return airportDB; },
        isLoaded: function() { return airportsLoaded; }
    };
}
