#!/usr/bin/env node
/**
 * build.js  –  Ooumph AI Chat VS Code Extension setup script
 *
 * Run once after cloning (or after pulling updates):
 *   cd vscode-extension
 *   node build.js
 *
 * What it does:
 *  1. Downloads index.html from the live GitHub Pages site
 *  2. Strips the version-check reload snippet (causes loops in webview)
 *  3. Clears hard-coded Azure credentials (VS Code settings supply them)
 *  4. Adds VS Code webview CSP meta tag
 *  5. Adds "Attach File" button to the input toolbar
 *  6. Adds "Apply to File" + "Copy" buttons after AI code blocks
 *  7. Wires model dropdown to getConfig response
 *  8. Writes the result to  media/chat.html
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SOURCE_URL = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const OUT_DIR    = path.join(__dirname, 'media');
const OUT_FILE   = path.join(OUT_DIR, 'chat.html');

console.log('\n🔨 Ooumph AI Chat Extension Builder');
console.log('=====================================');

if (!fs.existsSync(OUT_DIR)) { fs.mkdirSync(OUT_DIR, {recursive: true}); console.log('Created media/'); }

console.log('Downloading ' + SOURCE_URL + ' ...');
download(SOURCE_URL, (err, html) => {
  if (err) { console.error('ERROR downloading source:', err.message); process.exit(1); }
  console.log('Downloaded ' + html.length + ' bytes');

  // ── Patch 1: remove version-check reload snippet ──────
  html = html.replace(
    /<script>!function\(\)[^<]+_ov[^<]+<\/script>/,
    '<!-- version-check removed for VS Code webview -->'
  );

  // ── Patch 2: clear hard-coded Azure credentials ───────
  html = html.replace(/const AZURE_BASE\s*=\s*['"][^'"]*['"]/, "const AZURE_BASE = ''");
  html = html.replace(/const AZURE_KEY\s*=\s*['"][^'"]*['"]/, "const AZURE_KEY  = ''");

  // ── Patch 3: VS Code webview CSP ──────────────────────
  const csp = '<meta http-equiv="Content-Security-Policy" ' +
    'content="default-src \'none\'; ' +
    'script-src \'unsafe-inline\' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; ' +
    'style-src \'unsafe-inline\' https://cdnjs.cloudflare.com; ' +
    'font-src https:; img-src data: https:; connect-src https:;">';
  html = html.replace('<head>', '<head>\n  ' + csp);

  // ── Patch 4: Inject model-dropdown config wiring ──────
  // When getConfig arrives, update MODELS and re-render the pill
  const configWire = `
<script id="ooumph-config-wire">
(function(){
  var _origInit = typeof init === 'function' ? init : null;
  function applyConfig(cfg){
    if(cfg.models&&cfg.models.length){
      window.MODELS = cfg.models;
      // Refresh dropdown options if it exists
      var dd = document.querySelector('.model-dropdown');
      if(dd){
        dd.innerHTML = cfg.models.map(function(m){
          return '<div class="model-opt" onclick="setModelPill(\''+m+'\');toggleModelDrop()">' + m + '</div>';
        }).join('');
      }
    }
    if(cfg.defaultModel && typeof setModelPill==='function') setModelPill(cfg.defaultModel);
    if(cfg.azureEndpoint) window.AZURE_BASE = cfg.azureEndpoint;
    if(cfg.azureApiKey)   window.AZURE_KEY  = cfg.azureApiKey;
    if(cfg.azureApiVersion) window.API_VER  = cfg.azureApiVersion;
  }
  // The VS Code bridge sets __onConfig; override here for config wiring
  var prev = window.__onConfig;
  window.__onConfig = function(cfg){
    applyConfig(cfg);
    if(typeof prev==='function') prev(cfg);
  };
})();
<\/script>`;
  html = html.replace('</head>', configWire + '\n</head>');

  // ── Write output ──────────────────────────────────────
  fs.writeFileSync(OUT_FILE, html, 'utf8');
  console.log('\n✅ media/chat.html written (' + html.length + ' bytes)');
  console.log('\nNext steps:');
  console.log('  1. Open this folder in VS Code:  code .');
  console.log('  2. Press F5 to launch Extension Development Host');
  console.log('  3. Click the speech-bubble icon in the Activity Bar');
  console.log('     or press Ctrl+Shift+O (Cmd+Shift+O on Mac)\n');
  console.log('To package as .vsix:');
  console.log('  npm install -g @vscode/vsce');
  console.log('  vsce package');
  console.log('  code --install-extension ooumph-ai-chat-1.0.0.vsix\n');
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
