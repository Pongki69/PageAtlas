import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePage, CaptureError, crawlPageLimit, isOnThisComputer, openCaptureSession } from './capture.ts';
import type { CaptureResult, CaptureRuntime, InteractiveCapture } from './capture.ts';
import { renderReport } from './report.ts';
import { renderCapturePdf } from './pdf-export.ts';
import { resolveCaptureViewport } from '../shared/viewports.ts';
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
/** Hosted mode serves many anonymous visitors from a public server instead of one person on their own computer. */
const hosted = process.env.PAGEATLAS_HOSTED === '1';
const port = Number(process.env.PAGEATLAS_PORT ?? (hosted ? process.env.PORT ?? 10000 : 4317));
const dev = process.argv.includes('--dev');
const maxBodyBytes = 8192;
const reviewLifetime = 15 * 60 * 1000;
const signedInReviewLifetime = 15 * 60 * 1000;
const signInLifetime = 10 * 60 * 1000;

function wholeNumberSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

function listSetting(name: string): string[] {
  // Dashboards make it easy to paste quotes, spaces, or line breaks around values.
  return (process.env[name] ?? '').split(/[,\s]+/).map(value => value.replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);
}

/** Reduces an address such as "https://Example.app/" to the origin browsers send, "https://example.app". */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

/** Captures that may run at the same time across all visitors; later captures wait in line. */
const maxConcurrentCaptures = hosted ? wholeNumberSetting('PAGEATLAS_MAX_CONCURRENT', 1, 1, 16) : 1;
const maxQueuedCaptures = hosted ? wholeNumberSetting('PAGEATLAS_MAX_QUEUE', 8, 0, 100) : 0;
/** Captures one visitor, or one network address, may start per hour. */
const hourlyCaptureLimit = hosted ? wholeNumberSetting('PAGEATLAS_HOURLY_LIMIT', 10, 1, 1000) : Infinity;
const maxStoredReviews = hosted ? wholeNumberSetting('PAGEATLAS_MAX_REVIEWS', 12, 1, 500) : 1;
const maxReviewImageBytes = wholeNumberSetting('PAGEATLAS_REVIEW_MEMORY_MB', 96, 8, 16384) * 1024 * 1024;
/**
 * Proxies in front of the server that append to X-Forwarded-For. When set, captures are also limited per network
 * address. Leave it at 0 unless you have checked the header: a wrong count makes every visitor share one address.
 */
const proxyHops = hosted ? wholeNumberSetting('PAGEATLAS_PROXY_HOPS', 0, 0, 5) : 0;
const allowedOrigins = new Set(listSetting('PAGEATLAS_ALLOWED_ORIGINS').map(originOf));
const publicHosts = new Set([
  ...listSetting('PAGEATLAS_PUBLIC_HOSTS'),
  ...(process.env.RENDER_EXTERNAL_HOSTNAME ? [process.env.RENDER_EXTERNAL_HOSTNAME] : []),
  ...[...allowedOrigins].map(origin => { try { return new URL(origin).host; } catch { return ''; } }).filter(Boolean),
].map(host => host.toLowerCase()));
for (const host of publicHosts) allowedOrigins.add(`https://${host}`);
if (hosted && !publicHosts.size) {
  throw new Error('Set PAGEATLAS_PUBLIC_HOSTS or PAGEATLAS_ALLOWED_ORIGINS to the public address of this PageAtlas server.');
}
const visitorCookie = 'pageatlas_visitor';
const localOwner = 'local';
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
const reviews = new Map<string, { owner: string; capture: CaptureResult; expiresAt: number; imageBytes: number }>();
type SignIn = { id: string; browser: InteractiveCapture; expiresAt: number; timeout: NodeJS.Timeout; closing?: Promise<void> };
let signIn: SignIn | undefined;
/** Visitors with a capture running, waiting in line, or a sign-in window opening. Each visitor runs one at a time. */
const busyOwners = new Set<string>();
let runningCaptures = 0;
const captureLine: { job: CaptureJob; start: () => void }[] = [];
const recentCaptures = new Map<string, number[]>();
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
  owner: string;
  state: JobState;
  controller: AbortController;
  done: Promise<void>;
  expiresAt: number;
  errorStatus?: number;
  nextLogId: number;
};
const jobs = new Map<string, CaptureJob>();
/** The latest capture of each visitor, restored when they refresh the page. */
const currentJobs = new Map<string, CaptureJob>();

