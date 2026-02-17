// CAA Live Fuel Pricing Worker — Cloudflare Worker
// Logs into caa.org, downloads CSV, returns JSON fuel prices
// Secrets required: CAA_EMAIL, CAA_PASSWORD

export default {
  async fetch(request, env) {
    // CORS headers for browser access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Check for cached response (cache for 6 hours)
    const cache = caches.default;
    const cacheKey = new Request('https://caa-fuel-cache/pricing.json');
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set('Access-Control-Allow-Origin', '*');
      resp.headers.set('X-Cache', 'HIT');
      return resp;
    }

    try {
      const email = env.CAA_EMAIL;
      const password = env.CAA_PASSWORD;

      if (!email || !password) {
        return jsonResponse({ success: false, error: 'CAA_EMAIL and CAA_PASSWORD secrets not configured' }, corsHeaders);
      }

      // Step 1: Get the login page to find the form action and nonce
      const loginPageResp = await fetch('https://caa.org/my-account/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'manual',
      });
      const loginPageHtml = await loginPageResp.text();

      // Extract nonce from login form
      const nonceMatch = loginPageHtml.match(/name="woocommerce-login-nonce"\s+value="([^"]+)"/);
      const nonce = nonceMatch ? nonceMatch[1] : '';

      // Step 2: Submit login form
      const formData = new URLSearchParams();
      formData.append('username', email);
      formData.append('password', password);
      formData.append('woocommerce-login-nonce', nonce);
      formData.append('_wp_http_referer', '/my-account/');
      formData.append('login', 'Log in');

      const loginResp = await fetch('https://caa.org/my-account/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: formData.toString(),
        redirect: 'manual',
      });

      // Collect ALL cookies — must use getAll() in Workers (entries() deduplicates Set-Cookie)
      const cookies = [];
      const rawCookies = loginResp.headers.getAll('Set-Cookie');
      for (const value of rawCookies) {
        const cookiePart = value.split(';')[0];
        if (cookiePart) cookies.push(cookiePart);
      }

      // WordPress may redirect after login — follow it to collect more cookies
      const loginLocation = loginResp.headers.get('Location');
      if (loginLocation) {
        const redirectUrl = loginLocation.startsWith('http') ? loginLocation : `https://caa.org${loginLocation}`;
        const redirectResp = await fetch(redirectUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': cookies.join('; '),
          },
          redirect: 'manual',
        });
        const moreCookies = redirectResp.headers.getAll('Set-Cookie');
        for (const value of moreCookies) {
          const cookiePart = value.split(';')[0];
          if (cookiePart) cookies.push(cookiePart);
        }
      }

      const cookieHeader = cookies.join('; ');

      if (!cookieHeader.includes('wordpress_logged_in')) {
        return jsonResponse({
          success: false,
          error: 'Login failed — no auth cookie received. Check CAA_EMAIL and CAA_PASSWORD secrets.',
          cookieNames: cookies.map(c => c.split('=')[0]),
          cookieCount: cookies.length,
          redirectedTo: loginLocation || 'none',
          loginStatus: loginResp.status,
        }, corsHeaders);
      }

      // Step 3: Fetch the CSV files page
      const csvPageResp = await fetch('https://caa.org/csv-files/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': cookieHeader,
        },
      });
      const csvPageHtml = await csvPageResp.text();

      // Step 4: Find the CSV download link
      // ALL patterns MUST include .csv to avoid matching .css/.js files
      
      // Pattern 1: Standard href with .csv extension
      let csvLinkMatch = csvPageHtml.match(/href=["']([^"']*\.csv)["']/i);
      
      // Pattern 2: href containing .csv anywhere (with query params etc)
      if (!csvLinkMatch) csvLinkMatch = csvPageHtml.match(/href=["']([^"']*\.csv[^"']*?)["']/i);
      
      // Pattern 3: href with CAA-CSV in the filename ending in .csv
      if (!csvLinkMatch) csvLinkMatch = csvPageHtml.match(/href=["']([^"']*CAA-CSV[^"']*\.csv[^"']*?)["']/i);
      
      // Pattern 4: Full URL from wp-content/uploads ending in .csv (no quotes needed — picks up JS-rendered links)
      if (!csvLinkMatch) csvLinkMatch = csvPageHtml.match(/(https?:\/\/caa\.org\/wp-content\/uploads\/[^\s"'<>]*\.csv)/i);
      
      // Pattern 5: Any full URL ending in .csv on caa.org
      if (!csvLinkMatch) csvLinkMatch = csvPageHtml.match(/(https?:\/\/caa\.org\/[^\s"'<>]*\.csv)/i);
      
      // Pattern 6: Look for the download link text which contains the filename, then construct URL
      if (!csvLinkMatch) {
        const textMatch = csvPageHtml.match(/Download\s+the\s+(CAA-CSV-Live-Fuel-Prices[^\s<"']+\.csv)/i);
        if (textMatch) {
          // Construct the likely URL from the filename
          const filename = textMatch[1];
          // Try to extract date parts from filename: CAA-CSV-Live-Fuel-Prices-M-DD-YYYY-...
          const dateMatch = filename.match(/Prices-(\d{1,2})-(\d{1,2})-(\d{4})/);
          if (dateMatch) {
            const month = dateMatch[1].padStart(2, '0');
            const year = dateMatch[3];
            csvLinkMatch = [null, `https://caa.org/wp-content/uploads/${year}/${month}/${filename}`];
          }
        }
      }

      if (!csvLinkMatch) {
        // Return debug info — first 2000 chars of page for troubleshooting
        const preview = csvPageHtml.substring(0, 2000);
        
        // Also check: did we even get a real page or a redirect?
        const titleMatch = csvPageHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : 'unknown';
        
        // Count all href links for debugging
        const allHrefs = csvPageHtml.match(/href=["'][^"']+["']/gi) || [];
        const uploadHrefs = allHrefs.filter(h => h.includes('uploads'));
        
        return jsonResponse({
          success: false,
          error: `Could not find .csv link on caa.org/csv-files/ page`,
          pageTitle,
          totalLinks: allHrefs.length,
          uploadLinks: uploadHrefs.length,
          uploadLinkSamples: uploadHrefs.slice(0, 10),
          pagePreview: preview,
        }, corsHeaders);
      }

      const csvUrl = csvLinkMatch[1].startsWith('http')
        ? csvLinkMatch[1]
        : `https://caa.org${csvLinkMatch[1]}`;

      // Step 5: Download the CSV
      const csvResp = await fetch(csvUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Cookie': cookieHeader,
        },
      });

      const csvText = await csvResp.text();

      // Quick sanity check — make sure we got CSV, not HTML/CSS/JS
      const trimmed = csvText.trimStart();
      if (trimmed.startsWith('<') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
        return jsonResponse({
          success: false,
          error: `Downloaded URL returned non-CSV content (looks like ${trimmed.startsWith('<') ? 'HTML' : 'CSS/JS'}). URL: ${csvUrl}`,
          rawPreview: csvText.substring(0, 500),
        }, corsHeaders);
      }

      // Step 6: Parse CSV into JSON
      const airports = parseCAACsv(csvText);

      if (Object.keys(airports).length === 0) {
        return jsonResponse({
          success: false,
          error: 'CSV parsed but produced 0 airports. CSV format may have changed.',
          csvUrl,
          rawPreview: csvText.substring(0, 500),
        }, corsHeaders);
      }

      const result = {
        success: true,
        count: Object.keys(airports).length,
        updated: new Date().toISOString(),
        csvUrl,
        airports,
      };

      // Cache for 6 hours
      const response = jsonResponse(result, corsHeaders);
      const cacheResp = new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=21600' },
      });
      await cache.put(cacheKey, cacheResp);

      return response;

    } catch (err) {
      return jsonResponse({
        success: false,
        error: err.message,
        stack: err.stack,
      }, corsHeaders);
    }
  }
};

function jsonResponse(data, corsHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function parseCAACsv(csvText) {
  const airports = {};
  const lines = csvText.split('\n');

  if (lines.length < 2) return airports;

  // Parse header — find column indices by name
  const header = parseCSVLine(lines[0]);
  const colMap = {};
  header.forEach((col, idx) => {
    colMap[col.trim().toLowerCase()] = idx;
  });

  // Try to find the right columns — CAA CSV column names may vary
  const icaoCol = findCol(colMap, ['icao', 'icao code', 'icao_code', 'airport_icao', 'airport code', 'code']);
  const fboCol = findCol(colMap, ['fbo', 'fbo name', 'fbo_name', 'dealer', 'dealer name']);
  const cityCol = findCol(colMap, ['city', 'city name', 'city_name']);
  const stateCol = findCol(colMap, ['state', 'state code', 'state_code', 'st']);
  const retailCol = findCol(colMap, ['retail', 'retail price', 'retail_price', 'posted price', 'posted_price']);
  const caaCol = findCol(colMap, ['caa', 'caa price', 'caa_price', 'contract', 'contract price', 'member price', 'member_price']);

  if (icaoCol === -1 || caaCol === -1) {
    // Can't find essential columns — return empty
    return airports;
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const icao = (fields[icaoCol] || '').trim().toUpperCase();
    if (!icao || icao.length < 3) continue;

    const caaPrice = parseFloat(fields[caaCol]);
    if (isNaN(caaPrice) || caaPrice <= 0) continue;

    const retail = retailCol >= 0 ? parseFloat(fields[retailCol]) : null;

    airports[icao] = {
      fbo: fboCol >= 0 ? (fields[fboCol] || '').trim() : 'FBO',
      city: cityCol >= 0 ? (fields[cityCol] || '').trim() : '',
      state: stateCol >= 0 ? (fields[stateCol] || '').trim() : '',
      retail: retail && !isNaN(retail) ? retail : null,
      caa_price: caaPrice,
    };
  }

  return airports;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
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

function findCol(colMap, names) {
  for (const name of names) {
    if (colMap[name] !== undefined) return colMap[name];
  }
  return -1;
}
