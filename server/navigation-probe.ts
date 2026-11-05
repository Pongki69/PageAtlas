import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { NavigationTarget } from './navigation.ts';

export type NavigationProbeResult = {
  url: string;
  changed: boolean;
  popupUrl?: string;
  blocked: boolean;
};

export async function probeNavigation(page: Page, target: NavigationTarget): Promise<NavigationProbeResult> {
  const beforeUrl = page.url();
  if (!target.control || page.isClosed()) return { url: beforeUrl, changed: false, blocked: true };
  const deadline = Date.now() + 2000;
  const control = page.locator(target.control.selector);
  if (await control.count() !== 1 || !await control.isVisible()) {
    return { url: beforeUrl, changed: false, blocked: true };
  }
  const eligible = await control.evaluate((element, expectedLabel) => {
    if (element.closest('form, [inert]') || element.matches('[disabled], [aria-disabled=true]')) return false;
    const referenced = element.getAttribute('aria-labelledby')?.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    const label = [element.getAttribute('aria-label'), referenced, element.textContent,
      element instanceof HTMLInputElement ? element.value : undefined, element.getAttribute('title')]
      .map(value => value?.trim().replace(/\s+/g, ' ')).find(Boolean)?.slice(0, 140);
    if (label !== expectedLabel) return false;
    const role = element.getAttribute('role');
    return element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && element.type === 'button') ||
      role === 'link' || role === 'tab' || role === 'button' || role === 'menuitem';
  }, target.label, { timeout: Math.max(1, deadline - Date.now()) }).catch(() => false);
  if (!eligible) return { url: beforeUrl, changed: false, blocked: true };

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
      const content = (roots.length ? roots : [document.body]).filter(Boolean)
        .map(element => element.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000).replace(/\d/g, '#'));
      const controls = Array.from(document.querySelectorAll('[role=tab], [aria-expanded], dialog, [role=dialog]'))
        .filter(visible).slice(0, 100).map(element => [
          element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 120),
          element.getAttribute('aria-selected'), element.getAttribute('aria-expanded'),
          element.hasAttribute('open'), element.getAttribute('aria-busy'),
        ]);
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        .filter(visible).slice(0, 150).map(link => [link.href, link.textContent?.trim().slice(0, 100)]);
      return JSON.stringify([document.title, content, controls, links]);
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
      inspect() { return { popupUrl, blocked, signature: signature() }; },
      restore,
    };
  });

  let popupUrl: string | undefined;
  let blocked = false;
  let contentChanged = false;
  let clicked = false;
  try {
    const installed = await state.evaluate(value => value.installed);
    if (!installed) return { url: beforeUrl, changed: false, blocked: true };
    const before = await state.evaluate(value => value.before);
    try {
      await control.click({ timeout: Math.max(1, Math.min(1200, deadline - Date.now())), noWaitAfter: true });
      clicked = true;
    } catch {
      // Navigation may replace the control before Playwright completes its actionability check.
    }
    while (!page.isClosed() && Date.now() < deadline) {
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
      const observed = await state.evaluate(value => value.inspect()).catch(() => undefined);
      if (observed) {
        popupUrl = observed.popupUrl;
        blocked ||= observed.blocked;
        contentChanged = observed.signature !== before;
      }
      if (page.url() !== beforeUrl || popupUrl || contentChanged || blocked) break;
    }
    const url = page.url();
    const changed = url !== beforeUrl || Boolean(popupUrl) || contentChanged;
    return { url, changed, ...(popupUrl && { popupUrl }), blocked: blocked || (!clicked && !changed) };
  } finally {
    await state.evaluate(value => value.restore()).catch(() => {});
    await state.dispose().catch(() => {});
  }
}
