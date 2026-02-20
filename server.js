/**
 * WhatsApp Automation Service (Express + Puppeteer)
 * - Run once: opens WhatsApp Web, scan QR and keep browser open.
 * - POST /send-invoice: receives phone, file_path, message from Odoo; attaches PDF and sends.
 * Run: npm start  (then keep this running; Odoo calls http://localhost:3000/send-invoice)
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let browser, page;
let initialPageReadyPromise = null;
let dailyCount = 0;
let lastResetDate = new Date().toDateString();

function resetDailyCountIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyCount = 0;
    lastResetDate = today;
  }
}

async function openWhatsAppWindow() {
  if (browser && browser.connected) {
    try {
      await browser.close();
    } catch (e) {}
    browser = null;
    page = null;
  }
  initialPageReadyPromise = null;
 const browser = await puppeteer.launch({
	  headless: true,
	  args: [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--disable-dev-shm-usage',
		'--disable-gpu',
		'--no-zygote',
		'--single-process'
	  ]
	});
  page = await browser.newPage();
  initialPageReadyPromise = page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle2', timeout: 60000 });
  await initialPageReadyPromise;
  initialPageReadyPromise = null;
  try {
    await page.bringToFront();
  } catch (e) {}
}

app.post('/send-invoice', async (req, res) => {
  try {
    resetDailyCountIfNewDay();
    if (dailyCount >= DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily send limit reached (${DAILY_LIMIT}). Try again tomorrow.`,
      });
    }

    const { phone, file_path, message } = req.body;
    if (!phone || !file_path) {
      return res.status(400).json({ error: 'Missing phone or file_path' });
    }

    // Use ONLY the invoice PDF path from Odoo — no manual attachment; this file is what we attach
    const normalized = (typeof file_path === 'string' ? file_path : String(file_path)).trim().replace(/\//g, path.sep);
    const resolvedPath = path.resolve(normalized);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: 'File not found: ' + resolvedPath });
    }

    // If window was closed, reopen WhatsApp Web (QR page) so user can scan again
    const needReopen = !browser || !browser.connected || !page || page.isClosed();
    if (needReopen) {
      try {
        await openWhatsAppWindow();
      } catch (e) {
        return res.status(503).json({
          error: 'Could not open WhatsApp Web. Please try again.',
        });
      }
    }

    if (!page) {
      return res.status(503).json({
        error: 'WhatsApp Web not ready. Scan QR code and keep the service running.',
      });
    }

    // If page was closed after the check above (e.g. user closed window), reopen so QR page is visible
    if (page.isClosed()) {
      try {
        await openWhatsAppWindow();
      } catch (e) {
        return res.status(503).json({
          error: 'Could not open WhatsApp Web. Please try again.',
        });
      }
    }

    // Wait for initial WhatsApp Web load so we don't get "Requesting main frame too early!"
    if (initialPageReadyPromise) {
      await initialPageReadyPromise;
      initialPageReadyPromise = null;
    }

    // Bring WhatsApp window to front so user sees it (QR page or chat)
    try {
      await page.bringToFront();
    } catch (e) {}
    await sleep(500);

    // Check if already logged in; if not, we're on QR page — wait for user to scan (up to 3 min)
    const loggedInSelectors = [
      '[data-testid="chat-list"]', '#pane-side', '#side', 'header [data-testid="search"]',
      '[data-testid="default-user"]', 'div[role="textbox"][contenteditable="true"]',
      '[data-testid="menu-bar-menu"]', 'div[data-testid="drawer-right"]', 'aside',
      '[role="textbox"]', 'footer [role="button"]', 'div[contenteditable="true"][data-tab="1"]',
    ];
    let loggedIn = false;
    try {
      if (!page.isClosed()) {
        loggedIn = await page.evaluate((sels) => sels.some((s) => document.querySelector(s)), loggedInSelectors);
      }
    } catch (e) {}
    if (!loggedIn) {
      if (page.isClosed()) {
        try {
          await openWhatsAppWindow();
        } catch (e) {
          return res.status(503).json({
            error: 'Could not open WhatsApp Web. Please try again.',
          });
        }
      }
      try {
        await page.waitForFunction(
          (sels) => sels.some((s) => document.querySelector(s)),
          { timeout: 180000 },
          loggedInSelectors
        );
      } catch (e) {
        return res.status(503).json({
          error: 'Please scan the QR code in the WhatsApp Web window, then try again.',
        });
      }
    }

    // Open chat WITHOUT pre-filled text so we attach PDF first, then add message (avoids sending text-only)
    const chatUrl = `https://web.whatsapp.com/send?phone=${phone}`;
    await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    await sleep(DELAY_MS);
    await sleep(2500);

    const continueClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const t = (el) => (el.textContent || '').toLowerCase();
      const msg = links.find(el => /continue to chat|message|start chat|chat/.test(t(el)));
      if (msg) { msg.click(); return true; }
      return false;
    });
    if (continueClicked) await sleep(1500);

    const inputArea = 'div[contenteditable="true"][data-tab="1"]';
    const inputFallback = 'footer div[contenteditable="true"]';
    try {
      await page.waitForSelector(inputArea, { timeout: 15000 });
    } catch (e) {
      await page.waitForSelector(inputFallback, { timeout: 8000 });
    }

    const clipSelectors = [
      'span[data-icon="attach-menu-plus"]',
      'div[data-testid="conversation-clip"]',
      '[data-testid="conversation-clip-plus"]',
      'span[data-icon="clip"]',
      'div[role="button"][aria-label*="attach"]',
      'div[role="button"][aria-label*="Attach"]',
      'button[aria-label*="attach"]',
      'button[aria-label*="Attach"]',
      'footer button',
      'footer [role="button"]',
    ];
    const clipTimeout = 6000;
    let clipEl = null;
    for (const sel of clipSelectors) {
      try {
        clipEl = await page.waitForSelector(sel, { timeout: clipTimeout });
        if (clipEl) break;
      } catch (e) {
        continue;
      }
    }
    if (!clipEl) {
      const clicked = await page.evaluate(() => {
        const footer = document.querySelector('footer');
        if (!footer) return false;
        const plus = Array.from(footer.querySelectorAll('*')).find(el => (el.getAttribute('data-icon') && el.getAttribute('data-icon').includes('attach')) || el.textContent === '+');
        if (plus) { plus.click(); return true; }
        const btn = footer.querySelector('[data-icon]') || footer.querySelector('button') || footer.querySelector('[role="button"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) return res.status(500).json({ error: 'Attach button not found' });
      await sleep(1000);
    } else {
      await clipEl.click();
      await sleep(800);
    }

    // Wait for attach menu to fully render
    await sleep(1200);

    let fileAttached = false;
    const docSelectors = [
      'li[data-testid="mi-attach-document"]',
      '[data-testid="mi-attach-document"]',
      'li[data-icon="document"]',
      'span[data-icon="document"]',
      'div[role="button"][aria-label*="Document"]',
      'div[role="button"][aria-label*="document"]',
      'button[aria-label*="Document"]',
      'button[aria-label*="document"]',
      '[data-icon="document"]',
      'li span[data-icon="document"]',
      'div[role="menu"] li',
      'ul li[role="option"]',
    ];
    let docEl = null;
    for (const sel of docSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await page.evaluate(e => (e.textContent || e.getAttribute('aria-label') || '').toLowerCase(), el);
          if (sel.includes('document') || sel.includes('Document') || text.includes('document')) {
            docEl = el;
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }
    if (!docEl) {
      const fileChooserPromise = page.waitForFileChooser({ timeout: 6000 });
      const clickedByText = await page.evaluate(() => {
        const all = document.querySelectorAll('[role="button"], [role="menuitem"], li, button, div[data-testid]');
        for (const el of all) {
          const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          if (t.trim() === 'document' || (t.includes('document') && t.length < 30)) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (!clickedByText) {
        return res.status(500).json({ error: 'Document option not found in attach menu' });
      }
      try {
        const chooser = await fileChooserPromise;
        await chooser.accept([resolvedPath]);
        fileAttached = true;
      } catch (e) {
        fileAttached = false;
      }
      docEl = true;
    }

    // Prefer file chooser when clicking Document (most reliable); fallback to hidden input
    if (docEl && docEl !== true) {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 8000 }),
          docEl.click(),
        ]);
        await fileChooser.accept([resolvedPath]);
        fileAttached = true;
      } catch (e) {
        await docEl.click();
        await sleep(1000);
        const inputs = await page.$$('input[type="file"]');
        const lastInput = inputs.length ? inputs[inputs.length - 1] : null;
        if (lastInput) {
          await lastInput.uploadFile(resolvedPath);
          fileAttached = true;
        }
      }
    }
    if (!fileAttached) {
      await sleep(800);
      const inputs = await page.$$('input[type="file"]');
      const lastInput = inputs.length ? inputs[inputs.length - 1] : null;
      if (lastInput) {
        await lastInput.uploadFile(resolvedPath);
        fileAttached = true;
      }
    }
    if (!fileAttached) {
      return res.status(500).json({ error: 'Could not attach PDF (file chooser or input not available)' });
    }

    await sleep(2500);

    // Type the message after the file is attached (so both PDF + text are sent together)
    const caption = message || 'Please find your invoice attached.';
    const inputSel = await page.$(inputArea) || await page.$(inputFallback);
    if (inputSel && caption) {
      await inputSel.click();
      await page.keyboard.type(caption, { delay: 30 });
      await sleep(300);
    }

    const sendSelectors = [
      'button[data-testid="send"]',
      'span[data-icon="send"]',
      '[data-testid="send"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'footer button[aria-label]',
      'footer span[data-icon="send"]',
    ];
    let sendBtn = null;
    for (const sel of sendSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000, visible: true });
        sendBtn = await page.$(sel);
        if (sendBtn) break;
      } catch (e) {
        continue;
      }
    }
    if (!sendBtn) {
      const clicked = await page.evaluate(() => {
        const footer = document.querySelector('footer');
        if (!footer) return false;
        const sendIcon = footer.querySelector('span[data-icon="send"]');
        if (sendIcon) { sendIcon.scrollIntoView(); sendIcon.click(); return true; }
        const btns = footer.querySelectorAll('button');
        for (const b of btns) {
          const label = (b.getAttribute('aria-label') || '').toLowerCase();
          if (label.includes('send') || label.includes('submit')) { b.scrollIntoView(); b.click(); return true; }
        }
        const lastBtn = footer.querySelector('button:last-of-type');
        if (lastBtn) { lastBtn.scrollIntoView(); lastBtn.click(); return true; }
        return false;
      });
      if (!clicked) {
        await page.keyboard.press('Enter');
        await sleep(500);
      }
    } else {
      await sendBtn.evaluate((el) => el.scrollIntoView());
      await sleep(300);
      await sendBtn.click({ delay: 100 });
    }
    // With attachment in chat, Enter triggers send — press it so message goes automatically
    await page.keyboard.press('Enter');
    await sleep(300);

    dailyCount++;
    await sleep(1500);

    res.json({ success: true, message: 'Invoice sent via WhatsApp' });
  } catch (err) {
    console.error('[/send-invoice]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/health', (req, res) => {
  if (!page) {
    return res.status(503).json({ ok: false, error: 'Browser not ready yet' });
  }
  res.json({
    ok: true,
    browser: !!browser,
    page: !!page,
    dailyCount,
    limit: DAILY_LIMIT,
  });
});

(async () => {
  try {
    await openWhatsAppWindow();
    console.log('📱 Scan QR code in the browser once, then keep this window open.');
    console.log('🚀 WhatsApp Automation Service running on http://localhost:3000');
    console.log('   POST /send-invoice — send invoice (phone, file_path, message)');
    console.log('   GET  /health      — check status');
  } catch (err) {
    console.error('Failed to start browser:', err);
    process.exit(1);
  }
})();

app.listen(3000, '0.0.0.0', () => {
  console.log('Server listening on http://0.0.0.0:3000 (use http://127.0.0.1:3000 from Odoo)');
});
