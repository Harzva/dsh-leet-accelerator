import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This controller writes only its own overlay, never a user's DSH profile.
const root = dirname(fileURLToPath(import.meta.url));
const control = join(root, 'control');
if (lstatSync(control).isSymbolicLink() || realpathSync(control) !== control) throw new Error('Control directory must be a real local directory');
const overlay = join(control, 'accelerator.patch.json');
const page = readFileSync(join(control, 'index.html'), 'utf8');
const token = randomBytes(32).toString('hex');
const renderOverlay = enabled => JSON.stringify([{ id: 'dsh-leet-accelerator', config: {
  enabled, thresholdChars: 8192, headChars: 4096, tailChars: 1024,
} }], null, 2) + '\n';

function readEnabled() {
  let stat;
  try { stat = lstatSync(overlay); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Overlay is not a regular file');
  const text = readFileSync(overlay, 'utf8');
  if (text === renderOverlay(true)) return true;
  if (text === renderOverlay(false)) return false;
  throw new Error('Overlay contains unrecognized data; refusing to overwrite it');
}
function saveEnabled(enabled) {
  readEnabled();
  const temp = join(control, `.accelerator-${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, renderOverlay(enabled));
    closeSync(fd); fd = undefined;
    // Recheck immediately before replacing the solely owned overlay.
    readEnabled();
    renameSync(temp, overlay);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// A fresh overlay defaults to the upstream algorithm; an unknown file is never replaced.
if (readEnabled() === null) saveEnabled(false);

const server = createServer((req, res) => {
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + token + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page.replaceAll('__NONCE__', token));
    return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    try {
      const enabled = readEnabled();
      if (enabled === null) { res.writeHead(409).end('Overlay is missing; restart the controller'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ enabled, overlay }));
    }
    catch { res.writeHead(500).end('Cannot read owned overlay'); }
    return;
  }
  if (req.method !== 'POST' || req.url !== '/state' || req.headers.origin !== origin || req.headers['x-control-token'] !== token || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; if (body.length > 128) req.destroy(); });
  req.on('end', () => {
    try {
      const value = JSON.parse(body);
      if (!value || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') { res.writeHead(400).end('Invalid state'); return; }
      saveEnabled(value.enabled);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ enabled: value.enabled, overlay }));
    } catch { res.writeHead(409).end('Overlay could not be saved'); }
  });
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Leet Accelerator control: ${url}`);
  console.log(`Owned overlay: ${overlay}`);
  console.log('Apply at next start with: dsh --profile <your-compatible-profile> --patch "' + overlay + '"');
});
