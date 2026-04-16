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

    // ── Shared toggle wiring helper ────────────────────────────────────────

    function wireToggle(toggleId, getActive, setActive, drawFn) {
        const toggleEl = document.getElementById(toggleId);
        if (!toggleEl) return;
        toggleEl.addEventListener('click', function (e) {
            const btn = e.target.closest('[data-years]');
            if (!btn) return;
            const years = parseInt(btn.dataset.years, 10);
            if (years === getActive()) return;
            setActive(years);
            toggleEl.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            drawFn(years);
        });
    }

    // ── Panel 1: Inflation Comparison ─────────────────────────────────────
    // Multi-line: Headline CPI YoY, Core CPI YoY, PCE YoY
    // Dashed reference line at 2% (Fed's inflation target)

    function renderInflation(bls, fred) {
        const fullRef  = (bls && bls.headlineCPIYoY) || [];
        const fullCore = alignValues(fullRef, bls && bls.coreCPIYoY);
        const fullPce  = alignValues(fullRef, fred && fred.pcepiyoy);
        const L        = latest(fullRef);

        document.getElementById('latestInflation').textContent =
            L ? `${L.value.toFixed(1)}% CPI` : '--';
        document.getElementById('updatedInflation').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const n      = years * 12;
            const ref    = fullRef.slice(-n);
            // Slice the pre-aligned arrays by the same tail count
            const refStart = fullRef.length - ref.length;
            const core   = fullCore.slice(refStart);
            const pce    = fullPce.slice(refStart);
            const labels = ref.map(o => fmtMonth(o.date));

            if (chart) {
                chart.data.labels              = labels;
                chart.data.datasets[0].data    = ref.map(o => o.value);
                chart.data.datasets[1].data    = core;
                chart.data.datasets[2].data    = pce;
                chart.data.datasets[3].data    = labels.map(() => 2);
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartInflation'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Headline CPI', ref.map(o => o.value), C.red),
                        lineDataset('Core CPI',     core,                  C.blue),
                        lineDataset('PCE',          pce,                   C.green),
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

        wireToggle('inflation-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 2: Real vs. Nominal Wage Growth ─────────────────────────────
    // Dual-line: nominal hourly earnings YoY%, real wage growth YoY%
    // Fill between the lines makes the gap visually obvious

    function renderWages(bls) {
        const fullNominal = computeYoY(bls && bls.avgHourlyEarnings);
        const realYoY     = (bls && bls.realWageGrowth) || [];
        const fullAligned = alignValues(fullNominal, realYoY);
        const L           = latest(fullNominal);

        document.getElementById('latestWages').textContent =
            L ? `${L.value.toFixed(1)}% nominal` : '--';
        document.getElementById('updatedWages').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const n      = years * 12;
            const nom    = fullNominal.slice(-n);
            const start  = fullNominal.length - nom.length;
            const real   = fullAligned.slice(start);
            const labels = nom.map(o => fmtMonth(o.date));

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = nom.map(o => o.value);
                chart.data.datasets[1].data = real;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartWages'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Nominal Wage Growth', nom.map(o => o.value), C.blue),
                        lineDataset('Real Wage Growth', real, C.green, {
                            fill: {
                                target: '-1',
                                below:  'rgba(239,68,68,0.12)',
                                above:  'rgba(16,185,129,0.10)'
                            }
                        })
                    ]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('wages-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 3: U.S. Dollar Index (DXY) ─────────────────────────────────────
    // Daily series collapsed to monthly — higher = stronger dollar

    function renderDollarIndex(fred) {
        const fullRaw = toMonthlyLast((fred && fred.dollarIndex) || []);
        const L       = latest(fullRaw);

        document.getElementById('latestDollarIndex').textContent =
            L ? L.value.toFixed(1) : '--';
        document.getElementById('updatedDollarIndex').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const raw    = fullRaw.slice(-years * 12);
            const labels = raw.map(o => fmtMonth(o.date));
            const values = raw.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartDollarIndex'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('DXY', values, C.primary, {
                            fill: { target: 'origin', above: 'rgba(30,64,175,0.06)' }
                        })
                    ]
                },
                options: baseOptions('')
            });
        }

        wireToggle('dxy-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 4: Fed Funds Rate ────────────────────────────────────────────

    function renderFed(fred) {
        const fullRaw = (fred && fred.fedfunds) || [];
        const L       = latest(fullRaw);

        document.getElementById('latestFed').textContent =
            L ? `${L.value.toFixed(2)}% fed funds` : '--';
        document.getElementById('updatedFed').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const raw    = fullRaw.slice(-years * 12);
            const labels = raw.map(o => fmtMonth(o.date));
            const values = raw.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartFed'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Fed Funds Rate', values, C.primary, {
                            fill: { target: 'origin', above: 'rgba(30,64,175,0.06)' }
                        })
                    ]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('fed-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 5: Shiller CAPE Ratio ────────────────────────────────────────
    // Line chart with dashed reference at the long-run historical average (~16.8)

    const CAPE_HIST_AVG = 16.8;

    function renderCAPE(fred) {
        const fullData = (fred && fred.cape) || [];
        const L        = latest(fullData);

        document.getElementById('latestCAPE').textContent =
            L ? L.value.toFixed(1) : '--';
        document.getElementById('updatedCAPE').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const data   = fullData.slice(-years * 12);
            const labels = data.map(o => fmtMonth(o.date));
            const values = data.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.data.datasets[1].data = labels.map(() => CAPE_HIST_AVG);
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartCAPE'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('CAPE Ratio', values, C.primary, {
                            fill: { target: { value: CAPE_HIST_AVG }, above: 'rgba(239,68,68,0.08)' }
                        }),
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

        wireToggle('cape-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 6: Real GDP Growth (with 1Y / 5Y / 10Y toggle) ─────────────
    // Quarterly bar chart; recession-period bars shaded light red

    function renderGDP(bea, fred) {
        const allData = (bea && bea.realGDP) || [];
        const recSet  = buildRecessionSet(fred && fred.recession);
        const L       = latest(allData);

        document.getElementById('latestGDP').textContent =
            L ? `${L.value.toFixed(1)}% annualized` : '--';
        document.getElementById('updatedGDP').textContent =
            L ? `Last updated: ${fmtQtr(L.date)}` : 'Last updated: --';

        let gdpChart    = null;
        let activeYears = 10;

        function getSlice(years) { return allData.slice(-(years * 4)); }

        function buildColors(slice) {
            return slice.map(o => {
                if (inRecession(o.date, recSet)) return 'rgba(239,68,68,0.45)';
                return o.value >= 0 ? 'rgba(59,130,246,0.78)' : 'rgba(30,64,175,0.78)';
            });
        }

        function drawChart(years) {
            const slice    = getSlice(years);
            const bgColors = buildColors(slice);
            const labels   = slice.map(o => fmtQtr(o.date));
            const values   = slice.map(o => o.value);

            if (gdpChart) {
                gdpChart.data.labels                      = labels;
                gdpChart.data.datasets[0].data            = values;
                gdpChart.data.datasets[0].backgroundColor = bgColors;
                gdpChart.update();
                return;
            }

            const opts = baseOptions('%');
            gdpChart = new Chart(document.getElementById('chartGDP'), {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label:           'Real GDP Growth (annualized)',
                        data:            values,
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

        const toggleEl = document.getElementById('gdp-range-toggle');
        if (toggleEl) {
            toggleEl.addEventListener('click', function (e) {
                const btn = e.target.closest('[data-years]');
                if (!btn) return;
                const years = parseInt(btn.dataset.years, 10);
                if (years === activeYears) return;
                activeYears = years;
                toggleEl.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                drawChart(years);
            });
        }

        drawChart(activeYears);
    }

    // ── Panel 7: 10Y–2Y Yield Curve Spread ────────────────────────────────
    // Fill below zero in red — an inverted curve historically precedes recessions

    function renderYieldCurve(fred) {
        const fullRaw = toMonthlyLast((fred && fred.yieldCurveSpread) || []);
        const L       = latest(fullRaw);

        document.getElementById('latestYieldCurve').textContent =
            L ? `${L.value.toFixed(2)}%` : '--';
        document.getElementById('updatedYieldCurve').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const raw    = fullRaw.slice(-years * 12);
            const labels = raw.map(o => fmtMonth(o.date));
            const values = raw.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartYieldCurve'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('10Y–2Y Spread', values, C.blue, {
                            fill: { target: { value: 0 }, below: 'rgba(239,68,68,0.13)', above: 'rgba(16,185,129,0.08)' }
                        })
                    ]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('yield-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 8: Labor Force Participation Rate ────────────────────────────
    // Monthly BLS series — % of working-age population employed or actively seeking work

    function renderLFPR(bls) {
        const fullRaw = (bls && bls.lfpr) || [];
        const L       = latest(fullRaw);

        document.getElementById('latestLFPR').textContent =
            L ? `${L.value.toFixed(1)}%` : '--';
        document.getElementById('updatedLFPR').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const raw    = fullRaw.slice(-years * 12);
            const labels = raw.map(o => fmtMonth(o.date));
            const values = raw.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartLFPR'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('LFPR', values, C.green, {
                            fill: { target: 'origin', above: 'rgba(16,185,129,0.06)' }
                        })
                    ]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('lfpr-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 9: Real Yield & Breakeven Inflation ─────────────────────────
    // 10-year TIPS real yield vs. market-implied breakeven inflation expectation

    function renderRealYield(fred) {
        const fullRealYield = toMonthlyLast((fred && fred.realYield10y)       || []);
        const fullBreakeven = toMonthlyLast((fred && fred.breakevenInflation) || []);
        const fullAligned   = alignValues(fullRealYield, fullBreakeven);
        const L             = latest(fullRealYield);

        document.getElementById('latestRealYield').textContent =
            L ? `${L.value.toFixed(2)}% real` : '--';
        document.getElementById('updatedRealYield').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const n         = years * 12;
            const realYield = fullRealYield.slice(-n);
            const start     = fullRealYield.length - realYield.length;
            const aligned   = fullAligned.slice(start);
            const labels    = realYield.map(o => fmtMonth(o.date));

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = realYield.map(o => o.value);
                chart.data.datasets[1].data = aligned;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartRealYield'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('10Y Real Yield (TIPS)',     realYield.map(o => o.value), C.primary),
                        lineDataset('Breakeven Inflation (10Y)', aligned,                     C.amber)
                    ]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('realyield-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 10: Credit Spreads (OAS) ────────────────────────────────────
    // Investment Grade vs High Yield option-adjusted spreads in basis points
    // Periods where HY OAS > 600 bps are shaded red (market stress signal)

    function renderCreditSpreads(fred) {
        const fullHy      = toMonthlyLast((fred && fred.hySpread) || []);
        const fullIg      = toMonthlyLast((fred && fred.igSpread) || []);
        const fullIgAlign = alignValues(fullHy, fullIg);
        const L           = latest(fullHy);

        document.getElementById('latestCreditSpreads').textContent =
            L ? `${L.value.toFixed(0)} bps HY` : '--';
        document.getElementById('updatedCreditSpreads').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        const HY_STRESS = 600;

        // Mutable reference so the plugin always reads the current slice
        let currentHyValues = [];

        const stressPlugin = {
            id: 'hy-stress',
            afterDraw(chart) {
                const meta = chart.getDatasetMeta(1);
                if (!meta.data.length) return;
                const ctx = chart.ctx, area = chart.chartArea;
                let inStress = false, startX = null;
                ctx.save();
                ctx.beginPath();
                ctx.rect(area.left, area.top, area.width, area.height);
                ctx.clip();
                meta.data.forEach((point, i) => {
                    const above = currentHyValues[i] > HY_STRESS;
                    if (above && !inStress) { inStress = true; startX = point.x; }
                    else if (!above && inStress) {
                        inStress = false;
                        ctx.fillStyle = 'rgba(239,68,68,0.12)';
                        ctx.fillRect(startX, area.top, point.x - startX, area.height);
                        startX = null;
                    }
                });
                if (inStress && startX !== null) {
                    ctx.fillStyle = 'rgba(239,68,68,0.12)';
                    ctx.fillRect(startX, area.top, meta.data[meta.data.length - 1].x - startX, area.height);
                }
                ctx.restore();
            }
        };

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            const n      = years * 12;
            const hy     = fullHy.slice(-n);
            const start  = fullHy.length - hy.length;
            const ig     = fullIgAlign.slice(start);
            currentHyValues = hy.map(o => o.value);
            const labels = hy.map(o => fmtMonth(o.date));

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = ig;
                chart.data.datasets[1].data = currentHyValues;
                chart.update();
                return;
            }

            const opts = baseOptions(' bps');
            opts.plugins.tooltip.callbacks.label = ctx => {
                const v = ctx.parsed.y;
                return ` ${ctx.dataset.label}: ${v != null ? v.toFixed(0) + ' bps' : '—'}`;
            };

            chart = new Chart(document.getElementById('chartCreditSpreads'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Investment Grade OAS', ig,              C.blue),
                        lineDataset('High Yield OAS',       currentHyValues, C.red)
                    ]
                },
                options: opts,
                plugins:  [stressPlugin]
            });
        }

        wireToggle('creditspreads-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
    }

    // ── Panel 11: Household Debt Service Ratio ────────────────────────────
    // % of disposable income going to debt payments — rising = consumer stress

    function renderDebtService(fred) {
        const fullData = (fred && fred.debtServiceRatio) || [];
        const L        = latest(fullData);

        document.getElementById('latestDebtService').textContent =
            L ? `${L.value.toFixed(2)}%` : '--';
        document.getElementById('updatedDebtService').textContent =
            L ? `Last updated: ${fmtMonth(L.date)}` : 'Last updated: --';

        let chart       = null;
        let activeYears = 5;

        function draw(years) {
            // Debt Service Ratio is quarterly — 4 observations per year
            const data   = fullData.slice(-years * 4);
            const labels = data.map(o => fmtMonth(o.date));
            const values = data.map(o => o.value);

            if (chart) {
                chart.data.labels           = labels;
                chart.data.datasets[0].data = values;
                chart.update();
                return;
            }

            chart = new Chart(document.getElementById('chartDebtService'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [lineDataset('Debt Service Ratio', values, C.blue, {
                        fill: { target: 'origin', above: 'rgba(59,130,246,0.06)' }
                    })]
                },
                options: baseOptions('%')
            });
        }

        wireToggle('debtservice-range-toggle',
            () => activeYears,
            v  => { activeYears = v; },
            draw
        );
        draw(activeYears);
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

        // Show the published date below the title
        if (monthEl) {
            if (summaryData.generatedAt) {
                const d = new Date(summaryData.generatedAt);
                monthEl.textContent = 'Published ' + d.toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric'
                });
            } else if (summaryData.month) {
                monthEl.textContent = summaryData.month;
            }
        }

        // The summary arrives as plain text with paragraph breaks — wrap each in <p>
        // Strip any leading bold title Claude may have added (e.g. "**June 2025 — ...**")
        const cleanedSummary = summaryData.summary
            .replace(/^\s*\*\*[^*]+\*\*\s*\n?/, '');
        const html = cleanedSummary
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

        try {
            // getData() is defined in data-service.js — fetches from all Netlify functions,
            // checking the 24-hour localStorage cache before making any network calls
            const data = await getData();

            // Reveal the grid now that data has arrived (hides the loading spinner)
            if (loadingEl) loadingEl.style.display = 'none';
            if (gridEl)    gridEl.style.display    = 'grid';

            // Render each panel — missing data sources show '--' rather than crashing
            renderInflation(data.bls, data.fred);
            renderGDP(data.bea, data.fred);
            renderWages(data.bls);
            renderLFPR(data.bls);
            renderYieldCurve(data.fred);
            renderFed(data.fred);
            renderRealYield(data.fred);
            renderCAPE(data.fred);
            renderDollarIndex(data.fred);
            renderCreditSpreads(data.fred);
            renderDebtService(data.fred);

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
