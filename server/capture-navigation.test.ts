import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { capturePage } from './capture.ts';

test('capture follows dynamically created modal links and restores nested navigation before opening profile', { timeout: 90000 }, async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url !== '/') {
      const heading = request.url === '/reserve' ? 'Reserve a table' : request.url === '/menus' ? 'Menu overview' : 'Profile settings';
      response.end(`<!doctype html><title>${heading}</title><main><h1>${heading}</h1><p>Review this page.</p></main>`);
      return;
    }
    response.end(`<!doctype html><title>Restaurant dashboard</title>
      <aside><button id="tools">More tools</button></aside>
      <button id="profile">Your workspace</button>
      <main><h1>Dashboard</h1><p>Restaurant overview</p></main>
      <script>
        function openDialog(content) {
          const dialog = document.createElement('dialog');
          dialog.innerHTML = content;
          document.body.append(dialog);
          dialog.showModal();
          return dialog;
        }
        document.querySelector('#tools').onclick = () => {
          const tools = openDialog('<h2>Restaurant tools</h2><a href="/reserve">Reserve a table</a><button id="categories">Browse menus</button>');
          tools.querySelector('#categories').onclick = () => openDialog('<h2>Menus</h2><a href="/menus">Menu overview</a>');
        };
        document.querySelector('#profile').onclick = () => openDialog('<h2>Your workspace</h2><a href="/profile">Profile settings</a>');
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await capturePage({ url: origin, width: 1024, height: 768, crawl: true }, { signal: AbortSignal.timeout(80000) });
    const pages = result.linkedPages ?? [];
    for (const path of ['/reserve', '/menus', '/profile']) {
      assert.ok(pages.some(page => page.url === `${origin}${path}`), `Missing ${path}; captured ${pages.map(page => page.navigationLabel).join(', ')}; ${JSON.stringify(result.exploration)}`);
    }
    assert.ok(pages.findIndex(page => page.url === `${origin}/reserve`) < pages.findIndex(page => page.navigationLabel === 'Your workspace'));
    assert.equal(result.exploration?.controlsClicked, 3);
    assert.deepEqual(result.exploration?.skipped, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('shared tools and profile dialogs are captured once across application routes', { timeout: 90000 }, async () => {
  const server = createServer((request, response) => {
    const title = request.url === '/reserve' ? 'Reserve a table' : request.url === '/profile' ? 'Profile settings' : request.url === '/orders' ? 'Orders' : 'Dashboard';
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><title>${title}</title>
      <aside><nav><a href="/">Dashboard</a><a href="/orders">Orders</a>
        <button aria-label="More restaurant tools" aria-controls="tools" onclick="document.querySelector('#tools').showModal()">More tools</button></nav></aside>
      <header><button aria-label="Open user profile" onclick="document.querySelector('#profile').showModal()">Profile</button></header>
      <main><h1>${title}</h1><p>Current application page</p></main>
      <dialog id="tools" aria-labelledby="tools-title"><h2 id="tools-title">Restaurant tools</h2>
        <nav><a href="/reserve">Reserve a table</a></nav></dialog>
      <dialog id="profile" aria-label="Your workspace"><h2>Your workspace</h2><a href="/profile">Profile settings</a></dialog>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const result = await capturePage({ url: origin, width: 1024, height: 768, crawl: true }, { signal: AbortSignal.timeout(80000) });
    const pages = [result, ...(result.linkedPages ?? [])];
    for (const path of ['/', '/orders', '/reserve', '/profile']) {
      assert.equal(pages.filter(page => page.url === `${origin}${path}` && !page.navigationLabel?.match(/More restaurant tools|Open user profile/)).length, 1, `Missing or duplicate route ${path}`);
    }
    assert.equal(pages.filter(page => page.navigationLabel === 'More restaurant tools').length, 1);
    assert.equal(pages.filter(page => page.navigationLabel === 'Open user profile').length, 1);
    assert.equal(pages.length, 6);
    assert.deepEqual(result.exploration?.skipped, []);
    assert.deepEqual(result.warnings, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
