import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('Windows launcher reuses one server and restarts/stops it without stopping other apps', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const launch = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/launch.mjs', ...args, '--no-browser'], {
      cwd: projectRoot, env: { ...process.env, PAGEATLAS_PORT: String(port) }, windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  const info = async () => (await fetch(`${base}/api/server-info`)).json();
  try {
    await t.test('start keeps running after the launcher exits', async () => {
      const started = await launch('--background');
      assert.equal(started.code, 0, started.output);
      assert.equal((await info()).app, 'PageAtlas');
      await delay(300);
      assert.equal((await info()).app, 'PageAtlas');
    });
    await t.test('restart replaces the running process and becomes ready', async () => {
      const before = await info();
      const restarted = await launch('--restart', '--background');
      assert.equal(restarted.code, 0, restarted.output);
      const after = await info();
      assert.notEqual(after.pid, before.pid);
      assert.notEqual(after.parentPid, before.parentPid);
    });
    await t.test('repeated start reuses the existing server', async () => {
      const before = await info();
      const reopened = await launch('--background');
      assert.equal(reopened.code, 0, reopened.output);
      assert.equal((await info()).pid, before.pid);
    });
    await t.test('stop stays stopped and can be repeated', async () => {
      const stopped = await launch('--stop');
      assert.equal(stopped.code, 0, stopped.output);
      await delay(500);
      await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1500) }));
      const again = await launch('--stop');
      assert.equal(again.code, 0, again.output);
      assert.match(again.output, /already stopped/);
    });
  } finally {
    await launch('--stop');
  }
  await t.test('refuses to stop an unrelated listener', async () => {
    const other = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ app: 'Other application' }));
    });
    await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
    try {
      const stopped = await launch('--stop');
      assert.equal(stopped.code, 1);
      assert.match(stopped.output, /left running/);
      assert.equal((await (await fetch(base)).json()).app, 'Other application');
    } finally {
      other.closeAllConnections();
      await new Promise(resolve => other.close(resolve));
    }
  });
});
