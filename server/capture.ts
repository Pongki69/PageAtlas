import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { existsSync } from "node:fs";
import { BlockList, createConnection, createServer, isIP } from "node:net";
import type { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect as connectTls } from "node:tls";
import { chromium, errors } from "playwright-core";
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright-core";
import { discoverNavigation, isUnsafeActionUrl, navigationUrl as crawlRoute } from "./navigation.ts";
import type { NavigationTarget } from "./navigation.ts";
import { probeNavigation } from "./navigation-probe.ts";

type Dimensions = { width: number; height: number };
export type CaptureRequest = Dimensions & { url: string; allowDevCertificate?: boolean; crawl?: boolean };

export type Section = Dimensions & {
  id: string;
  label: string;
  tag: string;
  depth: number;
  x: number;
  y: number;
};

export type ScrollRegion = Dimensions & {
  id: string;
  label: string;
  tag: string;
  screenshot: string;
  complete: boolean;
  contentWidth?: number;
  contentHeight?: number;
  partialReason?: string;
};

export type ViewportShot = Dimensions & {
  id: string;
  label: string;
  scrollX: number;
  scrollY: number;
  screenshot: string;
  sections: Section[];
};

export type CaptureResult = {
  title: string;
  url: string;
  navigationLabel?: string;
  capturedAt: string;
  viewport: Dimensions;
  page: Dimensions;
  screenshot: string;
  viewportScreenshot?: Dimensions & { screenshot: string };
  viewportShots?: ViewportShot[];
  sections: Section[];
  scrollRegions: ScrollRegion[];
  warnings: string[];
  linkedPages?: CaptureResult[];
};

export type InteractiveCapture = {
  capture(): Promise<CaptureResult>;
  close(): Promise<void>;
  isOpen(): boolean;
};

export class CaptureError extends Error {
  readonly status: number;
  readonly code?: 'LOCAL_DEV_CERTIFICATE_REQUIRED' | 'CONTENT_NOT_READY';

  constructor(status: number, message: string, code?: 'LOCAL_DEV_CERTIFICATE_REQUIRED' | 'CONTENT_NOT_READY') {
    super(message);
    this.name = "CaptureError";
    this.status = status;
    this.code = code;
  }
}

const MAX_WIDTH = 8192;
const MAX_HEIGHT = 24000;
const MAX_PIXELS = 32_000_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIEWPORT_IMAGE_BYTES = 4 * 1024 * 1024;
const MOBILE_VIEW_LIMIT = 30;
const CAPTURE_TIMEOUT = 60000;
const CRAWL_TIMEOUT = 180000;
const CRAWL_PAGE_LIMIT = 30;
const CRAWL_DEPTH_LIMIT = 3;
const CRAWL_ATTEMPT_LIMIT = 45;
const CRAWL_LINK_LIMIT = 240;
const CRAWL_CONTROL_LIMIT = 24;
const CRAWL_IMAGE_BYTES = 48 * 1024 * 1024;
const SECTION_LIMIT = 180;
const SCROLL_REGION_LIMIT = 6;
const SCROLL_REGION_TIME = 25000;
const SCROLL_TILE_LIMIT = 96;
const SCROLL_PIXEL_LIMIT = 12_000_000;
const SCROLL_IMAGE_BYTES = 16 * 1024 * 1024;
const PNG_PREFIX = "data:image/png;base64,";

const privateAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) {
  privateAddresses.addSubnet(network, prefix);
}
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) {
  privateAddresses.addSubnet(network, prefix, "ipv6");
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8);
loopback.addAddress("::1", "ipv6");

function isLoopback(address: string) {
  const family = isIP(address);
  return family !== 0 && loopback.check(address, family === 6 ? "ipv6" : "ipv4");
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address);
  return family === 6 && globalIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6");
}

function normalizeHost(host: string) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // URL canonicalizes equivalent IPv6 representations received from the proxy.
  return isIP(name) === 6 ? new URL(`http://[${name}]`).hostname.slice(1, -1) : name;
}

function assignedAddresses() {
  return new Set(Object.values(networkInterfaces()).flatMap(interfaces =>
    interfaces?.map(({ address }) => normalizeHost(address.replace(/%.*$/, ""))) ?? []));
}

function isLocalHost(host: string, assigned: ReadonlySet<string>) {
  return host === "localhost" || isLoopback(host) || assigned.has(host);
}

export function isOnThisComputer(hostname: string) {
  return isLocalHost(normalizeHost(hostname), assignedAddresses());
}

async function readLocalCertificate(target: URL) {
  const host = normalizeHost(target.hostname);
  if (target.protocol !== "https:" || !isOnThisComputer(host)) {
    throw new CaptureError(400, "A development certificate can only be allowed for an HTTPS address on this computer.");
  }
  const port = Number(target.port || 443);
  const addresses = host === "localhost"
    ? (await lookup(host, { all: true, order: "ipv4first" }).catch(() => [])).map(({ address }) => address).filter(isLoopback)
    : [host];
  for (const address of addresses) {
    const fingerprint = await new Promise<string | undefined>(resolve => {
      // Read the presented certificate only. This connection sends no HTTP request or credentials.
      const socket = connectTls({
        host: address, port, rejectUnauthorized: false,
        ...(host === "localhost" && { servername: host }),
      });
      const timer = setTimeout(() => finish(), 2500);
      function finish(fingerprint?: string) {
        clearTimeout(timer);
        socket.destroy();
        resolve(fingerprint);
      }
      socket.once("error", () => finish());
      socket.once("secureConnect", () => {
        try {
          const key = socket.getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
          finish(key && createHash("sha256").update(key).digest("base64"));
        } catch {
          finish();
        }
      });
    });
    if (fingerprint) return { address: normalizeHost(address), fingerprint };
  }
  throw new CaptureError(422, "PageAtlas could not read a development certificate at that HTTPS address. Check that the local app is running.");
}

