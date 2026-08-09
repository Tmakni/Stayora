#!/usr/bin/env node
/**
 * Responsive layout check (dev tool, not part of the Jest suite).
 *
 *   node scripts/check-mobile-layout.js
 *
 * Boots the real Express server against a throwaway SQLite database, seeds a
 * user with both a small and a large dataset, then drives headless Chrome
 * through every page at the phone widths this app targets and asserts:
 *
 *   1. no horizontal overflow (scrollWidth must not exceed clientWidth);
 *   2. no element sticking out past the right edge of the viewport;
 *   3. interactive controls meet a ~44px touch target on coarse pointers;
 *   4. the mobile tab bar is present, and hidden on a full-screen thread.
 *
 * Uses puppeteer-core with the locally installed Chrome — no browser download.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WIDTHS = [360, 375, 390, 430, 768];
const HEIGHT = 800;

const PAGES = [
  { name: 'Accueil', path: '/' },
  { name: 'Conversations (liste)', path: '/conversations' },
  { name: 'Logements', path: '/properties' },
  { name: 'Calendrier', path: '/calendar' },
  { name: 'Automatisations', path: '/automations' },
  { name: 'Intégrations', path: '/integrations' },
  { name: 'Paramètres', path: '/settings' },
];

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const PORT = process.env.CHECK_PORT || 3457;
const BASE = `http://127.0.0.1:${PORT}`;

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, data: json, raw: text };
}

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      const data = await res.json();
      if (data.ready) return;
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error('server never became ready');
    await new Promise((r) => setTimeout(r, 400));
  }
}

(async () => {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error('Chrome introuvable — installez Chrome ou ajustez CHROME_CANDIDATES.');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(__dirname, '..', 'client', 'dist', 'index.html'))) {
    console.error('client/dist absent — lancez d\'abord: npm --prefix client run build');
    process.exit(1);
  }

  // CHECK_EXTERNAL=1 → a server is already listening on PORT (started elsewhere,
  // e.g. under WSL where better-sqlite3's native build actually loads, while
  // Chrome runs on the Windows side). Otherwise boot one in-process.
  const external = process.env.CHECK_EXTERNAL === '1';
  let dbFile = null;
  let httpServer = null;

  if (external) {
    console.log(`Utilise le serveur déjà démarré sur ${BASE}`);
    await waitForServer();
  } else {
    dbFile = path.join(os.tmpdir(), `michel-mobile-check-${Date.now()}.db`);
    process.env.SQLITE_DB_PATH = dbFile;
    process.env.NODE_ENV = 'development';
    process.env.PORT = String(PORT);
    process.env.USE_MEMORY_DB = 'true';

    const server = require(path.join(__dirname, '..', 'server', 'server.js'));
    httpServer = http.createServer(server);
    await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve));
    await server.initializeApp();
    await waitForServer();
  }

  // ── Seed ──────────────────────────────────────────────────────────────
  const email = `mobile-check-${Date.now()}@example.test`;
  const password = 'MobileCheck123';
  const reg = await api('/api/auth/register', { method: 'POST', body: { email, password } });
  const token = reg.data?.token;
  if (!token) {
    console.error('Seed: registration failed:', reg.status, reg.raw.slice(0, 300));
    process.exit(1);
  }

  const bigDataset = process.env.SMALL_DATASET !== '1';
  const propertyCount = bigDataset ? 12 : 1;
  const conversationCount = bigDataset ? 60 : 2;

  for (let i = 0; i < propertyCount; i++) {
    await api('/api/properties', {
      method: 'POST', token,
      body: {
        name: bigDataset
          ? `Villa ${i} — Un nom de logement volontairement très long pour tester la troncature`
          : 'Petit studio',
        property_type: 'apartment', bedrooms: 2, beds: 2, bathrooms: 1, max_guests: 4,
      },
    });
  }

  for (let i = 0; i < conversationCount; i++) {
    const conv = await api('/api/conversations', {
      method: 'POST', token,
      body: { title: `Conversation ${i} avec un titre très long pour éprouver la mise en page mobile`, booking_status: 'inquiry' },
    });
    const convId = conv.data?.conversation?.id;
    if (convId && i < 4) {
      for (let m = 0; m < 6; m++) {
        await api(`/api/conversations/${convId}/messages`, {
          method: 'POST', token,
          body: {
            role: m % 2 ? 'outgoing' : 'incoming',
            content: 'Bonjour, '.repeat(20) + 'https://exemple-de-lien-tres-long.example.com/qui/ne/doit/pas/deborder',
          },
        });
      }
    }
  }

  const convList = await api('/api/conversations?limit=1', { token });
  const firstConvId = convList.data?.conversations?.[0]?.id;

  // ── Browser ───────────────────────────────────────────────────────────
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const failures = [];
  const results = [];

  const targets = [...PAGES];
  if (firstConvId) targets.push({ name: 'Conversation (thread)', path: `/conversations/${firstConvId}` });

  for (const width of WIDTHS) {
    const page = await browser.newPage();
    // isMobile/hasTouch make Chrome report a COARSE pointer, which is what the
    // touch-target CSS in index.css keys off.
    await page.setViewport({ width, height: HEIGHT, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 2 });

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t, e) => {
      localStorage.setItem('token', t);
      localStorage.setItem('user_email', e);
    }, token, email);

    for (const target of targets) {
      await page.goto(`${BASE}${target.path}`, { waitUntil: 'networkidle2' });
      await new Promise((r) => setTimeout(r, 450));

      const report = await page.evaluate((vw) => {
        const doc = document.documentElement;
        const overflowPx = doc.scrollWidth - doc.clientWidth;

        // Elements poking past the right edge (ignore fixed/sticky chrome and
        // anything inside a deliberately scrollable container).
        const offenders = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= vw + 1) continue;
          let scrollableAncestor = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (/(auto|scroll)/.test(s.overflowX)) { scrollableAncestor = true; break; }
          }
          if (scrollableAncestor) continue;
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && String(el.className).slice(0, 60)) || '',
            right: Math.round(r.right),
          });
          if (offenders.length >= 5) break;
        }

        // Touch targets
        const small = [];
        for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], input, select, textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (getComputedStyle(el).display === 'none') continue;
          if (r.height < 40 || r.width < 24) {
            small.push({
              tag: el.tagName.toLowerCase(),
              label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28),
              h: Math.round(r.height), w: Math.round(r.width),
            });
          }
          if (small.length >= 6) break;
        }

        const nav = document.querySelector('nav[aria-label="Navigation principale"]');
        const navVisible = !!nav && getComputedStyle(nav).display !== 'none' && nav.getBoundingClientRect().height > 0;

        return { overflowPx, offenders, small, navVisible, bodyText: document.body.innerText.slice(0, 60) };
      }, width);

      const isThread = target.path.startsWith('/conversations/');
      const label = `${String(width).padStart(3)}px ${target.name}`;

      if (report.overflowPx > 0) {
        failures.push(`${label}: débordement horizontal de ${report.overflowPx}px`);
      }
      if (report.offenders.length > 0) {
        failures.push(`${label}: ${report.offenders.length} élément(s) hors écran → ` +
          report.offenders.map((o) => `${o.tag}.${o.cls.split(' ')[0]}@${o.right}`).join(', '));
      }
      if (width < 768 && report.small.length > 0) {
        failures.push(`${label}: cibles tactiles < 40px → ` +
          report.small.map((s) => `${s.tag}"${s.label}"(${s.w}x${s.h})`).join(', '));
      }
      // The tab bar must be there on phones — except on a full-screen thread.
      if (width < 1024) {
        if (isThread && report.navVisible) failures.push(`${label}: la barre d'onglets devrait être masquée sur un fil ouvert`);
        if (!isThread && !report.navVisible) failures.push(`${label}: barre d'onglets absente`);
      }

      results.push({ width, page: target.name, overflow: report.overflowPx, offenders: report.offenders.length, small: report.small.length, nav: report.navVisible });
    }

    await page.close();
  }

  await browser.close();
  if (httpServer) httpServer.close();

  // ── Report ────────────────────────────────────────────────────────────
  console.log('');
  console.log(`Dataset: ${propertyCount} logements, ${conversationCount} conversations`);
  console.log('');
  console.log('largeur | page                     | overflow | hors-écran | petites cibles | tabbar');
  console.log('--------|--------------------------|----------|------------|----------------|-------');
  for (const r of results) {
    console.log(
      `${String(r.width).padStart(6)}px | ${r.page.padEnd(24)} | ${String(r.overflow).padStart(8)} | ` +
      `${String(r.offenders).padStart(10)} | ${String(r.small).padStart(14)} | ${r.nav ? 'oui' : 'non'}`
    );
  }
  console.log('');

  if (dbFile) { try { fs.unlinkSync(dbFile); } catch (_) {} }

  if (failures.length > 0) {
    console.log(`ÉCHECS (${failures.length}) :`);
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }

  console.log('✓ Aucun débordement horizontal, aucune cible tactile trop petite, navigation correcte.');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
