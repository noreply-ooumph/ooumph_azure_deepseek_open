// Ooumph AI Chat -- VS Code Extension
// extension.js
//
// Fetches chat HTML from GitHub Pages on demand — no build step required.
// Processes the HTML in-memory: strips inline handlers, adds nonce-based CSP,
// and re-attaches all event listeners via addEventListener inside a nonce script.

const vscode = require('vscode');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const SOURCE_URL = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';

let panel;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
function activate(context) {
  const provider = new OoumphViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OoumphViewProvider.viewType, provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const cmd = vscode.commands.registerCommand('ooumph.openChat', async () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
    panel = vscode.window.createWebviewPanel(
      'ooumphChat', 'Ooumph AI Chat',
      vscode.ViewColumn.Beside,
      getWebviewOptions(context.extensionUri)
    );
    panel.webview.html = getLoadingHtml();
    try {
      panel.webview.html = await buildWebviewHtml(panel.webview, context);
    } catch (e) {
      panel.webview.html = getErrorHtml(e.message);
    }
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });
  context.subscriptions.push(cmd);
}

// ---------------------------------------------------------------------------
// Sidebar provider
// ---------------------------------------------------------------------------
class OoumphViewProvider {
  static viewType = 'ooumph.chatView';
  constructor(ctx) { this._ctx = ctx; }

