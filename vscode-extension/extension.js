// Ooumph AI Chat -- VS Code Extension
// extension.js
//
// Serves media/chat.html locally with proper nonce-based CSP.
// All event handlers are re-attached via addEventListener() in a
// nonce-tagged <script> block, bypassing VS Code's CSP restrictions.

const vscode = require('vscode');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

let panel;

function activate(context) {
  const provider = new OoumphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OoumphViewProvider.viewType, provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const cmd = vscode.commands.registerCommand('ooumph.openChat', () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
    panel = vscode.window.createWebviewPanel(
      'ooumphChat', 'Ooumph AI Chat',
      vscode.ViewColumn.Beside,
      getWebviewOptions(context.extensionUri)
    );
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });
  context.subscriptions.push(cmd);
}

class OoumphViewProvider {
  static viewType = 'ooumph.chatView';
  constructor(u) { this._uri = u; }
  resolveWebviewView(v) {
    v.webview.options = getWebviewOptions(this._uri);
    v.webview.html    = getWebviewContent(v.webview, this._uri);
  }
}

function getWebviewOptions(extensionUri) {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
  };
}

function getWebviewContent(webview, extensionUri) {
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'chat.html');
  let html;
  try { html = fs.readFileSync(htmlPath.fsPath, 'utf8'); }
  catch (_) { return getFallbackHtml(); }

  // Generate a unique nonce for this page load.
  // VS Code requires nonces on all <script> tags.
  const nonce = crypto.randomBytes(16).toString('base64');

  // Add nonce to the app's existing inline <script> block.
  // The main script block is <script> (no src, no attributes).
  html = html.replace(/<script>/, '<script nonce="' + nonce + '">');

  // Also add nonce to the highlight.js inline script (if any)
  html = html.replace(/<script>\s*hljs/, '<script nonce="' + nonce + '">\nhljs');

  // Build the CSP meta tag using webview.cspSource + nonce.
  // - nonce allows our nonce-tagged <script> blocks
  // - webview.cspSource allows local extension resources
  // - CDN hosts allow highlight.js and marked.js
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

  // Build the addEventListener handler script (nonce-tagged).
  // This re-attaches all the onclick/onkeydown/oninput handlers
  // that build.js stripped from the HTML attributes.
  const handlerScript = buildHandlerScript(nonce);
  // Inject handlers: try placeholder first, fall back to </body>
  if (html.includes('<!-- VSC_HANDLERS_PLACEHOLDER -->')) {
    html = html.replace('<!-- VSC_HANDLERS_PLACEHOLDER -->', handlerScript);
  } else {
    // Replace LAST </body> - first is inside a JS string in export function!
    html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, handlerScript + '\n</body>');
  }

  return html;
}

function buildHandlerScript(nonce) {
  const s = [];
  s.push('<script nonce="' + nonce + '">');
  s.push('(function() {');
  s.push('  function on(sel, evt, fn) {');
  s.push('    var el = typeof sel === "string" ? document.querySelector(sel) : sel;');
  s.push('    if (el) el.addEventListener(evt, fn);');
  s.push('  }');
  s.push('  function onAll(sel, evt, fn) {');
  s.push('    document.querySelectorAll(sel).forEach(function(el) {');
  s.push('      el.addEventListener(evt, fn);');
  s.push('    });');
  s.push('  }');
  s.push('');
  // Ã¢ÂÂÃ¢ÂÂ Sidebar / navigation Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on(".topbar-toggle", "click", function() { toggleSidebar(false); });');
  s.push('  on("#sb-overlay",    "click", function() { toggleSidebar(); });');
  s.push('  on(".btn-new",        "click", function() { newChat(); });');
  s.push('  on("#tab-chats",      "click", function() { switchSbTab("chats"); });');
  s.push('  on("#tab-graphify",   "click", function() { switchSbTab("graphify"); });');
  // Ã¢ÂÂÃ¢ÂÂ Search Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on("#search", "input", function() { renderChatList(); });');
  // Ã¢ÂÂÃ¢ÂÂ Model dropdown Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on("#model-pill", "click", function() { toggleModelDrop(); });');
  // Ã¢ÂÂÃ¢ÂÂ Topbar icons Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  var icons = document.querySelectorAll(".topbar-icon");');
  s.push('  if (icons[0]) icons[0].addEventListener("click", function() { openGhModal(); });');
  s.push('  if (icons[1]) icons[1].addEventListener("click", function() { openInstModal(); });');
  s.push('  if (icons[2]) icons[2].addEventListener("click", function() { showHelp(); });');
  // Ã¢ÂÂÃ¢ÂÂ Chat input / send Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on("#input", "keydown", function(e) { onKey(e); });');
  s.push('  on("#input", "input",   function() { autoResize(this); updateSend(); });');
  s.push('  on("#send-btn", "click", function() { send(); });');
  // Ã¢ÂÂÃ¢ÂÂ Compose bar buttons Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  // Attach button uses first compose-btn (attach/paperclip)');
  s.push('  on(".compose-btn:not(#sparkle-btn)", "click", function() { document.getElementById("file-input").click(); });');
  s.push('  on("#sparkle-btn", "click", function() { toggleTray(); });');
  // ââ File input change handler (stripped by build.js, re-attached here) âââ
  s.push('  on("#file-input", "change", function() { handleFiles(this.files); });');
  // Ã¢ÂÂÃ¢ÂÂ Skills tray Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on(".btn-add-skill", "click", function() { openSkillPanel(null); });');
  s.push('  on(".topbar-icon.tray-close", "click", function() { closeTray(); });');
  // Ã¢ÂÂÃ¢ÂÂ Skill panel Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on("#btn-del-skill", "click", function() { deleteSkillPanel(); });');
  // Ã¢ÂÂÃ¢ÂÂ Instructions modal Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  var instBtns = document.querySelectorAll(".inst-modal button");');
  s.push('  if (instBtns[0]) instBtns[0].addEventListener("click", function() { closeInstModal(); });');
  s.push('  if (instBtns[1]) instBtns[1].addEventListener("click", function() { saveInst(); });');
  // Ã¢ÂÂÃ¢ÂÂ GitHub Gist modal Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  var ghBtns = document.querySelectorAll(".gh-modal button");');
  s.push('  if (ghBtns[0]) ghBtns[0].addEventListener("click", function() { closeGhModal(); });');
  s.push('  if (ghBtns[1]) ghBtns[1].addEventListener("click", function() { saveGhSettings(); });');
  // Ã¢ÂÂÃ¢ÂÂ Context menu Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  s.push('  on(".ctx-rename", "click", function() { ctxRename(); });');
  s.push('  on(".ctx-star",   "click", function() { ctxStar(); });');
  s.push('  on(".ctx-delete", "click", function() { ctxDelete(); });');
  s.push('})();');
  s.push('<\/script>');
  return s.join('\n');
}

function getFallbackHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<p style="font-family:system-ui;padding:24px;color:#ccc;background:#1a1a1a">' +
    '<strong>media/chat.html not found.</strong><br>' +
    'Run: <code>node build.js</code> then reload VS Code.</p></body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
