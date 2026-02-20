/**
 * Standalone script: open WhatsApp Web, send one PDF from ./pdfs/ folder.
 * Usage: Put a PDF in ./pdfs/ (e.g. invoice.pdf), set phoneNumber below, run: node sendPdf.js
 * For production use the Express server (server.js) which Odoo calls.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const phoneNumber = '919XXXXXXXXX'; // with country code, no +
const message = 'Please find the attached PDF';

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  const page = await browser.newPage();
  await page.goto('https://web.whatsapp.com');

  console.log('📱 Scan QR Code and wait for WhatsApp to load...');
  await page.waitForSelector('canvas', { timeout: 0 });
  await new Promise((r) => setTimeout(r, 15000));

  const pdfFolder = path.join(__dirname, 'pdfs');
  if (!fs.existsSync(pdfFolder)) {
    fs.mkdirSync(pdfFolder, { recursive: true });
    console.log('Created pdfs/ folder. Put a PDF there and run again.');
    await browser.close();
    return;
  }

  const files = fs.readdirSync(pdfFolder);
  const pdfFile = files.find((f) => f.toLowerCase().endsWith('.pdf'));
  if (!pdfFile) {
    console.log('No PDF found in pdfs/. Add one and run again.');
    await browser.close();
    return;
  }

  const pdfPath = path.join(pdfFolder, pdfFile);
  const chatUrl = `https://web.whatsapp.com/send?phone=${phoneNumber}&text=${encodeURIComponent(message)}`;
  await page.goto(chatUrl);

  await page.waitForSelector('span[data-icon="clip"]', { timeout: 0 });
  await page.click('span[data-icon="clip"]');

  const fileInput = await page.$('input[type="file"]');
  await fileInput.uploadFile(path.resolve(pdfPath));

  await new Promise((r) => setTimeout(r, 2000));
  await page.waitForSelector('span[data-icon="send"]');
  await page.click('span[data-icon="send"]');

  console.log('✅ PDF sent. You can close the browser.');
})();