function forgetCurrentJob(job: CaptureJob): void {
  if (currentJobs.get(job.owner) === job) currentJobs.delete(job.owner);
}

/** Identifies the visitor so captures and reviews stay private to the browser that made them. */
function cookieVisitor(req: IncomingMessage): string | undefined {
  return new RegExp(`(?:^|;\\s*)${visitorCookie}=([0-9a-f-]{36})(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
}

function visitorOf(req: IncomingMessage, res: ServerResponse): string {
  if (!hosted) return localOwner;
  const existing = cookieVisitor(req);
  if (existing) return existing;
  const id = randomUUID();
  res.setHeader('Set-Cookie', `${visitorCookie}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
  return id;
}

function clientAddress(req: IncomingMessage): string | undefined {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  // Proxies append the address they received the request from, so only the entries they added can be trusted.
  return proxyHops && forwarded.length ? forwarded[Math.max(0, forwarded.length - proxyHops)] : undefined;
}

function requireCaptureAllowance(req: IncomingMessage, owner: string): void {
  if (!hosted) return;
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const address = clientAddress(req);
  const keys = [`visitor:${owner}`, ...(address ? [`address:${address}`] : [])];
  const histories = keys.map(key => (recentCaptures.get(key) ?? []).filter(time => time > hourAgo));
  if (histories.some(history => history.length >= hourlyCaptureLimit)) {
    throw new CaptureError(429, `You’ve reached the limit of ${hourlyCaptureLimit} captures per hour. Try again later, or run PageAtlas on your own computer for unlimited captures.`);
  }
  keys.forEach((key, index) => recentCaptures.set(key, [...histories[index]!, Date.now()]));
}

function updateLinePositions(): void {
  captureLine.forEach(({ job }, index) => {
    const phase = index === 0 ? 'Waiting for a free capture browser · next in line' : `Waiting for a free capture browser · ${index + 1} in line`;
    if (job.state.phase !== phase) {
      job.state.phase = phase;
      job.state.updatedAt = new Date().toISOString();
    }
  });
}

/** Waits for a free capture browser. Rejects when the capture is stopped while waiting. */
function acquireCaptureSlot(job: CaptureJob): Promise<void> {
  if (runningCaptures < maxConcurrentCaptures) {
    runningCaptures++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const signal = job.controller.signal;
    const entry = {
      job,
      start: () => {
        signal.removeEventListener('abort', leave);
        runningCaptures++;
        resolve();
      },
    };
    function leave() {
      const index = captureLine.indexOf(entry);
      if (index >= 0) captureLine.splice(index, 1);
      updateLinePositions();
      reject(new CaptureError(499, 'Capture stopped.', 'CAPTURE_CANCELLED'));
    }
    signal.addEventListener('abort', leave, { once: true });
    captureLine.push(entry);
    logJob(job, 'All capture browsers are busy. Your capture will start automatically when one is free.');
    updateLinePositions();
  });
}

function releaseCaptureSlot(): void {
  runningCaptures--;
  const next = captureLine.shift();
  updateLinePositions();
  next?.start();
}

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
  if (hosted && isOnThisComputer(hostname)) {
    throw new CaptureError(400, 'The online version of PageAtlas captures public websites only. Run PageAtlas on your computer to capture a local app.');
  }
  if (hosted && allowDevCertificate) {
    throw new CaptureError(400, 'Development certificates are available only when PageAtlas runs on your computer.');
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
    forgetCurrentJob(job);
  }
}

