// ============================================================
// CLOUDFLARE WORKER — Aviation Data Proxy
// TBM850 Apple Flight Planner
// ============================================================
// This worker acts as a middleman between your app and
// aviation data websites that block direct browser requests.
// ============================================================

// List of allowed external sites (add more as needed)
const ALLOWED_HOSTS = [
  'aviationweather.gov',
  'www.aviationweather.gov',
];

export default {
  async fetch(request) {
    // Handle preflight CORS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    // Get the target URL from the query string
    // Example: https://your-worker.workers.dev/?url=https://aviationweather.gov/api/data/windtemp?region=all&level=high&fcst=06
    const workerUrl = new URL(request.url);
    const targetUrl = workerUrl.searchParams.get('url');

    // Safety checks
    if (!targetUrl) {
      return new Response('Missing ?url= parameter', {
        status: 400,
        headers: corsHeaders(),
      });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch (e) {
      return new Response('Invalid URL', {
        status: 400,
        headers: corsHeaders(),
      });
    }

    // Only allow requests to approved aviation sites
    if (!ALLOWED_HOSTS.includes(parsedTarget.hostname)) {
      return new Response('Host not allowed: ' + parsedTarget.hostname, {
        status: 403,
        headers: corsHeaders(),
      });
    }

    // Fetch the data from the target site
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'TBM850-FlightPlanner/1.0',
        },
      });

      // Get the response body
      const body = await response.text();

      // Send it back to the browser with CORS headers
      return new Response(body, {
        status: response.status,
        headers: {
          ...corsHeaders(),
          'Content-Type': response.headers.get('Content-Type') || 'text/plain',
        },
      });

    } catch (err) {
      return new Response('Proxy error: ' + err.message, {
        status: 502,
        headers: corsHeaders(),
      });
    }
  },
};

// These headers tell the browser "it's OK, let the app read this data"
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
