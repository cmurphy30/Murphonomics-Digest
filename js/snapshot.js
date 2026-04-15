/**
 * snapshot.js — Economic Snapshot section renderer for index.html
 *
 * Fetches live data via data-service.js, then builds five compact chart panels
 * and an AI-generated written summary in the #snapshotSection on the homepage.
 *
 * Load order in HTML (required):
 *   1. Chart.js CDN
 *   2. js/cache.js          ← defines saveToCache / getFromCache
 *   3. js/data-service.js   ← defines getData / showDataErrors
 *   4. js/snapshot.js       ← this file
 */

(function () {
    'use strict';

    // ── Colors (all from STYLE_GUIDE.md) ──────────────────────────────────

    const C = {
        primary:    '#1e40af',
        blue:       '#3b82f6',
        blueLight:  '#60a5fa',
        green:      '#10b981',
        red:        '#ef4444',
        amber:      '#f59e0b',
        gray:       '#64748b',
        gridLine:   'rgba(30,64,175,0.08)'
    };

    // ── Data helpers ───────────────────────────────────────────────────────

    // Return the last { date, value } entry from a series (most recent reading)
    function latest(series) {
        if (!Array.isArray(series) || series.length === 0) return null;
        return series[series.length - 1];
    }

    // Daily series (e.g. DGS2, DGS10) have ~1,250 points over 5 years — too many
    // for a compact chart. Collapse to one value per month (keeps the last reading).
    function toMonthlyLast(series) {
        if (!series) return [];
        const byMonth = new Map();
        series.forEach(obs => {
            byMonth.set(obs.date.slice(0, 7), obs); // "YYYY-MM" → last obs wins
        });
        return Array.from(byMonth.values());
    }

    // Compute year-over-year % change from a raw level series (e.g. hourly earnings)
    // Returns [{ date, value }, ...] in the same format as other series
    function computeYoY(levelSeries) {
        if (!levelSeries || levelSeries.length === 0) return [];
        const byDate = new Map(levelSeries.map(o => [o.date, o.value]));
        return levelSeries
            .map(obs => {
                const d = new Date(obs.date + 'T00:00:00Z');
                d.setUTCFullYear(d.getUTCFullYear() - 1);
                const yearAgoDate = d.toISOString().slice(0, 10);
                const prior = byDate.get(yearAgoDate);
                if (prior == null) return null;
                return {
                    date:  obs.date,
                    value: +((obs.value - prior) / prior * 100).toFixed(2)
                };
            })
            .filter(Boolean);
    }

    // Build a Set of "YYYY-MM" strings where the USREC indicator = 1 (recession)
    function buildRecessionSet(recessionSeries) {
        const s = new Set();
        if (!recessionSeries) return s;
        recessionSeries.forEach(obs => {
            if (obs.value === 1) s.add(obs.date.slice(0, 7));
        });
        return s;
    }

    // Does a quarterly date like "2024Q1" overlap with any months in the recession set?
    function inRecession(qtrDate, recSet) {
        const yr  = qtrDate.slice(0, 4);
        const q   = qtrDate[5];
        const map = { '1':['01','02','03'], '2':['04','05','06'], '3':['07','08','09'], '4':['10','11','12'] };
        return (map[q] || []).some(m => recSet.has(`${yr}-${m}`));
    }

    // Format a "YYYY-MM-DD" date string as "Jan '24" for chart labels
    function fmtMonth(d) {
        return new Date(d + 'T00:00:00Z')
            .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }

    // Format a BEA quarter string "2024Q1" as "Q1 '24"
    function fmtQtr(q) {
        return `Q${q[5]} '${q.slice(2, 4)}`;
    }

    // Map a secondary series onto the reference series's dates.
    // Returns an array of values (null where the secondary series has no matching date).
    function alignValues(refSeries, secondarySeries) {
        const m = new Map((secondarySeries || []).map(o => [o.date, o.value]));
        return refSeries.map(obs => m.has(obs.date) ? m.get(obs.date) : null);
    }

    // ── Shared Chart.js building blocks ───────────────────────────────────

    // Create a standard line dataset with sensible defaults.
    // Pass `overrides` to change individual properties (e.g. borderDash, yAxisID).
    function lineDataset(label, data, color, overrides) {
        return Object.assign({
            label,
            data,
            borderColor:      color,
            borderWidth:      1.75,
            pointRadius:      0,
            pointHoverRadius: 4,
            tension:          0.35,
            fill:             false
        }, overrides || {});
    }

    // Base Chart.js options shared across all five panels.
    // yUnit is the suffix appended to tick labels and tooltips (e.g. '%').
    function baseOptions(yUnit) {
        const u = yUnit || '';
        return {
            responsive:          true,
            maintainAspectRatio: false,
            interaction:         { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font:     { family: "'Inter', sans-serif", size: 10 },
                        boxWidth: 12,
                        padding:  6,
                        color:    C.gray
                    }
                },
                tooltip: {
                    backgroundColor: C.primary,
                    titleFont:  { family: "'Inter', sans-serif", size: 11 },
                    bodyFont:   { family: "'Inter', sans-serif", size: 11 },
                    padding:    8,
                    callbacks: {
                        label: ctx => {
                            const v = ctx.parsed.y;
                            return ` ${ctx.dataset.label}: ${v != null ? v.toFixed(2) + u : '—'}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        maxTicksLimit: 10,
                        font:         { size: 10, family: "'Inter', sans-serif" },
                        color:        C.gray,
                        maxRotation:  0
                    },
                    grid:   { display: false },
                    border: { color: '#e2e8f0' }
                },
                y: {
                    ticks: {
                        font:     { size: 10, family: "'Inter', sans-serif" },
                        color:    C.gray,
                        callback: v => v + u
                    },
                    grid:   { color: C.gridLine },
                    border: { color: '#e2e8f0' }
                }
            }
        };
    }

    // ── Panel 1: Inflation Comparison ─────────────────────────────────────
    // Multi-line: Headline CPI YoY, Core CPI YoY, PCE YoY
    // Dashed reference line at 2% (Fed's inflation target)

    function renderInflation(bls, fred) {
        const ref  = (bls && bls.headlineCPIYoY) || [];
        const core = alignValues(ref, bls && bls.coreCPIYoY);
        const pce  = alignValues(ref, fred && fred.pcepiyoy);
        const L    = latest(ref);

        document.getElementById('latestInflation').textContent =
            L ? `${L.value.toFixed(1)}% CPI` : '--';
        document.getElementById('updatedInflation').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        const labels = ref.map(o => fmtMonth(o.date));

        new Chart(document.getElementById('chartInflation'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('Headline CPI', ref.map(o => o.value), C.red),
                    lineDataset('Core CPI',     core,                  C.blue),
                    lineDataset('PCE',          pce,                   C.green),
                    // Dashed horizontal line at the Fed's 2% target
                    lineDataset('Fed Target (2%)', labels.map(() => 2), C.amber, {
                        borderDash:  [5, 4],
                        borderWidth: 1.5,
                        tension:     0,
                        pointRadius: 0
                    })
                ]
            },
            options: baseOptions('%')
        });
    }

    // ── Panel 2: Real vs. Nominal Wage Growth ─────────────────────────────
    // Dual-line: nominal hourly earnings YoY%, real wage growth YoY%
    // Fill between the lines makes the gap visually obvious

    function renderWages(bls) {
        // avgHourlyEarnings comes as a dollar level — calculate YoY % change
        const nominalYoY = computeYoY(bls && bls.avgHourlyEarnings);
        const realYoY    = (bls && bls.realWageGrowth) || [];
        const realAligned = alignValues(nominalYoY, realYoY);
        const L = latest(nominalYoY);

        document.getElementById('latestWages').textContent =
            L ? `${L.value.toFixed(1)}% nominal` : '--';
        document.getElementById('updatedWages').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        new Chart(document.getElementById('chartWages'), {
            type: 'line',
            data: {
                labels: nominalYoY.map(o => fmtMonth(o.date)),
                datasets: [
                    lineDataset('Nominal Wage Growth', nominalYoY.map(o => o.value), C.blue),
                    // Fill between the two lines: red gap means inflation outpacing paychecks
                    lineDataset('Real Wage Growth', realAligned, C.green, {
                        fill: {
                            target: '-1',                          // fill against prior dataset (nominal)
                            below:  'rgba(239,68,68,0.12)',        // red = inflation eating wages
                            above:  'rgba(16,185,129,0.10)'        // green = wages beating inflation
                        }
                    })
                ]
            },
            options: baseOptions('%')
        });
    }

    // ── Panel 3: Real GDP Growth ───────────────────────────────────────────
    // Quarterly bar chart; bars during recession periods are shaded light red

    function renderGDP(bea, fred) {
        const gdpData = (bea && bea.realGDP) || [];
        const recSet  = buildRecessionSet(fred && fred.recession);
        const L       = latest(gdpData);

        document.getElementById('latestGDP').textContent =
            L ? `${L.value.toFixed(1)}% annualized` : '--';
        document.getElementById('updatedGDP').textContent =
            L ? `Last updated: ${fmtQtr(L.date)}` : 'Last updated: --';

        // Color each bar: recession = light red, growth = blue, contraction = dark blue
        const bgColors = gdpData.map(o => {
            if (inRecession(o.date, recSet)) return 'rgba(239,68,68,0.45)';
            return o.value >= 0 ? 'rgba(59,130,246,0.78)' : 'rgba(30,64,175,0.78)';
        });

        const opts = baseOptions('%');
        new Chart(document.getElementById('chartGDP'), {
            type: 'bar',
            data: {
                labels: gdpData.map(o => fmtQtr(o.date)),
                datasets: [{
                    label:           'Real GDP Growth (annualized)',
                    data:            gdpData.map(o => o.value),
                    backgroundColor: bgColors,
                    borderRadius:    2,
                    borderWidth:     0
                }]
            },
            options: {
                ...opts,
                plugins: {
                    ...opts.plugins,
                    legend: {
                        display: true,
                        labels: {
                            // Custom legend to explain the three bar colors
                            generateLabels: () => [
                                { text: 'Growth',      fillStyle: 'rgba(59,130,246,0.78)', strokeStyle: 'transparent', fontColor: C.gray },
                                { text: 'Contraction', fillStyle: 'rgba(30,64,175,0.78)',  strokeStyle: 'transparent', fontColor: C.gray },
                                { text: 'Recession',   fillStyle: 'rgba(239,68,68,0.45)',  strokeStyle: 'transparent', fontColor: C.gray }
                            ],
                            font: { family: "'Inter', sans-serif", size: 10 },
                            boxWidth: 12,
                            padding:  6
                        }
                    }
                }
            }
        });
    }

    // ── Panel 4: Fed Funds Rate + 2Y/10Y Yield Curve Spread ───────────────
    // Dual-axis: Fed Funds (left), spread (right)
    // Fill below zero on the spread — inverted curve = recession warning

    function renderFed(fred) {
        const fedRaw     = (fred && fred.fedfunds) || [];
        // Yield spread is derived from daily DGS2/DGS10 — collapse to monthly
        const spreadMonthly = toMonthlyLast((fred && fred.yieldCurveSpread) || []);
        const spreadAligned = alignValues(fedRaw, spreadMonthly);
        const L = latest(fedRaw);

        document.getElementById('latestFed').textContent =
            L ? `${L.value.toFixed(2)}% fed funds` : '--';
        document.getElementById('updatedFed').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        const labels = fedRaw.map(o => fmtMonth(o.date));

        // Build options with dual y-axes instead of the default single y
        const opts = baseOptions('%');
        delete opts.scales.y;
        opts.scales.yLeft = {
            position: 'left',
            ticks:    { font: { size: 10, family: "'Inter', sans-serif" }, color: C.gray, callback: v => v + '%' },
            grid:     { color: C.gridLine },
            border:   { color: '#e2e8f0' }
        };
        opts.scales.yRight = {
            position: 'right',
            grid:     { drawOnChartArea: false },        // don't double-draw grid lines
            ticks:    { font: { size: 10, family: "'Inter', sans-serif" }, color: C.gray, callback: v => v + '%' },
            border:   { color: '#e2e8f0' }
        };

        new Chart(document.getElementById('chartFed'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('Fed Funds Rate', fedRaw.map(o => o.value), C.primary, { yAxisID: 'yLeft' }),
                    lineDataset('2Y/10Y Spread',  spreadAligned, C.red, {
                        yAxisID: 'yRight',
                        // Shade below the zero line light red — inverted curve = potential recession signal
                        fill: { target: { value: 0 }, below: 'rgba(239,68,68,0.13)' }
                    })
                ]
            },
            options: opts
        });
    }

    // ── Panel 5: Shiller CAPE Ratio ────────────────────────────────────────
    // Line chart with dashed reference at the long-run historical average (~16.8)

    const CAPE_HIST_AVG = 16.8;

    function renderCAPE(fred) {
        const capeData = (fred && fred.cape) || [];
        const L = latest(capeData);

        document.getElementById('latestCAPE').textContent =
            L ? L.value.toFixed(1) : '--';
        document.getElementById('updatedCAPE').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        const labels = capeData.map(o => fmtMonth(o.date));

        new Chart(document.getElementById('chartCAPE'), {
            type: 'line',
            data: {
                labels,
                datasets: [
                    lineDataset('CAPE Ratio', capeData.map(o => o.value), C.primary, {
                        // Shade above historical avg red — signals elevated valuations
                        fill: { target: { value: CAPE_HIST_AVG }, above: 'rgba(239,68,68,0.08)' }
                    }),
                    // Dashed horizontal reference line at historical average
                    lineDataset(`Hist. Avg (${CAPE_HIST_AVG})`, labels.map(() => CAPE_HIST_AVG), C.amber, {
                        borderDash:  [5, 4],
                        borderWidth: 1.5,
                        tension:     0,
                        pointRadius: 0,
                        fill:        false
                    })
                ]
            },
            options: baseOptions('')
        });
    }

    // ── Summary block ──────────────────────────────────────────────────────

    function renderSummary(summaryData) {
        const block   = document.getElementById('snapshotSummaryBlock');
        const textEl  = document.getElementById('summaryText');
        const metaEl  = document.getElementById('summaryMeta');
        const monthEl = document.getElementById('summaryMonth');

        if (!summaryData || !summaryData.summary) {
            // No data — replace placeholder with a neutral message
            if (textEl) textEl.innerHTML = '<p style="color:var(--color-text-tertiary)">No summary available yet. Check back after the next monthly update.</p>';
            return;
        }

        // Show the month label (e.g. "April 2025") if it exists in the response.
        // Older cached summaries may not have this field — handle gracefully.
        if (monthEl) {
            monthEl.textContent = summaryData.month || '';
        }

        // The summary arrives as plain text with paragraph breaks — wrap each in <p>
        const html = summaryData.summary
            .split(/\n{2,}/)
            .filter(p => p.trim())
            .map(p => `<p>${p.trim()}</p>`)
            .join('');

        textEl.innerHTML = html;

        if (summaryData.generatedAt) {
            const d = new Date(summaryData.generatedAt);
            metaEl.textContent = 'Generated: ' + d.toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric'
            }) + ' at ' + d.toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit'
            });
        }

        // Wire up collapse behaviour
        initCollapse();
    }

    function initCollapse() {
        const collapsible = document.getElementById('summaryCollapsible');
        const btn         = document.getElementById('summaryToggleBtn');
        if (!collapsible || !btn) return;

        // collapsedPx starts as a reasonable estimate and gets refined once
        // fonts are fully loaded (font metrics affect the rendered height).
        let collapsedPx = 220;

        // Apply initial collapsed height with no animation on first paint
        collapsible.style.transition = 'none';
        collapsible.style.maxHeight  = collapsedPx + 'px';
        requestAnimationFrame(function () { collapsible.style.transition = ''; });

        // Once fonts are loaded, re-measure and set the true 40% height.
        // scrollHeight returns the FULL content height even when max-height
        // is smaller — so this is safe to call while the element is collapsed.
        document.fonts.ready.then(function () {
            if (collapsible.classList.contains('collapsed')) {
                var full = collapsible.scrollHeight;
                if (full > 80) {
                    collapsedPx = Math.round(full * 0.4);
                    collapsible.style.transition = 'none';
                    collapsible.style.maxHeight  = collapsedPx + 'px';
                    requestAnimationFrame(function () { collapsible.style.transition = ''; });
                }
            }
        });

        btn.addEventListener('click', function () {
            if (collapsible.classList.contains('collapsed')) {
                // Read full height at click-time — fonts are loaded, layout is stable
                var full = collapsible.scrollHeight;
                // Store the accurate 40% so collapsing back lands in the right place
                collapsedPx = Math.round(full * 0.4);
                collapsible.style.maxHeight = full + 'px';
                collapsible.classList.remove('collapsed');
                collapsible.classList.add('expanded');
                btn.textContent = 'Read Less ↑';
            } else {
                collapsible.style.maxHeight = collapsedPx + 'px';
                collapsible.classList.remove('expanded');
                collapsible.classList.add('collapsed');
                btn.textContent = 'Read Full Market Update ↓';
            }
        });
    }

    // ── Main: wire everything together ─────────────────────────────────────

    async function initSnapshot() {
        const loadingEl = document.getElementById('snapshotLoading');
        const gridEl    = document.getElementById('snapshotGrid');
        const summaryEl = document.getElementById('snapshotSummaryBlock');

        try {
            // getData() is defined in data-service.js — fetches from all Netlify functions,
            // checking the 24-hour localStorage cache before making any network calls
            const data = await getData();

            // Reveal the grid now that data has arrived (hides the loading spinner)
            if (loadingEl) loadingEl.style.display = 'none';
            if (gridEl)    gridEl.style.display    = 'grid';

            // Render each panel — missing data sources show '--' rather than crashing
            renderInflation(data.bls, data.fred);
            renderWages(data.bls);
            renderGDP(data.bea, data.fred);
            renderFed(data.fred);
            renderCAPE(data.fred);

            // Render the AI-written summary (may be null if Claude call failed)
            renderSummary(data.summary);

            // Show any non-fatal errors (page still loads, failed sources show '--')
            if (data.errors && data.errors.length > 0) {
                showDataErrors(data.errors);
            }

        } catch (err) {
            // getData() is designed never to throw, but handle it gracefully just in case
            if (loadingEl) {
                loadingEl.innerHTML =
                    '<p style="color:#ef4444;font-size:0.9rem">Could not load economic data. Please try again later.</p>';
            }
            console.error('[snapshot] init error:', err);
        }
    }

    document.addEventListener('DOMContentLoaded', initSnapshot);

}());
