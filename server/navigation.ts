import type { Page } from "playwright-core";

export type NavigationTarget = {
  url: string;
  label: string;
  priority: number;
  key: string;
  control?: { selector: string; kind: "navigate" | "disclosure" | "tab" };
};

const viewParameters = new Set(["view", "tab", "screen", "page", "section", "mode"]);
const unsafePath = /(?:^|[/_.-])(?:log[/_.-]?out|sign[/_.-]?out|delete|remove|destroy|cancel|revoke|unsubscribe|submit|checkout|purchase|pay|approve|reject|refund|download|export|impersonate|verify|reset|activate|execute|webhook)(?:$|[/_.-])/i;
const documentOnlyPath = /(?:^|[/_.-])(?:api|oauth|sso|auth|token|login|sign[/_.-]?in)(?:$|[/_.-])/i;
const unsafeQuery = /(?:^|[_-])(?:action|delete|remove|destroy|cancel|revoke|unsubscribe|submit|checkout|purchase|pay|approve|reject|refund|execute|download|export|token|secret|password|credential|authorization|auth|code|signature|nonce|redirect|returnurl|callback)(?:$|[_-])/i;
const filePath = /\.(?:zip|gz|tar|pdf|csv|xlsx?|docx?|jpe?g|png|svg|webp|mp[34]|exe|json|xml|txt)$/i;

function decoded(value: string): string {
  let result = value;
  for (let count = 0; count < 2; count++) result = decodeURIComponent(result);
  return result;
}

function safeViewQuery(query: URLSearchParams): boolean {
  const keys = new Set<string>();
  for (const [key, value] of query) {
    if (!viewParameters.has(key.toLowerCase()) || keys.has(key.toLowerCase()) || keys.size >= 4 ||
        !/^[\w .-]{1,64}$/.test(value) || unsafePath.test(value)) return false;
    keys.add(key.toLowerCase());
  }
  return true;
}

