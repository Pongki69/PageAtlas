import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePage, CaptureError, isOnThisComputer, openCaptureSession } from './capture.ts';
import type { CaptureResult, CaptureRuntime, InteractiveCapture } from './capture.ts';
import { renderReport } from './report.ts';
import { renderCapturePdf } from './pdf-export.ts';
import { resolveCaptureViewport } from '../shared/viewports.ts';
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PAGEATLAS_PORT ?? 4317);
const dev = process.argv.includes('--dev');
const maxBodyBytes = 8192;
const reviewLifetime = 15 * 60 * 1000;
const signedInReviewLifetime = 15 * 60 * 1000;
const signInLifetime = 10 * 60 * 1000;
const maxReviews = 1;
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
type CaptureInput = ReturnType<typeof parseCaptureInput>;
type JobState = {
  id: string;
  status: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed';
  progress: number;
  phase: string;
  startedAt: string;
  updatedAt: string;
  logs: { id: number; time: string; message: string }[];
  input?: Pick<CaptureInput, 'url' | 'viewport' | 'width' | 'height' | 'crawl' | 'allowDevCertificate'>;
  result?: ReturnType<typeof storeReview>;
  error?: string;
  errorCode?: CaptureError['code'];
  pagesCaptured?: number;
  viewsCaptured?: number;
  sessionId?: string;
};
type CaptureJob = {
  state: JobState;
  controller: AbortController;
  done: Promise<void>;
  expiresAt: number;
  errorStatus?: number;
  nextLogId: number;
};
const jobs = new Map<string, CaptureJob>();
let currentJob: CaptureJob | undefined;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
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

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CaptureError(400, 'The capture settings could not be read.');
  }
}

