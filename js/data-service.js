/**
 * data-service.js — Front-end data layer for Murphonomics
 *
 * This is the single place in the front-end that talks to the Netlify
 * serverless functions. No other file should make fetch() calls to the
 * API functions — everything goes through getData() here.
 *
 * What this file does:
 *   - Before making any network request, checks localStorage for cached data
 *     (cache expires after 24 hours — managed by js/cache.js)
 *   - Fetches FRED, BLS, and BEA data in parallel
 *   - Builds a flat "snapshot" (one latest value per indicator) from that data
 *   - POSTs the snapshot to economic-summary, which calls Claude and returns text
 *   - If a data source fails, the page still loads — failed sources return null
 *
 * ─── How to use ────────────────────────────────────────────────────────────
 *
 *   const data = await getData();
 *
 *   data.fred.fedfunds           // [{ date, value }, ...]  Federal Funds Rate
 *   data.bls.headlineCPIYoY      // CPI year-over-year % change series
 *   data.bea.realGDP             // quarterly GDP growth series
 *   data.summary.summary         // AI-generated summary text (string)
 *   data.errors                  // array of error strings (empty if all OK)
 *
 * ─── Script tag order ──────────────────────────────────────────────────────
 *
 *   js/cache.js must be loaded BEFORE this file.
 *
 *   <script src="js/cache.js"></script>
 *   <script src="js/data-service.js"></script>
 */

// ─── Site token ──────────────────────────────────────────────────────────────

// This token is NOT secret — it's visible in frontend code.
// Its only job is to prevent random public abuse of the economic-summary endpoint.
// Set the same value in Netlify environment variables as SUMMARY_TOKEN.
const SITE_TOKEN = 'murphonomics-2024';

// ─── Data source config ──────────────────────────────────────────────────────

const DATA_SOURCES = [
    {
        key:      'fred',
        endpoint: '/.netlify/functions/fred-data',
        label:    'Federal Reserve (FRED) data'
    },
    {
        key:      'bls',
        endpoint: '/.netlify/functions/bls-data',
        label:    'Bureau of Labor Statistics data'
    },
    {
        key:      'bea_v2',
        endpoint: '/.netlify/functions/bea-data',
        label:    'Bureau of Economic Analysis data'
    }
];

// ─── Core fetch logic ────────────────────────────────────────────────────────

// Fetch one data source via GET, using localStorage cache when available.
async function fetchSource(source) {
    const cached = getFromCache(source.key);
    if (cached) return cached;

    const response = await fetch(source.endpoint);

    if (!response.ok) {
        // Include the actual error message from the function body, not just the status code
        let detail = '';
        try {
            const errData = await response.json();
            if (errData.error) detail = ' — ' + errData.error;
        } catch (_) { /* body wasn't JSON */ }
        throw new Error(`${source.label} returned HTTP ${response.status}${detail}`);
    }

    const data = await response.json();

    if (data && data.error) {
        throw new Error(`${source.label}: ${data.error}`);
    }

    saveToCache(source.key, data);
    return data;
}

// ─── Snapshot builder ────────────────────────────────────────────────────────

// Get the most recent value from a time series, or null if the series is missing.
function latestValue(series) {
    if (!Array.isArray(series) || series.length === 0) return null;
    return series[series.length - 1].value;
}

// Format a number to a fixed number of decimal places.
// Returns 'unavailable' for missing data so the Claude prompt stays readable.
function fmt(value, decimals) {
    if (value === null || value === undefined || isNaN(value)) return 'unavailable';
    return Number(value).toFixed(decimals != null ? decimals : 2);
}

// Compute year-over-year % change from a level series (e.g. average hourly earnings).
// Needed here because BLS returns avgHourlyEarnings as a dollar level, not a % change.
function computeYoYLatest(levelSeries) {
    if (!Array.isArray(levelSeries) || levelSeries.length < 13) return null;
    const last = levelSeries[levelSeries.length - 1];
    // Find the entry from ~12 months ago
    const byDate = new Map(levelSeries.map(o => [o.date, o.value]));
    const d = new Date(last.date + 'T00:00:00Z');
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    const yearAgo = d.toISOString().slice(0, 10);
    const prior = byDate.get(yearAgo);
    if (prior == null) return null;
    return (last.value - prior) / prior * 100;
}

