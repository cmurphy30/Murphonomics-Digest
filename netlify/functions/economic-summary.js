/**
 * economic-summary.js — Netlify serverless function
 *
 * Receives a snapshot of current economic data (pre-built by the frontend from
 * already-fetched FRED/BLS/BEA data) and asks Claude to write a plain-English
 * economic summary.
 *
 * Why this approach: the old version fetched three APIs AND called Claude in the
 * same function, which exceeded Netlify's 10-second timeout. Now the frontend
 * fetches data itself (using fred-data, bls-data, bea-data), extracts the latest
 * values into a flat "snapshot" object, and POSTs that here. This function only
 * does one thing: call Claude.
 *
 * After generating a summary, it saves the result to Netlify Blobs under the key
 * "summary-YYYY-MM" (e.g. "summary-2025-04"). This builds the archive that
 * get-summaries.js serves to the Market Updates page.
 *
 * Request:  POST with JSON body { snapshot: { fedFundsRate, headlineCPIYoY, ... } }
 * Response: { summary: "...", generatedAt: "...", month: "April 2025" }
 *
 * NOTE: @netlify/blobs is required lazily (inside the handler) so that a missing
 * package does not crash the entire function on load. If Blobs storage fails, the
 * Claude response is still returned — archiving is best-effort.
 */

// ─── Prompt formatting ───────────────────────────────────────────────────────

