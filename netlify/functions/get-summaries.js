/**
 * get-summaries.js — Netlify serverless function
 *
 * Reads all archived economic summaries from Netlify Blobs and returns them
 * as a JSON array sorted newest to oldest.
 *
 * Uses the Netlify Blobs REST API directly via fetch (Node 18 built-in) instead
 * of requiring @netlify/blobs, which caused deploy and runtime failures.
 * NETLIFY_BLOBS_CONTEXT is automatically injected by Netlify into every function.
 *
 * Each summary was stored by economic-summary.js under the key "summary-YYYY-MM"
 * (e.g. "summary-2025-04") with the shape:
 *   { summary: "...", generatedAt: "ISO timestamp", month: "April 2025" }
 *
 * Called from: market-updates.html
 * Response: JSON array of summary objects, newest first
 */

exports.handler = async function (event, context) {
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed. Use GET.' })
        };
    }

    try {
        // Decode the Netlify Blobs context injected automatically into every function
        const blobsCtx = process.env.NETLIFY_BLOBS_CONTEXT;
        if (!blobsCtx) {
            console.warn('[get-summaries] NETLIFY_BLOBS_CONTEXT not set — returning empty list');
            return okJson([]);
        }

        const { edgeURL, token, siteID } = JSON.parse(
            Buffer.from(blobsCtx, 'base64').toString('utf8')
        );

        // List all blobs in the "summaries" store
        const listRes = await fetch(
            `${edgeURL}/${siteID}/summaries?list=true`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (listRes.status === 404) {
            // Store doesn't exist yet — no summaries have been generated
            return okJson([]);
        }

        if (!listRes.ok) {
            throw new Error(`Blobs LIST returned ${listRes.status}`);
        }

        const { blobs } = await listRes.json();

        if (!blobs || blobs.length === 0) {
            return okJson([]);
        }

        // Fetch each summary object in parallel
        const results = await Promise.all(
            blobs.map(async (blob) => {
                const res = await fetch(
                    `${edgeURL}/${siteID}/summaries/${encodeURIComponent(blob.key)}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (!res.ok) return null;
                return res.json();
            })
        );

        // Filter nulls, sort newest first by generatedAt timestamp
        const summaries = results
            .filter(Boolean)
            .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));

        return okJson(summaries);

    } catch (err) {
        console.error('[get-summaries] error:', err.message);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message })
        };
    }
};

function okJson(data) {
    return {
        statusCode: 200,
        headers: {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(data)
    };
}
