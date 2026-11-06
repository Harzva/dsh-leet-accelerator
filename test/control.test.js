import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runRoot = tmpdir();

test('local controller saves only its overlay and rejects invalid or missing state', { timeout: 15000 }, async t => {
  // The executable and page are copied byte-for-byte to a unique test-owned
  // root. No user profile or production overlay is opened or changed.
  // Node resolves ESM entry paths to their realpath; on macOS tmpdir() is a
  // /var -> /private/var symlink. Compare against the same canonical path so
  // the controller's reported overlay matches regardless of TMPDIR.
  const root = realpathSync(mkdtempSync(join(runRoot, 'control-regression-')));
  mkdirSync(join(root, 'control'));
  copyFileSync(join(sourceRoot, 'control-server.js'), join(root, 'control-server.mjs'));
  copyFileSync(join(sourceRoot, 'control', 'index.html'), join(root, 'control', 'index.html'));
  const overlay = join(root, 'control', 'accelerator.patch.json');
  const child = spawn(process.execPath, [join(root, 'control-server.mjs')], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: runRoot }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('controller startup timeout: ' + stderr)), 5000);
    const onData = () => {
      const match = stdout.match(/Leet Accelerator control: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on('data', onData);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`controller exited early: ${code} ${stderr}`)); });
    onData();
  });
  const origin = new URL(url).origin;
  const pageResponse = await fetch(url);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  const token = page.match(/const token = '([a-f0-9]{64})';/)?.[1];
  assert.ok(token, 'page must have its per-process token');
  assert.match(pageResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const state = async () => fetch(url + 'state');
  const post = (enabled, opts = {}) => fetch(url + 'state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: opts.origin ?? origin, 'X-Control-Token': opts.token ?? token },
    body: JSON.stringify({ enabled }),
  });

  let res = await state();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { enabled: false, overlay });
  assert.equal(JSON.parse(readFileSync(overlay, 'utf8'))[0].config.enabled, false);
  assert.equal((await post(true, { origin: 'http://example.com' })).status, 403);
  assert.equal((await post(true, { token: 'incorrect' })).status, 403);
  assert.equal(JSON.parse(readFileSync(overlay, 'utf8'))[0].config.enabled, false);

  for (const enabled of [true, false]) {
    res = await post(enabled);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled, overlay });
    assert.equal(JSON.parse(readFileSync(overlay, 'utf8'))[0].config.enabled, enabled);
    assert.equal((await (await state()).json()).enabled, enabled);
  }

  unlinkSync(overlay);
  res = await state();
  assert.equal(res.status, 409, 'a missing overlay must not appear as saved/off');
  assert.match(await res.text(), /missing/i);
  res = await post(true);
  assert.equal(res.status, 200, 'explicitly saving can recreate the owned overlay');

  const unknown = '{"preserve":"unrecognized user content"}\n';
  writeFileSync(overlay, unknown);
  assert.equal((await state()).status, 500);
  assert.equal((await post(false)).status, 409);
  assert.equal(readFileSync(overlay, 'utf8'), unknown, 'unknown data must not be overwritten');
});