function ownedReview(owner: string, id: string) {
  const review = reviews.get(id);
  return review?.owner === owner ? review : undefined;
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
  const origin = req.headers.origin;
  if (hosted && origin && !allowedOrigins.has(origin)) {
    // Name the address so whoever runs the server can see exactly what to add to the allowed list.
    console.warn(`PageAtlas refused a request from ${origin}. Allowed: ${[...allowedOrigins].join(', ')}`);
    throw new CaptureError(403, `PageAtlas opened at ${origin} isn’t allowed to use this capture server yet. This is about the PageAtlas address, not the page you’re capturing. Add ${origin} to PAGEATLAS_ALLOWED_ORIGINS on the server.`);
  }
  if ((origin && !hosted && origin !== `http://${req.headers.host}`)
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

function storeReview(owner: string, capture: CaptureResult, lifetime = reviewLifetime) {
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
  // Each visitor keeps only their latest review.
  for (const [previous, review] of reviews) {
    if (review.owner === owner) deleteReview(previous);
  }
  // When memory or the review count runs short, the oldest reviews of any visitor expire first.
  let retainedImageBytes = [...reviews.values()].reduce((total, review) => total + review.imageBytes, 0);
  for (const [oldest, review] of reviews) {
    if (reviews.size < maxStoredReviews && retainedImageBytes + imageBytes <= maxReviewImageBytes) break;
    deleteReview(oldest);
    retainedImageBytes -= review.imageBytes;
  }
  reviews.set(id, { owner, capture, imageBytes, expiresAt: Date.now() + lifetime });
  return { ...metadata, linkedPages };
}

function closeSignIn(session: SignIn): Promise<void> {
  clearTimeout(session.timeout);
  session.closing ??= session.browser.close().catch(() => {}).finally(() => {
    if (signIn === session) signIn = undefined;
  });
  return session.closing;
}

function requireIdle(owner: string): void {
  if (busyOwners.has(owner)) throw new CaptureError(429, 'A capture is already running. Try again in a moment.');
  if (!signIn) return;
  if (signIn.browser.isOpen()) throw new CaptureError(409, 'Finish or close the open sign-in window first.');
  void closeSignIn(signIn);
}

function requireLineSpace(): void {
  if (runningCaptures >= maxConcurrentCaptures && captureLine.length >= maxQueuedCaptures) {
    throw new CaptureError(503, 'PageAtlas is busy with other captures right now. Try again in a few minutes.');
  }
}

function pruneJobs(): void {
  removeExpiredReviews();
  for (const [id, job] of jobs) {
    if (job.state.status === 'running' || job.state.status === 'cancelling') continue;
    if (job.expiresAt <= Date.now() || (job.state.result && !reviews.has(job.state.result.id))) {
      jobs.delete(id);
      forgetCurrentJob(job);
    }
  }
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, times] of recentCaptures) {
    if (!times.some(time => time > hourAgo)) recentCaptures.delete(key);
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
  if (busyOwners.has(localOwner)) throw new CaptureError(429, 'A capture is already running. Follow its progress or stop it first.');
  if (session.expiresAt <= Date.now() || !session.browser.isOpen()) {
    void closeSignIn(session);
    throw new CaptureError(410, 'The sign-in window closed or expired. Open a new window to capture the page.');
  }
  return session;
}

const maxRetainedJobs = Math.max(5, maxStoredReviews * 2 + maxConcurrentCaptures + maxQueuedCaptures);

function beginJob(owner: string, input: CaptureInput | undefined, session?: SignIn): CaptureJob {
  if (busyOwners.has(owner)) throw new CaptureError(429, 'A capture is already running. Follow its progress or stop it first.');
  if (!input && !session) throw new Error('A capture needs settings or a sign-in session.');
  // Reserve the visitor's capture before starting any asynchronous work, including cleanup.
  busyOwners.add(owner);
  pruneJobs();
  for (const [id, old] of jobs) {
    if (jobs.size < maxRetainedJobs) break;
    if (old.state.status !== 'running' && old.state.status !== 'cancelling') {
      jobs.delete(id);
      forgetCurrentJob(old);
    }
  }
  const now = new Date().toISOString();
  const job: CaptureJob = {
    owner,
    state: {
      id: randomUUID(), status: 'running', progress: 1, phase: 'Starting capture',
      startedAt: now, updatedAt: now, logs: [], pagesCaptured: 0, viewsCaptured: 0,
      input: input ? { url: input.url, viewport: input.viewport, width: input.width, height: input.height, crawl: input.crawl, allowDevCertificate: input.allowDevCertificate } : undefined,
    },
    controller: new AbortController(), done: Promise.resolve(), expiresAt: Infinity, nextLogId: 1,
  };
  currentJobs.set(owner, job);
  jobs.set(job.state.id, job);
  logJob(job, 'Capture started. Progress will stay available if you refresh this page.');
  job.done = Promise.resolve().then(async () => {
    let keepSession = false;
    let capture: CaptureResult | undefined;
    let holdsSlot = false;
    const runtime: CaptureRuntime = { signal: job.controller.signal, onProgress: event => updateJob(job, event) };
    try {
      await acquireCaptureSlot(job);
      holdsSlot = true;
      if (job.controller.signal.aborted) throw new CaptureError(499, 'Capture stopped.', 'CAPTURE_CANCELLED');
      if (job.state.phase !== 'Starting capture') {
        job.state.phase = 'Starting capture';
        logJob(job, 'A capture browser is free. Starting your capture.');
      }
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
            job.state.result = storeReview(owner, capture, session ? signedInReviewLifetime : reviewLifetime);
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
      if (holdsSlot) releaseCaptureSlot();
      busyOwners.delete(owner);
    }
  });
  return job;
}

function requireLocalSignIn(): void {
  if (hosted) throw new CaptureError(403, 'Sign-in capture is available only when PageAtlas runs on your computer.');
}

/** Checks that a visitor may start a new capture now, recording it against their hourly allowance. */
function admitCapture(req: IncomingMessage, owner: string): void {
  requireIdle(owner);
  requireLineSpace();
  requireCaptureAllowance(req, owner);
}

async function createJob(req: IncomingMessage, res: ServerResponse, owner: string): Promise<void> {
  requireSameOrigin(req);
  const body = await readJson(req);
  let job: CaptureJob;
  if (body && typeof body === 'object' && 'sessionId' in body) {
    requireLocalSignIn();
    if (typeof body.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.sessionId)) {
      throw new CaptureError(400, 'Open a sign-in window before capturing.');
    }
    job = beginJob(owner, undefined, captureSession(body.sessionId));
  } else {
    const input = parseCaptureInput(body);
    admitCapture(req, owner);
    job = beginJob(owner, input);
  }
  sendJson(res, 202, { job: job.state });
}