async function startCaptureProxy(target: URL, pinnedLocalAddress?: string) {
  const targetHost = normalizeHost(target.hostname);
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const assigned = assignedAddresses();
  const localTarget = isLocalHost(targetHost, assigned);
  let localTargetAllowed = localTarget;
  if (!localTargetAllowed && isIP(targetHost) && !isPublicAddress(targetHost)) {
    throw new CaptureError(400, "This private address is not assigned to this computer. Use a public URL or an app running on this computer.");
  }

  const resolutions = new Map<string, Promise<LookupAddress[]>>();
  const sockets = new Set<Socket>();
  const localTunnels = new Set<Socket>();
  const policy = { blocked: 0, blockedTarget: false };
  function track(socket: Socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  async function destinations(host: string, port: number) {
    const matchesTarget = host === targetHost && port === targetPort;
    let resolution = resolutions.get(host);
    if (!resolution) {
      if (resolutions.size >= 512) return [];
      resolution = lookup(host, { all: true, order: "ipv4first" });
      resolutions.set(host, resolution);
    }
    const addresses = await resolution;
    const allowed = addresses.filter(({ address }) => {
      const normalized = normalizeHost(address);
      if (matchesTarget && localTargetAllowed) {
        if (pinnedLocalAddress && normalized !== pinnedLocalAddress) return false;
        return targetHost === "localhost" ? isLoopback(normalized) : normalized === targetHost;
      }
      return isPublicAddress(normalized) && !assigned.has(normalized);
    });
    if (!allowed.length) {
      policy.blocked++;
      if (matchesTarget) policy.blockedTarget = true;
    }
    return allowed;
  }

  // Chromium sends each TCP destination through SOCKS, including redirects.
  // The lookup callback supplies only the vetted IPs, avoiding a second DNS resolution.
  const server = createServer(client => {
    track(client);
    client.setTimeout(15000, () => client.destroy());
    let pending: Buffer = Buffer.alloc(0);
    let greeted = false;
    client.on("data", function read(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      if (!greeted) {
        const methods = pending[1];
        if (methods === undefined || pending.length < 2 + methods) return;
        if (pending[0] !== 5 || !pending.subarray(2, 2 + methods).includes(0)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        pending = pending.subarray(2 + methods);
        greeted = true;
      }

      const addressType = pending[3];
      if (addressType === undefined) return;
      const addressStart = addressType === 3 ? 5 : 4;
      const addressLength = addressType === 1 ? 4 : addressType === 4 ? 16 : pending[4];
      if (addressLength === undefined) return;
      if (pending[0] !== 5 || pending[1] !== 1 || ![1, 3, 4].includes(addressType)) {
        client.destroy();
        return;
      }
      const portOffset = addressStart + addressLength;
      if (pending.length < portOffset + 2) return;

      client.pause();
      client.off("data", read);
      const address = pending.subarray(addressStart, portOffset);
      const port = pending.readUInt16BE(portOffset);
      const host = addressType === 1
        ? Array.from(address).join(".")
        : addressType === 4
          ? Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(":")
          : address.toString("ascii");
      const earlyData = pending.subarray(portOffset + 2);
      const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
      void (async () => {
        const hostname = normalizeHost(host);
        const allowed = await destinations(hostname, port);
        const first = allowed[0];
        if (client.destroyed) return;
        const localTunnel = localTarget && hostname === targetHost && port === targetPort;
        if (!first || (localTunnel && !localTargetAllowed)) {
          client.end(reply(2));
          return;
        }

        if (localTunnel) {
          localTunnels.add(client);
          client.once("close", () => localTunnels.delete(client));
        }
        const upstream = createConnection({
          host: isIP(hostname) ? first.address : hostname,
          port,
          autoSelectFamily: true,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, allowed);
            else callback(null, first.address, first.family);
          },
        });
        track(upstream);
        client.once("close", () => upstream.destroy());
        let connected = false;
        upstream.once("error", () => {
          if (!connected) client.end(reply(5));
          else client.destroy();
        });
        upstream.once("connect", () => {
          connected = true;
          client.setTimeout(0);
          client.write(reply(0));
          if (earlyData.length) upstream.write(earlyData);
          upstream.pipe(client).pipe(upstream);
          client.resume();
        });
      })().catch(() => client.end(reply(4)));
    });
  });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start capture proxy");
  return {
    url: `socks5://127.0.0.1:${address.port}`,
    policy,
    releaseLocalTarget: () => {
      localTargetAllowed = false;
      for (const tunnel of localTunnels) tunnel.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function browserExecutable() {
  const override = process.env.PAGEATLAS_BROWSER;
  const programRoots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  const candidates = [
    ...programRoots.flatMap(root => root ? [
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
    ] : []),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    chromium.executablePath(),
  ];
  const executable = override || candidates.find(path => existsSync(path));
  if (!executable || !existsSync(executable)) {
    throw new CaptureError(503, "Install Microsoft Edge or Google Chrome, or set PAGEATLAS_BROWSER to your Chromium executable.");
  }
  return executable;
}

async function waitForContent(page: Page, deadline: number, initial = false): Promise<void> {
  const startedAt = Date.now();
  const until = Math.min(deadline, startedAt + (initial ? 15000 : 6000));
  let signature = "";
  let stableSince = startedAt;
  while (Date.now() < until) {
    const state = await page.evaluate(() => {
      const body = document.body;
      if (!body || document.readyState === "loading") return { ready: false, signature: "" };
      function visible(element: Element) {
        if (!element.checkVisibility({ visibilityProperty: true })) return false;
        const bounds = element.getBoundingClientRect();
        let left = Math.max(0, bounds.left);
        let top = Math.max(0, bounds.top);
        let right = Math.min(innerWidth, bounds.right);
        let bottom = Math.min(innerHeight, bounds.bottom);
        let fixed = getComputedStyle(element).position === "fixed";
        for (let parent = element.parentElement; parent && !fixed; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const clip = parent.getBoundingClientRect();
          if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)) {
            left = Math.max(left, clip.left + parent.clientLeft);
            right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
          }
          if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)) {
            top = Math.max(top, clip.top + parent.clientTop);
            bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
          }
          fixed = style.position === "fixed";
        }
        return right - left > 1 && bottom - top > 1;
      }
      const main = document.querySelector<HTMLElement>("main, [role=main]") ?? body;
      const content = main.innerText.trim();
      const loadingText = content.length < 150 && /^(?:loading(?:\b|[.…])|fetching\b|please\s+wait\b)/i.test(content);
      const markers = document.querySelectorAll(
        '[aria-busy="true"], [data-loading="true"], [data-state="loading"], [class*="skeleton" i], [class*="shimmer" i], [data-testid*="skeleton" i], [role="status"], [role="progressbar"]',
      );
      const loading = loadingText || Array.from(markers).slice(0, 2000).some(element => {
        if (!visible(element)) return false;
        if (element.matches('[aria-busy="true"], [data-loading="true"], [data-state="loading"], [class*="skeleton" i], [class*="shimmer" i], [data-testid*="skeleton" i]')) return true;
        const label = element.getAttribute("aria-label") || element.textContent || "";
        return /^\s*(?:loading(?:\b|[.…])|fetching\b|please\s+wait\b)/i.test(label);
      });
      const images = Array.from(document.images).filter(visible);
      const bounds = main.getBoundingClientRect();
      return {
        ready: !loading && document.fonts.status === "loaded" && images.every(image => image.complete),
        signature: JSON.stringify([
          content.slice(0, 6000).replace(/\d/g, "#"), main.childElementCount,
          Math.round(bounds.width), Math.round(bounds.height), main.scrollHeight,
          document.documentElement.scrollHeight, images.length,
        ]),
      };
    });
    const now = Date.now();
    if (!state.ready || state.signature !== signature) stableSince = now;
    signature = state.signature;
    if (state.ready && now - stableSince >= 400 && now - startedAt >= (initial ? 800 : 400)) return;
    await delay(Math.min(150, Math.max(1, until - now)));
  }
  throw new CaptureError(409, "The app is still showing loading content. Wait for it to finish loading, then capture again.", "CONTENT_NOT_READY");
}

async function warmPage(page: Page, viewport: Dimensions, deadline: number) {
  const step = Math.max(300, Math.floor(viewport.height * 0.9));
  const maxSteps = Math.ceil(MAX_HEIGHT / step);
  let reachedEnd = false;
  for (let index = 0; index <= maxSteps; index++) {
    const top = index * step;
    await page.evaluate(top => window.scrollTo({ left: 0, top, behavior: "instant" }), top);
    await waitForContent(page, deadline);
    reachedEnd = await page.evaluate(({ top, maxHeight }) => {
      const height = Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight);
      return top + window.innerHeight >= height || height > maxHeight;
    }, { top, maxHeight: MAX_HEIGHT });
    if (reachedEnd) break;
  }
  await page.evaluate(() => window.scrollTo({ left: 0, top: 0, behavior: "instant" }));
  await waitForContent(page, deadline);
  return reachedEnd;
}

