#!/usr/bin/env node
// ─────────────────────────────────────────────────────────
//  janapress · sync daemon
//  OmniSync pattern: watch → commit → push → Netlify deploys
//
//  Usage:  node sync.js
//
//  Claude (Cowork) edits index.html
//  → sync.js detects change after 4s quiet
//  → auto-commits with timestamp + changed file list
//  → pushes to github.com/solarkyy/janapress
//  → Netlify auto-deploys in ~25 seconds
//  → live on the web ✅
//
//  Zero external dependencies — pure Node.js built-ins only.
// ─────────────────────────────────────────────────────────
'use strict';

const fs     = require('fs');
const path   = require('path');
const { execSync, spawn } = require('child_process');

const ROOT         = __dirname;
const QUIET_MS     = 4000;    // wait 4s of quiet before committing
const POLL_REMOTE  = 30000;   // check for remote changes every 30s

const WATCH_FILES  = ['index.html', 'manifest.json', 'sw.js', 'netlify.toml', '_redirects'];

// ── Helpers ──────────────────────────────────────────────
function git(...args) {
  return execSync(['git', ...args].join(' '), { cwd: ROOT, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
}

function log(symbol, msg) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`  ${symbol}  [${time}] ${msg}`);
}

// ── State ─────────────────────────────────────────────────
let pendingFiles  = new Set();
let commitTimer   = null;
let pushing       = false;

// ── Watch for file changes ────────────────────────────────
WATCH_FILES.forEach(filename => {
  const filepath = path.join(ROOT, filename);
  if (!fs.existsSync(filepath)) return;

  fs.watch(filepath, (event) => {
    if (event !== 'change') return;
    pendingFiles.add(filename);
    scheduleCommit();
  });
});

// Also watch for any new files added to the folder
fs.watch(ROOT, (event, filename) => {
  if (!filename || filename.startsWith('.') || filename === 'sync.js' || filename === 'serve.js') return;
  const ext = path.extname(filename);
  if (['.html','.json','.js','.css','.toml','.txt'].includes(ext)) {
    pendingFiles.add(filename);
    scheduleCommit();
  }
});

function scheduleCommit() {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(doCommitAndPush, QUIET_MS);
  const files = [...pendingFiles].join(', ');
  log('✏', `Change detected: ${files} — committing in ${QUIET_MS/1000}s…`);
}

// ── Commit + push ─────────────────────────────────────────
async function doCommitAndPush() {
  if (pushing) { scheduleCommit(); return; }
  pushing = true;

  const changedFiles = [...pendingFiles];
  pendingFiles.clear();
  commitTimer = null;

  try {
    // Stage changed files
    changedFiles.forEach(f => {
      try { git('add', f); } catch(_) {}
    });

    // Check if there's actually anything to commit
    const status = git('status', '--porcelain');
    if (!status.trim()) {
      log('○', 'No staged changes — skipping commit');
      pushing = false;
      return;
    }

    // Build commit message
    const now = new Date();
    const timestamp = now.toLocaleString('en-GB', {
      day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false
    }).replace(',','');
    const msg = `update ${changedFiles.join(', ')} — ${timestamp}`;

    git('commit', '-m', JSON.stringify(msg));
    log('✅', `Committed: ${msg}`);

    // Push
    log('⬆', 'Pushing to GitHub…');
    git('push', 'origin', 'main');
    log('🌐', 'Pushed → Netlify will deploy in ~25 seconds');

  } catch(err) {
    log('❌', 'Git error: ' + (err.message || err).split('\n')[0]);
    // Re-queue if push failed
    changedFiles.forEach(f => pendingFiles.add(f));
  }

  pushing = false;
}

// ── Pull remote changes periodically ─────────────────────
function pollRemote() {
  try {
    git('fetch', 'origin', '--quiet');
    const behind = git('rev-list', '--count', 'HEAD..origin/main');
    if (parseInt(behind) > 0) {
      git('pull', '--rebase', 'origin', 'main');
      log('⬇', `Pulled ${behind} commit(s) from remote`);
    }
  } catch(_) {}
}
setInterval(pollRemote, POLL_REMOTE);

// ── Startup ───────────────────────────────────────────────
try {
  const branch = git('branch', '--show-current');
  const remote = git('remote', 'get-url', 'origin').replace(/ghp_[^@]+@/, '');
  const lastCommit = git('log', '--oneline', '-1');

  console.log('');
  console.log('  ┌────────────────────────────────────────────────────┐');
  console.log('  │  janapress · sync daemon                           │');
  console.log('  ├────────────────────────────────────────────────────┤');
  console.log('  │  Repo:    ' + remote.padEnd(41) + '│');
  console.log('  │  Branch:  ' + branch.padEnd(41) + '│');
  console.log('  │  Last:    ' + lastCommit.slice(0,41).padEnd(41) + '│');
  console.log('  ├────────────────────────────────────────────────────┤');
  console.log('  │  Watching: index.html + all .html/.js/.json files  │');
  console.log('  │  Claude edits → 4s quiet → commit → push → live   │');
  console.log('  └────────────────────────────────────────────────────┘');
  console.log('');
} catch(e) {
  console.log('  janapress sync daemon started');
}

log('👁', 'Watching for changes… (Ctrl+C to stop)\n');
