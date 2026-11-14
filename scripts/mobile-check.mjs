import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const [url, jsonPath, screenshotPath, clientLabel] = process.argv.slice(2);
if (!url || !jsonPath || !screenshotPath || !clientLabel) {
  throw new Error('usage: node scripts/mobile-check.mjs HTTPS_URL REPORT_JSON SCREENSHOT_PNG CLIENT_LABEL');
}
if (new URL(url).protocol !== 'https:') throw new Error('the public edge URL must use HTTPS');

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await context.newPage();
  const imageResponses = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('.jpg')) {
      imageResponses.push({ status: response.status(), bytes: Number(response.headers()['content-length'] || 0) });
    }
  });
  await page.addInitScript(() => {
    window.__largestContentfulPaintMs = null;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__largestContentfulPaintMs = entry.startTime;
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    window.__lcpObserver = observer;
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: 200 * 1024,
    uploadThroughput: 75 * 1024,
    connectionType: 'cellular4g',
  });

  const started = Date.now();
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() !== 200) {
    throw new Error(`public page returned ${response?.status() ?? 'no response'}`);
  }
  await page.locator('img').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => {
    const image = document.querySelector('img');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, null, { timeout: 20000 });

  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const audience = document.querySelector('meta[name="audience"]')?.content ?? '';
    const image = document.querySelector('img');
    return {
      title: document.title,
      audience,
      lcp_ms: window.__largestContentfulPaintMs,
      load_ms: nav?.loadEventEnd ?? null,
      image_width: image?.naturalWidth ?? 0,
      image_height: image?.naturalHeight ?? 0,
      image_alt: image?.alt ?? '',
    };
  });
  metrics.edge_url = url;
  metrics.tested_at = new Date().toISOString();
  metrics.client = clientLabel;
  metrics.first_navigation_elapsed_ms = Date.now() - started;
  metrics.document_status = response.status();
  metrics.image_responses = imageResponses;

  if (metrics.audience !== 'public') throw new Error(`expected public audience, got ${metrics.audience}`);
  if (!metrics.image_alt || metrics.image_width < 1 || imageResponses.length !== 1 || imageResponses[0].status !== 200) {
    throw new Error('photo did not load as one successful image request');
  }
  if (metrics.lcp_ms === null || metrics.lcp_ms > 2500) {
    throw new Error(`mobile Largest Contentful Paint exceeded 2.5 seconds: ${metrics.lcp_ms}`);
  }

  await mkdir(path.dirname(jsonPath), { recursive: true });
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(metrics, null, 2)}\n`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify(metrics));
  await context.close();
} finally {
  await browser.close();
}