async function readStructure(page: Page, viewportOnly = false) {
  return page.evaluate(({ sectionLimit, viewportOnly }) => {
    const body = document.body;
    const root = document.documentElement;
    const width = viewportOnly ? window.innerWidth : Math.max(root.scrollWidth, root.offsetWidth, root.clientWidth,
      body?.scrollWidth || 0, body?.offsetWidth || 0, body?.clientWidth || 0);
    const height = viewportOnly ? window.innerHeight : Math.max(root.scrollHeight, root.offsetHeight, root.clientHeight,
      body?.scrollHeight || 0, body?.offsetHeight || 0, body?.clientHeight || 0);
    const landmarks = [
      "header", "nav", "main", "section", "article", "aside", "footer", "form", "dialog", "iframe",
      ...["banner", "navigation", "main", "region", "article", "complementary", "contentinfo", "form",
        "search", "dialog"].map(role => `[role="${role}"]`),
    ].join(",");
    const headings = "h1,h2,h3,h4,h5,h6,[role=heading]";
    const clean = (text: string | null | undefined) => (text || "").replace(/\s+/g, " ").trim().slice(0, 140);
    function visibleBox(element: Element) {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
      const bounds = element.getBoundingClientRect();
      let left = bounds.left;
      let top = bounds.top;
      let right = bounds.right;
      let bottom = bounds.bottom;
      if (viewportOnly) {
        let fixed = getComputedStyle(element).position === "fixed";
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (fixed) break;
          const style = getComputedStyle(parent);
          const clip = parent.getBoundingClientRect();
          if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)) {
            left = Math.max(left, clip.left + parent.clientLeft);
            right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
          }
          if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)) {
            top = Math.max(top, clip.top + parent.clientTop);
            bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
          }
          fixed = style.position === "fixed";
        }
      }
      const offsetX = viewportOnly ? 0 : window.scrollX;
      const offsetY = viewportOnly ? 0 : window.scrollY;
      const x = Math.max(0, Math.floor(left + offsetX));
      const y = Math.max(0, Math.floor(top + offsetY));
      const boxWidth = Math.min(width, Math.ceil(right + offsetX)) - x;
      const boxHeight = Math.min(height, Math.ceil(bottom + offsetY)) - y;
      if (boxWidth >= 1 && boxHeight >= 1) return { x, y, width: boxWidth, height: boxHeight };
    }

    const semanticElements = document.querySelectorAll<HTMLElement>(`${landmarks},${headings}`);
    const inferred = !Array.from(semanticElements).some(visibleBox);
    const candidates = inferred
      ? document.querySelectorAll<HTMLElement>("body > *, body > div > *, body > div > div > *")
      : semanticElements;
    const sections: Section[] = [];
    const depths = new WeakMap<Element, number>();
    let limited = false;
    for (const element of candidates) {
      const box = visibleBox(element);
      if (!box) continue;
      if (sections.length >= sectionLimit) {
        limited = true;
        break;
      }
      let ancestor = element.parentElement;
      while (ancestor && !depths.has(ancestor)) ancestor = ancestor.parentElement;
      const depth = ancestor ? (depths.get(ancestor) ?? -1) + 1 : 0;
      depths.set(element, depth);

      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role");
      const referencedLabel = element.getAttribute("aria-labelledby")?.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || "").join(" ");
      const headingText = element.matches(headings)
        ? element.innerText
        : Array.from(element.querySelectorAll<HTMLElement>(headings))
          .find(heading => heading.closest(landmarks) === element && visibleBox(heading))?.innerText;
      const fallback = ({
        nav: "Navigation", aside: "Sidebar", main: "Main content", iframe: "Embedded frame", img: "Image",
        banner: "Header", contentinfo: "Footer", complementary: "Sidebar", div: "Layout block", svg: "Graphic",
      } as Record<string, string>)[role || tag] || (role || tag);
      const inferredText = inferred && element.matches("p,li,blockquote,a,button,span") ? element.innerText : "";
      const label = clean(referencedLabel) || clean(element.getAttribute("aria-label")) ||
        clean(headingText) || clean(element.getAttribute("title")) || clean(inferredText) ||
        (fallback.charAt(0).toUpperCase() + fallback.slice(1));
      sections.push({
        id: `section-${sections.length + 1}`,
        label,
        tag: role && tag !== role ? `${tag} · ${role.slice(0, 30)}` : tag,
        depth,
        ...box,
      });
    }
    const title = clean(document.title) || clean(document.querySelector("h1")?.textContent) || location.hostname;
    return { title, url: location.href, dimensions: { width, height }, sections, inferred, limited };
  }, { sectionLimit: SECTION_LIMIT, viewportOnly });
}

type ScrollTile = { x: number; y: number; png: string };
type ScrollCapture = { regions: ScrollRegion[]; omitted: boolean; notices: string[] };