export function isUnsafeActionUrl(value: string): boolean {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return true;
  try {
    const url = new URL(value, "http://navigation.invalid");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return true;
    const hashRoute = /^#!?\//.test(url.hash) ? url.hash.replace(/^#!?/, "") : "";
    const route = decoded(`${url.pathname}${hashRoute.split("?")[0] ?? ""}`);
    if (unsafePath.test(route)) return true;
    if (/(?:^|\/)api(?:\/|$)/i.test(route) && /(?:^|[/_.-])(?:save|update|create|set|toggle|change|mark)(?:$|[/_.-])/i.test(route)) return true;
    const hashQuery = hashRoute.includes("?") ? hashRoute.slice(hashRoute.indexOf("?") + 1) : "";
    for (const query of [url.searchParams, new URLSearchParams(hashQuery)]) {
      for (const [key, parameter] of query) {
        if (unsafeQuery.test(decoded(key)) || unsafePath.test(decoded(parameter))) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export function navigationUrl(value: string, origin: string): string | undefined {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || isUnsafeActionUrl(url.href) || !safeViewQuery(url.searchParams)) return;
    let hashPath = "";
    if (/^#!?\//.test(url.hash)) {
      const route = url.hash.replace(/^#!?/, "");
      const question = route.indexOf("?");
      hashPath = question < 0 ? route : route.slice(0, question);
      const query = new URLSearchParams(question < 0 ? "" : route.slice(question + 1));
      if (!safeViewQuery(query)) return;
      query.sort();
      const prefix = url.hash.startsWith("#!") ? "#!" : "#";
      url.hash = `${prefix}${hashPath}${query.size ? `?${query}` : ""}`;
    } else {
      url.hash = "";
    }
    const route = decoded(`${url.pathname}${hashPath}`);
    if (/[?&#=;]/.test(route) || documentOnlyPath.test(route) || filePath.test(route)) return;
    url.searchParams.sort();
    return url.href;
  } catch {
    return;
  }
}

export async function discoverNavigation(page: Page): Promise<NavigationTarget[]> {
  const sourceUrl = page.url();
  const origin = new URL(sourceUrl).origin;
  const candidates = await page.evaluate(() => {
    type Candidate = {
      url?: string;
      label: string;
      priority: number;
      control?: { selector: string; kind: "navigate" | "disclosure" | "tab" };
    };
    const results: Candidate[] = [];
    const navigationContext = "aside, nav, [role=navigation], [role=complementary], [role=menu], [role=menubar], [role=tablist]";
    const unsafeLabel = /\b(?:delete|remove|destroy|save|submit|send|confirm|checkout|purchase|buy|pay|approve|reject|refund|revoke|unsubscribe|sign\s*out|log\s*out|logout|discard|reset|cancel|download|export|print)\b/i;
    const clearNavigation = /^(?:open|view|go\s+to|browse|details)(?:\b|\s)/i;
    function labelOf(element: Element) {
      const referenced = element.getAttribute("aria-labelledby")?.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || "").join(" ");
      return [element.getAttribute("aria-label"), referenced, element.textContent,
        element instanceof HTMLInputElement ? element.value : undefined, element.getAttribute("title")]
        .map(value => value?.trim().replace(/\s+/g, " ")).find(Boolean)?.slice(0, 140) || "";
    }
    function priorityOf(element: Element) {
      if (element.closest("aside, [role=complementary]")) return 0;
      return element.closest(navigationContext) ? 1 : 2;
    }
    function excluded(element: Element) {
      const method = element.getAttribute("data-method") || element.getAttribute("data-turbo-method");
      return element.matches('[disabled], [aria-disabled=true], [download], [data-confirm], [rel~=external], [type=submit], [type=reset], [form]') ||
        Boolean(method && method.toLowerCase() !== "get") || Boolean(element.closest("form, [inert]"));
    }
    function selectorOf(element: Element) {
      if (element.id) {
        const selector = `#${CSS.escape(element.id)}`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      for (const attribute of ["data-testid", "data-test", "data-cy", "aria-label"]) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const selector = `${element.localName}[${attribute}=${CSS.escape(value)}]`;
        if (document.querySelectorAll(selector).length === 1) return selector;
      }
      const parts: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        let part = node.localName;
        const parent: Element | null = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(sibling => sibling.localName === node!.localName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
      }
      return parts.join(" > ");
    }
    const elements = document.querySelectorAll<HTMLElement>(
      'a[href], [data-href], [data-url], [data-to], [data-route], button, input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]',
    );
    for (const element of Array.from(elements).slice(0, 2000)) {
      if (excluded(element)) continue;
      const label = labelOf(element);
      const priority = priorityOf(element);
      const inNavigation = Boolean(element.closest(navigationContext));
      const visible = element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      if (!visible && !inNavigation) continue;
      const href = element.getAttribute("href")?.trim();
      const destination = element instanceof HTMLAnchorElement && href && href !== "#" ? element.href
        : ["data-href", "data-url", "data-to", "data-route"].map(attribute => element.getAttribute(attribute)).find(Boolean);
      if (destination) {
        if (/^(?:delete|remove|save|submit|send|confirm|approve|reject|revoke|reset|cancel|download|export|print)\b/i.test(label)) continue;
        try {
          results.push({ url: new URL(destination, document.baseURI).href, label, priority });
        } catch {
          // Ignore malformed route attributes without interrupting discovery.
        }
        continue;
      }
      if (!visible || !label || unsafeLabel.test(label) || /^(?:close|dismiss|collapse)\b/i.test(label)) continue;
      const role = element.getAttribute("role");
      if (!["tab", "link", "menuitem"].includes(role || "") && !inNavigation && !clearNavigation.test(label)) continue;
      const selector = selectorOf(element);
      if (!selector || selector.length > 4096) continue;
      const kind = role === "tab" ? "tab"
        : element.hasAttribute("aria-expanded") || element.hasAttribute("aria-controls") || element.hasAttribute("aria-haspopup")
          ? "disclosure" : "navigate";
      results.push({ label, priority, control: { selector, kind } });
    }
    return results;
  });
  const targets = new Map<string, NavigationTarget>();
  for (const candidate of candidates) {
    if (candidate.control) {
      const key = `control:${candidate.control.kind}:${candidate.control.selector}`;
      targets.set(key, { ...candidate, url: sourceUrl, key });
      continue;
    }
    const url = candidate.url && navigationUrl(candidate.url, origin);
    if (!url) continue;
    const existing = targets.get(url);
    if (!existing || candidate.priority < existing.priority) targets.set(url, { ...candidate, url, key: url });
  }
  return [...targets.values()].sort((a, b) => a.priority - b.priority);
}