function parseCaptureInput(body: unknown) {
  if (!body || typeof body !== 'object' || !('url' in body) || !('viewport' in body)) {
    throw new CaptureError(400, 'Enter a web address and choose a viewport.');
  }
  if (typeof body.url !== 'string' || body.url.length > 4096) {
    throw new CaptureError(400, 'Enter a valid web address.');
  }
  let dimensions: ReturnType<typeof resolveCaptureViewport>;
  try {
    dimensions = resolveCaptureViewport(body.viewport, 'width' in body ? body.width : undefined, 'height' in body ? body.height : undefined);
  } catch (error) {
    throw new CaptureError(400, error instanceof Error ? error.message : 'Choose a valid capture size.');
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
  return { url: url.href, ...dimensions, allowDevCertificate, crawl };
}

async function captureInput(req: IncomingMessage): Promise<CaptureInput> {
  return parseCaptureInput(await readJson(req));
}

function deleteReview(id: string): void {
  reviews.delete(id);
  for (const [jobId, job] of jobs) {
    if (job.state.result?.id !== id) continue;
    job.state.result = undefined;
    job.state.input = undefined;
    job.state.logs = [];
    job.state.error = undefined;
    jobs.delete(jobId);
    if (currentJob === job) currentJob = undefined;
  }
}

function removeExpiredReviews(): void {
  const now = Date.now();
  for (const [id, review] of reviews) {
    if (review.expiresAt <= now) deleteReview(id);
  }
}

const expirationTimer = setInterval(pruneJobs, 30_000);
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

function storeReview(capture: CaptureResult, lifetime = reviewLifetime) {
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
    deleteReview(oldest);
    retainedImageBytes -= review.imageBytes;
  }
  reviews.set(id, { capture, imageBytes, expiresAt: Date.now() + lifetime });
  return { ...metadata, linkedPages };
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

function pruneJobs(): void {
  removeExpiredReviews();
  for (const [id, job] of jobs) {
    if (job.state.status === 'running' || job.state.status === 'cancelling') continue;
    if (job.expiresAt <= Date.now() || (job.state.result && !reviews.has(job.state.result.id))) {
      jobs.delete(id);
      if (currentJob === job) currentJob = undefined;
    }
  }
}

function logJob(job: CaptureJob, message: string): void {
  const time = new Date().toISOString();
  job.state.updatedAt = time;
  job.state.logs.push({ id: job.nextLogId++, time, message: message.slice(0, 300) });
  if (job.state.logs.length > 160) job.state.logs.splice(0, job.state.logs.length - 160);
}

function updateJob(job: CaptureJob, event: Parameters<NonNullable<CaptureRuntime['onProgress']>>[0]): void {
  if (job.state.status !== 'running') return;
  const progressByPhase: Readonly<Record<string, number>> = {
    starting: 3, loading: 10, capturing: 20, scrolling: 25, panels: 30,
    captured: 40, exploring: 45, skipped: 45, completed: 95,
  };
  const labels: Readonly<Record<string, string>> = {
    starting: 'Opening capture browser', loading: 'Waiting for page content',
    capturing: 'Capturing page', scrolling: 'Capturing scroll views',
    panels: 'Capturing scrollable areas', captured: 'Page captured',
    exploring: 'Exploring app pages', skipped: 'Exploring app pages', completed: 'Preparing review',
  };
  job.state.phase = labels[event.phase] ?? 'Capturing';
  if (event.pagesCaptured !== undefined) job.state.pagesCaptured = Math.max(job.state.pagesCaptured ?? 0, event.pagesCaptured);
  if (event.viewsCaptured !== undefined) job.state.viewsCaptured = Math.max(job.state.viewsCaptured ?? 0, event.viewsCaptured);
  const completedWork = 40 + 45 * (1 - Math.exp(-(job.state.pagesCaptured ?? 0) / 5))
    + 8 * (1 - Math.exp(-(job.state.viewsCaptured ?? 0) / 20));
  job.state.progress = Math.min(95, Math.max(job.state.progress, progressByPhase[event.phase] ?? 0,
    job.state.pagesCaptured ? completedWork : 0));
  logJob(job, event.message);
}

function captureSession(id: string): SignIn {
  const session = signIn?.id === id ? signIn : undefined;
  if (!session || session.closing) throw new CaptureError(410, 'This sign-in session ended. Open a new sign-in window.');
  if (isCapturing) throw new CaptureError(429, 'A capture is already running. Follow its progress or stop it first.');
  if (session.expiresAt <= Date.now() || !session.browser.isOpen()) {
    void closeSignIn(session);
    throw new CaptureError(410, 'The sign-in window closed or expired. Open a new window to capture the page.');
  }
  return session;
}

function beginJob(input: CaptureInput | undefined, session?: SignIn): CaptureJob {
  if (isCapturing) throw new CaptureError(429, 'A capture is already running. Follow its progress or stop it first.');
  if (!input && !session) throw new Error('A capture needs settings or a sign-in session.');
  // Reserve the browser before starting any asynchronous work, including cleanup.
  isCapturing = true;
  pruneJobs();
  for (const [id, old] of jobs) {
    if (jobs.size < 5) break;
    if (old.state.status !== 'running' && old.state.status !== 'cancelling') jobs.delete(id);
  }
  const now = new Date().toISOString();
  const job: CaptureJob = {
    state: {
      id: randomUUID(), status: 'running', progress: 1, phase: 'Starting capture',
      startedAt: now, updatedAt: now, logs: [], pagesCaptured: 0, viewsCaptured: 0,
      input: input ? { url: input.url, viewport: input.viewport, width: input.width, height: input.height, crawl: input.crawl, allowDevCertificate: input.allowDevCertificate } : undefined,
    },
    controller: new AbortController(), done: Promise.resolve(), expiresAt: Infinity, nextLogId: 1,
  };
  currentJob = job;
  jobs.set(job.state.id, job);
  logJob(job, 'Capture started. Progress will stay available if you refresh this page.');
  job.done = Promise.resolve().then(async () => {
    let keepSession = false;
    let capture: CaptureResult | undefined;
    const runtime: CaptureRuntime = { signal: job.controller.signal, onProgress: event => updateJob(job, event) };
    try {
      capture = session ? await session.browser.capture(runtime) : await capturePage(input!, runtime);
      if (job.controller.signal.aborted) throw new CaptureError(499, 'Capture stopped.', 'CAPTURE_CANCELLED');
    } catch (error) {
      if (job.controller.signal.aborted || (error instanceof CaptureError && error.code === 'CAPTURE_CANCELLED')) {
        job.state.phase = 'Capture stopped';
        job.state.errorCode = 'CAPTURE_CANCELLED';
        job.errorStatus = 499;
        logJob(job, 'Capture stopped. Closing the capture browser.');
      } else {
        const failure = error instanceof CaptureError ? error : new CaptureError(502, 'The capture could not finish. Try again.');
        if (!(error instanceof CaptureError)) console.error('PageAtlas capture job failed.');
        keepSession = !!session && [409, 429].includes(failure.status) && session.browser.isOpen() && session.expiresAt > Date.now();
        if (keepSession) job.state.sessionId = session!.id;
        job.state.error = failure.message;
        job.state.errorCode = failure.code;
        job.errorStatus = failure.status;
        job.state.phase = 'Capture failed';
        logJob(job, 'Capture could not finish. See the error message for the next step.');
      }
    } finally {
      if (session && !keepSession) await closeSignIn(session);
      // Terminal status means cleanup is complete and another capture may start.
      if (job.controller.signal.aborted || job.state.errorCode === 'CAPTURE_CANCELLED') {
        job.state.result = undefined;
        job.state.status = 'cancelled';
        job.state.phase = 'Capture stopped';
        logJob(job, 'Capture stopped. Ready for another capture.');
      } else {
        if (capture && !job.state.error) {
          try {
            job.state.result = storeReview(capture, session ? signedInReviewLifetime : reviewLifetime);
            job.state.pagesCaptured = 1 + (capture.linkedPages?.length ?? 0);
            job.state.viewsCaptured = [capture, ...(capture.linkedPages ?? [])]
              .reduce((total, page) => total + (page.viewportShots?.length ?? 1), 0);
            job.state.progress = 100;
            job.state.phase = 'Capture complete';
            logJob(job, 'Review ready. You can explore the captured pages and export the review.');
          } catch {
            job.state.error = 'The captured review could not be saved. Try again.';
            job.state.phase = 'Capture failed';
            logJob(job, 'The captured review could not be saved.');
          }
        }
        job.state.status = job.state.result ? 'complete' : 'failed';
      }
      job.state.updatedAt = new Date().toISOString();
      job.expiresAt = Date.now() + (session ? signedInReviewLifetime : reviewLifetime);
      isCapturing = false;
    }
  });
  return job;
}

async function createJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireSameOrigin(req);
  const body = await readJson(req);
  let job: CaptureJob;
  if (body && typeof body === 'object' && 'sessionId' in body) {
    if (typeof body.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.sessionId)) {
      throw new CaptureError(400, 'Open a sign-in window before capturing.');
    }
    job = beginJob(undefined, captureSession(body.sessionId));
  } else {
    const input = parseCaptureInput(body);
    requireIdle();
    job = beginJob(input);
  }
  sendJson(res, 202, { job: job.state });
}

