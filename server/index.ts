import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePage, CaptureError, isOnThisComputer, openCaptureSession } from './capture.ts';
import type { CaptureResult, InteractiveCapture } from './capture.ts';
import { renderReport } from './report.ts';

const viewports = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PAGEATLAS_PORT ?? 4317);
const dev = process.argv.includes('--dev');
const maxBodyBytes = 8192;
const reviewLifetime = 60 * 60 * 1000;
const signedInReviewLifetime = 15 * 60 * 1000;
const signInLifetime = 10 * 60 * 1000;
const maxReviews = 5;
const maxReviewImageBytes = 96 * 1024 * 1024;
const pngPrefix = 'data:image/png;base64,';
const staticTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const appPolicy = "default-src 'self'; img-src 'self' data:; style-src-attr 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PAGEATLAS_PORT must be a whole number between 1024 and 65535.');
}

const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const reviews = new Map<string, { capture: CaptureResult; expiresAt: number; imageBytes: number }>();
type SignIn = { id: string; browser: InteractiveCapture; expiresAt: number; timeout: NodeJS.Timeout; closing?: Promise<void> };
let signIn: SignIn | undefined;
let isCapturing = false;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function captureInput(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new CaptureError(415, 'Send the capture settings as JSON.');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      req.resume();
      throw new CaptureError(413, 'The capture settings are too large.');
    }
    chunks.push(chunk);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CaptureError(400, 'The capture settings could not be read.');
  }

  if (!body || typeof body !== 'object' || !('url' in body) || !('viewport' in body)) {
    throw new CaptureError(400, 'Enter a web address and choose a viewport.');
  }
  if (typeof body.url !== 'string' || body.url.length > 4096) {
    throw new CaptureError(400, 'Enter a valid web address.');
  }
  if (body.viewport !== 'desktop' && body.viewport !== 'tablet' && body.viewport !== 'mobile') {
    throw new CaptureError(400, 'Choose Desktop, Tablet, or Mobile.');
  }
  const allowDevCertificate = 'allowDevCertificate' in body ? body.allowDevCertificate : false;
  if (typeof allowDevCertificate !== 'boolean') {
    throw new CaptureError(400, 'Choose whether to allow a local development certificate.');
  }
  const crawl = 'crawl' in body ? body.crawl : false;
  if (typeof crawl !== 'boolean') throw new CaptureError(400, 'Choose whether to capture linked pages.');

  let url: URL;
  try {
    url = new URL(body.url.trim());
  } catch {
    throw new CaptureError(400, 'Enter a complete HTTP or HTTPS address.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CaptureError(400, 'Use an HTTP or HTTPS address without embedded credentials.');
  }
  const hostname = url.hostname.replace(/\.$/, '');
  if (loopbackNames.has(hostname) && Number(url.port) === port) {
    throw new CaptureError(400, 'Enter the address of the site or web app you want to review.');
  }
  if (allowDevCertificate && (url.protocol !== 'https:' || !isOnThisComputer(hostname))) {
    throw new CaptureError(400, 'The development certificate option is available only for HTTPS apps running on this computer.');
  }
  return { url: url.href, ...viewports[body.viewport], allowDevCertificate, crawl };
}

function removeExpiredReviews(): void {
  const now = Date.now();
  for (const [id, review] of reviews) {
    if (review.expiresAt <= now) reviews.delete(id);
  }
}

const expirationTimer = setInterval(removeExpiredReviews, 60_000);
expirationTimer.unref();

function requireSameOrigin(req: IncomingMessage): void {
  if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) {
    throw new CaptureError(403, 'Start the capture from PageAtlas.');
  }
}

function reviewPageMetadata(capture: CaptureResult, id: string, reviewPath: string) {
  const { screenshot, viewportScreenshot, viewportShots, scrollRegions, linkedPages: _linkedPages, ...metadata } = capture;
  if (!screenshot.startsWith(pngPrefix) || (viewportScreenshot && !viewportScreenshot.screenshot.startsWith(pngPrefix))
    || viewportShots?.some(shot => !shot.screenshot.startsWith(pngPrefix))
    || scrollRegions.some(region => !region.screenshot.startsWith(pngPrefix))) {
    throw new Error('Unexpected screenshot format');
  }
  return {
    id,
    ...metadata,
    screenshotUrl: `${reviewPath}/screenshot`,
    viewportShots: viewportShots?.map(({ screenshot: _screenshot, ...shot }) => ({
      ...shot,
      screenshotUrl: `${reviewPath}/shots/${encodeURIComponent(shot.id)}`,
    })),
    viewportScreenshot: viewportScreenshot ? {
      width: viewportScreenshot.width,
      height: viewportScreenshot.height,
      screenshotUrl: `${reviewPath}/viewport`,
    } : undefined,
    scrollRegions: scrollRegions.map(({ screenshot: _screenshot, ...region }) => ({
      ...region,
      screenshotUrl: `${reviewPath}/scroll-regions/${encodeURIComponent(region.id)}/screenshot`,
    })),
  };
}