function serveJob(req: IncomingMessage, res: ServerResponse, owner: string, id?: string, cancel = false): void {
  requireSameOrigin(req);
  pruneJobs();
  const found = id ? jobs.get(id) : currentJobs.get(owner);
  const job = found?.owner === owner ? found : undefined;
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

async function createReview(req: IncomingMessage, res: ServerResponse, owner: string): Promise<void> {
  requireSameOrigin(req);
  const input = await captureInput(req);
  admitCapture(req, owner);
  await sendCompletedJob(res, beginJob(owner, input));
}

async function startSignIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireLocalSignIn();
  requireSameOrigin(req);
  const input = await captureInput(req);
  const url = new URL(input.url);
  if (url.protocol !== 'https:' && !loopbackNames.has(url.hostname.replace(/\.$/, ''))) {
    throw new CaptureError(400, 'Use an HTTPS address to sign in, or a localhost address for a local app.');
  }
  requireIdle(localOwner);

  busyOwners.add(localOwner);
  try {
    const browser = await openCaptureSession(input);
    if (res.destroyed) {
      await browser.close();
      return;
    }
    const id = randomUUID();
    const expiresAt = Date.now() + signInLifetime;
    const timeout = setTimeout(() => {
      if (signIn?.id === id && !busyOwners.has(localOwner)) void closeSignIn(signIn);
    }, signInLifetime);
    timeout.unref();
    signIn = { id, browser, expiresAt, timeout };
    sendJson(res, 201, { id });
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError(502, 'The sign-in window could not open. Try again.');
  } finally {
    busyOwners.delete(localOwner);
  }
}

