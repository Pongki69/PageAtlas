import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { browserExecutable } from './capture.ts';
import type { CaptureResult } from './capture.ts';
import { capturePdfDocument, renderCapturePdf } from './pdf-export.ts';

test('PDF includes every captured page, fits long screenshots without cropping, and excludes review UI', async () => {
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
  let first: Buffer;
  let second: Buffer;
  try {
    const page = await browser.newPage({ viewport: { width: 1122, height: 794 } });
    await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;font:44px Arial}.block{height:700px;padding:50px}.a{background:#dceee5}.b{background:#e9e1f5}.c{background:#fff0cf;height:600px}</style><div class="block a">First capture - top</div><div class="block b">First capture - middle</div><div class="block c">First capture - bottom</div>`);
    first = await page.screenshot({ fullPage: true });
    await page.setContent('<style>body{margin:0;padding:60px;background:#e3ecfa;font:44px Arial}</style>Second capture');
    second = await page.screenshot();
  } finally { await browser.close(); }
  const makeCapture = (screenshot: Buffer, height: number): CaptureResult => ({
    title: 'Private page title', url: 'https://example.test/private', capturedAt: new Date().toISOString(),
    viewport: { width: 1122, height: 794 }, page: { width: 1122, height },
    screenshot: `data:image/png;base64,${screenshot.toString('base64')}`, sections: [], scrollRegions: [], warnings: [],
  });
  const review = { ...makeCapture(first, 2000), linkedPages: [makeCapture(second, 794)] };
  const document = capturePdfDocument(review);
  assert.equal((document.match(/class="sheet image-/g) ?? []).length, 2);
  assert.ok(!document.includes('Private page title'));
  assert.ok(!document.includes('example.test'));
  const pdf = await renderCapturePdf(review);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length, 2);
  await writeFile(join(tmpdir(), 'PageAtlas-pdf-export-test.pdf'), pdf);
});
