/* Economic Dashboard - Fetch real data from Federal Reserve API */

document.addEventListener('DOMContentLoaded', () => {
    initHeroAnimation();
    fetchEconomicData();
    fetchSubstackPosts();
});

/* ============================================================
   HERO ANIMATION
   Full-screen intro that compresses into a sticky header as
   the user scrolls. Only runs when #hero exists (index.html).
   ============================================================ */

function initHeroAnimation() {
    const hero     = document.getElementById('hero');
    if (!hero) return;

    const spacer   = document.getElementById('heroSpacer');
    const title    = document.getElementById('heroTitle');
    const subtitle = document.getElementById('heroSubtitle');
    const canvas   = document.getElementById('heroCanvas');
    const hint     = document.getElementById('heroScrollHint');
    const nav      = document.getElementById('sidenav');
    const navItems = nav.querySelectorAll('.sidenav-menu li');
    const socialEl = nav.querySelector('.sidenav-social');

    const FINAL_H      = 68;    // px — resting header height after animation
    const SCROLL_RANGE = 1225;  // px of scroll to complete the animation
    const FS_SCALE_END = 1.6 / 5; // title shrinks from 5rem → 1.6rem via transform

    // Spacer height is fixed: scroll range + final header height.
    // This ensures content starts exactly at the header bottom when animation ends.
    function setSpacerHeight() {
        spacer.style.height = (SCROLL_RANGE + FINAL_H) + 'px';
    }
    setSpacerHeight();
    window.addEventListener('resize', setSpacerHeight);

    // Skip animation for users who prefer reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyProgress(1);
        return;
    }

    let raf = null;

    function easeInOut(t) {
        return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    }

    function applyProgress(p) {
        const viewH = window.innerHeight;

        // ── Hero: clip from the bottom (hard edge) ──
        const clipBottom = (viewH - FINAL_H) * p;
        hero.style.clipPath = `inset(0 0 ${clipBottom.toFixed(1)}px 0)`;

        // ── Title: scale down AND float upward into header position ──
        // Without this translateY, the title stays at the vertical center of
        // the full 100vh hero and vanishes above the visible mask area.
        const scale      = 1 + (FS_SCALE_END - 1) * p;            // 1.0 → 0.32
        const translateY = (FINAL_H / 2 - viewH / 2) * p;          // 0 → ~-366px
        title.style.transform = `translateY(${translateY.toFixed(1)}px) scale(${scale.toFixed(4)})`;

        // ── Subtitle fades out; canvas stays visible as a persistent background ──
        subtitle.style.opacity = Math.max(0, 1 - p * 2.5).toFixed(3);
        if (hint) hint.style.opacity = Math.max(0, 1 - p * 4).toFixed(3);
    }

    function tick() {
        raf = null;
        applyProgress(easeInOut(Math.min(window.scrollY / SCROLL_RANGE, 1)));
    }

    window.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(tick); }, { passive: true });
    window.addEventListener('resize', tick);

    tick(); // set correct initial state on page load

    startHeroCanvas(canvas);
}

