/**
 * WhatsApp Automation Service (Express + Puppeteer)
 * - Persistent session via userDataDir (scan QR only once)
 * - GET  /qr            → returns QR code as base64 PNG (use when not logged in)
 * - GET  /status        → check login state
 * - GET  /health        → check service health
 * - POST /send-invoice  → send PDF via WhatsApp
 */

const express = require('express');
const puppeteer = require('puppeteer');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

const DAILY_LIMIT = 30;
const DELAY_MS = 1500;
const SESSION_DIR = path.join(process.env.HOME || '/home/odoo', 'whatsapp-session');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let browser = null;
let page = null;
let isLoggedIn = false;
let dailyCount = 0;
let lastResetDate = new Date().toDateString();

function resetDailyCountIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyCount = 0;
    lastResetDate = today;
  }
}

const LOGGED_IN_SELECTORS = [
  '[data-testid="chat-list"]',
  '#pane-side',
  '#side',
  'header [data-testid="search"]',
  '[data-testid="default-user"]',
  '[data-testid="menu-bar-menu"]',
  'aside',
  'div[contenteditable="true"][data-tab="1"]',
];

async function checkLoggedIn() {
  try {
    if (!page || page.isClosed()) return false;
    return await page.evaluate(
      (sels) => sels.some((s) => document.querySelector(s)),
      LOGGED_IN_SELECTORS
    );
  } catch (e) {
    return false;
  }
}

async function openWhatsAppWindow() {
  // Close existing browser if any
  if (browser) {
    try { await browser.close(); } catch (e) {}
    browser = null;
    page = null;
    isLoggedIn = false;
  }

  // Ensure session directory exists
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  console.log('🚀 Launching browser with session dir:', SESSION_DIR);

  browser = await puppeteer.launch({
    headless: true,
    userDataDir: SESSION_DIR,   // ← persistent session: scan QR only once
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-software-rasterizer',
    ],
  });

  page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  console.log('📱 Opening WhatsApp Web...');
  await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  isLoggedIn = await checkLoggedIn();
  if (isLoggedIn) {
    console.log('✅ Already logged in via saved session!');
  } else {
    console.log('⚠️  Not logged in. Call GET /qr to get QR code and scan it.');
    // Save QR screenshot automatically
    try {
      const qrPath = path.join(process.env.HOME || '/home/odoo', 'whatsapp-automation', 'qr.png');
      await page.screenshot({ path: qrPath, fullPage: true });
      console.log('📸 QR screenshot saved to:', qrPath);
    } catch (e) {
      console.log('Could not save QR screenshot:', e.message);
    }
  }
}

