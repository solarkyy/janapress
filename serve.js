#!/usr/bin/env node
// ─────────────────────────────────────────────────────────
//  janapress · dev server
//  Zero external dependencies — pure Node.js built-ins only
//
//  Usage:  node serve.js
//  Then:   open http://localhost:3000
//
//  Claude (Cowork) edits index.html → file watcher detects
//  change → browser auto-reloads in < 1 second.
//  Same relay pattern as OmniOPS DevBridge / OmniServe.
// ─────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

// ── Live-reload snippet injected before </body> ──
const LIVE_RELOAD = `
<script>
/* janapress live-reload — injected by serve.js */
(function(){
  var _mtime = 0;
  function poll() {
    fetch('/__jp_reload?t=' + _mtime, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d.reload) {
          console.log('[janapress] Change detected — reloading…');
          location.reload();
        }
        setTimeout(poll, 600);
      })
      .catch(() => setTimeout(poll, 2000));
  }
  poll();
  console.log('%c janapress dev server — live reload active ', 'background:#C84060;color:#fff;padding:2px 8px;border-radius:4px;');
})();
</script>`;

// Track mtime of index.html
let indexPath  = path.join(ROOT, 'index.html');
let lastMtime  = 0;
try { lastMtime = fs.statSync(indexPath).mtimeMs; } catch(_) {}

// Watch for changes (works across the VM/host boundary via the shared folder)
fs.watch(ROOT, { persistent: true }, (event, filename) => {
  if (!filename) return;
  const abs = path.join(ROOT, filename);
  try {
    const mtime = fs.statSync(abs).mtimeMs;
    if (mtime !== lastMtime) {
      lastMtime = mtime;
      console.log(`  ✏  ${filename} changed — browser will reload`);
    }
  } catch(_) {}
});

// ── HTTP server ──────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const pname = url.pathname;

  // ── Live-reload polling endpoint ──
  if (pname === '/__jp_reload') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    // Check current mtime
    let currentMtime = lastMtime;
    try { currentMtime = fs.statSync(indexPath).mtimeMs; } catch(_) {}
    const clientMtime = parseFloat(url.searchParams.get('t') || '0');
    if (clientMtime > 0 && currentMtime > clientMtime) {
      lastMtime = currentMtime;
      res.end(JSON.stringify({ reload: true, mtime: currentMtime }));
    } else {
      res.end(JSON.stringify({ reload: false, mtime: currentMtime }));
    }
    return;
  }

  // ── Status endpoint ──
  if (pname === '/__jp_status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, server: 'janapress-dev', port: PORT }));
    return;
  }

  // ── Static file serving ──
  let filePath = path.join(ROOT, pname === '/' ? 'index.html' : pname);

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try /index.html as fallback (SPA routing)
      fs.readFile(indexPath, (err2, fallback) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        serveHtml(res, fallback);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') { serveHtml(res, data); return; }
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
});

function serveHtml(res, data) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // Inject live-reload before </body>
  const html = data.toString().replace('</body>', LIVE_RELOAD + '\n</body>');
  res.end(html);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │  janapress · Publisher OS  dev server   │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log(`  │  Local:   http://localhost:${PORT}           │`);
  console.log('  │  Network: http://' + getLocalIP() + ':' + PORT + '        │');
  console.log('  │  Live reload: ✅ watching for changes    │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log('  │  Claude edits index.html                 │');
  console.log('  │  → browser auto-reloads in < 1 second   │');
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
  console.log('  Press Ctrl+C to stop.\n');
});

function getLocalIP() {
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch(_) {}
  return '0.0.0.0          ';
}