async function captureScrollRegion(
  page: Page,
  element: ElementHandle<HTMLElement>,
  compose: (tiles: ScrollTile[], size: Dimensions) => Promise<string>,
  id: string,
  budget: { tiles: number; until: number },
  attempt = 0,
): Promise<ScrollRegion | undefined> {
  const state = await element.evaluateHandle(el => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const style = getComputedStyle(el);
    const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX);
    const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY);
    const referencedLabel = el.getAttribute("aria-labelledby")?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || "").join(" ");
    const label = [referencedLabel, el.getAttribute("aria-label"), el.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]")?.textContent,
      el.getAttribute("title")].map(text => text?.replace(/\s+/g, " ").trim()).find(Boolean)?.slice(0, 140);
    const layout = {
      width: el.clientWidth, height: el.clientHeight,
      contentWidth: horizontal ? el.scrollWidth : el.clientWidth,
      contentHeight: vertical ? el.scrollHeight : el.clientHeight,
      rtl: horizontal && style.direction === "rtl", label, tag: el.localName,
    };
    const { scrollLeft, scrollTop } = el;
    const overrides = [["scroll-snap-type", "none"], ["scroll-behavior", "auto"], ["overflow-anchor", "none"]] as const;
    const saved = overrides.map(([property, value]) => {
      const previous = [property, el.style.getPropertyValue(property), el.style.getPropertyPriority(property)] as const;
      el.style.setProperty(property, value, "important");
      return previous;
    });
    return {
      layout,
      measure() {
        const style = getComputedStyle(el);
        return {
          width: el.clientWidth, height: el.clientHeight,
          contentWidth: /^(auto|scroll|overlay)$/.test(style.overflowX) ? el.scrollWidth : el.clientWidth,
          contentHeight: /^(auto|scroll|overlay)$/.test(style.overflowY) ? el.scrollHeight : el.clientHeight,
        };
      },
      restore() {
        el.scrollTo({ left: scrollLeft, top: scrollTop, behavior: "instant" });
        for (const [property, value, priority] of saved) el.style.setProperty(property, value, priority);
      },
    };
  });

  try {
    await waitForContent(page, budget.until - 250);
    const layout = await state.evaluate(state => ({ ...state.layout, ...state.measure() }));
    if (!layout.width || !layout.height) return;
    const width = Math.min(layout.contentWidth, MAX_WIDTH, layout.width * budget.tiles);
    const columns = Math.ceil(width / layout.width);
    const pixelHeight = Math.floor(SCROLL_PIXEL_LIMIT / width);
    const tileHeightLimit = layout.height * Math.floor(budget.tiles / columns);
    const height = Math.min(layout.contentHeight, MAX_HEIGHT, pixelHeight, tileHeightLimit);
    const tiles: ScrollTile[] = [];
    let capturedHeight = 0;
    let resized = false;
    let partialReason: string | undefined;

    for (let y = 0; y < height; y += layout.height) {
      const row: ScrollTile[] = [];
      const tileHeight = Math.min(layout.height, height - y);
      for (let x = 0; x < width && Date.now() < budget.until - 800; x += layout.width) {
        const tileWidth = Math.min(layout.width, width - x);
        await element.evaluate((el, { x, y, rtl }) => el.scrollTo({
          left: rtl ? x - (el.scrollWidth - el.clientWidth) : x, top: y, behavior: "instant",
        }), { x, y, rtl: layout.rtl });
        try {
          await waitForContent(page, budget.until - 250);
        } catch (error) {
          if (!(error instanceof CaptureError) || error.code !== 'CONTENT_NOT_READY') throw error;
          partialReason = Date.now() >= budget.until - 400
            ? "The panel reached its capture time allowance." : "The panel was still loading.";
          break;
        }
        const measured = await state.evaluate(state => state.measure());
        if (measured.width !== layout.width || measured.height !== layout.height ||
            measured.contentWidth !== layout.contentWidth || measured.contentHeight !== layout.contentHeight) {
          resized = true;
          partialReason = "The panel content kept changing size while it was captured.";
          break;
        }
        const geometry = await element.evaluate((el, { x, y, tileWidth, tileHeight, layout }) => {
          if (!el.isConnected || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) ||
            el.clientWidth !== layout.width || el.clientHeight !== layout.height) return;
          const bounds = el.getBoundingClientRect();
          if (Math.abs(bounds.width - el.offsetWidth) > 1 || Math.abs(bounds.height - el.offsetHeight) > 1) return;
          const actualX = el.scrollLeft + (layout.rtl ? el.scrollWidth - el.clientWidth : 0);
          const offsetX = Math.round(x - actualX);
          const offsetY = Math.round(y - el.scrollTop);
          if (offsetX < 0 || offsetY < 0 || offsetX + tileWidth > layout.width || offsetY + tileHeight > layout.height) return;
          const left = bounds.left + el.clientLeft + offsetX;
          const top = bounds.top + el.clientTop + offsetY;
          for (let parent = el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
            const parentStyle = getComputedStyle(parent);
            const parentBounds = parent.getBoundingClientRect();
            const clientX = parentBounds.left + parent.clientLeft;
            const clientY = parentBounds.top + parent.clientTop;
            if ((parentStyle.overflowX !== "visible" && (left < clientX - 1 || left + tileWidth > clientX + parent.clientWidth + 1)) ||
                (parentStyle.overflowY !== "visible" && (top < clientY - 1 || top + tileHeight > clientY + parent.clientHeight + 1))) return;
          }
          const clip = { x: Math.round(left + window.scrollX), y: Math.round(top + window.scrollY), width: tileWidth, height: tileHeight };
          if (clip.x < 0 || clip.y < 0) return;
          return { clip };
        }, { x, y, tileWidth, tileHeight, layout });
        if (!geometry) {
          partialReason = "Part of the panel is clipped or transformed by its surrounding layout.";
          break;
        }
        if (Date.now() >= budget.until - 300 || !budget.tiles) {
          partialReason = !budget.tiles ? "The panel reached the tile limit." : "The panel reached its capture time allowance.";
          break;
        }
        budget.tiles--;
        const png = await page.screenshot({
          fullPage: true, clip: geometry.clip, type: "png", caret: "hide", scale: "css",
          timeout: Math.min(2000, budget.until - Date.now() - 200),
        }).catch(() => undefined);
        if (!png || png.readUInt32BE(16) !== tileWidth || png.readUInt32BE(20) !== tileHeight) {
          partialReason = "The browser could not capture the next section of this panel.";
          break;
        }
        row.push({ x, y, png: png.toString("base64") });
      }
      if (row.length !== columns) break;
      tiles.push(...row);
      capturedHeight += tileHeight;
    }

    const content = await state.evaluate(state => state.measure());
    resized ||= content.width !== layout.width || content.height !== layout.height ||
      content.contentWidth !== layout.contentWidth || content.contentHeight !== layout.contentHeight;
    const label = layout.label || `Scrollable area ${id.slice("scroll-".length)}`;
    const complete = !resized && !partialReason && width === content.contentWidth && capturedHeight === content.contentHeight;
    if (!complete && !partialReason) {
      if (resized) partialReason = "The panel content kept changing size while it was captured.";
      else if (Date.now() >= budget.until - 800) partialReason = "The panel reached its capture time allowance.";
      else if ((width < layout.contentWidth && width === MAX_WIDTH) || (height < layout.contentHeight && height === MAX_HEIGHT)) partialReason = "The panel exceeds the maximum image dimensions.";
      else if (height < layout.contentHeight && height === pixelHeight) partialReason = "The panel exceeds the 12-megapixel image limit.";
      else partialReason = "The panel reached the tile limit.";
    }
    let result: ScrollRegion | undefined;
    if (capturedHeight) {
      const size = { width, height: capturedHeight };
      const screenshot = tiles.length === 1 ? `${PNG_PREFIX}${tiles[0]!.png}` : await compose(tiles, size);
      result = {
        id, ...size, label, tag: layout.tag, screenshot, complete,
        contentWidth: content.contentWidth, contentHeight: content.contentHeight,
        ...(partialReason && { partialReason }),
      };
    }
    if (resized && attempt === 0 && budget.tiles && Date.now() < budget.until - 2000) {
      await state.evaluate(state => state.restore());
      const retried = await captureScrollRegion(page, element, compose, id, budget, 1).catch(() => undefined);
      if (retried?.complete || !result || (retried && retried.height >= result.height)) result = retried ?? result;
    }
    if (!result) throw new CaptureError(422, `${label} could not be captured. ${partialReason || 'The panel was not visible.'}`);
    return result;
  } finally {
    await state.evaluate(state => state.restore()).catch(() => {});
    await state.dispose();
  }
}

async function captureScrollRegions(page: Page, until: number, output: ScrollCapture) {
  const list = await page.evaluateHandle(limit => {
    const candidates: HTMLElement[] = [];
    if (!document.body) return candidates;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node && candidates.length <= limit; node = walker.nextNode()) {
      if (!(node instanceof HTMLElement) || node.clientWidth < 32 || node.clientHeight < 24) continue;
      const overflowsX = node.scrollWidth - node.clientWidth > 2;
      const overflowsY = node.scrollHeight - node.clientHeight > 2;
      if (!overflowsX && !overflowsY) continue;
      const style = getComputedStyle(node);
      if (((overflowsX && /^(auto|scroll|overlay)$/.test(style.overflowX)) ||
           (overflowsY && /^(auto|scroll|overlay)$/.test(style.overflowY))) &&
          node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
        candidates.push(node);
      }
    }
    return candidates;
  }, SCROLL_REGION_LIMIT);
  let composer: Page | undefined;
  const budget = { tiles: SCROLL_TILE_LIMIT, until };
  let bytes = 0;
  async function compose(tiles: ScrollTile[], size: Dimensions) {
    if (!composer) {
      composer = await page.context().newPage();
      await page.bringToFront();
    }
    return composer.evaluate(async ({ tiles, size, prefix }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not assemble scroll capture");
      for (const tile of tiles) {
        const image = new Image();
        image.src = `${prefix}${tile.png}`;
        await image.decode();
        context.drawImage(image, tile.x, tile.y);
      }
      return canvas.toDataURL("image/png");
    }, { tiles, size, prefix: PNG_PREFIX });
  }

  const handles = await list.getProperties();
  try {
    if (handles.size > SCROLL_REGION_LIMIT) output.omitted = true;
    for (const [index, handle] of handles) {
      if (Number(index) >= SCROLL_REGION_LIMIT || !budget.tiles || Date.now() >= until - 400) {
        output.omitted = true;
        break;
      }
      const element = handle.asElement() as ElementHandle<HTMLElement> | null;
      const remainingRegions = Math.min(handles.size, SCROLL_REGION_LIMIT) - Number(index) - 1;
      const panelBudget = { tiles: budget.tiles, until: Math.min(until, Math.max(Date.now() + 700, until - remainingRegions * 1000)) };
      const panel = element && await captureScrollRegion(page, element, compose, `scroll-${Number(index) + 1}`, panelBudget)
        .catch((error: unknown) => {
          if (error instanceof CaptureError) output.notices.push(error.message);
          return undefined;
        });
      budget.tiles = panelBudget.tiles;
      if (panel && panel.screenshot.startsWith(PNG_PREFIX)) {
        bytes += Buffer.byteLength(panel.screenshot.slice(PNG_PREFIX.length), "base64");
        if (bytes <= SCROLL_IMAGE_BYTES) {
          output.regions.push(panel);
          continue;
        }
        output.omitted = true;
        break;
      }
      output.omitted = true;
    }
  } finally {
    await Promise.all([...handles.values(), list].map(handle => handle.dispose()));
    await composer?.close();
  }
}