/* Animated graph-line background for the hero canvas */
function startHeroCanvas(canvas) {
    const ctx = canvas.getContext('2d');

    // Each entry defines one chart-like wave: position, frequencies, speed, style
    const LINES = [
        { yFrac: 0.30, f1: 1.6, a1: 0.080, f2: 4.5, a2: 0.025, ph: 0.0, spd: 0.20, alpha: 0.16, lw: 2.0 },
        { yFrac: 0.50, f1: 2.4, a1: 0.055, f2: 6.0, a2: 0.020, ph: 1.4, spd: 0.15, alpha: 0.13, lw: 1.5 },
        { yFrac: 0.67, f1: 1.3, a1: 0.065, f2: 5.5, a2: 0.022, ph: 2.6, spd: 0.18, alpha: 0.11, lw: 1.5 },
        { yFrac: 0.40, f1: 3.0, a1: 0.040, f2: 7.5, a2: 0.015, ph: 0.9, spd: 0.25, alpha: 0.09, lw: 1.0 },
    ];

    let t0 = null;

    function resize() {
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    function draw(ts) {
        if (!t0) t0 = ts;
        const t = (ts - t0) / 1000; // seconds elapsed

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Faint horizontal grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.lineWidth   = 1;
        for (let i = 1; i < 5; i++) {
            ctx.beginPath();
            ctx.moveTo(0,   H * i / 5);
            ctx.lineTo(W, H * i / 5);
            ctx.stroke();
        }

        // Chart lines
        LINES.forEach(l => {
            ctx.beginPath();
            ctx.strokeStyle = `rgba(255,255,255,${l.alpha})`;
            ctx.lineWidth   = l.lw;
            ctx.lineJoin    = 'round';

            const N = Math.max(60, Math.floor(W / 8));
            for (let i = 0; i <= N; i++) {
                const xp = (i / N) * Math.PI * 2;
                const x  = (i / N) * W;
                const y  = H * l.yFrac
                    + Math.sin(xp * l.f1 + t * l.spd * Math.PI * 2)         * H * l.a1
                    + Math.sin(xp * l.f2 + t * l.spd * Math.PI * 2 + l.ph)  * H * l.a2;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        });

        requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(draw);
}

async function fetchEconomicData() {
    const loadingSpinner = document.getElementById('loadingSpinner');

    try {
        loadingSpinner.style.display = 'flex';

        const API_KEY = '459a75b9d65c1c4b7794661625265047';
        const base = 'https://api.stlouisfed.org/fred/series/observations';
        const params = `&api_key=${API_KEY}&file_type=json&sort_order=asc`;

        const [gdpRes, cpiRes, unrateRes, fedRes] = await Promise.all([
            fetch(`${base}?series_id=GDP${params}&observation_start=2018-01-01`),
            fetch(`${base}?series_id=CPIAUCSL${params}&observation_start=2022-01-01`),
            fetch(`${base}?series_id=UNRATE${params}&observation_start=2023-01-01`),
            fetch(`${base}?series_id=FEDFUNDS${params}&observation_start=2023-01-01`)
        ]);

        if (!gdpRes.ok || !cpiRes.ok || !unrateRes.ok || !fedRes.ok) {
            throw new Error('One or more FRED API requests failed');
        }

        const [gdpJson, cpiJson, unrateJson, fedJson] = await Promise.all([
            gdpRes.json(), cpiRes.json(), unrateRes.json(), fedRes.json()
        ]);

        const gdpObs    = gdpJson.observations.filter(o => o.value !== '.');
        const cpiObs    = cpiJson.observations.filter(o => o.value !== '.');
        const unrateObs = unrateJson.observations.filter(o => o.value !== '.');
        const fedObs    = fedJson.observations.filter(o => o.value !== '.');

        displayGDPChart(gdpObs);
        updateIndicatorsLive(cpiObs, unrateObs, fedObs);

        const latest = new Date(gdpObs[gdpObs.length - 1].date);
        document.getElementById('lastUpdated').textContent =
            'Last updated: ' + latest.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        loadingSpinner.style.display = 'none';

    } catch (error) {
        console.error('FRED API error — falling back to mock data:', error);
        displayMockData();
        loadingSpinner.style.display = 'none';
    }
}

function updateIndicatorsLive(cpiObs, unrateObs, fedObs) {
    /* YoY CPI inflation: compare latest to value 12 months prior */
    if (cpiObs.length >= 13) {
        const latest  = parseFloat(cpiObs[cpiObs.length - 1].value);
        const yearAgo = parseFloat(cpiObs[cpiObs.length - 13].value);
        const yoy = ((latest - yearAgo) / yearAgo) * 100;
        document.getElementById('inflationRate').textContent = yoy.toFixed(1) + '%';
    }

    if (unrateObs.length > 0) {
        const val = parseFloat(unrateObs[unrateObs.length - 1].value);
        document.getElementById('unemploymentRate').textContent = val.toFixed(1) + '%';
    }

    if (fedObs.length > 0) {
        const val = parseFloat(fedObs[fedObs.length - 1].value);
        document.getElementById('fedRate').textContent = val.toFixed(2) + '%';
    }
}

/* Display mock/sample economic data */
function displayMockData() {
    /* Mock GDP data (quarterly) */
    const mockGdpObservations = [
        { date: '2023-01-01', value: '27360.1' },
        { date: '2023-04-01', value: '27535.2' },
        { date: '2023-07-01', value: '27815.6' },
        { date: '2023-10-01', value: '28200.5' },
        { date: '2024-01-01', value: '28556.8' },
        { date: '2024-04-01', value: '28754.3' },
        { date: '2024-07-01', value: '29215.7' },
        { date: '2024-10-01', value: '29835.4' }
    ];
    
    /* Mock inflation data */
    const mockInflationObservations = [
        { value: '3.4' },
        { value: '3.2' },
        { value: '3.1' }
    ];
    
    /* Mock unemployment data */
    const mockUnemploymentObservations = [
        { value: '3.8' },
        { value: '4.0' },
        { value: '4.1' }
    ];
    
    /* Mock Fed Rate data */
    const mockFedRateObservations = [
        { value: '5.33' },
        { value: '5.25' },
        { value: '5.00' }
    ];
    
    displayGDPChart(mockGdpObservations);
    updateIndicatorsMock(mockInflationObservations, mockUnemploymentObservations, mockFedRateObservations);
    
    document.getElementById('lastUpdated').textContent = 'Last updated: Sample Data';
}


function displayGDPChart(observations) {
    /* Need at least 2 data points to compute a growth rate */
    const allValid = observations.filter(obs => obs.value && obs.value !== '.');
    if (allValid.length < 2) return;

    /* Keep the last 17 raw values so we can produce 16 growth-rate bars */
    const raw = allValid.slice(-17);

    const labels = raw.slice(1).map(obs => {
        const d = new Date(obs.date);
        const q = Math.floor(d.getUTCMonth() / 3) + 1;
        return `Q${q} ${d.getUTCFullYear()}`;
    });

    /* QoQ % change: annualised using the standard BEA method ((curr/prev)^4 - 1) * 100 */
    const growthRates = raw.slice(1).map((obs, i) => {
        const curr = parseFloat(obs.value);
        const prev = parseFloat(raw[i].value);
        return (Math.pow(curr / prev, 4) - 1) * 100;
    });

    const backgroundColors = growthRates.map(r => r >= 0 ? '#3b82f6' : '#1e40af');

    const ctx = document.getElementById('gdpChart').getContext('2d');
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'GDP Growth Rate (annualised %)',
                data: growthRates,
                backgroundColor: backgroundColors,
                borderRadius: 4,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: ctx => ctx.parsed.y.toFixed(2) + '%'
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#1f2937',
                        font: { weight: 500 }
                    },
                    grid: {
                        color: 'rgba(30, 64, 175, 0.1)',
                        drawBorder: false
                    }
                },
                y: {
                    ticks: {
                        color: '#1f2937',
                        font: { weight: 500 },
                        callback: value => value.toFixed(1) + '%'
                    },
                    grid: {
                        color: 'rgba(30, 64, 175, 0.1)',
                        drawBorder: false
                    }
                }
            }
        }
    });
}

