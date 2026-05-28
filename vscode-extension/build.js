#!/usr/bin/env node
/**
 * build.js  –  Ooumph AI Chat VS Code Extension setup script
 *
 * Run once after cloning:
 *   cd vscode-extension
 *   node build.js
 *
 * What it does:
 *  1. Downloads index.html from the live GitHub Pages site
 *  2. Strips the version-check snippet (not needed inside VS Code)
 *  3. Removes the hard-coded Azure credentials so they come from VS Code settings
 *  4. Writes the result to  media/chat.html
 *
 * After this, open the vscode-extension folder in VS Code and press F5
 * to launch the Extension Development Host.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SOURCE_URL = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const OUT_DIR    = path.join(__dirname, 'media');
const OUT_FILE   = path.join(OUT_DIR, 'chat.html');

console.log('\n🔨 Ooumph AI Chat Extension Builder');
console.log('=====================================');

// Ensure media/ folder exists
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, {recursive: true});
  console.log('Created media/ folder');
}

// Download the live web app
console.log('Downloading ' + SOURCE_URL + ' ...');
download(SOURCE_URL, (err, html) => {
  if (err) {
    console.error('ERROR downloading source:', err.message);
    process.exit(1);
  }
  console.log('Downloaded ' + html.length + ' bytes');

  // ── Patch 1: remove version-check reload snippet ──────
  // (The _ov localStorage trick causes infinite reloads inside webview)
  html = html.replace(
    /<script>!function\(\)[^<]+_ov[^<]+<\/script>/,
    '<!-- version-check removed for VS Code webview -->'
  );

  // ── Patch 2: neutralise hard-coded Azure credentials ──
  // Replace AZURE_BASE and AZURE_KEY with empty strings;
  // the bridge script (injected by extension.js) will supply
  // the real values from VS Code settings at runtime.
  html = html.replace(
    /const AZURE_BASE\s*=\s*['"][^'"]*['"]/,
    "const AZURE_BASE = ''"
  );
  html = html.replace(
    /const AZURE_KEY\s*=\s*['"][^'"]*['"]/,
    "const AZURE_KEY  = ''"
  );

  // ── Patch 3: add VS Code webview CSP meta tag ─────────
  // Allow scripts from 'self' and the CDNs already used in the app
  const csp = '<meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; ' +
    'script-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; ' +
    'style-src \'unsafe-inline\' https://cdnjs.cloudflare.com; ' +
    'font-src https:; ' +
    'img-src data: https:; ' +
    'connect-src https:;">';

  html = html.replace('<head>', '<head>\n  ' + csp);

  // ── Patch 4: remove the GitHub Gist sync UI label ─────
  // (optional – keeps the extension cleaner; remove this block to keep it)
  // Left in for now – users may still want Gist sync.

  // Write output
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  console.log('\n✅ media/chat.html written (' + html.length + ' bytes)');
  console.log('\nNext steps:');
  console.log('  1. Open this folder in VS Code:  code .');
  console.log('  2. Press F5 to launch Extension Development Host');
  console.log('  3. In the new window, open the Ooumph chat:');
  console.log('     • Click the speech-bubble icon in the Activity Bar, OR');
  console.log('     • Press Ctrl+Shift+O  (Cmd+Shift+O on Mac)\n');
});

// ── helpers ──────────────────────────────────────────────

function download(url, cb) {
  const follow = (u, redirects) => {
    if (redirects > 5) return cb(new Error('Too many redirects'));
    const mod = u.startsWith('https') ? https : require('http');
    mod.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, u).href;
        return follow(next, redirects + 1);
      }
      if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => cb(null, data));
    }).on('error', cb);
  };
  follow(url, 0);
}
