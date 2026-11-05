import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { NavigationTarget } from './navigation.ts';

export type NavigationProbeResult = {
  url: string;
  changed: boolean;
  popupUrl?: string;
  blocked: boolean;
  clicked: boolean;
  reason?: string;
};

export async function probeNavigation(page: Page, target: NavigationTarget): Promise<NavigationProbeResult> {
  const beforeUrl = page.url();
  if (!target.control || page.isClosed()) return { url: beforeUrl, changed: false, blocked: true, clicked: false, reason: 'The navigation control is no longer available.' };
  const deadline = Date.now() + 6000;
  const control = page.locator(target.control.selector);
  if (await control.count() !== 1 || !await control.isVisible()) {
    return { url: beforeUrl, changed: false, blocked: true, clicked: false, reason: 'The navigation control was hidden or could not be identified uniquely.' };
  }
  const ineligibleReason = await control.evaluate((element, expectedLabel) => {
    if (element.closest('form, [inert]') || element.matches('[form], [type=submit], [type=reset]')) return 'The control belongs to a form or an inactive view.';
    if (element.matches('[disabled], [aria-disabled=true]')) return 'The navigation control was disabled.';
    const referenced = element.getAttribute('aria-labelledby')?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = [element.getAttribute('aria-label'), referenced, element.textContent,
      element instanceof HTMLInputElement ? element.value : undefined, element.getAttribute('title')]
      .map(value => value?.trim().replace(/\s+/g, ' ')).find(Boolean)?.slice(0, 140);
    const withoutBadge = (value: string) => value.trim().replace(/\s*(?:\(\s*\d+\s*\)|\[\s*\d+\s*\])\s*$/, '').trim();
    if (!label || withoutBadge(label) !== withoutBadge(expectedLabel)) return 'The navigation control changed before it could be clicked.';
    const role = element.getAttribute('role');
    const eligible = element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && element.type === 'button') ||
      role === 'link' || role === 'tab' || role === 'button' || role === 'menuitem';
    return eligible ? undefined : 'The element was no longer an interactive navigation control.';
  }, target.label, { timeout: Math.max(1, deadline - Date.now()) }).catch(() => 'The navigation control could not be inspected.');
  if (ineligibleReason) return { url: beforeUrl, changed: false, blocked: true, clicked: false, reason: ineligibleReason };

  const state = await page.evaluateHandle(() => {
    let blocked = false;
    let popupUrl: string | undefined;
    const openDescriptor = Object.getOwnPropertyDescriptor(window, 'open');
    const sendDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'send');
    const interceptedOpen = (url?: string | URL) => {
      try {
        const destination = new URL(String(url || ''), document.baseURI);
        if (!url || destination.href.length > 4096 || !['http:', 'https:'].includes(destination.protocol)) {
          blocked = true;
        } else {
          popupUrl = destination.href;
          if (destination.origin !== location.origin) blocked = true;
        }
      } catch {
        blocked = true;
      }
      return null;
    };
    const interceptedSend = () => { blocked = true; };
    function restore() {
      if (Object.getOwnPropertyDescriptor(window, 'open')?.value === interceptedOpen) {
        if (openDescriptor) Object.defineProperty(window, 'open', openDescriptor);
        else Reflect.deleteProperty(window, 'open');
      }
      if (Object.getOwnPropertyDescriptor(WebSocket.prototype, 'send')?.value === interceptedSend) {
        if (sendDescriptor) Object.defineProperty(WebSocket.prototype, 'send', sendDescriptor);
        else Reflect.deleteProperty(WebSocket.prototype, 'send');
      }
    }
    function signature() {
      const visible = (element: Element) => {
        const bounds = element.getBoundingClientRect();
        return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          bounds.width > 0 && bounds.height > 0;
      };
      const roots = Array.from(document.querySelectorAll<HTMLElement>('main, [role=main], dialog[open], [role=dialog], [role=menu]'))
        .filter(visible);
      const text = (value: string | null | undefined, limit: number) => value?.replace(/\s+/g, ' ').trim().slice(0, limit).replace(/\d+/g, '#');
      const content = (roots.length ? roots : [document.body]).filter(Boolean)
        .map(element => text(element.innerText, 4000));
      const controls = Array.from(document.querySelectorAll('[role=tab], [aria-expanded], dialog, [role=dialog]'))
        .filter(visible).slice(0, 100).map(element => [
          text(element.getAttribute('aria-label') || element.textContent, 120),
          element.getAttribute('aria-selected'), element.getAttribute('aria-expanded'),
          element.hasAttribute('open'),
        ]);
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter(visible).slice(0, 150).map(link => [link.href, text(link.textContent, 100)]);
      return JSON.stringify([text(document.title, 200), content, controls, links]);
    }
    function loading() {
      if (document.readyState === 'loading') return true;
      const main = document.querySelector<HTMLElement>('main, [role=main]') ?? document.body;
      const content = main?.innerText.trim() || '';
      if (content.length < 150 && /^(?:loading(?:\b|[.…])|fetching\b|please\s+wait\b)/i.test(content)) return true;
      return Array.from(document.querySelectorAll('[aria-busy=true], [data-loading=true], [data-state=loading], [class*="skeleton" i], [role=status]'))
        .slice(0, 1000).some(element => {
          const bounds = element.getBoundingClientRect();
          if (!element.checkVisibility({ visibilityProperty: true }) || bounds.width <= 0 || bounds.height <= 0 ||
              bounds.top >= innerHeight || bounds.bottom <= 0 || bounds.left >= innerWidth || bounds.right <= 0) return false;
          if (element.matches('[aria-busy=true], [data-loading=true], [data-state=loading], [class*="skeleton" i]')) return true;
          return /^\s*(?:loading(?:\b|[.…])|fetching\b|please\s+wait\b)/i.test(element.getAttribute('aria-label') || element.textContent || '');
        });
    }
    let installed = false;
    try {
      Object.defineProperty(window, 'open', { ...openDescriptor, configurable: true, writable: true, value: interceptedOpen });
      Object.defineProperty(WebSocket.prototype, 'send', { ...sendDescriptor, configurable: true, writable: true, value: interceptedSend });
      installed = true;
    } catch {
      blocked = true;
      restore();
    }
    return {
      installed,
      before: signature(),
      inspect() { return { popupUrl, blocked, signature: signature(), loading: loading() }; },
      restore,
    };
  });

  let popupUrl: string | undefined;
  let blocked = false;
  let contentChanged = false;
  let clicked = false;
  let stillLoading = false;
  let stableSince = Date.now();
  let lastSignature = '';
  try {
    const installed = await state.evaluate(value => value.installed);
    if (!installed) return { url: beforeUrl, changed: false, blocked: true, clicked: false, reason: 'The navigation control could not be explored with the interaction guards.' };
    const before = await state.evaluate(value => value.before);
    try {
      await control.click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), noWaitAfter: true });
      clicked = true;
    } catch {
      // Navigation may replace the control before Playwright completes its actionability check.
    }
    while (!page.isClosed() && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      const observed = await state.evaluate(value => value.inspect()).catch(() => undefined);
      if (!observed) {
        if (page.url() !== beforeUrl) break;
        continue;
      }
      popupUrl = observed.popupUrl;
      blocked ||= observed.blocked;
      stillLoading = observed.loading;
      contentChanged = observed.signature !== before;
      if (observed.signature !== lastSignature || stillLoading) stableSince = Date.now();
      lastSignature = observed.signature;
      if (page.url() !== beforeUrl || popupUrl || blocked) break;
      if (contentChanged && !stillLoading && Date.now() - stableSince >= 350) break;
    }
    const url = page.url();
    const changed = url !== beforeUrl || Boolean(popupUrl) || (contentChanged && !stillLoading);
    const reason = blocked ? 'The control attempted an unsupported window or data-changing interaction.'
      : !clicked && !changed ? 'The navigation control could not be clicked.'
        : !changed && stillLoading ? 'The control was still loading after it was clicked.'
          : !changed ? 'The control did not open another view within the interaction allowance.' : undefined;
    return { url, changed, ...(popupUrl && { popupUrl }), blocked: blocked || (!clicked && !changed), clicked, ...(reason && { reason }) };
  } finally {
    await state.evaluate(value => value.restore()).catch(() => {});
    await state.dispose().catch(() => {});
  }
}