async function createCaptureBrowser({ url, width, height, allowDevCertificate, crawl }: CaptureRequest, interactive: boolean) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new CaptureError(400, "Enter an HTTP or HTTPS URL without embedded credentials.");
  }
  const executablePath = browserExecutable();
  const devCertificate = allowDevCertificate ? await readLocalCertificate(target) : undefined;
  const proxy = await startCaptureProxy(target, devCertificate?.address);
  const viewport = { width, height };
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      try {
        if (browser?.isConnected()) await browser.close();
      } finally {
        await proxy.close();
      }
    })();
    return closing;
  }
  try {
    browser = await chromium.launch({
      executablePath,
      headless: !interactive,
      chromiumSandbox: true,
      ...(interactive && { ignoreDefaultArgs: ["--disable-client-side-phishing-detection"] }),
      timeout: 12000,
      args: [
        `--proxy-server=${proxy.url}`,
        ...(devCertificate ? [`--ignore-certificate-errors-spki-list=${devCertificate.fingerprint}`] : []),
        "--proxy-bypass-list=<-loopback>",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
      ],
    }).catch(() => {
      throw new CaptureError(503, "The capture browser could not start. Check that Edge or Chrome opens on this computer.");
    });
    browser.once("disconnected", () => { void close().catch(() => {}); });
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      deviceScaleFactor: 1,
      isMobile: width <= 600,
      hasTouch: width <= 1024,
      acceptDownloads: false,
      reducedMotion: "reduce",
      ...(crawl && { serviceWorkers: "block" }),
    });
    const guardedCrawlPages = new Set<Page>();
    context.on("request", request => {
      if (!request.isNavigationRequest() || !/^https?:/.test(request.url()) ||
          new URL(request.url()).origin === target.origin) return;
      try {
        const frame = request.frame();
        if (frame === frame.page().mainFrame() && !guardedCrawlPages.has(frame.page())) proxy.releaseLocalTarget();
      } catch {
        // A new window can navigate before Playwright exposes its frame. Revoke the local exception if the frame is unknown.
        if (interactive) proxy.releaseLocalTarget();
      }
    });
    const page = await context.newPage();
    const connection = browser;
    function isOpen() {
      return !closing && connection.isConnected() && context.pages().length > 0;
    }
    if (interactive) {
      function closeWhenLastTabCloses(tab: Page) {
        tab.once("close", () => {
          setTimeout(() => {
            if (!context.pages().length) void close().catch(() => {});
          }, 250).unref();
        });
      }
      closeWhenLastTabCloses(page);
      context.on("page", closeWhenLastTabCloses);
    }
    return { page, context, target, viewport, devCertificateAllowed: Boolean(devCertificate), policy: proxy.policy, guardedCrawlPages, close, isOpen };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

type CaptureBrowser = Awaited<ReturnType<typeof createCaptureBrowser>>;

async function navigateToTarget({ page, target, policy, devCertificateAllowed }: CaptureBrowser) {
  const response = await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 18000 }).catch(error => {
    if (policy.blockedTarget) {
      throw new CaptureError(400, "This address resolves to a private network. Use a public URL or the address of an app running on this computer.");
    }
    if (error instanceof errors.TimeoutError) {
      throw new CaptureError(504, "The page took too long to load. Check the URL and try again.");
    }
    if (!devCertificateAllowed && error instanceof Error && /net::ERR_CERT_/.test(error.message) && isOnThisComputer(target.hostname)) {
      throw new CaptureError(422, "The local HTTPS certificate needs your approval before PageAtlas can capture this app.", "LOCAL_DEV_CERTIFICATE_REQUIRED");
    }
    throw new CaptureError(422, "The browser could not open this URL. Check that the site is reachable and uses a valid certificate.");
  });
  if (response && response.status() >= 400) {
    throw new CaptureError(422, `The website returned HTTP ${response.status()}. Open the URL in your browser to check access.`);
  }
}

async function bottomNavigation(page: Page) {
  return page.evaluateHandle(() => {
    const bars = new Map<HTMLElement, string>();
    const viewportHeight = window.innerHeight;
    const bottomEdge = viewportHeight - Math.max(24, viewportHeight * 0.04);
    for (const nav of Array.from(document.querySelectorAll<HTMLElement>("nav, [role=navigation]")).slice(0, 100)) {
      if (!nav.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const navBounds = nav.getBoundingClientRect();
      if (navBounds.width <= 0 || navBounds.height <= 0 || navBounds.top >= viewportHeight || navBounds.bottom < viewportHeight * 0.65) continue;

      for (let element: HTMLElement | null = nav; element && element !== document.body; element = element.parentElement) {
        const { position, bottom } = getComputedStyle(element);
        if (position !== "fixed" && position !== "sticky") continue;
        const bounds = element.getBoundingClientRect();
        if (bounds.height <= 0 || bounds.height > Math.min(240, viewportHeight * 0.35) || (bottom === "auto" && bounds.bottom < bottomEdge)) continue;
        bars.set(element, position);
        break;
      }
    }

    const changed: { element: HTMLElement; property: string; value: string; priority: string }[] = [];
    function override(element: HTMLElement, property: string, value: string) {
      changed.push({ element, property, value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) });
      element.style.setProperty(property, value, "important");
    }
    return {
      count: bars.size,
      apply() {
        for (const [element, position] of bars) {
          if (position === "fixed") {
            override(element, "opacity", "0");
          } else {
            override(element, "position", "relative");
            for (const inset of ["top", "right", "bottom", "left"]) override(element, inset, "auto");
          }
        }
      },
      restore() {
        for (const { element, property, value, priority } of changed.reverse()) {
          element.style.setProperty(property, value, priority);
        }
      },
    };
  });
}

async function captureMainLayout(page: Page) {
  const { title, url: mappedUrl, dimensions, sections, inferred, limited } = await readStructure(page);
  if (dimensions.width > MAX_WIDTH || dimensions.height > MAX_HEIGHT || dimensions.width * dimensions.height > MAX_PIXELS) {
    throw new CaptureError(413, "This page is too large for a single screenshot. Try a narrower viewport or a shorter page.");
  }
  const finalUrl = new URL(mappedUrl);
  if (!["http:", "https:"].includes(finalUrl.protocol)) {
    throw new CaptureError(422, "The website navigated away from the reviewable HTTP or HTTPS page.");
  }
  finalUrl.username = "";
  finalUrl.password = "";
  const png = await page.screenshot({
    fullPage: true, clip: { x: 0, y: 0, ...dimensions }, type: "png",
    animations: "disabled", caret: "hide", scale: "css", timeout: 12000,
  });
  if (page.url() !== mappedUrl) {
    throw new CaptureError(422, "The website changed pages during capture. Try entering the destination URL directly.");
  }
  if (png.length > MAX_IMAGE_BYTES) {
    throw new CaptureError(413, "The screenshot exceeds 20 MB. Try a narrower viewport or a shorter page.");
  }
  const imageSize = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  const pageGrew = await page.evaluate(({ width, height }) =>
    document.documentElement.scrollWidth > width || document.documentElement.scrollHeight > height,
  dimensions);
  return { title, finalUrl, dimensions, sections, inferred, limited, png, imageSize, pageGrew };
}

