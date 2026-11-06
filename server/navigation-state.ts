import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';

// Kept self-contained so Playwright can run the same inspection in any app.
function inspectNavigationState() {
  const visible = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && bounds.width > 0 && bounds.height > 0;
  };
  function selectorOf(element: Element): string {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(sibling => sibling.localName === node!.localName) : [node];
      parts.unshift(`${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  }
  // Native modal dialogs live in the browser's top layer. For ARIA dialogs,
  // use hit testing to distinguish stacked dialogs even with different z-indexes.
  const native = Array.from(document.querySelectorAll('dialog:modal')).filter(visible);
  const dialogs = native.length ? native : Array.from(document.querySelectorAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog][aria-modal=true]')).filter(visible);
  const modal = [...dialogs].reverse().find(dialog => {
    const bounds = dialog.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, bounds.left + bounds.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, bounds.top + bounds.height / 2));
    const hit = document.elementFromPoint(x, y);
    return hit && dialog.contains(hit) && !dialogs.some(other => other !== dialog && dialog.contains(other) && other.contains(hit));
  }) ?? dialogs.at(-1);
  const scope = modal ?? document.body;
  const text = (value: string | null | undefined, limit = 160) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit).replace(/\d+/g, '#');
  const resolvedHref = (element: Element) => {
    const href = element.getAttribute('href');
    if (href === null) return null;
    try { return new URL(href, document.baseURI).href; }
    catch { return href; }
  };
  const roots = modal ? [modal] : Array.from(document.querySelectorAll<HTMLElement>('main, [role=main]')).filter(visible);
  const scopeSelector = modal ? selectorOf(modal) : undefined;
  const controls = Array.from(scope?.querySelectorAll('[href], button, [role=tab], [role=button], [role=menuitem], [role=link]') ?? [])
    .filter(visible).slice(0, 300).map(element => [
      element.localName, element.getAttribute('href'), text(element.getAttribute('aria-label') || element.textContent),
      element.getAttribute('aria-selected'), element.getAttribute('aria-expanded'), element.getAttribute('aria-pressed'),
    ]);
  const key = JSON.stringify([
    location.href, scopeSelector,
    (roots.length ? roots : [document.body]).map(root => text((root as HTMLElement)?.innerText, 4000)),
    controls,
  ]);
  // A shared tools/profile dialog is one view even when opened over several
  // different routes. Keep its own content and resolved destinations, not the
  // background URL, DOM position, or the sequence used to open it.
  const viewKey = modal ? JSON.stringify([
    modal.getAttribute('aria-label'),
    modal.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' '),
    (modal as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
    Array.from(modal.querySelectorAll('[href], button, [role=tab], [role=button], [role=menuitem], [role=link]'))
      .filter(visible).slice(0, 300).map(element => [
        element.localName,
        resolvedHref(element),
        element.getAttribute('aria-label'), element.getAttribute('aria-selected'), element.getAttribute('aria-expanded'),
      ]),
  ]) : undefined;
  return { scopeSelector, key, viewKey };
}

export async function readNavigationState(page: Page) {
  const state = await page.evaluate(inspectNavigationState);
  return {
    ...state,
    key: createHash('sha256').update(state.key).digest('hex'),
    viewKey: state.viewKey ? createHash('sha256').update(state.viewKey).digest('hex') : undefined,
  };
}
