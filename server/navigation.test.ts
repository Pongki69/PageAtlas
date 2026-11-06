import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { discoverNavigation } from './navigation.ts';
import { probeNavigation } from './navigation-probe.ts';

async function launchBrowser() {
  const candidates = [
    process.env.PAGEATLAS_BROWSER,
    ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
      .filter((root): root is string => Boolean(root))
      .flatMap(root => [join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath(),
  ];
  const executablePath = candidates.find(path => path && existsSync(path));
  assert.ok(executablePath, 'Install Chrome/Edge or set PAGEATLAS_BROWSER to run the navigation regression test.');
  return chromium.launch({ executablePath, headless: true });
}

test('discovers href destinations regardless of element type or visibility', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('http://pageatlas.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><base href="/app/"><link rel="alternate" href="metadata">
        <a href="overview">Overview</a>
        <a href="reports?year=2026&sort=name">Reports</a>
        <a href="#/settings?tab=profile">Settings</a>
        <a href="#section">Section</a>
        <div hidden><a href="mobile-only">Mobile view</a></div>
        <div style="display:none"><a href="collapsed">Collapsed link</a></div>
        <button href="button-page">Button link</button>
        <div role="link" href="custom-page">Custom link</div>
        <svg width="100" height="30"><a href="svg-page"><text y="20">SVG link</text></a></svg>
        <map name="pages"><area href="image-page" alt="Image link"></map>
        <a data-href="attribute-page">Route attribute</a>
        <button aria-label="Open menu">Menu</button>
        <button hidden>Hidden control</button>
        <a href="https://other.test/outside">External</a>
        <a href="logout" hidden>Log out</a>
        <a href="report.pdf">File</a>
        <a href="download-file" download>Download file</a>
        <a href="javascript:alert(1)">Script</a>
        <a href="mailto:test@example.test">Email</a>
        <a href="delete-item" data-method="post">Action</a>
        <a href="inert-page" inert>Inactive</a>`,
    }));
    await page.goto('http://pageatlas.test/app/start');
    const targets = await discoverNavigation(page);
    const links = targets.filter(target => !target.control).map(target => target.url).sort();
    assert.deepEqual(links, [
      'http://pageatlas.test/app/overview',
      'http://pageatlas.test/app/reports?sort=name&year=2026',
      'http://pageatlas.test/app/#/settings?tab=profile',
      'http://pageatlas.test/app/',
      'http://pageatlas.test/app/mobile-only',
      'http://pageatlas.test/app/collapsed',
      'http://pageatlas.test/app/button-page',
      'http://pageatlas.test/app/custom-page',
      'http://pageatlas.test/app/svg-page',
      'http://pageatlas.test/app/image-page',
      'http://pageatlas.test/app/attribute-page',
    ].sort());
    assert.deepEqual(targets.filter(target => target.control).map(target => target.label), ['Open menu']);
  } finally {
    await browser.close();
  }
});

test('scopes navigation to the active dialog and rejects stale or background controls', async t => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.route('http://pageatlas.test/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Dialog fixture</title>',
    }));
    await page.goto('http://pageatlas.test/');
    await t.test('native modal links take priority and background profile is never clicked', async () => {
      await page.setContent(`<!doctype html>
        <aside><button id="tools" onclick="document.querySelector('dialog').showModal()">More tools</button></aside>
        <button id="profile" onclick="document.body.dataset.profileClicked='true'">Profile</button>
        <dialog><h2>Restaurant tools</h2><nav><a href="/reserve">Reserve a table</a></nav>
        <button id="inside" onclick="document.querySelector('h2').textContent='Table options'">Table options</button></dialog>`);
      const rootTargets = await discoverNavigation(page);
      const tools = rootTargets.find(target => target.label === 'More tools')!;
      const profile = rootTargets.find(target => target.label === 'Profile')!;
      assert.equal((await probeNavigation(page, tools)).changed, true);
      const targets = await discoverNavigation(page);
      assert.deepEqual(targets.map(target => target.label), ['Reserve a table', 'Table options']);
      assert.ok(targets[0]!.priority < profile.priority);
      const stale = await probeNavigation(page, profile);
      assert.equal(stale.clicked, false);
      assert.equal(stale.blocked, true);
      const unscoped = await probeNavigation(page, { ...profile, sourceKey: undefined });
      assert.equal(unscoped.clicked, false);
      assert.match(unscoped.reason!, /outside the active dialog/);
      assert.equal(await page.getAttribute('body', 'data-profile-clicked'), null);
      assert.equal((await probeNavigation(page, targets.find(target => target.control)!)).changed, true);
    });
    await t.test('ARIA modals exclude background links and stacked dialogs use the topmost scope', async () => {
      await page.setContent(`<!doctype html><a href="/background">Background</a>
        <div role="dialog" aria-modal="true" style="position:fixed;inset:10px;background:white;z-index:20">
          <a href="/lower">Lower dialog</a></div>
        <div role="dialog" aria-modal="true" style="position:fixed;inset:30px;background:white;z-index:30">
          <a href="/upper">Upper dialog</a></div>`);
      assert.deepEqual((await discoverNavigation(page)).map(target => target.label), ['Upper dialog']);
    });
    await t.test('native top layer wins over custom overlays and nested dialogs', async () => {
      await page.setContent(`<!doctype html>
        <dialog id="outer"><a href="/outer">Outer</a></dialog>
        <dialog id="inner"><a href="/inner">Inner</a></dialog>
        <div role="dialog" aria-modal="true" style="position:fixed;inset:0;z-index:9999;background:white"><a href="/fake">Overlay</a></div>
        <script>outer.showModal(); inner.showModal();</script>`);
      assert.deepEqual((await discoverNavigation(page)).map(target => target.label), ['Inner']);
    });
    await t.test('same URL and selector cannot replay a control from a different tab', async () => {
      await page.setContent('<main><h1>Reservations</h1><button id="open">Open details</button></main>');
      const target = (await discoverNavigation(page)).find(target => target.control)!;
      await page.setContent('<main><h1>Profile</h1><button id="open" onclick="document.body.dataset.clicked=1">Open details</button></main>');
      const result = await probeNavigation(page, target);
      assert.equal(result.clicked, false);
      assert.match(result.reason!, /source view changed/);
      assert.equal(await page.getAttribute('body', 'data-clicked'), null);
    });
  } finally {
    await browser.close();
  }
});