async function captureMobileViews(page: Page, viewport: Dimensions, captureStartedAt: number, interactive: boolean, currentViewOnly = false): Promise<CaptureResult> {
  const shots: ViewportShot[] = [];
  const warnings: string[] = [];
  const expectedUrl = page.url();
  const until = captureStartedAt + CAPTURE_TIMEOUT - 750;
  let imageBytes = 0;
  let limited = false;
  let stopped = false;
  let title = "";
  const targets = await page.evaluateHandle(({ limit, currentViewOnly }) => {
    const root = document.scrollingElement;
    if (currentViewOnly) return { elements: root ? [root] : [], omitted: false };
    const candidates: HTMLElement[] = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof HTMLElement) || node === root || node.clientWidth < 32 || node.clientHeight < 24 ||
          !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const style = getComputedStyle(node);
      if ((node.scrollHeight - node.clientHeight > 2 && /^(auto|scroll|overlay)$/.test(style.overflowY)) ||
          (node.scrollWidth - node.clientWidth > 2 && /^(auto|scroll|overlay)$/.test(style.overflowX))) candidates.push(node);
      if (candidates.length >= 120) break;
    }
    candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const primaryPanel = candidates.some(el => el.clientWidth >= innerWidth * 0.55 && el.clientHeight >= innerHeight * 0.45);
    const rootScrolls = root && (root.scrollHeight - innerHeight > 2 || root.scrollWidth - innerWidth > 2);
    const includeRoot = root && (rootScrolls || !primaryPanel);
    return {
      elements: [...(includeRoot ? [root] : []), ...candidates.slice(0, limit)],
      omitted: candidates.length > limit,
    };
  }, { limit: SCROLL_REGION_LIMIT, currentViewOnly });
  const list = await targets.getProperty("elements");
  const handles = await list.getProperties();
  limited = await (await targets.getProperty("omitted")).jsonValue();

  try {
    if (!currentViewOnly) await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    for (const handle of handles.values()) {
      const element = handle.asElement() as ElementHandle<HTMLElement> | null;
      if (!element) continue;
      const initial = await element.evaluate(el => {
        const root = el === document.scrollingElement;
        const label = root ? "Page" : [el.getAttribute("aria-label"), el.getAttribute("title"),
          el.querySelector("h1,h2,h3,[role=heading]")?.textContent]
          .map(value => value?.trim().replace(/\s+/g, " ")).find(Boolean)?.slice(0, 100) || "Scrollable panel";
        const original = { x: el.scrollLeft, y: el.scrollTop };
        if (!root) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return { label, original };
      });
      let nextX = 0;
      let nextY = 0;
      let previousPosition = "";
      let targetStep = 0;
      try {
        while (!stopped && shots.length < MOBILE_VIEW_LIMIT && Date.now() < until - 800) {
          if (!currentViewOnly) await element.evaluate((el, { x, y }) => {
            if (el === document.scrollingElement) window.scrollTo({ left: x, top: y, behavior: "instant" });
            else el.scrollTo({ left: x, top: y, behavior: "instant" });
          }, { x: nextX, y: nextY });
          try {
            await waitForContent(page, until - 250);
          } catch (error) {
            if (!shots.length || !(error instanceof CaptureError) || error.code !== 'CONTENT_NOT_READY') throw error;
            warnings.push("The sequence stopped before a scroll view that was still loading.");
            stopped = true;
            limited = true;
            break;
          }
          const position = await element.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
          const key = `${position.x},${position.y}`;
          if (key === previousPosition) {
            limited = true;
            break;
          }
          previousPosition = key;
          const structure = await readStructure(page, true);
          if (structure.url !== expectedUrl) throw new CaptureError(422, "The app changed pages while scrolling. Capture the destination page directly.");
          title ||= structure.title;
          const png = await page.screenshot({
            fullPage: false, type: "png", animations: "disabled", caret: "hide", scale: "css",
            timeout: Math.min(5000, Math.max(1, until - Date.now())),
          });
          if (page.url() !== expectedUrl) throw new CaptureError(422, "The app changed pages while scrolling. Capture the destination page directly.");
          if (png.length > MAX_VIEWPORT_IMAGE_BYTES || imageBytes + png.length > MAX_IMAGE_BYTES) {
            limited = true;
            break;
          }
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          const screenshot = `${PNG_PREFIX}${png.toString("base64")}`;
          if (screenshot !== shots.at(-1)?.screenshot) {
            const scaleX = width / structure.dimensions.width;
            const scaleY = height / structure.dimensions.height;
            targetStep++;
            shots.push({
              id: `view-${shots.length + 1}`,
              label: `${initial.label} · view ${targetStep}`,
              width, height, scrollX: position.x, scrollY: position.y, screenshot,
              sections: structure.sections.map(section => ({
                ...section, x: section.x * scaleX, y: section.y * scaleY,
                width: section.width * scaleX, height: section.height * scaleY,
              })),
            });
            imageBytes += png.length;
          }
          if (currentViewOnly) break;
          const state = await element.evaluate(el => {
            const root = el === document.scrollingElement;
            const width = root ? innerWidth : el.clientWidth;
            const height = root ? innerHeight : el.clientHeight;
            return {
              x: el.scrollLeft, y: el.scrollTop,
              maxX: Math.max(0, el.scrollWidth - width), maxY: Math.max(0, el.scrollHeight - height),
              stepX: Math.max(1, Math.floor(width * 0.75)), stepY: Math.max(1, Math.floor(height * 0.75)),
            };
          });
          if (state.y < state.maxY - 2) {
            nextY = Math.min(state.y + state.stepY, state.maxY);
          } else if (state.x < state.maxX - 2) {
            nextX = Math.min(state.x + state.stepX, state.maxX);
            nextY = 0;
          } else {
            break;
          }
        }
        if (shots.length >= MOBILE_VIEW_LIMIT || Date.now() >= until - 800) limited = true;
      } finally {
        await element.evaluate((el, original) => el.scrollTo({ left: original.x, top: original.y, behavior: "instant" }), initial.original).catch(() => {});
      }
      if (stopped || shots.length >= MOBILE_VIEW_LIMIT || Date.now() >= until - 800 || imageBytes >= MAX_IMAGE_BYTES) break;
    }
  } finally {
    if (!currentViewOnly) await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
    await Promise.all([...handles.values(), list, targets].map(handle => handle.dispose().catch(() => {})));
  }

  const first = shots[0];
  if (!first) throw new CaptureError(413, "The mobile viewport could not be captured within the review limits.");
  if (limited) warnings.push("The viewport sequence reached a capture limit. It shows the scroll views captured so far.");
  return {
    title, url: interactive ? new URL(expectedUrl).origin : expectedUrl,
    capturedAt: new Date().toISOString(), viewport,
    page: { width: first.width, height: first.height }, screenshot: first.screenshot,
    sections: first.sections, viewportShots: shots, scrollRegions: [], warnings,
  };
}