function serveJob(req: IncomingMessage, res: ServerResponse, id?: string, cancel = false): void {
  requireSameOrigin(req);
  pruneJobs();
  const job = id ? jobs.get(id) : currentJob;
  if (id && !job) throw new CaptureError(404, 'This capture job has expired. Start a new capture.');
  if (job && cancel && job.state.status === 'running') {
    job.state.status = 'cancelling';
    job.state.phase = 'Stopping capture';
    logJob(job, 'Stop requested. Waiting for the capture browser to close.');
    job.controller.abort();
  }
  sendJson(res, 200, { job: job?.state ?? null });
}

async function sendCompletedJob(res: ServerResponse, job: CaptureJob): Promise<void> {
  await job.done;
  if (res.destroyed) return;
  if (job.state.status === 'complete') {
    sendJson(res, 201, job.state.result);
    return;
  }
  throw new CaptureError(job.errorStatus ?? 502, job.state.error ?? 'Capture stopped.', job.state.errorCode);
}

async function createReview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireSameOrigin(req);
  const input = await captureInput(req);
  requireIdle();
  await sendCompletedJob(res, beginJob(input));
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
  await sendCompletedJob(res, beginJob(undefined, captureSession(id)));
}

async function serveReview(res: ServerResponse, id: string, action: string, regionId?: string, pageNumber?: string, shotId?: string): Promise<void> {
  removeExpiredReviews();
  const review = reviews.get(id)?.capture;
  if (!review) throw new CaptureError(404, 'This review has expired. Capture the page again.');

  if (action === 'export-pdf') {
    if (pageNumber) throw new CaptureError(404, 'Export all captured pages from PageAtlas.');
    const pdf = await renderCapturePdf(review);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="pageatlas-captures-${id.slice(0, 8)}.pdf"`,
      'Content-Length': pdf.length,
    });
    res.once('finish', () => deleteReview(id));
    res.end(pdf);
    return;
  }

  if (action === 'export') {
    if (pageNumber) throw new CaptureError(404, 'Export the complete review from PageAtlas.');
    const report = renderReport(review);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="pageatlas-review-${id.slice(0, 8)}.html"`,
    });
    res.once('finish', () => deleteReview(id));
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
  const deletePath = /^\/api\/reviews\/([0-9a-f-]{36})$/.exec(pathname);
  if (deletePath?.[1] && req.method === 'DELETE') {
    requireSameOrigin(req);
    deleteReview(deletePath[1]);
    res.writeHead(204).end();
    return;
  }
  if (pathname === '/api/server-info' && req.method === 'GET') {
    requireSameOrigin(req);
    sendJson(res, 200, {
      app: 'PageAtlas', pid: process.pid, parentPid: process.ppid,
      projectRoot: fileURLToPath(new URL('../', import.meta.url)),
    });
    return;
  }
  if (pathname === '/api/capture-job') {
    if (req.method === 'GET') serveJob(req, res);
    else if (req.method === 'POST') await createJob(req, res);
    else throw new CaptureError(405, 'Method not allowed.');
    return;
  }
  const jobPath = /^\/api\/capture-job\/([0-9a-f-]{36})(\/cancel)?$/.exec(pathname);
  if (jobPath?.[1] && (jobPath[2] ? req.method === 'POST' : req.method === 'GET')) {
    serveJob(req, res, jobPath[1], !!jobPath[2]);
    return;
  }
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
  const reviewPath = /^\/api\/reviews\/([0-9a-f-]{36})(?:\/pages\/([1-9]\d?))?\/(screenshot|viewport|export|export-pdf|scroll-regions\/([a-z0-9-]{1,32})\/screenshot|shots\/(view-\d{1,2}))$/.exec(pathname);
  if ((req.method === 'GET' || (req.method === 'POST' && ['export', 'export-pdf'].includes(reviewPath?.[3] ?? ''))) && reviewPath?.[1] && reviewPath[3]) {
    requireSameOrigin(req);
    await serveReview(res, reviewPath[1], reviewPath[3], reviewPath[4], reviewPath[2], reviewPath[5]);
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
      sendJson(res, error.status, {
        error: error.message, code: error.code,
        job: error.status === 429 && currentJob && ['running', 'cancelling'].includes(currentJob.state.status) ? currentJob.state : undefined,
      });
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