function updateIndicators(inflationData, unemploymentData, fedRateData) {
    const latestInflation = inflationData.observations
        .filter(obs => obs.value && obs.value !== '.')
        .pop();
    
    const latestUnemployment = unemploymentData.observations
        .filter(obs => obs.value && obs.value !== '.')
        .pop();
    
    const latestFedRate = fedRateData.observations
        .filter(obs => obs.value && obs.value !== '.')
        .pop();
    
    const inflationYoY = calculateYoYChange(inflationData.observations);
    
    if (latestInflation) {
        document.getElementById('inflationRate').textContent = inflationYoY.toFixed(2) + '%';
    }
    
    if (latestUnemployment) {
        document.getElementById('unemploymentRate').textContent = parseFloat(latestUnemployment.value).toFixed(2) + '%';
    }
    
    if (latestFedRate) {
        document.getElementById('fedRate').textContent = parseFloat(latestFedRate.value).toFixed(2) + '%';
    }
}

function updateIndicatorsMock(inflationData, unemploymentData, fedRateData) {
    /* Get the last values from mock data */
    const latestInflation = inflationData[inflationData.length - 1];
    const latestUnemployment = unemploymentData[unemploymentData.length - 1];
    const latestFedRate = fedRateData[fedRateData.length - 1];
    
    document.getElementById('inflationRate').textContent = latestInflation.value + '%';
    document.getElementById('unemploymentRate').textContent = latestUnemployment.value + '%';
    document.getElementById('fedRate').textContent = latestFedRate.value + '%';
}

async function fetchSubstackPosts() {
    const container = document.getElementById('substackPosts');
    if (!container) return;

    try {
        /* Substack RSS feeds support CORS — fetch directly */
        const response = await fetch('https://murphonomics.substack.com/feed');

        if (!response.ok) throw new Error('Feed unavailable');

        const text = await response.text();
        const xml = new DOMParser().parseFromString(text, 'text/xml');
        const items = Array.from(xml.querySelectorAll('item'));

        if (items.length === 0) {
            container.innerHTML = '<p class="substack-error">No posts yet. <a href="https://murphonomics.substack.com/" target="_blank" rel="noopener noreferrer">Visit Substack</a> to get started.</p>';
            return;
        }

        /* RSS is already newest-first but sort to be safe */
        const posts = items.map(item => {
            const rawLink = item.querySelector('link');
            /* In RSS XML, <link> text is a sibling text node */
            const link = rawLink ? (rawLink.textContent || rawLink.nextSibling?.nodeValue || '').trim() : '';
            return {
                title: item.querySelector('title')?.textContent?.trim() || 'Untitled',
                link: link || 'https://murphonomics.substack.com/',
                pubDate: new Date(item.querySelector('pubDate')?.textContent || 0)
            };
        }).sort((a, b) => b.pubDate - a.pubDate);

        container.innerHTML = posts.map(post => {
            const dateStr = post.pubDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return `
                <a class="substack-post" href="${post.link}" target="_blank" rel="noopener noreferrer">
                    <span class="substack-post-date">${dateStr}</span>
                    <span class="substack-post-title">${post.title}</span>
                </a>`;
        }).join('');

    } catch {
        /* Fallback: show known articles statically (fetch fails on file:// protocol) */
        const fallbackPosts = [
            { title: 'The Trump Economy', link: 'https://murphonomics.substack.com/p/the-trump-economy', date: '' }
        ];
        container.innerHTML = fallbackPosts.map(post => `
            <a class="substack-post" href="${post.link}" target="_blank" rel="noopener noreferrer">
                ${post.date ? `<span class="substack-post-date">${post.date}</span>` : ''}
                <span class="substack-post-title">${post.title}</span>
            </a>`).join('');
    }
}

function calculateYoYChange(observations) {
    const validData = observations.filter(obs => obs.value && obs.value !== '.');
    if (validData.length < 12) return 0;
    
    const latest = parseFloat(validData[validData.length - 1].value);
    const yearAgo = parseFloat(validData[validData.length - 13].value);
    
    if (yearAgo === 0) return 0;
    return ((latest - yearAgo) / yearAgo) * 100;
}