async function snapshot(page: Page, { viewport, policy }: CaptureBrowser, captureStartedAt: number, interactive: boolean, currentViewOnly = false): Promise<CaptureResult> {
  await page.waitForLoadState("load", { timeout: 1800 }).catch(() => {});
  const deadline = captureStartedAt + CAPTURE_TIMEOUT - 1000;
  await waitForContent(page, deadline, true);
  if (viewport.width <= 600 || currentViewOnly) {
    const result = await captureMobileViews(page, viewport, captureStartedAt, interactive, currentViewOnly);
    if (policy.blocked) result.warnings.push("Some page requests were blocked because they targeted a private network.");
    return result;
  }
  const reachedEnd = await warmPage(page, viewport, deadline);
  const navigation = await bottomNavigation(page);
  let viewportScreenshot: CaptureResult["viewportScreenshot"];
  const warnings: string[] = [];
  let layout: Awaited<ReturnType<typeof captureMainLayout>>;
  try {
    if (await navigation.evaluate(state => state.count)) {
      const reference = await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "css", timeout: 3500 }).catch(() => undefined);
      if (reference && reference.length <= MAX_VIEWPORT_IMAGE_BYTES) {
        viewportScreenshot = {
          width: reference.readUInt32BE(16),
          height: reference.readUInt32BE(20),
          screenshot: `${PNG_PREFIX}${reference.toString("base64")}`,
        };
        await navigation.evaluate(state => state.apply());
        warnings.push("The viewport reference shows the pinned bottom navigation. The full-page view removes the overlay so it does not cover the content.");
      } else {
        warnings.push("The separate viewport reference could not be captured. The full-page image retains the pinned bottom navigation.");
      }
    }
    layout = await captureMainLayout(page);
  } finally {
    await navigation.evaluate(state => state.restore()).catch(() => {});
    await navigation.dispose().catch(() => {});
  }
  const { title, finalUrl, dimensions, sections, inferred, limited, png, imageSize, pageGrew } = layout;
  if (pageGrew || imageSize.width !== dimensions.width || imageSize.height !== dimensions.height) {
    warnings.push("The page changed size during capture. The screenshot is bounded to the measured layout.");
  }
  if (imageSize.width > viewport.width) warnings.push("The page layout is wider than the selected viewport.");
  if (inferred && sections.length) warnings.push("The page has no visible landmarks or headings. The map shows its top-level layout blocks.");
  if (limited) warnings.push(`The structure map shows the first ${SECTION_LIMIT} visible elements.`);
  if (!reachedEnd) warnings.push("The site loaded more content as the browser scrolled. The screenshot shows the content loaded at capture time.");
  const scrollCapture: ScrollCapture = { regions: [], omitted: false, notices: [] };
  const until = Math.min(Date.now() + SCROLL_REGION_TIME, captureStartedAt + CAPTURE_TIMEOUT - 500);
  const scrollFinished = await Promise.race([
    captureScrollRegions(page, until, scrollCapture).then(() => true, () => false),
    delay(Math.max(0, until - Date.now()), false, { ref: false }),
  ]);
  if (!scrollFinished || scrollCapture.omitted) {
    warnings.push("Some scrollable areas could not be captured within the review limits.");
  }
  warnings.push(...scrollCapture.notices);
  for (const region of scrollCapture.regions) {
    if (!region.complete) warnings.push(`${region.label} is partial. ${region.partialReason || 'The panel reached a capture limit.'}`);
  }
  if (policy.blocked) warnings.push("Some page requests were blocked because they targeted a private network.");
  return {
    title,
    url: interactive ? finalUrl.origin : finalUrl.href,
    capturedAt: new Date().toISOString(),
    viewport,
    page: imageSize,
    screenshot: `${PNG_PREFIX}${png.toString("base64")}`,
    ...(viewportScreenshot && { viewportScreenshot }),
    sections,
    scrollRegions: scrollCapture.regions.slice(),
    warnings,
  };
}

