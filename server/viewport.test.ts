import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { resolveCaptureViewport } from '../shared/viewports.ts';

test('viewport settings keep presets fixed and validate current/custom dimensions', () => {
  assert.deepEqual(resolveCaptureViewport('desktop', 400, 300), { viewport: 'desktop', width: 1920, height: 1080 });
  assert.deepEqual(resolveCaptureViewport('auto', 2560, 1339), { viewport: 'auto', width: 2560, height: 1339 });
  assert.deepEqual(resolveCaptureViewport('custom', 430, 932), { viewport: 'custom', width: 430, height: 932 });
  for (const [width, height] of [[undefined, undefined], [0, 800], [1024, -1], [1000.5, 800], ['1024', 800], [Infinity, 800], [7680, 4320]]) {
    assert.throws(() => resolveCaptureViewport('auto', width, height));
    assert.throws(() => resolveCaptureViewport('custom', width, height));
  }
  assert.throws(() => resolveCaptureViewport('unknown', 1024, 768));
});

test('current screen and custom sizes reach the capture browser and sign-in request', { timeout: 90000 }, async () => {
  const fixture = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Responsive fixture</title><main><h1></h1><p>Responsive content</p></main>
      <script>document.querySelector('h1').textContent = innerWidth + ' × ' + innerHeight;</script>`);
  });
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const appAddress = reservation.address();
  assert.ok(appAddress && typeof appAddress !== 'string');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const targetAddress = fixture.address();
  assert.ok(targetAddress && typeof targetAddress !== 'string');
  const base = `http://127.0.0.1:${appAddress.port}`;
  const target = `http://127.0.0.1:${targetAddress.port}`;
  const service = spawn(process.execPath, ['server/index.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PAGEATLAS_PORT: String(appAddress.port) }, stdio: 'ignore', windowsHide: true,
  });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`${base}/api/server-info`).then(response => response.ok).catch(() => false)) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, 'The isolated PageAtlas server did not start.');
    browser = await chromium.launch({
      ...(process.env.PAGEATLAS_BROWSER ? { executablePath: process.env.PAGEATLAS_BROWSER } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 });
    await page.goto(`${base}/#capture`);
    assert.equal(await page.getByRole('radio', { name: /Current screen/ }).isChecked(), true);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByText('1280 × 800 pixels.', { exact: false }).waitFor();
    await page.getByLabel('Website or web app URL').fill(target);
    await page.getByLabel('Capture linked pages', { exact: true }).uncheck();

    async function capture(width: number, height: number) {
      await page.getByRole('button', { name: 'Capture page', exact: true }).click();
      for (let attempt = 0; attempt < 150; attempt++) {
        const { job } = await (await page.request.get(`${base}/api/capture-job`)).json();
        if (job?.status === 'failed') assert.fail(job.error);
        if (job?.status === 'complete' && job.input?.width === width && job.input?.height === height) {
          assert.deepEqual(job.result.viewport, { width, height });
          assert.ok(job.result.sections.some((section: { label: string }) => section.label === `${width} × ${height}`), JSON.stringify(job.result.sections.map((section: { label: string }) => section.label)));
          return;
        }
        await delay(100);
      }
      assert.fail('The capture did not complete with the chosen size.');
    }
    await capture(1280, 800);
    const firstReview = (await (await page.request.get(`${base}/api/capture-job`)).json()).job.result;
    await page.getByRole('radio', { name: /Custom/ }).check();
    await page.getByLabel('Width (px)', { exact: true }).fill('430');
    await page.getByLabel('Height (px)', { exact: true }).fill('932');
    await capture(430, 932);
    assert.equal((await page.request.get(`${base}${firstReview.screenshotUrl}`)).status(), 404);
    for (const width of [320, 390, 768, 1024, 1920, 2560]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 1080 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal page overflow at ${width}px`);
      const grid = await page.locator('.workspace-grid').boundingBox();
      assert.ok(grid && grid.width <= width, `Workspace overflow at ${width}px`);
      if (width === 390 || width === 1920) await page.screenshot({ path: join(tmpdir(), `PageAtlas-layout-${width}.png`), fullPage: true });
    }
    await page.reload();
    await page.getByLabel('Width (px)', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Width (px)', { exact: true }).inputValue(), '430');
    assert.equal(await page.getByLabel('Height (px)', { exact: true }).inputValue(), '932');
    const reviewJob = (await (await page.request.get(`${base}/api/capture-job`)).json()).job;
    const forbidden = await page.request.delete(`${base}/api/reviews/${reviewJob.result.id}`, { headers: { Origin: 'https://other.test' } });
    assert.equal(forbidden.status(), 403);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export review', exact: true }).click();
    const download = await downloadEvent;
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    const html = await readFile(downloadedPath, 'utf8');
    assert.match(html, /Responsive fixture/);
    assert.match(html, /data:image\/png;base64,/);
    assert.equal((await page.request.get(`${base}${reviewJob.result.screenshotUrl}`)).status(), 404);
    assert.equal((await page.request.get(`${base}/api/capture-job/${reviewJob.id}`)).status(), 404);
    assert.equal((await (await page.request.get(`${base}/api/capture-job`)).json()).job, null);
    const reportPage = await browser.newPage();
    try {
      await reportPage.setContent(html, { waitUntil: 'load' });
      for (const width of [390, 1920]) {
        await reportPage.setViewportSize({ width, height: 900 });
        assert.ok(await reportPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Exported HTML overflow at ${width}px`);
      }
      assert.ok(await reportPage.locator('img').first().evaluate(image => (image as HTMLImageElement).naturalWidth > 0), 'The offline export must retain its screenshot after server deletion.');
    } finally {
      await reportPage.close();
    }
    await page.waitForFunction(() => (document.querySelector('#page-url') as HTMLInputElement)?.value === '');
    assert.equal(await page.locator('.screenshot img').count(), 0);
    await page.getByLabel('Website or web app URL').fill(target);
    await capture(430, 932);
    const doneJob = (await (await page.request.get(`${base}/api/capture-job`)).json()).job;
    await page.getByRole('button', { name: 'Done · delete review', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#page-url') as HTMLInputElement)?.value === '');
    assert.equal((await page.request.get(`${base}${doneJob.result.screenshotUrl}`)).status(), 404);
    assert.equal((await (await page.request.get(`${base}/api/capture-job`)).json()).job, null);
    await page.getByLabel('Website or web app URL').fill(target);
    await capture(430, 932);
    const pdfJob = (await (await page.request.get(`${base}/api/capture-job`)).json()).job;
    const pdfDownloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export all pages as PDF', exact: true }).click();
    const pdfDownload = await pdfDownloadEvent;
    assert.match(pdfDownload.suggestedFilename(), /\.pdf$/);
    const pdfPath = await pdfDownload.path();
    assert.ok(pdfPath);
    assert.equal((await readFile(pdfPath)).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await page.request.get(`${base}${pdfJob.result.screenshotUrl}`)).status(), 404);
    assert.equal((await (await page.request.get(`${base}/api/capture-job`)).json()).job, null);
    await page.waitForFunction(() => (document.querySelector('#page-url') as HTMLInputElement)?.value === '');
    await page.getByLabel('Website or web app URL').fill(target);
    await page.route('**/api/sign-in', route => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'test-session' }) }));
    await page.getByLabel('Sign in, then capture', { exact: true }).check();
    const signInRequest = page.waitForRequest(request => request.url().endsWith('/api/sign-in'));
    await page.getByRole('button', { name: 'Open sign-in window', exact: true }).click();
    const payload = (await signInRequest).postDataJSON();
    assert.equal(payload.width, 430);
    assert.equal(payload.height, 932);
  } finally {
    await browser?.close();
    if (service.exitCode === null) {
      const stopped = new Promise(resolve => service.once('exit', resolve));
      service.kill();
      await stopped;
    }
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});