  async resolveWebviewView(v) {
    v.webview.options = getWebviewOptions(this._ctx.extensionUri);
    v.webview.html = getLoadingHtml();
    try {
      v.webview.html = await buildWebviewHtml(v.webview, this._ctx);
    } catch (e) {
      v.webview.html = getErrorHtml(e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Core: fetch + patch + nonce-wrap
// ---------------------------------------------------------------------------
async function buildWebviewHtml(webview, context) {
  let html = await loadCached(context);
  if (!html) {
    const raw = await download(SOURCE_URL);
    html = patchHtml(raw);
    saveCache(context, html).catch(() => {});
  }
  return injectSecurityAndHandlers(webview, html);
}

// ---------------------------------------------------------------------------
// HTML patching (same transforms as build.js)
// ---------------------------------------------------------------------------
function patchHtml(html) {
  html = html.replace(/<script>!function\(\)[^<]+_ov[^<]+<\/script>/, '<!-- version-check removed -->');
  html = html.replace(/\bconst (AZURE_BASE\s*=)/, 'let   $1');
  html = html.replace(/\bconst (AZURE_KEY\s*=)/,  'let   $1');
  html = html.replace(/(let\s+AZURE_BASE\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/(let\s+AZURE_KEY\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/\s*onclick="[^"]*"/g,   '');
  html = html.replace(/\s*onkeydown="[^"]*"/g, '');
  html = html.replace(/\s*oninput="[^"]*"/g,   '');
  html = html.replace(/\s*onchange="[^"]*"/g,  '');
  html = html.replace(/(<button[^>]+id="send-btn"[^>]+)\bdisabled\b/, '$1');
  html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, '<!-- VSC_HANDLERS_PLACEHOLDER -->\n</body>');
  return html;
}

// ---------------------------------------------------------------------------
// Inject CSP meta tag + nonce + handler script
// ---------------------------------------------------------------------------
function injectSecurityAndHandlers(webview, html) {
  const nonce = crypto.randomBytes(16).toString('base64');

  html = html.replace(/<script>/g, '<script nonce="' + nonce + '">');

  const cspParts = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "' " + webview.cspSource +
      " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline' " + webview.cspSource +
      " https://cdnjs.cloudflare.com",
    "font-src https:",
    "img-src data: https: " + webview.cspSource,
    "connect-src https:"
  ];
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="' +
    cspParts.join('; ') + '">';
  html = html.replace('<head>', '<head>\n  ' + cspMeta);

  const handlerScript = buildHandlerScript(nonce);
  if (html.includes('<!-- VSC_HANDLERS_PLACEHOLDER -->')) {
    html = html.replace('<!-- VSC_HANDLERS_PLACEHOLDER -->', handlerScript);
  } else {
    html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, handlerScript + '\n</body>');
  }
  return html;
}

// ---------------------------------------------------------------------------
// Event-handler re-attachment script
// ---------------------------------------------------------------------------
function buildHandlerScript(nonce) {
  const s = [];
  s.push('<script nonce="' + nonce + '">');
  s.push('(function() {');
  s.push('  "use strict";');
  s.push('  function on(sel, evt, fn) {');
  s.push('    var el = typeof sel === "string" ? document.querySelector(sel) : sel;');
  s.push('    if (el) el.addEventListener(evt, fn);');
  s.push('  }');
  s.push('  function wire() {');
  s.push('    on(".topbar-toggle", "click", function() { toggleSidebar(false); });');
  s.push('    on("#sb-overlay",    "click", function() { toggleSidebar(); });');
  s.push('    on(".btn-new",        "click", function() { newChat(); });');
  s.push('    on("#tab-chats",      "click", function() { switchSbTab("chats"); });');
  s.push('    on("#tab-graphify",   "click", function() { switchSbTab("graphify"); });');
  s.push('    on("#search", "input", function() { renderChatList(); });');
  s.push('    on("#model-pill", "click", function() { toggleModelDrop(); });');
  s.push('    var icons = document.querySelectorAll(".topbar-icon");');
  s.push('    if (icons[0]) icons[0].addEventListener("click", function() { openGhModal(); });');
  s.push('    if (icons[1]) icons[1].addEventListener("click", function() { openInstModal(); });');
  s.push('    if (icons[2]) icons[2].addEventListener("click", function() { showHelp(); });');
  s.push('    on("#input", "keydown", function(e) { onKey(e); });');
  s.push('    on("#input", "input",   function() { autoResize(this); updateSend(); });');
  s.push('    on("#send-btn", "click", function() { send(); });');
  s.push('    on(".compose-btn:not(#sparkle-btn)", "click", function() {');
  s.push('      var fi = document.getElementById("file-input");');
  s.push('      if (fi) fi.click();');
  s.push('    });');
  s.push('    on("#sparkle-btn", "click", function() { toggleTray(); });');
  s.push('    on("#file-input", "change", function() { handleFiles(this.files); });');
  s.push('    on(".btn-add-skill", "click", function() { openSkillPanel(null); });');
  s.push('    on(".topbar-icon.tray-close", "click", function() { closeTray(); });');
  s.push('    on("#btn-del-skill", "click", function() { deleteSkillPanel(); });');
  s.push('    var instBtns = document.querySelectorAll(".inst-modal button");');
  s.push('    if (instBtns[0]) instBtns[0].addEventListener("click", function() { closeInstModal(); });');
  s.push('    if (instBtns[1]) instBtns[1].addEventListener("click", function() { saveInst(); });');
  s.push('    var ghBtns = document.querySelectorAll(".gh-modal button");');
  s.push('    if (ghBtns[0]) ghBtns[0].addEventListener("click", function() { closeGhModal(); });');
  s.push('    if (ghBtns[1]) ghBtns[1].addEventListener("click", function() { saveGhSettings(); });');
  s.push('    on(".ctx-rename", "click", function() { ctxRename(); });');
  s.push('    on(".ctx-star",   "click", function() { ctxStar(); });');
  s.push('    on(".ctx-delete", "click", function() { ctxDelete(); });');
  s.push('  }');
  s.push('  if (document.readyState === "loading") {');
  s.push('    document.addEventListener("DOMContentLoaded", wire);');
  s.push('  } else {');
  s.push('    wire();');
  s.push('  }');
  s.push('})();');
  s.push('<\/script>');
  return s.join('\n');
}

// ---------------------------------------------------------------------------
// Cache helpers (globalStorageUri — survives extension updates)
// ---------------------------------------------------------------------------
async function loadCached(context) {
  try {
    const p = getCachePath(context);
    if (!fs.existsSync(p)) return null;
    const ageHours = (Date.now() - fs.statSync(p).mtimeMs) / 3600000;
    if (ageHours > 24) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (_) { return null; }
}

async function saveCache(context, html) {
  const dir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getCachePath(context), html, 'utf8');
}

function getCachePath(context) {
  return path.join(context.globalStorageUri.fsPath, 'chat.html');
}

// ---------------------------------------------------------------------------
// HTTP download with redirect follow
// ---------------------------------------------------------------------------
function download(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, hops) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).href;
          return follow(next, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

// ---------------------------------------------------------------------------
// Helper HTMLs
// ---------------------------------------------------------------------------
function getWebviewOptions(extensionUri) {
  return { enableScripts: true };
}

function getLoadingHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>body{background:#1a1a1a;color:#ccc;font-family:system-ui;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.dot{animation:blink 1.2s infinite}.dot:nth-child(2){animation-delay:.4s}' +
    '.dot:nth-child(3){animation-delay:.8s}' +
    '@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}</style></head>' +
    '<body><span>Loading Ooumph</span>' +
    '<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>' +
    '</body></html>';
}

function getErrorHtml(msg) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:system-ui;padding:24px;color:#ccc;background:#1a1a1a">' +
    '<strong style="color:#e05252">Failed to load Ooumph AI Chat</strong><br><br>' +
    '<code style="font-size:12px">' + (msg || 'Unknown error') + '</code><br><br>' +
    '<p style="font-size:13px">Check your internet connection and reload ' +
    '(<kbd>Ctrl+Shift+P</kbd> → <em>Developer: Reload Window</em>).</p>' +
    '</body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