async function finishSignIn(req: IncomingMessage, res: ServerResponse, id: string, cancel: boolean): Promise<void> {
  requireLocalSignIn();
  requireSameOrigin(req);
  const session = signIn?.id === id ? signIn : undefined;
  if (!session || session.closing) throw new CaptureError(410, 'This sign-in session ended. Open a new sign-in window.');
  if (busyOwners.has(localOwner)) throw new CaptureError(429, 'A capture is already running. Try again in a moment.');
  if (cancel) {
    await closeSignIn(session);
    res.writeHead(204).end();
    return;
  }
  await sendCompletedJob(res, beginJob(localOwner, undefined, captureSession(id)));
}

async function serveReview(res: ServerResponse, owner: string, id: string, action: string, regionId?: string, pageNumber?: string, shotId?: string): Promise<void> {
  removeExpiredReviews();
  const review = ownedReview(owner, id)?.capture;
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

  const pathname = req.url?.split('?')[0] ?? '';
  // Hosting platforms probe this from inside their network, using an internal address as the host.
  if (hosted && pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (hosted ? !publicHosts.has((req.headers.host ?? '').toLowerCase()) : !req.headers.host || !hosts.has(req.headers.host)) {
    throw new CaptureError(403, hosted ? 'Open PageAtlas using its public address.' : 'Open PageAtlas using its local address.');
  }
  const owner = visitorOf(req, res);
  const deletePath = /^\/api\/reviews\/([0-9a-f-]{36})$/.exec(pathname);
  if (deletePath?.[1] && req.method === 'DELETE') {
    requireSameOrigin(req);
    if (ownedReview(owner, deletePath[1])) deleteReview(deletePath[1]);
    res.writeHead(204).end();
    return;
  }
  if (pathname === '/api/server-info' && req.method === 'GET') {
    requireSameOrigin(req);
    sendJson(res, 200, hosted ? {
      app: 'PageAtlas', hosted: true, signIn: false, devCertificate: false,
      crawlPageLimit: crawlPageLimit(), hourlyCaptureLimit, reviewMinutes: reviewLifetime / 60_000,
    } : {
      app: 'PageAtlas', hosted: false, signIn: true, devCertificate: true, crawlPageLimit: crawlPageLimit(),
      pid: process.pid, parentPid: process.ppid,
      projectRoot: fileURLToPath(new URL('../', import.meta.url)),
    });
    return;
  }
  if (pathname === '/api/capture-job') {
    if (req.method === 'GET') serveJob(req, res, owner);
    else if (req.method === 'POST') await createJob(req, res, owner);
    else throw new CaptureError(405, 'Method not allowed.');
    return;
  }
  const jobPath = /^\/api\/capture-job\/([0-9a-f-]{36})(\/cancel)?$/.exec(pathname);
  if (jobPath?.[1] && (jobPath[2] ? req.method === 'POST' : req.method === 'GET')) {
    serveJob(req, res, owner, jobPath[1], !!jobPath[2]);
    return;
  }
  if (pathname === '/api/capture' && req.method === 'POST') {
    await createReview(req, res, owner);
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
    await serveReview(res, owner, reviewPath[1], reviewPath[3], reviewPath[4], reviewPath[2], reviewPath[5]);
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
      const owner = hosted ? cookieVisitor(req) : localOwner;
      const current = owner ? currentJobs.get(owner) : undefined;
      sendJson(res, error.status, {
        error: error.message, code: error.code,
        job: error.status === 429 && current && ['running', 'cancelling'].includes(current.state.status) ? current.state : undefined,
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

if (hosted) {
  server.listen(port, '0.0.0.0', () => console.log(`PageAtlas (hosted) is listening on port ${port}. Accepting captures from ${[...allowedOrigins].join(', ')}`));
} else {
  server.listen(port, '127.0.0.1', () => console.log(`PageAtlas is ready at http://127.0.0.1:${port}`));
}
