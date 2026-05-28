#!/usr/bin/env node
/**
 * build.js  --  Ooumph AI Chat VS Code Extension setup script
 *
 * Run once after cloning (or after pulling updates):
 *   cd vscode-extension
 *   node build.js
 *
 * What it does:
 *  1. Downloads index.html from the live GitHub Pages site
 *  2. Strips the version-check reload snippet (causes loops in webview)
 *  3. Changes const->let for AZURE_BASE and AZURE_KEY so the bridge
 *     can update them at runtime from VS Code settings
 *  4. Writes the result to  media/chat.html
 *     (The bridge script in extension.js handles everything else at runtime)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SOURCE_URL = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const OUT_DIR    = path.join(__dirname, 'media');
const OUT_FILE   = path.join(OUT_DIR, 'chat.html');

console.log('\n Ooumph AI Chat Extension Builder');
console.log('=====================================');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('Created media/ folder');
}

console.log('Downloading ' + SOURCE_URL + ' ...');
download(SOURCE_URL, (err, html) => {
  if (err) { console.error('ERROR downloading source:', err.message); process.exit(1); }
  console.log('Downloaded ' + html.length + ' bytes');

  // ── Patch 1: remove version-check reload snippet ──────
  // This snippet calls location.reload() which loops forever in a webview
  html = html.replace(
    /<script>!function\(\)[^<]+_ov[^<]+<\/script>/,
    '<!-- version-check removed for VS Code webview -->'
  );

  // ── Patch 2: const -> let for Azure credential vars ───
  // The bridge script needs to UPDATE these at runtime from VS Code settings.
  // 'const' variables cannot be reassigned, so we change them to 'let'.
  html = html.replace(/\bconst (AZURE_BASE\s*=)/, 'let   $1');
  html = html.replace(/\bconst (AZURE_KEY\s*=)/,  'let   $1');

  // ── Patch 3: clear the credential values ─────────────
  // Blank them out so the extension must supply them via settings.
  // The bridge will fill them in as soon as VS Code sends the config.
  html = html.replace(/(let\s+AZURE_BASE\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/(let\s+AZURE_KEY\s*=\s*)['"][^'"]*['"]/, "$1''");

  // ── Write output ──────────────────────────────────────
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  console.log('\n media/chat.html written (' + html.length + ' bytes)');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Open Settings in VS Code and search "ooumph"');
  console.log('     Fill in: Azure Endpoint, Azure Api Key, Models list');
  console.log('  2. Open this folder in VS Code:  code .');
  console.log('  3. Press F5 to launch Extension Development Host, OR');
  console.log('     package and install permanently:');
  console.log('       vsce package');
  console.log('       code --install-extension ooumph-ai-chat-1.0.0.vsix');
  console.log('');
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
