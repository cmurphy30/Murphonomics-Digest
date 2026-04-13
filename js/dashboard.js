/**
 * dashboard.js — Full economic data dashboard for dashboard.html
 *
 * Renders ten chart panels organized into three sections, plus an
 * AI-generated economic summary at the top of the page.
 *
 * All data comes from getData() in data-service.js, which handles caching
 * and fetching from the three Netlify functions (fred-data, bls-data, bea-data).
 * The summary is fetched by getData() internally and exposed as data.summary.
 *
 * The Refresh button calls fetchSummary() from data-service.js directly —
 * both functions are globally accessible from that file.
 *
 * Load order required in HTML:
 *   1. Chart.js CDN
 *   2. js/cache.js          ← getFromCache / saveToCache / SUMMARY_CACHE_TTL_MS
 *   3. js/data-service.js   ← getData / fetchSummary
 *   4. js/dashboard.js      ← this file
 */

(function () {
    'use strict';

    // ── Colors (all from STYLE_GUIDE.md) ──────────────────────────────────────

    const C = {
        primary:   '#1e40af',
        blue:      '#3b82f6',
        blueLight: '#60a5fa',
        green:     '#10b981',
        red:       '#ef4444',
        amber:     '#f59e0b',
        gray:      '#64748b',
        gridLine:  'rgba(30,64,175,0.08)'
    };

    // ── Data helpers ───────────────────────────────────────────────────────────

    function latest(series) {
        if (!Array.isArray(series) || series.length === 0) return null;
        return series[series.length - 1];
    }

    // Collapse a daily series to one value per month (keeps the last observation)
    function toMonthlyLast(series) {
        if (!series) return [];
        const byMonth = new Map();
        series.forEach(obs => { byMonth.set(obs.date.slice(0, 7), obs); });
        return Array.from(byMonth.values());
    }

    // Compute YoY % change from a dollar-level series (e.g. average hourly earnings)
    function computeYoY(levelSeries) {
        if (!levelSeries || levelSeries.length === 0) return [];
        const byDate = new Map(levelSeries.map(o => [o.date, o.value]));
        return levelSeries.map(obs => {
            const d = new Date(obs.date + 'T00:00:00Z');
            d.setUTCFullYear(d.getUTCFullYear() - 1);
            const prior = byDate.get(d.toISOString().slice(0, 10));
            if (prior == null) return null;
            return { date: obs.date, value: +((obs.value - prior) / prior * 100).toFixed(2) };
        }).filter(Boolean);
    }

    // Build a Set of "YYYY-MM" strings where USREC = 1
    function buildRecessionSet(recSeries) {
        const s = new Set();
        if (!recSeries) return s;
        recSeries.forEach(obs => { if (obs.value === 1) s.add(obs.date.slice(0, 7)); });
        return s;
    }

    // Does a BEA quarterly date ("2024Q1") overlap with a recession month?
    function inRecession(qtrDate, recSet) {
        const yr  = qtrDate.slice(0, 4);
        const map = { '1':['01','02','03'], '2':['04','05','06'], '3':['07','08','09'], '4':['10','11','12'] };
        return (map[qtrDate[5]] || []).some(m => recSet.has(`${yr}-${m}`));
    }

    // Align a secondary series onto the reference series's dates
    function alignValues(refSeries, secondarySeries) {
        const m = new Map((secondarySeries || []).map(o => [o.date, o.value]));
        return refSeries.map(obs => m.has(obs.date) ? m.get(obs.date) : null);
    }

    // Format "YYYY-MM-DD" → "Jan '24"
    function fmtMonth(d) {
        return new Date(d + 'T00:00:00Z')
            .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }

    // Format BEA quarter string "2024Q1" → "Q1 '24"
    function fmtQtr(q) {
        return `Q${q[5]} '${q.slice(2, 4)}`;
    }

    // Compute change between the last two values in a series.
    // Returns { text, color } for display, or null if series is too short.
    function computeChange(series, decimals) {
        const dec = decimals != null ? decimals : 2;
        if (!Array.isArray(series) || series.length < 2) return null;
        const last = series[series.length - 1].value;
        const prev = series[series.length - 2].value;
        const diff = last - prev;
        const arrow = diff >= 0 ? '↑' : '↓';
        return {
            text:  `${arrow} ${Math.abs(diff).toFixed(dec)}`,
            color: diff >= 0 ? C.green : C.red
        };
    }

    // ── Panel stat helpers ─────────────────────────────────────────────────────

    // Populate the value, change, and updated timestamp for one panel.
    // series is the primary data series used to derive the change and timestamp.
    function setStats(id, valueText, series, decimals, isQtrly) {
        const valEl = document.getElementById(`val-${id}`);
        const chgEl = document.getElementById(`chg-${id}`);
        const updEl = document.getElementById(`upd-${id}`);
        const L     = latest(series);

        if (valEl) valEl.textContent = valueText || '--';

        if (chgEl) {
            const chg = computeChange(series, decimals);
            if (chg) {
                chgEl.textContent = chg.text;
                chgEl.style.color = chg.color;
            }
        }

        if (updEl && L) {
            const label = isQtrly ? fmtQtr(L.date) : fmtMonth(L.date);
            updEl.textContent = `Last updated: ${label}`;
        }
    }

    // ── Chart.js building blocks ───────────────────────────────────────────────

    function lineDataset(label, data, color, overrides) {
        return Object.assign({
            label,
            data,
            borderColor:      color,
            borderWidth:      2,
            pointRadius:      0,
            pointHoverRadius: 4,
            tension:          0.35,
            fill:             false
        }, overrides || {});
    }

    // Shared Chart.js config. isLarge increases tick density for full-width panels.
    function baseOptions(yUnit, isLarge) {
        const u = yUnit || '';
        return {
            responsive:          true,
            maintainAspectRatio: false,
            interaction:         { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        font:     { family: "'Inter', sans-serif", size: 11 },
                        boxWidth: 14,
                        padding:  8,
                        color:    C.gray
                    }
                },
                tooltip: {
                    backgroundColor: C.primary,
                    titleFont:  { family: "'Inter', sans-serif", size: 12 },
                    bodyFont:   { family: "'Inter', sans-serif", size: 12 },
                    padding:    10,
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
                        maxTicksLimit: isLarge ? 14 : 8,
                        font:          { size: 11, family: "'Inter', sans-serif" },
                        color:         C.gray,
                        maxRotation:   0
                    },
                    grid:   { display: false },
                    border: { color: '#e2e8f0' }
                },
                y: {
                    ticks: {
                        font:     { size: 11, family: "'Inter', sans-serif" },
                        color:    C.gray,
                        callback: v => v + u
                    },
                    grid:   { color: C.gridLine },
                    border: { color: '#e2e8f0' }
                }
            }
        };
    }

    // Inline vertical-line annotation plugin — no extra CDN required.
    // vlines: [{ date: "YYYY-MM", label: "text", color: "rgba(...)" }]
    // Matches against the formatted x-axis labels ("Apr '22" style).
    function makeVLinePlugin(vlines) {
        return {
            id: 'vlines',
            afterDraw(chart) {
                if (!vlines || !vlines.length) return;
                const ctx    = chart.ctx;
                const labels = chart.data.labels || [];
                vlines.forEach(vl => {
                    const targetLabel = new Date(vl.date + 'T00:00:00Z')
                        .toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
                    const idx = labels.indexOf(targetLabel);
                    if (idx === -1) return;
                    const meta = chart.getDatasetMeta(0);
                    if (!meta.data[idx]) return;
                    const x = meta.data[idx].x;
                    const { top, bottom } = chart.chartArea;
                    ctx.save();
                    ctx.beginPath();
                    ctx.moveTo(x, top + 16);
                    ctx.lineTo(x, bottom);
                    ctx.strokeStyle = vl.color || 'rgba(100,116,139,0.5)';
                    ctx.lineWidth   = 1.5;
                    ctx.setLineDash([4, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.font      = "10px 'Inter', sans-serif";
                    ctx.fillStyle = vl.color || '#64748b';
                    ctx.textAlign = 'center';
                    ctx.fillText(vl.label, x, top + 11);
                    ctx.restore();
                });
            }
        };
    }

    // Show an error message inside a panel's chart area when rendering fails
    function showPanelError(canvasId, message) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const wrap = canvas.closest('.db-chart-wrap');
        if (wrap) {
            wrap.innerHTML = `<div class="db-panel-error">Could not load chart: ${message}</div>`;
        }
    }

    // ── SECTION 1: MACROECONOMIC CONDITIONS ───────────────────────────────────

    function renderGDP(bea, fred) {
        try {
            const data   = (bea && bea.realGDP) || [];
            const recSet = buildRecessionSet(fred && fred.recession);
            const L      = latest(data);

            setStats('gdp', L ? `${L.value.toFixed(1)}%` : '--', data, 1, true);

            const bgColors = data.map(o => {
                if (inRecession(o.date, recSet)) return 'rgba(239,68,68,0.45)';
                return o.value >= 0 ? 'rgba(59,130,246,0.78)' : 'rgba(30,64,175,0.78)';
            });

            const opts = baseOptions('%', true);
            new Chart(document.getElementById('chart-gdp'), {
                type: 'bar',
                data: {
                    labels:   data.map(o => fmtQtr(o.date)),
                    datasets: [{
                        label:           'Real GDP Growth (annualized, %)',
                        data:            data.map(o => o.value),
                        backgroundColor: bgColors,
                        borderRadius:    3,
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
                                font: { family: "'Inter', sans-serif", size: 11 },
                                boxWidth: 14,
                                padding:  8
                            }
                        }
                    }
                }
            });
        } catch (err) {
            showPanelError('chart-gdp', err.message);
        }
    }

    function renderInflation(bls, fred) {
        try {
            const ref  = (bls && bls.headlineCPIYoY) || [];
            const core = alignValues(ref, bls && bls.coreCPIYoY);
            const pce  = alignValues(ref, fred && fred.pcepiyoy);
            const L    = latest(ref);

            setStats('inflation', L ? `${L.value.toFixed(1)}% CPI` : '--', ref, 1);

            const labels = ref.map(o => fmtMonth(o.date));
            new Chart(document.getElementById('chart-inflation'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Headline CPI',    ref.map(o => o.value), C.red),
                        lineDataset('Core CPI',        core,                  C.blue),
                        lineDataset('PCE',             pce,                   C.green),
                        lineDataset('Fed Target (2%)', labels.map(() => 2),   C.amber, {
                            borderDash: [5, 4], borderWidth: 1.5, tension: 0, pointRadius: 0
                        })
                    ]
                },
                options: baseOptions('%')
            });
        } catch (err) {
            showPanelError('chart-inflation', err.message);
        }
    }

    function renderLFPR(bls) {
        try {
            const data = (bls && bls.lfpr) || [];
            const L    = latest(data);

            setStats('lfpr', L ? `${L.value.toFixed(1)}%` : '--', data, 1);

            // Pre-pandemic level (Jan 2020 ≈ 63.3%) as a dashed reference line.
            // The COVID drop itself falls just outside the 5-year window, so the
            // reference line provides context for how far participation has recovered.
            const PRE_PANDEMIC = 63.3;
            const labels = data.map(o => fmtMonth(o.date));

            new Chart(document.getElementById('chart-lfpr'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('LFPR', data.map(o => o.value), C.primary),
                        lineDataset(`Pre-pandemic level (${PRE_PANDEMIC}%)`, labels.map(() => PRE_PANDEMIC), C.amber, {
                            borderDash: [5, 4], borderWidth: 1.5, tension: 0, pointRadius: 0
                        })
                    ]
                },
                options: baseOptions('%')
            });
        } catch (err) {
            showPanelError('chart-lfpr', err.message);
        }
    }

    // ── SECTION 2: MONETARY POLICY & DEBT ─────────────────────────────────────

    function renderFed(fred) {
        try {
            const fedRaw        = (fred && fred.fedfunds) || [];
            const spreadMonthly = toMonthlyLast((fred && fred.yieldCurveSpread) || []);
            const spreadAligned = alignValues(fedRaw, spreadMonthly);
            const L             = latest(fedRaw);

            setStats('fed', L ? `${L.value.toFixed(2)}%` : '--', fedRaw, 2);

            const labels = fedRaw.map(o => fmtMonth(o.date));
            const opts   = baseOptions('%', true);
            delete opts.scales.y;
            opts.scales.yLeft = {
                position: 'left',
                title:    { display: true, text: 'Fed Funds Rate', font: { size: 10 }, color: C.gray },
                ticks:    { font: { size: 11, family: "'Inter', sans-serif" }, color: C.gray, callback: v => v + '%' },
                grid:     { color: C.gridLine },
                border:   { color: '#e2e8f0' }
            };
            opts.scales.yRight = {
                position: 'right',
                title:    { display: true, text: '2Y/10Y Spread', font: { size: 10 }, color: C.gray },
                grid:     { drawOnChartArea: false },
                ticks:    { font: { size: 11, family: "'Inter', sans-serif" }, color: C.gray, callback: v => v + '%' },
                border:   { color: '#e2e8f0' }
            };
            opts.plugins.tooltip.callbacks.label = ctx => {
                const v = ctx.parsed.y;
                return ` ${ctx.dataset.label}: ${v != null ? v.toFixed(2) + '%' : '—'}`;
            };

            // Custom plugin: shade periods where yield curve is inverted (spread < 0)
            const inversionShadePlugin = {
                id: 'inversion-shade',
                afterDraw(chart) {
                    const meta = chart.getDatasetMeta(1); // spread dataset
                    if (!meta.data.length) return;
                    const ctx       = chart.ctx;
                    const yScale    = chart.scales.yRight;
                    const zero      = yScale.getPixelForValue(0);
                    const chartArea = chart.chartArea;
                    let inInversion = false;
                    let startX      = null;

                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
                    ctx.clip();

                    const spreadData = spreadAligned;
                    meta.data.forEach((point, i) => {
                        const val = spreadData[i];
                        if (val != null && val < 0 && !inInversion) {
                            inInversion = true;
                            startX = point.x;
                        } else if ((val == null || val >= 0) && inInversion) {
                            inInversion = false;
                            ctx.fillStyle = 'rgba(239,68,68,0.10)';
                            ctx.fillRect(startX, chartArea.top, point.x - startX, chartArea.height);
                            startX = null;
                        }
                    });
                    // Close any open inversion period at the right edge
                    if (inInversion && startX !== null) {
                        const lastX = meta.data[meta.data.length - 1].x;
                        ctx.fillStyle = 'rgba(239,68,68,0.10)';
                        ctx.fillRect(startX, chartArea.top, lastX - startX, chartArea.height);
                    }
                    ctx.restore();
                }
            };

            new Chart(document.getElementById('chart-fed'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('Fed Funds Rate', fedRaw.map(o => o.value), C.primary, { yAxisID: 'yLeft' }),
                        lineDataset('2Y/10Y Spread',  spreadAligned, C.red, {
                            yAxisID: 'yRight',
                            fill: { target: { value: 0 }, below: 'rgba(239,68,68,0.13)' }
                        })
                    ]
                },
                options: opts,
                plugins:  [inversionShadePlugin]
            });
        } catch (err) {
            showPanelError('chart-fed', err.message);
        }
    }

    function renderRealYield(fred) {
        try {
            const realYield = toMonthlyLast((fred && fred.realYield10y)       || []);
            const breakeven = toMonthlyLast((fred && fred.breakevenInflation) || []);
            const aligned   = alignValues(realYield, breakeven);
            const L         = latest(realYield);

            setStats('realyield', L ? `${L.value.toFixed(2)}% real` : '--', realYield, 2);

            new Chart(document.getElementById('chart-realyield'), {
                type: 'line',
                data: {
                    labels:   realYield.map(o => fmtMonth(o.date)),
                    datasets: [
                        lineDataset('10-Year Real Yield (TIPS)',       realYield.map(o => o.value), C.primary),
                        lineDataset('Breakeven Inflation Expectation', aligned,                     C.amber)
                    ]
                },
                options: baseOptions('%')
            });
        } catch (err) {
            showPanelError('chart-realyield', err.message);
        }
    }

    function renderDebtService(fred) {
        try {
            const data = (fred && fred.debtServiceRatio) || [];
            const L    = latest(data);

            setStats('debt', L ? `${L.value.toFixed(2)}%` : '--', data, 2, true);

            new Chart(document.getElementById('chart-debt'), {
                type: 'line',
                data: {
                    labels:   data.map(o => fmtMonth(o.date)),
                    datasets: [lineDataset('Debt Service Ratio', data.map(o => o.value), C.blue)]
                },
                options: baseOptions('%')
            });
        } catch (err) {
            showPanelError('chart-debt', err.message);
        }
    }

    // ── SECTION 3: WAGES, MARKETS & FINANCIAL CONDITIONS ──────────────────────

    function renderWages(bls) {
        try {
            const nominalYoY  = computeYoY(bls && bls.avgHourlyEarnings);
            const realYoY     = (bls && bls.realWageGrowth) || [];
            const realAligned = alignValues(nominalYoY, realYoY);
            const L           = latest(nominalYoY);

            setStats('wages', L ? `${L.value.toFixed(1)}% nominal` : '--', nominalYoY, 1);

            new Chart(document.getElementById('chart-wages'), {
                type: 'line',
                data: {
                    labels:   nominalYoY.map(o => fmtMonth(o.date)),
                    datasets: [
                        lineDataset('Nominal Wage Growth', nominalYoY.map(o => o.value), C.blue),
                        lineDataset('Real Wage Growth',    realAligned,                  C.green, {
                            fill: {
                                target: '-1',
                                below:  'rgba(239,68,68,0.12)',   // inflation outpacing wages
                                above:  'rgba(16,185,129,0.10)'   // wages beating inflation
                            }
                        })
                    ]
                },
                options: baseOptions('%', true)
            });
        } catch (err) {
            showPanelError('chart-wages', err.message);
        }
    }

    function renderCAPE(fred) {
        try {
            const data     = (fred && fred.cape) || [];
            const HIST_AVG = 16.8;
            const L        = latest(data);

            setStats('cape', L ? L.value.toFixed(1) : '--', data, 1);

            const labels = data.map(o => fmtMonth(o.date));
            new Chart(document.getElementById('chart-cape'), {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        lineDataset('CAPE Ratio', data.map(o => o.value), C.primary, {
                            fill: { target: { value: HIST_AVG }, above: 'rgba(239,68,68,0.08)' }
                        }),
                        lineDataset(`Historical Avg (${HIST_AVG})`, labels.map(() => HIST_AVG), C.amber, {
                            borderDash: [5, 4], borderWidth: 1.5, tension: 0, pointRadius: 0, fill: false
                        })
                    ]
                },
                options: baseOptions('')
            });
        } catch (err) {
            showPanelError('chart-cape', err.message);
        }
    }

    function renderCreditSpreads(fred) {
        try {
            const igMonthly = toMonthlyLast((fred && fred.igSpread) || []);
            const hyMonthly = toMonthlyLast((fred && fred.hySpread) || []);
            // Use HY as the reference timeline (generally same length as IG)
            const igAligned = alignValues(hyMonthly, igMonthly);
            const L         = latest(hyMonthly);

            setStats('credit', L ? `${L.value.toFixed(0)} bps HY` : '--', hyMonthly, 0);

            const HY_STRESS = 600; // bps threshold for "stress" shading

            // Custom plugin: shade periods where HY OAS > 600 bps in light red
            const stressPlugin = {
                id: 'hy-stress',
                afterDraw(chart) {
                    const meta = chart.getDatasetMeta(1); // HY is dataset index 1
                    if (!meta.data.length) return;
                    const ctx       = chart.ctx;
                    const chartArea = chart.chartArea;
                    const hyValues  = hyMonthly.map(o => o.value);
                    let inStress    = false;
                    let startX      = null;

                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
                    ctx.clip();

                    meta.data.forEach((point, i) => {
                        const above = hyValues[i] > HY_STRESS;
                        if (above && !inStress) {
                            inStress = true;
                            startX   = point.x;
                        } else if (!above && inStress) {
                            inStress = false;
                            ctx.fillStyle = 'rgba(239,68,68,0.12)';
                            ctx.fillRect(startX, chartArea.top, point.x - startX, chartArea.height);
                            startX = null;
                        }
                    });
                    if (inStress && startX !== null) {
                        const lastX = meta.data[meta.data.length - 1].x;
                        ctx.fillStyle = 'rgba(239,68,68,0.12)';
                        ctx.fillRect(startX, chartArea.top, lastX - startX, chartArea.height);
                    }
                    ctx.restore();
                }
            };

            const opts = baseOptions(' bps');
            opts.plugins.tooltip.callbacks.label = ctx => {
                const v = ctx.parsed.y;
                return ` ${ctx.dataset.label}: ${v != null ? v.toFixed(0) + ' bps' : '—'}`;
            };

            new Chart(document.getElementById('chart-credit'), {
                type: 'line',
                data: {
                    labels:   hyMonthly.map(o => fmtMonth(o.date)),
                    datasets: [
                        lineDataset('Investment Grade OAS', igAligned,                  C.blue),
                        lineDataset('High Yield OAS',       hyMonthly.map(o => o.value), C.red)
                    ]
                },
                options: opts,
                plugins:  [stressPlugin]
            });
        } catch (err) {
            showPanelError('chart-credit', err.message);
        }
    }

    function renderDXY(fred) {
        try {
            const data = toMonthlyLast((fred && fred.dollarIndex) || []);
            const L    = latest(data);

            setStats('dxy', L ? L.value.toFixed(1) : '--', data, 1);

            // Key DXY events within the 5-year data window
            const vlines = [
                { date: '2022-03', label: 'Fed hike cycle',  color: 'rgba(100,116,139,0.75)' },
                { date: '2022-09', label: 'DXY peak',        color: 'rgba(239,68,68,0.75)'   },
                { date: '2023-02', label: 'Dollar retreat',  color: 'rgba(100,116,139,0.75)' }
            ];

            new Chart(document.getElementById('chart-dxy'), {
                type: 'line',
                data: {
                    labels:   data.map(o => fmtMonth(o.date)),
                    datasets: [lineDataset('U.S. Dollar Index (DXY)', data.map(o => o.value), C.primary)]
                },
                options: baseOptions('', true),
                plugins:  [makeVLinePlugin(vlines)]
            });
        } catch (err) {
            showPanelError('chart-dxy', err.message);
        }
    }

    // ── ECONOMIC SUMMARY ───────────────────────────────────────────────────────

    function displaySummary(data) {
        const monthEl  = document.getElementById('db-summary-month');
        const textEl   = document.getElementById('db-summary-text');
        const metaEl   = document.getElementById('db-summary-meta');
        const statusEl = document.getElementById('db-summary-status');
        const bodyEl   = document.getElementById('db-summary-body');

        if (statusEl) statusEl.style.display = 'none';
        if (bodyEl)   bodyEl.style.display   = 'block';

        if (monthEl && data.month)       monthEl.textContent = data.month;
        if (metaEl  && data.generatedAt) {
            const d = new Date(data.generatedAt);
            metaEl.textContent = 'Generated: ' + d.toLocaleDateString('en-US', {
                month: 'long', day: 'numeric', year: 'numeric'
            });
        }

        if (textEl && data.summary) {
            textEl.innerHTML = data.summary
                .split(/\n{2,}/)
                .filter(p => p.trim())
                .map(p => `<p>${p.trim()}</p>`)
                .join('');
        }
    }

    function showSummaryStatus(message, isError) {
        const statusEl = document.getElementById('db-summary-status');
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.style.color  = isError ? '#b91c1c' : '';
        statusEl.style.display = 'block';
    }

    // ── HINT TOGGLES ───────────────────────────────────────────────────────────

    function initHints() {
        document.querySelectorAll('.db-hint-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const hintEl = document.getElementById(`hint-${btn.dataset.panel}`);
                if (!hintEl) return;
                const visible = hintEl.style.display !== 'none';
                hintEl.style.display = visible ? 'none' : 'block';
                btn.textContent      = visible ? 'What is this?' : 'Hide ↑';
            });
        });
    }

    // ── MAIN ───────────────────────────────────────────────────────────────────

    async function initDashboard() {
        const loadingEl = document.getElementById('db-loading');
        const contentEl = document.getElementById('db-content');
        const errorEl   = document.getElementById('db-error');

        initHints();

        try {
            // getData() is from data-service.js — fetches FRED, BLS, BEA (cached 24h),
            // then calls fetchSummary internally (cached 30 days) and returns everything
            const data = await getData();

            // Store for the refresh button closure
            const { fred, bls, bea } = data;

            // Hide loading, reveal content
            if (loadingEl) loadingEl.style.display = 'none';
            if (contentEl) contentEl.style.display = 'block';

            // Show non-fatal source errors (page still renders with whatever loaded)
            if (data.errors && data.errors.length > 0) {
                const errEl = document.getElementById('db-data-errors');
                if (errEl) {
                    errEl.innerHTML = data.errors.map(e => `<p>${e}</p>`).join('');
                    errEl.style.display = 'block';
                }
            }

            // Render all ten panels (each is individually try/caught inside)
            renderGDP(bea, fred);
            renderInflation(bls, fred);
            renderLFPR(bls);
            renderFed(fred);
            renderRealYield(fred);
            renderDebtService(fred);
            renderWages(bls);
            renderCAPE(fred);
            renderCreditSpreads(fred);
            renderDXY(fred);

            // Display the summary (getData() already fetched or cached it)
            if (data.summary) {
                displaySummary(data.summary);
            } else {
                showSummaryStatus('Summary unavailable — check Netlify function logs.', true);
            }

            // Refresh button: clears the 30-day summary cache and re-generates.
            // fetchSummary() is defined in data-service.js (globally accessible).
            // Only fires on explicit click — never automatically.
            const refreshBtn = document.getElementById('db-summary-refresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', async e => {
                    e.preventDefault();
                    const bodyEl = document.getElementById('db-summary-body');
                    if (bodyEl) bodyEl.style.display = 'none';
                    showSummaryStatus('Generating new summary…', false);

                    try {
                        // Clear the localStorage cache entry before calling fetchSummary
                        // so it doesn't return the stale cached value
                        localStorage.removeItem('murphonomics_summary');
                        const fresh = await fetchSummary(fred, bls, bea);
                        displaySummary(fresh);
                    } catch (err) {
                        showSummaryStatus('Could not refresh: ' + err.message, true);
                    }
                });
            }

        } catch (err) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (errorEl) {
                errorEl.textContent = 'Could not load dashboard data: ' + err.message;
                errorEl.style.display = 'block';
            }
            console.error('[dashboard] init error:', err);
        }
    }

    document.addEventListener('DOMContentLoaded', initDashboard);

}());