function sendReview(res: ServerResponse, capture: CaptureResult, lifetime = reviewLifetime): void {
  const id = randomUUID();
  const reviewPath = `/api/reviews/${id}`;
  const metadata = reviewPageMetadata(capture, id, reviewPath);
  const linkedPages = capture.linkedPages?.map((page, index) =>
    reviewPageMetadata(page, `${id}-page-${index + 2}`, `${reviewPath}/pages/${index + 2}`),
  );
  const imageBytes = [capture, ...(capture.linkedPages ?? [])].reduce((total, page) =>
    total + page.screenshot.length + (page.viewportScreenshot?.screenshot.length ?? 0)
    + (page.viewportShots?.slice(1).reduce((sum, shot) => sum + shot.screenshot.length, 0) ?? 0)
    + page.scrollRegions.reduce((sum, region) => sum + region.screenshot.length, 0), 0,
  );
  removeExpiredReviews();
  let retainedImageBytes = [...reviews.values()].reduce((total, review) => total + review.imageBytes, 0);
  for (const [oldest, review] of reviews) {
    if (reviews.size < maxReviews && retainedImageBytes + imageBytes <= maxReviewImageBytes) break;
    reviews.delete(oldest);
    retainedImageBytes -= review.imageBytes;
  }
  reviews.set(id, { capture, imageBytes, expiresAt: Date.now() + lifetime });
  sendJson(res, 201, { ...metadata, linkedPages });
}

function closeSignIn(session: SignIn): Promise<void> {
  clearTimeout(session.timeout);
  session.closing ??= session.browser.close().catch(() => {}).finally(() => {
    if (signIn === session) signIn = undefined;
  });
  return session.closing;
}

function requireIdle(): void {
  if (isCapturing) throw new CaptureError(429, 'A capture is already running. Try again in a moment.');
  if (!signIn) return;
  if (signIn.browser.isOpen()) throw new CaptureError(409, 'Finish or close the open sign-in window first.');
  void closeSignIn(signIn);
}

async function createReview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireSameOrigin(req);
  const input = await captureInput(req);
  requireIdle();

  isCapturing = true;
  try {
    const capture = await capturePage(input);
    if (!res.destroyed) sendReview(res, capture);
  } finally {
    isCapturing = false;
  }
}

async function startSignIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireSameOrigin(req);
  const input = await captureInput(req);
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && !loopbackNames.has(url.hostname.replace(/\.$/, ''))) {
    throw new CaptureError(400, 'Use an HTTPS address to sign in, or a localhost address for a local app.');
  }
  requireIdle();

  isCapturing = true;
  try {
    const browser = await openCaptureSession(input);
    if (res.destroyed) {
      await browser.close();
      return;
    }
    const id = randomUUID();
    const expiresAt = Date.now() + signInLifetime;
    const timeout = setTimeout(() => {
      if (signIn?.id === id && !isCapturing) void closeSignIn(signIn);
    }, signInLifetime);
    timeout.unref();
    signIn = { id, browser, expiresAt, timeout };
    sendJson(res, 201, { id });
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(502, 'The sign-in window could not open. Try again.');
  } finally {
    isCapturing = false;
  }
}

async function finishSignIn(req: IncomingMessage, res: ServerResponse, id: string, cancel: boolean): Promise<void> {
  requireSameOrigin(req);
  const session = signIn?.id === id ? signIn : undefined;
  if (!session || session.closing) throw new CaptureError(410, 'This sign-in session ended. Open a new sign-in window.');
  if (isCapturing) throw new CaptureError(429, 'A capture is already running. Try again in a moment.');
  if (cancel) {
    await closeSignIn(session);
    res.writeHead(204).end();
    return;
  }
  if (session.expiresAt <= Date.now()) {
    await closeSignIn(session);
    throw new CaptureError(410, 'This sign-in session ended. Open a new sign-in window.');
  }
  if (!session.browser.isOpen()) {
    await closeSignIn(session);
    throw new CaptureError(410, 'The sign-in window closed. Open a new window to capture the page.');
  }

  isCapturing = true;
  let keepOpen = false;
  let capture: CaptureResult;
  try {
    capture = await session.browser.capture();
  } catch (error) {
    if (error instanceof CaptureError) {
      if (error.status === 409 || error.status === 429) {
        keepOpen = session.browser.isOpen() && session.expiresAt > Date.now();
        if (!keepOpen) throw new CaptureError(410, 'This sign-in session ended. Open a new sign-in window.');
      }
      throw error;
    }
    throw new CaptureError(502, 'The signed-in page could not be captured. Open a new sign-in window and try again.');
  } finally {
    if (!keepOpen) await closeSignIn(session);
    isCapturing = false;
  }
  if (!res.destroyed) sendReview(res, capture, signedInReviewLifetime);
}

