import { chromium } from 'playwright-core';
import { browserExecutable } from './capture.ts';
import type { CaptureResult } from './capture.ts';

export function capturePdfDocument(review: CaptureResult) {
  const landscape = review.viewport.width > review.viewport.height;
  const width = landscape ? 1122 : 794;
  const height = landscape ? 794 : 1122;
  const styles: string[] = [];
  const sheets: string[] = [];
  for (const capture of [review, ...(review.linkedPages ?? [])]) {
    const images = capture.viewportShots?.length ? capture.viewportShots : [{ ...capture.page, screenshot: capture.screenshot }];
    for (const shot of images) {
      const id = styles.length;
      const scale = Math.min(width / shot.width, height / shot.height);
      const imageWidth = shot.width * scale;
      const imageHeight = shot.height * scale;
      styles.push(`.image-${id}{background-image:url("${shot.screenshot}");background-size:${imageWidth}px ${imageHeight}px}`);
      sheets.push(`<div class="sheet image-${id}" style="background-position:center center"></div>`);
    }
  }
  return `<!doctype html><meta charset="utf-8"><style>
    @page{size:${width}px ${height}px;margin:0}
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:white}
    .sheet{width:${width}px;height:${height}px;background-repeat:no-repeat;break-after:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}
    .sheet:last-child{break-after:auto}
    ${styles.join('\n')}
    </style>${sheets.join('')}`;
}

export async function renderCapturePdf(review: CaptureResult): Promise<Buffer> {
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, timeout: 12000,
    // Containers often have a tiny /dev/shm, which crashes Chromium while rendering large pages.
    ...(process.env.PAGEATLAS_HOSTED === '1' && { args: ['--disable-dev-shm-usage'] }),
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(capturePdfDocument(review), { waitUntil: 'load', timeout: 20000 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.pdf({ preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('PDF export took too long. Please try again.')), 45000); }),
      ]);
    } finally { clearTimeout(timeout); }
  } finally {
    await browser.close();
  }
}