// ─── GET /qr ─────────────────────────────────────────────────────────────────
// Returns QR code as base64 PNG so you can view it in browser or download
app.get('/qr', async (req, res) => {
  try {
    if (!page || page.isClosed()) {
      return res.status(503).json({ error: 'Browser not ready' });
    }

    isLoggedIn = await checkLoggedIn();
    if (isLoggedIn) {
      return res.json({ status: 'already_logged_in', message: 'WhatsApp is already logged in. No QR needed.' });
    }

    // Take screenshot and return as base64
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    res.send(`
      <html>
        <body style="background:#111;display:flex;flex-direction:column;align-items:center;padding:20px">
          <h2 style="color:white">Scan this QR with WhatsApp</h2>
          <p style="color:#aaa">WhatsApp → Settings → Linked Devices → Link a Device</p>
          <img src="data:image/png;base64,${screenshot}" style="max-width:600px;border:4px solid #25D366;border-radius:8px"/>
          <p style="color:#aaa;margin-top:20px">Refresh this page after scanning to confirm login</p>
          <a href="/status" style="color:#25D366">Check login status →</a>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  isLoggedIn = await checkLoggedIn();
  res.json({
    loggedIn: isLoggedIn,
    browser: !!browser,
    page: !!page && !page.isClosed(),
    dailyCount,
    limit: DAILY_LIMIT,
    sessionDir: SESSION_DIR,
  });
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  if (!page) return res.status(503).json({ ok: false, error: 'Browser not ready' });
  res.json({ ok: true, browser: !!browser, page: !!page, loggedIn: isLoggedIn, dailyCount, limit: DAILY_LIMIT });
});

// ─── POST /send-invoice ───────────────────────────────────────────────────────
app.post('/send-invoice', async (req, res) => {
  try {
    resetDailyCountIfNewDay();
    if (dailyCount >= DAILY_LIMIT) {
      return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT}). Try again tomorrow.` });
    }

    const { phone, file_path, message } = req.body;
    if (!phone || !file_path) {
      return res.status(400).json({ error: 'Missing phone or file_path' });
    }

    const resolvedPath = path.resolve(String(file_path).trim());
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: 'File not found: ' + resolvedPath });
    }

    // Reopen browser if crashed
    if (!browser || !browser.connected || !page || page.isClosed()) {
      console.log('Browser not ready, reopening...');
      await openWhatsAppWindow();
    }

    // Check login
    isLoggedIn = await checkLoggedIn();
    if (!isLoggedIn) {
      // Wait up to 3 minutes for QR scan
      console.log('Waiting for QR scan...');
      try {
        await page.waitForFunction(
          (sels) => sels.some((s) => document.querySelector(s)),
          { timeout: 180000 },
          LOGGED_IN_SELECTORS
        );
        isLoggedIn = true;
      } catch (e) {
        return res.status(503).json({
          error: 'Not logged in. Open http://YOUR_SERVER:3000/qr in browser, scan QR code, then retry.',
        });
      }
    }

    console.log(`📤 Sending to ${phone}, file: ${resolvedPath}`);

    // Navigate to chat
    await page.goto(`https://web.whatsapp.com/send?phone=${phone}`, {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });
    await sleep(3000);

    // Click "Continue" if prompted
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a,button,[role="button"]'));
      const el = els.find(e => /continue|start chat|message/i.test(e.textContent));
      if (el) el.click();
    });
    await sleep(1500);

    // Wait for input box
    const inputSel = 'div[contenteditable="true"][data-tab="1"]';
    const inputFallback = 'footer div[contenteditable="true"]';
    try {
      await page.waitForSelector(inputSel, { timeout: 15000 });
    } catch (e) {
      await page.waitForSelector(inputFallback, { timeout: 8000 });
    }

    // Click attach button
    const attachSelectors = [
      'span[data-icon="attach-menu-plus"]',
      '[data-testid="conversation-clip"]',
      '[data-testid="conversation-clip-plus"]',
      'span[data-icon="clip"]',
      'div[role="button"][aria-label*="ttach"]',
      'button[aria-label*="ttach"]',
    ];
    let attached = false;
    for (const sel of attachSelectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 4000 });
        if (el) { await el.click(); await sleep(1000); attached = true; break; }
      } catch (e) { continue; }
    }
    if (!attached) {
      await page.evaluate(() => {
        const footer = document.querySelector('footer');
        if (!footer) return;
        const btn = footer.querySelector('[data-icon]') || footer.querySelector('[role="button"]');
        if (btn) btn.click();
      });
      await sleep(1000);
    }
    await sleep(1200);

    // Find and click Document option, then upload file
    let fileAttached = false;

    // Try file chooser approach
    const docSelectors = [
      'li[data-testid="mi-attach-document"]',
      '[data-testid="mi-attach-document"]',
      '[data-icon="document"]',
      'div[role="button"][aria-label*="ocument"]',
      'button[aria-label*="ocument"]',
    ];

    for (const sel of docSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 6000 }),
            el.click(),
          ]);
          await fileChooser.accept([resolvedPath]);
          fileAttached = true;
          console.log('✅ File attached via fileChooser');
          break;
        }
      } catch (e) { continue; }
    }

    // Fallback: click by text content
    if (!fileAttached) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 6000 }),
          page.evaluate(() => {
            const all = document.querySelectorAll('[role="button"],[role="menuitem"],li,button');
            for (const el of all) {
              const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
              if (t.includes('document')) { el.click(); return true; }
            }
            return false;
          }),
        ]);
        await fileChooser.accept([resolvedPath]);
        fileAttached = true;
        console.log('✅ File attached via text click');
      } catch (e) {
        console.log('File chooser fallback failed:', e.message);
      }
    }

    // Last resort: hidden input
    if (!fileAttached) {
      const inputs = await page.$$('input[type="file"]');
      if (inputs.length) {
        await inputs[inputs.length - 1].uploadFile(resolvedPath);
        fileAttached = true;
        console.log('✅ File attached via hidden input');
      }
    }

    if (!fileAttached) {
      return res.status(500).json({ error: 'Could not attach PDF' });
    }

    await sleep(2500);

    // Type caption
    const caption = message || 'Please find your invoice attached.';
    try {
      const inputEl = await page.$(inputSel) || await page.$(inputFallback);
      if (inputEl) {
        await inputEl.click();
        await page.keyboard.type(caption, { delay: 30 });
        await sleep(500);
      }
    } catch (e) {}

    // Send
    let sent = false;
    const sendSelectors = [
      'button[data-testid="send"]',
      'span[data-icon="send"]',
      '[data-testid="send"]',
      'button[aria-label*="Send"]',
    ];
    for (const sel of sendSelectors) {
      try {
        const btn = await page.waitForSelector(sel, { timeout: 5000, visible: true });
        if (btn) {
          await btn.evaluate(el => el.scrollIntoView());
          await sleep(300);
          await btn.click({ delay: 100 });
          sent = true;
          break;
        }
      } catch (e) { continue; }
    }
    if (!sent) {
      await page.keyboard.press('Enter');
    }
    await sleep(1500);

    dailyCount++;
    console.log(`✅ Sent to ${phone}. Daily count: ${dailyCount}`);
    res.json({ success: true, message: 'Invoice sent via WhatsApp', dailyCount });

  } catch (err) {
    console.error('[/send-invoice] ERROR:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(3000, '0.0.0.0', () => {
  console.log('Server listening on http://0.0.0.0:3000');
});

(async () => {
  try {
    await openWhatsAppWindow();
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  GET  /qr           → view QR in browser');
    console.log('  GET  /status       → check login state');
    console.log('  GET  /health       → health check');
    console.log('  POST /send-invoice → send PDF via WhatsApp');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (!isLoggedIn) {
      console.log('');
      console.log('⚠️  NOT LOGGED IN!');
      console.log('   Open this URL in your browser to scan QR:');
      console.log('   http://YOUR_SERVER_IP:3000/qr');
      console.log('   (Open port 3000 in AWS Security Group first)');
    }
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();