function serveReview(res: ServerResponse, id: string, action: string, regionId?: string, pageNumber?: string, shotId?: string): void {
  removeExpiredReviews();
  const review = reviews.get(id)?.capture;
  if (!review) throw new CaptureError(404, 'This review has expired. Capture the page again.');

  if (action === 'export') {
    if (pageNumber) throw new CaptureError(404, 'Export the complete review from PageAtlas.');
    const report = renderReport(review);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="pageatlas-review-${id.slice(0, 8)}.html"`,
    });
    res.end(report);
    return;
  }

  const page = pageNumber ? review.linkedPages?.[Number(pageNumber) - 2] : review;
  if (!page) throw new CaptureError(404, 'This page is not part of the review.');
  let image: string | undefined = page.screenshot;
  if (regionId) image = page.scrollRegions.find(region => region.id === regionId)?.screenshot;
  if (action === 'viewport') image = page.viewportScreenshot?.screenshot;
  if (shotId) image = page.viewportShots?.find(shot => shot.id === shotId)?.screenshot;
  if (!image) throw new CaptureError(404, 'This image is not part of the review.');
  const screenshot = Buffer.from(image.slice(pngPrefix.length), 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': screenshot.length });
  res.end(screenshot);
}

const vite = dev ? await (await import('vite')).createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, host: '127.0.0.1' },
}) : undefined;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  if (!req.headers.host || !hosts.has(req.headers.host)) {
    throw new CaptureError(403, 'Open PageAtlas using its local address.');
  }
  const pathname = req.url?.split('?')[0] ?? '';
  if (pathname === '/api/capture' && req.method === 'POST') {
    await createReview(req, res);
    return;
  }
  if (pathname === '/api/sign-in' && req.method === 'POST') {
    await startSignIn(req, res);
    return;
  }
  const signInPath = /^\/api\/sign-in\/([0-9a-f-]{36})(\/capture)?$/.exec(pathname);
  if (signInPath?.[1] && (signInPath[2] ? req.method === 'POST' : req.method === 'DELETE')) {
    await finishSignIn(req, res, signInPath[1], !signInPath[2]);
    return;
  }
  const reviewPath = /^\/api\/reviews\/([0-9a-f-]{36})(?:\/pages\/([1-9]\d?))?\/(screenshot|viewport|export|scroll-regions\/([a-z0-9-]{1,32})\/screenshot|shots\/(view-\d{1,2}))$/.exec(pathname);
  if (req.method === 'GET' && reviewPath?.[1] && reviewPath[3]) {
    serveReview(res, reviewPath[1], reviewPath[3], reviewPath[4], reviewPath[2], reviewPath[5]);
    return;
  }
  if (pathname.startsWith('/api/')) throw new CaptureError(404, 'This endpoint does not exist.');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new CaptureError(405, 'Method not allowed.');

  if (vite) {
    vite.middlewares(req, res, () => sendJson(res, 404, { error: 'Page not found.' }));
    return;
  }

  const isIndex = pathname === '/';
  const isIcon = pathname === '/favicon.svg';
  const asset = /^\/assets\/([\w.-]+\.(?:css|js|svg))$/.exec(pathname)?.[1];
  if (!isIndex && !isIcon && !asset) throw new CaptureError(404, 'Page not found.');

  const file = asset ? join(dist, 'assets', asset) : join(dist, isIcon ? 'favicon.svg' : 'index.html');
  const contents = await readFile(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new CaptureError(isIndex ? 503 : 404, isIndex ? 'Build PageAtlas with npm run build, then refresh.' : 'File not found.');
  });
  res.setHeader('Content-Security-Policy', appPolicy);
  if (asset) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.writeHead(200, {
    'Content-Type': isIndex ? 'text/html; charset=utf-8' : staticTypes[extname(file)] ?? 'application/octet-stream',
    'Content-Length': contents.length,
  });
  res.end(req.method === 'HEAD' ? undefined : contents);
}

const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
  void route(req, res).catch((error: unknown) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof CaptureError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    console.error('PageAtlas encountered an unexpected request error.', error);
    sendJson(res, 500, { error: 'Something went wrong while processing the request.' });
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Open the running app or set PAGEATLAS_PORT to a free port.`);
  } else {
    console.error('PageAtlas could not start.', error);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => console.log(`PageAtlas is ready at http://127.0.0.1:${port}`));