// Extract the single most-recent value for each indicator into a flat object.
// This is what gets sent to Claude — not the full history, just the latest numbers.
function buildSnapshot(fred, bls, bea) {
    return {
        realGDPGrowth:       fmt(latestValue(bea  && bea.realGDP)),
        headlineCPIYoY:      fmt(latestValue(bls  && bls.headlineCPIYoY)),
        coreCPIYoY:          fmt(latestValue(bls  && bls.coreCPIYoY)),
        pceInflationYoY:     fmt(latestValue(fred && fred.pcepiyoy)),
        breakevenInflation:  fmt(latestValue(fred && fred.breakevenInflation)),
        lfpr:                fmt(latestValue(bls  && bls.lfpr), 1),
        avgHourlyEarnings:   fmt(latestValue(bls  && bls.avgHourlyEarnings)),
        realWageGrowth:      fmt(latestValue(bls  && bls.realWageGrowth)),
        fedFundsRate:        fmt(latestValue(fred && fred.fedfunds)),
        treasury2y:          fmt(latestValue(fred && fred.dgs2)),
        treasury10y:         fmt(latestValue(fred && fred.dgs10)),
        yieldCurveSpread:    fmt(latestValue(fred && fred.yieldCurveSpread)),
        realYield10y:        fmt(latestValue(fred && fred.realYield10y)),
        igCreditSpread:      fmt(latestValue(fred && fred.igSpread)),
        hyCreditSpread:      fmt(latestValue(fred && fred.hySpread)),
        cape:                fmt(latestValue(fred && fred.cape), 1),
        dollarIndex:         fmt(latestValue(fred && fred.dollarIndex)),
        debtServiceRatio:    fmt(latestValue(fred && fred.debtServiceRatio))
    };
}

// ─── Summary fetch ────────────────────────────────────────────────────────────

// POST a pre-built snapshot to the economic-summary function.
// The function only calls Claude — no re-fetching of APIs on the server side.
async function fetchSummary(fred, bls, bea) {
    // Use the 30-day TTL (SUMMARY_CACHE_TTL_MS) — summaries are generated monthly
    const cached = getFromCache('summary', SUMMARY_CACHE_TTL_MS);
    if (cached) return cached;

    const snapshot = buildSnapshot(fred, bls, bea);

    const response = await fetch('/.netlify/functions/economic-summary', {
        method:  'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-site-token': SITE_TOKEN
        },
        body: JSON.stringify({ snapshot })
    });

    if (!response.ok) {
        let detail = '';
        try {
            const errData = await response.json();
            if (errData.error) detail = ' — ' + errData.error;
        } catch (_) {}
        throw new Error(`AI-generated economic summary returned HTTP ${response.status}${detail}`);
    }

    const data = await response.json();
    if (data && data.error) throw new Error(`AI-generated economic summary: ${data.error}`);

    saveToCache('summary', data);
    return data;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * getData() — fetch all economic data and return it as one object.
 *
 * Step 1: Fetch FRED, BLS, and BEA in parallel (checks cache first each time).
 * Step 2: Build a snapshot from that data and POST to economic-summary for Claude.
 *
 * Never throws — errors are captured in data.errors so the page still renders.
 *
 * @returns {Promise<{ fred, bls, bea, summary, errors: string[] }>}
 */
async function getData() {
    const errors = [];

    // Step 1: Fetch the three data APIs in parallel
    const [fredResult, blsResult, beaResult] = await Promise.allSettled(
        DATA_SOURCES.map(source => fetchSource(source))
    );

    const fred = fredResult.status === 'fulfilled' ? fredResult.value : null;
    const bls  = blsResult.status  === 'fulfilled' ? blsResult.value  : null;
    const bea  = beaResult.status  === 'fulfilled' ? beaResult.value  : null;

    if (!fred) errors.push(`Could not load Federal Reserve (FRED) data: ${fredResult.reason?.message || 'Unknown error'}`);
    if (!bls)  errors.push(`Could not load Bureau of Labor Statistics data: ${blsResult.reason?.message || 'Unknown error'}`);
    if (!bea)  errors.push(`Could not load Bureau of Economic Analysis data: ${beaResult.reason?.message || 'Unknown error'}`);

    // Step 2: Build snapshot from available data and POST to Claude
    // (runs after data fetch so the snapshot has real values, not nulls)
    let summary = null;
    try {
        summary = await fetchSummary(fred, bls, bea);
    } catch (err) {
        errors.push(`Could not load AI-generated economic summary: ${err.message}`);
        console.warn('[data-service]', err.message);
    }

    return { fred, bls, bea, summary, errors };
}

// ─── Error display helper ────────────────────────────────────────────────────

/**
 * showDataErrors(errors) — display a non-breaking error notice on the page.
 * Writes into #errorMessage if it exists; the rest of the page still loads.
 */
function showDataErrors(errors) {
    if (!errors || errors.length === 0) return;

    const container = document.getElementById('errorMessage');
    if (!container) return;

    container.style.display = 'block';
    container.innerHTML = errors.map(msg => `<p>${msg}</p>`).join('');
}
