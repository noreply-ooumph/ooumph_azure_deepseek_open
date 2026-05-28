#!/usr/bin/env node
/**
 * build.js  --  Ooumph AI Chat VS Code Extension setup script
 *
 * Run once after cloning:
 *   cd vscode-extension
 *   node build.js
 *
 * What it does:
 *  1. Downloads index.html from the live GitHub Pages site
 *  2. Removes the version-check reload snippet
 *  3. Changes const->let for AZURE_BASE/AZURE_KEY
 *  4. Strips ALL inline event handlers (onclick=, onkeydown=, oninput=)
 *     from HTML attributes -- VS Code webview blocks these even with unsafe-inline
 *  5. Adds a placeholder <script id="vsc-handlers"> tag just before </body>
 *     Extension.js replaces this placeholder with a nonce-tagged script
 *     containing addEventListener() calls for all the stripped handlers
 *  6. Writes result to media/chat.html
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
  if (err) { console.error('ERROR:', err.message); process.exit(1); }
  console.log('Downloaded ' + html.length + ' bytes');

  // Patch 1: remove version-check reload snippet
  html = html.replace(
    /<script>!function\(\)[^<]+_ov[^<]+<\/script>/,
    '<!-- version-check removed -->'
  );

  // Patch 2: const -> let for Azure credential vars
  html = html.replace(/\bconst (AZURE_BASE\s*=)/, 'let   $1');
  html = html.replace(/\bconst (AZURE_KEY\s*=)/,  'let   $1');
  html = html.replace(/(let\s+AZURE_BASE\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/(let\s+AZURE_KEY\s*=\s*)['"][^'"]*['"]/, "$1''");

  // Patch 3: strip inline event handlers from HTML attributes
  // VS Code webview blocks onclick=/onkeydown=/oninput= even with unsafe-inline.
  // We remove them here; extension.js re-attaches them via addEventListener
  // inside a nonce-tagged <script> block.
  html = html.replace(/\s*onclick="[^"]*"/g, '');
  html = html.replace(/\s*onkeydown="[^"]*"/g, '');
  html = html.replace(/\s*oninput="[^"]*"/g, '');
  html = html.replace(/\s*onchange="[^"]*"/g, '');

  // Patch 4: the send button starts disabled - remove disabled attr so it works
  // (updateSend() will manage it after the textarea has content)
  html = html.replace(/(<button[^>]+id="send-btn"[^>]+)\bdisabled\b/, '$1');

  // Patch 5: add placeholder where extension.js will inject the handlers script
  html = html.replace('</body>', '<!-- VSC_HANDLERS_PLACEHOLDER -->\n</body>');

  fs.writeFileSync(OUT_FILE, html, 256);
  console.log('\n media/chat.html written (' + html.length + ' bytes)');
  console.log('\nNext steps:');
  console.log('  npm install');
  console.log('  vsce package');
  console.log('  code --install-extension ooumph-ai-chat-1.0.0.vsix');
  console.log('');
});

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
