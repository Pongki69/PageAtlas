import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const commandShell = process.env.ComSpec || 'cmd.exe';
const background = process.argv.includes('--background');
const noBrowser = process.argv.includes('--no-browser');

async function appState(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const html = await response.text();
    return response.ok && html.includes('<title>PageAtlas') ? 'running' : 'occupied';
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return 'offline';
    return 'occupied';
  }
}

function runNpm(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandShell, ['/d', '/s', '/c', `npm.cmd ${command}`], {
      cwd: projectRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${command} did not finish successfully. Check the message above.`));
    });
  });
}

async function openBrowser(url) {
  console.log(`Open PageAtlas at ${url}`);
  if (noBrowser) return;
  const child = spawn(commandShell, ['/d', '/c', 'start', '', url], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise(resolve => {
    child.once('error', () => {
      console.log('Open the address above in your browser.');
      resolve();
    });
    child.once('exit', code => {
      if (code !== 0) console.log('Open the address above in your browser.');
      resolve();
    });
  });
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error('Install Node.js 22.18 or newer from https://nodejs.org, then run the launcher again.');
  }
  const portText = process.env.PAGEATLAS_PORT ?? '4317';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1024 || port > 65535) {
    throw new Error('PAGEATLAS_PORT must be a whole number between 1024 and 65535.');
  }
  const url = `http://127.0.0.1:${port}/`;
  if (process.argv.includes('--open')) {
    await openBrowser(url);
    return;
  }
  if (process.argv.includes('--stop') || process.argv.includes('--restart')) {
    const stopCode = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./stop-server.ps1', import.meta.url)), '-Port', String(port),
      ], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (stopCode !== 0) throw new Error('The server was left unchanged. See the message above.');
    if (process.argv.includes('--stop')) return;
    const deadline = Date.now() + 5000;
    while (await appState(url) !== 'offline') {
      if (Date.now() >= deadline) throw new Error('The server has not finished stopping. Try again.');
      await delay(100);
    }
  }
  const existing = await appState(url);
  if (existing === 'running') {
    console.log('PageAtlas is already running. Opening it in your browser.');
    await openBrowser(url);
    return;
  }
  if (existing === 'occupied') {
    throw new Error(`Port ${port} is in use by another application. Set PAGEATLAS_PORT to a free port and run the launcher again.`);
  }

  const lock = await stat(new URL('../package-lock.json', import.meta.url));
  const installed = await stat(new URL('../node_modules/.package-lock.json', import.meta.url)).catch(() => undefined);
  if (!installed || installed.mtimeMs < lock.mtimeMs) {
    console.log('Installing PageAtlas dependencies. This can take a few minutes the first time.');
    await runNpm('ci --include=dev');
  }
  console.log('Preparing the latest PageAtlas build.');
  await runNpm('run build');

  const logPath = fileURLToPath(new URL(`../pageatlas-server-${port}.log`, import.meta.url));
  const log = background ? openSync(logPath, 'w') : undefined;
  let server;
  try {
    server = spawn(process.execPath, ['server/index.ts'], {
      cwd: projectRoot,
      stdio: background ? ['ignore', log, log] : 'inherit',
      detached: background,
      windowsHide: true,
    });
  } finally {
    if (log !== undefined) closeSync(log);
  }
  let ended = false;
  let keepRunning = false;
  const serverExit = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('exit', code => {
      ended = true;
      resolve(code);
    });
  });
  // Observe startup failures immediately, including while the health check is polling.
  void serverExit.catch(() => {});
  const stopServer = () => server.kill();
  process.once('SIGINT', stopServer);
  process.once('SIGTERM', stopServer);
  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!ended && Date.now() < deadline) {
      if (await appState(url) === 'running') {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error('PageAtlas did not start. Check the server message above.');
    console.log(background
      ? 'PageAtlas is running. Use the launcher menu to restart or stop the server.'
      : 'Keep this window open while using PageAtlas. Press Ctrl+C to stop it.');
    await openBrowser(url);
    if (background) {
      keepRunning = true;
      server.unref();
      return;
    }
    const code = await serverExit;
    if (code && code !== 0) throw new Error(`PageAtlas stopped with exit code ${code}.`);
  } finally {
    process.removeListener('SIGINT', stopServer);
    process.removeListener('SIGTERM', stopServer);
    if (!ended && !keepRunning) server.kill();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