// Format the snapshot object as labeled text that Claude can read easily
function formatSnapshotForPrompt(s) {
    return `
CURRENT ECONOMIC DATA SNAPSHOT:

GDP & Growth:
  Real GDP Growth (annualized quarterly % change): ${s.realGDPGrowth}%

Inflation:
  Headline CPI (YoY):                     ${s.headlineCPIYoY}%
  Core CPI, ex food & energy (YoY):       ${s.coreCPIYoY}%
  PCE Inflation (YoY):                    ${s.pceInflationYoY}%
  10-Year Breakeven Inflation Rate:       ${s.breakevenInflation}%

Labor Market:
  Labor Force Participation Rate:         ${s.lfpr}%
  Average Hourly Earnings (nominal):      $${s.avgHourlyEarnings}
  Real Wage Growth (wages minus CPI):     ${s.realWageGrowth}%

Monetary Policy & Rates:
  Federal Funds Rate:                     ${s.fedFundsRate}%
  2-Year Treasury Yield:                  ${s.treasury2y}%
  10-Year Treasury Yield:                 ${s.treasury10y}%
  Yield Curve Spread (10Y minus 2Y):      ${s.yieldCurveSpread}%
  10-Year Real Yield (TIPS):              ${s.realYield10y}%

Credit Markets:
  Investment Grade Credit Spread (OAS):   ${s.igCreditSpread} bps
  High Yield Credit Spread (OAS):         ${s.hyCreditSpread} bps

Markets & Asset Prices:
  Shiller CAPE Ratio:                     ${s.cape}
  U.S. Dollar Index (DXY):               ${s.dollarIndex}

Consumer Finance:
  Household Debt Service Ratio:           ${s.debtServiceRatio}%
`.trim();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event, context) {
    console.log('[economic-summary] handler invoked, method:', event.httpMethod);

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const summaryToken = process.env.SUMMARY_TOKEN;

    if (!anthropicKey) {
        console.error('[economic-summary] ANTHROPIC_API_KEY is not set');
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable is not set.' })
        };
    }
    console.log('[economic-summary] API key present, length:', anthropicKey.length);

    // Token check — rejects requests that don't include the right x-site-token header.
    // The token isn't secret (it lives in frontend JS), but it prevents random public
    // abuse of this endpoint from outside the site.
    if (summaryToken) {
        const clientToken = event.headers['x-site-token'];
        if (clientToken !== summaryToken) {
            console.warn('[economic-summary] token mismatch — got:', clientToken);
            return {
                statusCode: 401,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Unauthorized.' })
            };
        }
    }

    // This function expects a POST request with a snapshot in the body
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
        };
    }

    let snapshot;
    try {
        const body = JSON.parse(event.body || '{}');
        snapshot = body.snapshot;
        console.log('[economic-summary] snapshot keys:', snapshot ? Object.keys(snapshot).join(', ') : 'missing');
    } catch (parseErr) {
        console.error('[economic-summary] failed to parse request body:', parseErr.message);
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Invalid JSON in request body.' })
        };
    }

    if (!snapshot) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Request body must include a "snapshot" object.' })
        };
    }

    try {
        const dataText = formatSnapshotForPrompt(snapshot);
        console.log('[economic-summary] prompt built, calling Claude API...');

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
                'x-api-key':         anthropicKey,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
            },
            body: JSON.stringify({
                model:      'claude-sonnet-4-6',
                // 2000 tokens: ~1200 for the main summary + ~800 for three blurbs
                max_tokens: 2000,

                system: `You are an economics writer for Murphonomics, a personal economics blog. Write in a voice that is analytical but accessible — serious and data-driven, but never jargon-heavy. Your reader is intelligent but not an economist.`,

                messages: [
                    {
                        role:    'user',
                        content: `Using the following current economic data, write an economic summary and three short panel insights.

Return your response as a JSON object with exactly these four keys:

- "summary": a 500–700 word summary in four paragraphs (1. GDP/inflation/labor market, 2. monetary policy and credit markets, 3. markets and asset prices, 4. wages and purchasing power). No title, heading, or date — begin directly with the first paragraph.
- "cpiBlurb": 2–3 sentences describing the current CPI trend and what it means for consumers. Be specific with numbers.
- "lfprBlurb": 2–3 sentences describing the current Labor Force Participation Rate and what's driving it. Be specific with numbers.
- "dxyBlurb": 2–3 sentences describing what's happening with the US Dollar Index and why it matters for the economy. Be specific with numbers.

${dataText}

Return only valid JSON. No markdown code fences. No bullet points anywhere.`
                    }
                ]
            })
        });

        console.log('[economic-summary] Claude responded with status:', claudeRes.status);

        if (!claudeRes.ok) {
            const errText = await claudeRes.text().catch(() => '');
            console.error('[economic-summary] Claude error body:', errText);
            throw new Error(`Claude API error: HTTP ${claudeRes.status}${errText ? ' — ' + errText : ''}`);
        }

        const claudeJson = await claudeRes.json();
        console.log('[economic-summary] Claude response stop_reason:', claudeJson.stop_reason,
            '| output tokens:', claudeJson.usage && claudeJson.usage.output_tokens);

        if (!claudeJson.content || !claudeJson.content[0] || !claudeJson.content[0].text) {
            console.error('[economic-summary] unexpected Claude response shape:', JSON.stringify(claudeJson).slice(0, 300));
            throw new Error('Claude returned an unexpected response shape — no content[0].text found');
        }

        const rawText = claudeJson.content[0].text;

        // Parse JSON response — strip markdown code fences if Claude added them
        let parsed;
        try {
            const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            console.warn('[economic-summary] JSON parse failed, using raw text as summary:', parseErr.message);
            parsed = { summary: rawText };
        }

        const summaryText = parsed.summary || rawText;
        const cpiBlurb    = parsed.cpiBlurb  || '';
        const lfprBlurb   = parsed.lfprBlurb || '';
        const dxyBlurb    = parsed.dxyBlurb  || '';

        const now         = new Date();
        const generatedAt = now.toISOString();

        // Human-readable month label (e.g. "April 2025") included in the response
        // so the frontend can display it without re-parsing the ISO timestamp
        const month = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        // ── Save to Netlify Blobs via REST API ───────────────────────────────────
        // We call the Blobs REST API directly using fetch (Node 18 built-in) instead
        // of requiring @netlify/blobs, which caused deploy and runtime failures.
        // NETLIFY_BLOBS_CONTEXT is automatically injected by Netlify into every function.
        // Key format: "summary-YYYY-MM" (e.g. "summary-2025-04").
        try {
            const blobsCtx = process.env.NETLIFY_BLOBS_CONTEXT;
            if (!blobsCtx) throw new Error('NETLIFY_BLOBS_CONTEXT not set');
            const { edgeURL, token, siteID } = JSON.parse(
                Buffer.from(blobsCtx, 'base64').toString('utf8')
            );
            const monthKey = `summary-${now.toISOString().slice(0, 7)}`; // "YYYY-MM"
            const blobRes  = await fetch(
                `${edgeURL}/${siteID}/summaries/${encodeURIComponent(monthKey)}`,
                {
                    method:  'PUT',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ summary: summaryText, generatedAt, month, cpiBlurb, lfprBlurb, dxyBlurb })
                }
            );
            if (!blobRes.ok) throw new Error(`Blobs PUT returned ${blobRes.status}`);
            console.log('[economic-summary] saved to Blobs under key:', monthKey);
        } catch (blobErr) {
            // Non-fatal — log and continue. The Claude response is still returned.
            console.warn('[economic-summary] failed to save to Blobs:', blobErr.message);
        }

        console.log('[economic-summary] returning success response');
        return {
            statusCode: 200,
            headers: {
                'Content-Type':                'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ summary: summaryText, generatedAt, month, cpiBlurb, lfprBlurb, dxyBlurb })
        };

    } catch (err) {
        console.error('[economic-summary] handler error:', err.message);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message })
        };
    }
};