async function withinCaptureBudget<T>(run: (startedAt: number) => Promise<T>, duration = CAPTURE_TIMEOUT) {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new CaptureError(504, "The page took too long to capture. Try again or use a shorter page.")), duration);
  });
  try {
    return await Promise.race([run(startedAt), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function captureSize(result: CaptureResult) {
  return [result.screenshot, result.viewportScreenshot?.screenshot ?? "", ...(result.viewportShots?.slice(1).map(shot => shot.screenshot) ?? []),
    ...result.scrollRegions.map(region => region.screenshot)]
    .reduce((size, data) => size + Buffer.byteLength(data.slice(PNG_PREFIX.length), "base64"), 0);
}

async function captureLinkedPages(page: Page, session: CaptureBrowser, root: CaptureResult, expiresAt: number, interactive: boolean) {
  const linkedPages: CaptureResult[] = [];
  const origin = new URL(root.url).origin;
  const entry = new URL(page.url());
  if (entry.origin !== origin) {
    return { ...root, linkedPages, warnings: [...root.warnings, "The app changed origins during capture. No linked pages were followed."] };
  }
  entry.search = "";
  const seen = new Set<string>();
  const scheduled = new Set<string>();
  const queue: (NavigationTarget & { depth: number; steps: NavigationTarget[] })[] = [];
  const entryRoute = crawlRoute(entry.href, origin);
  if (entryRoute) {
    seen.add(entryRoute);
    scheduled.add(entryRoute);
  }
  let bytes = captureSize(root);
  let attempts = 0;
  let controlsTried = 0;
  let controlsSkipped = 0;
  let probing = false;
  let blockedProbeRequest = false;
  let skipped = 0;
  const loadingSkipped: string[] = [];
  let limited = false;
  let stopped = false;

  async function discover(depth: number, steps: NavigationTarget[] = []) {
    for (const link of await discoverNavigation(page)) {
      const url = crawlRoute(link.url, origin);
      const key = link.control ? `${url}|${link.key}` : url;
      if (!url || !key || scheduled.has(key) || seen.has(key)) continue;
      if (depth > CRAWL_DEPTH_LIMIT || scheduled.size >= CRAWL_LINK_LIMIT) {
        limited = true;
        continue;
      }
      scheduled.add(key);
      queue.push({ ...link, url, key, depth, steps: link.control ? steps : [] });
    }
    queue.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
  }

  try {
    await withinCaptureBudget(async () => {
      await discover(1);
      if (!queue.length) return;
      const cdp = await session.context.newCDPSession(page);
      try {
        const { frameTree } = await cdp.send("Page.getFrameTree");
        // Redirect responses are checked before Chromium can leave the captured app.
        cdp.on("Fetch.requestPaused", ({ requestId, frameId, resourceType, request, responseStatusCode, responseHeaders }) => {
          const mainDocument = frameId === frameTree.frame.id && resourceType === "Document";
          let allowed = !mainDocument || (request.method === "GET" && Boolean(crawlRoute(request.url, origin)));
          if (probing && (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
              (['Document', 'XHR', 'Fetch'].includes(resourceType) && isUnsafeActionUrl(request.url)))) {
            blockedProbeRequest = true;
            allowed = false;
          }
          if (allowed && mainDocument && responseStatusCode && [301, 302, 303, 307, 308].includes(responseStatusCode)) {
            const location = responseHeaders?.find(header => header.name.toLowerCase() === "location")?.value;
            try {
              allowed = Boolean(location && crawlRoute(new URL(location, request.url).href, origin));
            } catch {
              allowed = false;
            }
          }
          // A completed synthetic response avoids a late chrome-error document aborting the next valid page.
          void (allowed ? cdp.send("Fetch.continueRequest", {
            requestId,
            ...(!responseStatusCode && mainDocument && { interceptResponse: true }),
          }) : cdp.send("Fetch.fulfillRequest", {
            requestId, responseCode: 451,
            responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
            body: Buffer.from("<!doctype html><title>Page outside review scope</title>").toString("base64"),
          })).catch(() => {});
        });
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        session.guardedCrawlPages.add(page);

        while (queue.length && !stopped) {
          const remaining = expiresAt - Date.now();
          if (linkedPages.length + 1 >= CRAWL_PAGE_LIMIT || attempts >= CRAWL_ATTEMPT_LIMIT || bytes >= CRAWL_IMAGE_BYTES || remaining < 1000) {
            limited = true;
            break;
          }
          const link = queue.shift();
          if (!link || seen.has(link.key)) continue;
          if (link.control && controlsTried >= CRAWL_CONTROL_LIMIT) {
            limited = true;
            continue;
          }
          attempts++;
          try {
            await withinCaptureBudget(async startedAt => {
              probing = false;
              const response = await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: Math.min(9000, remaining) });
              let url = crawlRoute(page.url(), origin);
              if (!url || (response && response.status() >= 400)) {
                skipped++;
                return;
              }
              let viewKey = url;
              let nextSteps: NavigationTarget[] = [];
              let currentViewOnly = false;
              if (link.control) {
                controlsTried++;
                seen.add(link.key);
                await waitForContent(page, startedAt + CAPTURE_TIMEOUT - 1500, true);
                blockedProbeRequest = false;
                probing = true;
                for (const step of link.steps) {
                  const replay = await probeNavigation(page, step);
                  if (replay.blocked || blockedProbeRequest || !replay.changed) {
                    controlsSkipped++;
                    return;
                  }
                  await waitForContent(page, startedAt + CAPTURE_TIMEOUT - 1500);
                }
                const outcome = await probeNavigation(page, link);
                const destination = crawlRoute(outcome.popupUrl || outcome.url, origin);
                if (!destination) {
                  controlsSkipped++;
                  return;
                }
                if (destination !== url) {
                  probing = false;
                  const destinationResponse = await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: Math.min(9000, remaining) });
                  url = crawlRoute(page.url(), origin);
                  if (!url || (destinationResponse && destinationResponse.status() >= 400)) {
                    controlsSkipped++;
                    return;
                  }
                  viewKey = url;
                } else {
                  if (!outcome.changed || outcome.blocked || blockedProbeRequest) {
                    controlsSkipped++;
                    return;
                  }
                  viewKey = link.key;
                  nextSteps = [...link.steps, link];
                  currentViewOnly = link.control.kind === 'disclosure' || await page.evaluate(() =>
                    Array.from(document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true]'))
                      .some(element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })));
                }
              }
              if (!link.control && seen.has(viewKey)) return;
              if (link.control && viewKey !== link.key && seen.has(viewKey)) return;
              seen.add(viewKey);
              const result = await snapshot(page, session, startedAt, interactive, currentViewOnly);
              if (stopped) return;
              if (crawlRoute(page.url(), origin) !== url) {
                skipped++;
                return;
              }
              const pageBytes = captureSize(result);
              if (bytes + pageBytes > CRAWL_IMAGE_BYTES) {
                limited = true;
                stopped = true;
                return;
              }
              bytes += pageBytes;
              linkedPages.push({ ...result, navigationLabel: link.label || undefined });
              await discover(link.depth + 1, nextSteps);
            }, Math.min(CAPTURE_TIMEOUT, remaining));
          } catch (error) {
            if (error instanceof CaptureError && error.code === 'CONTENT_NOT_READY') {
              loadingSkipped.push(link.label || 'A linked page');
            }
            if (error instanceof CaptureError && error.status === 504) {
              limited = true;
              stopped = true;
            } else {
              skipped++;
            }
          } finally {
            probing = false;
          }
        }
      } finally {
        await cdp.detach().catch(() => {});
        session.guardedCrawlPages.delete(page);
      }
    }, Math.max(1, expiresAt - Date.now()));
  } catch {
    stopped = true;
    limited = true;
  }

  const warnings = [...root.warnings];
  const otherSkipped = skipped - loadingSkipped.length;
  if (otherSkipped) warnings.push(`Linked pages skipped: ${otherSkipped}. These pages did not load or stay within the app.`);
  for (const label of loadingSkipped) warnings.push(`${label} was still loading and was skipped.`);
  if (controlsSkipped) warnings.push(`${controlsSkipped} navigation controls were skipped because they did not open a supported view or required a blocked action.`);
  if (limited) warnings.push("The linked-page capture reached a safety or size limit. The review contains the pages captured so far.");
  return { ...root, linkedPages: linkedPages.slice(), warnings };
}

export async function capturePage(input: CaptureRequest): Promise<CaptureResult> {
  const session = await createCaptureBrowser(input, false);
  const expiresAt = Date.now() + CRAWL_TIMEOUT;
  try {
    const root = await withinCaptureBudget(async startedAt => {
      await navigateToTarget(session);
      return snapshot(session.page, session, startedAt, false);
    });
    return input.crawl ? await captureLinkedPages(session.page, session, root, expiresAt, false) : root;
  } finally {
    await session.close();
  }
}

async function selectedWebsiteTab(context: BrowserContext, target: URL) {
  const pages = context.pages().filter(page => !page.isClosed() && /^https?:\/\//.test(page.url())).slice(-16).reverse();
  if (pages.length <= 1) return pages[0];
  const states = new Map<Page, { focused: boolean; visible: boolean }>();
  await Promise.race([
    Promise.all(pages.map(async page => {
      const state = await page.evaluate(() => ({
        focused: document.hasFocus(), visible: document.visibilityState === "visible",
      })).catch(() => undefined);
      if (state) states.set(page, state);
    })),
    delay(800, undefined, { ref: false }),
  ]);
  const sameOrigin = (page: Page) => page.url().startsWith(`${target.origin}/`);
  return pages.find(page => states.get(page)?.focused)
    ?? pages.find(page => states.get(page)?.visible && sameOrigin(page))
    ?? pages.find(page => states.get(page)?.visible)
    ?? pages.find(sameOrigin)
    ?? pages[0];
}

export async function openCaptureSession(input: CaptureRequest): Promise<InteractiveCapture> {
  const session = await createCaptureBrowser(input, true);
  // Chromium displays the initial page or its network error, while the API returns promptly.
  void session.page.goto(session.target.href, { waitUntil: "commit", timeout: 18000 }).catch(() => {});
  return {
    isOpen: session.isOpen,
    close: session.close,
    async capture() {
      const closed = () => new CaptureError(410, "The sign-in browser was closed. Open a new sign-in capture to try again.");
      if (!session.isOpen()) throw closed();
      const page = await selectedWebsiteTab(session.context, session.target);
      if (!session.isOpen()) throw closed();
      if (!page) throw new CaptureError(409, "The sign-in browser has no website tab ready to capture. Wait for the website to load before capturing.");
      try {
        const expiresAt = Date.now() + CRAWL_TIMEOUT;
        const root = await withinCaptureBudget(startedAt => snapshot(page, session, startedAt, true));
        return input.crawl ? await captureLinkedPages(page, session, root, expiresAt, true) : root;
      } catch (error) {
        if (!session.isOpen()) throw closed();
        if (error instanceof CaptureError) throw error;
        if (error instanceof Error && /execution context was destroyed|cannot find context|frame was detached/i.test(error.message)) {
          throw new CaptureError(409, "The page is still navigating. Wait for it to finish loading, then capture again.");
        }
        throw new CaptureError(422, "The signed-in page could not be captured. Try a new sign-in capture.");
      }
    },
  };
}
