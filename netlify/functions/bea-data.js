/**
 * bea-data.js — Netlify serverless function
 *
 * Fetches Real GDP growth from the Bureau of Economic Analysis (BEA) API.
 *
 * What we're getting:
 *   Dataset:   NIPA  (National Income and Product Accounts)
 *   Table:     T10101 — "Percent Change From Preceding Period in Real GDP"
 *   Line 1:    Real GDP — the headline quarterly growth figure you see in the news
 *   Frequency: Quarterly
 *   Period:    Last 10 years
 *
 * The value returned is the annualized % change from the prior quarter.
 * For example, "2.8" means the economy grew at an annualized rate of 2.8%.
 * Negative values indicate economic contraction.
 *
 * Called from the browser as: fetch('/.netlify/functions/bea-data')
 */

// ─── Handler ────────────────────────────────────────────────────────────────

exports.handler = async function (event, context) {
    const apiKey = process.env.BEA_API_KEY;

    if (!apiKey) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'BEA_API_KEY environment variable is not set.' })
        };
    }

    // BEA requires an explicit list of years rather than a date range
    // Build a comma-separated list: current year and the 10 years before it
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = currentYear - 10; y <= currentYear; y++) {
        years.push(y);
    }

    const url = new URL('https://apps.bea.gov/api/data');
    url.searchParams.set('UserID',      apiKey);
    url.searchParams.set('method',      'GetData');
    url.searchParams.set('DataSetName', 'NIPA');
    url.searchParams.set('TableName',   'T10101');  // % change in Real GDP
    url.searchParams.set('Frequency',   'Q');        // quarterly
    url.searchParams.set('Year',        years.join(','));
    url.searchParams.set('ResultFormat','JSON');

    try {
        const res = await fetch(url.toString());

        if (!res.ok) {
            throw new Error(`BEA API request failed: HTTP ${res.status}`);
        }

        const json = await res.json();

        // BEA returns API-level errors inside the response body
        if (json.BEAAPI && json.BEAAPI.Error) {
            throw new Error(`BEA API error: ${json.BEAAPI.Error.APIErrorDescription}`);
        }

        const allRows = json.BEAAPI.Results.Data;

        // Table T10101 has many lines (GDP components).
        // Line 1 is the top-line "Real Gross Domestic Product" figure.
        // Filter to Line 1 only, clean the values, and sort chronologically.
        const gdpData = allRows
            .filter(row => row.LineNumber === '1')
            .map(row => ({
                // BEA returns periods like "2024Q1", "2024Q2" — keep that format;
                // it's human-readable and works well as a chart label
                date:  row.TimePeriod,
                // DataValue can contain commas as thousands separators ("1,234")
                value: parseFloat(row.DataValue.replace(/,/g, ''))
            }))
            .filter(row => !isNaN(row.value))           // drop any rows that didn't parse
            .sort((a, b) => a.date.localeCompare(b.date)); // oldest first

        return {
            statusCode: 200,
            headers: {
                'Content-Type':                'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ realGDP: gdpData })
        };

    } catch (err) {
        console.error('bea-data error:', err.message);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message })
        };
    }
};
