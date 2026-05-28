// Ooumph AI Chat -- VS Code Extension
// extension.js
// Full VS Code integration: reads open files, applies AI edits, sends context.

const vscode = require('vscode');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const SOURCE_URL      = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const SECRET_ENDPOINT = 'ooumph.azureEndpoint';
const SECRET_KEY      = 'ooumph.azureKey';

let panel;
let sidebarView;   // reference to sidebar webview view

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

  // Push active-editor context whenever user switches files
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      const ctx = getEditorContext();
      if (sidebarView) postToWebview(sidebarView.webview, { type: 'vscContext', ...ctx });
      if (panel)       postToWebview(panel.webview,       { type: 'vscContext', ...ctx });
    })
  );

  // Push context on selection change too
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      const ctx = getEditorContext();
      if (sidebarView) postToWebview(sidebarView.webview, { type: 'vscContext', ...ctx });
      if (panel)       postToWebview(panel.webview,       { type: 'vscContext', ...ctx });
    })
  );

  // Command: open chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('ooumph.openChat', async () => {
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
      wireMessageHandler(panel.webview, context);
      panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
    })
  );

  // Command: set Azure credentials
  context.subscriptions.push(
    vscode.commands.registerCommand('ooumph.setCredentials', async () => {
      const endpoint = await vscode.window.showInputBox({
        title: 'Ooumph — Azure Endpoint',
        prompt: 'Paste your Azure OpenAI endpoint URL',
        placeHolder: 'https://YOUR-RESOURCE.openai.azure.com/',
        value: (await context.secrets.get(SECRET_ENDPOINT)) || '',
        ignoreFocusOut: true
      });
      if (endpoint === undefined) return;

      const key = await vscode.window.showInputBox({
        title: 'Ooumph — Azure API Key',
        prompt: 'Paste your Azure OpenAI API key',
        placeHolder: 'Key...',
        password: true,
        ignoreFocusOut: true
      });
      if (key === undefined) return;

      await context.secrets.store(SECRET_ENDPOINT, endpoint.trim());
      await context.secrets.store(SECRET_KEY, key.trim());
      bustCache(context);
      vscode.window.showInformationMessage('Ooumph: credentials saved. Reloading chat...');

      const reload = async (wv) => {
        wv.html = getLoadingHtml();
        try { wv.html = await buildWebviewHtml(wv, context); wireMessageHandler(wv, context); }
        catch (e) { wv.html = getErrorHtml(e.message); }
      };
      if (panel)       reload(panel.webview);
      if (sidebarView) reload(sidebarView.webview);
    })
  );

  // Prompt for credentials on first install
  context.secrets.get(SECRET_KEY).then(k => {
    if (!k) {
      vscode.window.showInformationMessage(
        'Ooumph AI Chat: set your Azure credentials to start chatting.',
        'Set Credentials'
      ).then(sel => {
        if (sel === 'Set Credentials')
          vscode.commands.executeCommand('ooumph.setCredentials');
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Message handler: webview → extension host
// ---------------------------------------------------------------------------
function wireMessageHandler(webview, context) {
  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {

      // Webview requests current editor context
      case 'getContext': {
        const ctx = getEditorContext();
        postToWebview(webview, { type: 'vscContext', ...ctx });
        break;
      }

      // Apply a code block to the active editor
      case 'applyEdit': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage('Ooumph: no active editor to apply to.');
          break;
        }
        await editor.edit(eb => {
          const sel = editor.selection;
          if (!sel.isEmpty) {
            eb.replace(sel, msg.code);
          } else {
            eb.replace(
              new vscode.Range(0, 0, editor.document.lineCount, 0),
              msg.code
            );
          }
        });
        postToWebview(webview, {
          type: 'applyDone',
          file: path.basename(editor.document.fileName)
        });
        vscode.window.showInformationMessage(
          'Ooumph: applied to ' + path.basename(editor.document.fileName)
        );
        break;
      }

      // Insert code at cursor position
      case 'insertAtCursor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) break;
        await editor.edit(eb => {
          eb.insert(editor.selection.active, msg.code);
        });
        vscode.window.showInformationMessage('Ooumph: inserted at cursor.');
        break;
      }

      // Open a file from workspace
      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: false
        });
        if (uris && uris[0]) {
          const content = fs.readFileSync(uris[0].fsPath, 'utf8');
          const fname   = path.basename(uris[0].fsPath);
          postToWebview(webview, { type: 'fileContent', fileName: fname, content });
        }
        break;
      }

      // Read all open editor tabs
      case 'getOpenFiles': {
        const files = vscode.workspace.textDocuments
          .filter(d => !d.isUntitled && d.uri.scheme === 'file')
          .map(d => ({
            fileName: path.basename(d.fileName),
            fullPath: d.fileName,
            language: d.languageId,
            content:  d.getText()
          }));
        postToWebview(webview, { type: 'openFiles', files });
        break;
      }
    }
  });
}

function postToWebview(webview, data) {
  try { webview.postMessage(data); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Get current editor context (file + selection)
// ---------------------------------------------------------------------------
function getEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { fileName: '', language: '', content: '', selection: '', hasContext: false };

  const doc       = editor.document;
  const sel       = editor.selection;
  const selText   = doc.getText(sel);
  const fullText  = doc.getText();

  return {
    hasContext: true,
    fileName:  path.basename(doc.fileName),
    fullPath:  doc.fileName,
    language:  doc.languageId,
    selection: selText,
    content:   fullText.length > 15000
      ? fullText.slice(0, 15000) + '\n... [truncated]'
      : fullText,
    lineCount: doc.lineCount,
    cursorLine: sel.active.line + 1
  };
}

// ---------------------------------------------------------------------------
// Sidebar provider
// ---------------------------------------------------------------------------
class OoumphViewProvider {
  static viewType = 'ooumph.chatView';
  constructor(ctx) { this._ctx = ctx; }

  async resolveWebviewView(v) {
    sidebarView = v;
    v.webview.options = getWebviewOptions(this._ctx.extensionUri);
    v.webview.html = getLoadingHtml();
    try {
      v.webview.html = await buildWebviewHtml(v.webview, this._ctx);
    } catch (e) {
      v.webview.html = getErrorHtml(e.message);
    }
    wireMessageHandler(v.webview, this._ctx);
    v.onDidDispose(() => { sidebarView = undefined; });
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

  const endpoint = (await context.secrets.get(SECRET_ENDPOINT)) || '';
  const key      = (await context.secrets.get(SECRET_KEY))      || '';
  html = injectCredentials(html, endpoint, key);

  return injectSecurityAndHandlers(webview, html);
}

// ---------------------------------------------------------------------------
// Inject credentials
// ---------------------------------------------------------------------------
function injectCredentials(html, endpoint, key) {
  const script =
    '<script id="ooumph-creds">' +
    'window.__OOUMPH_ENDPOINT__=' + JSON.stringify(endpoint) + ';' +
    'window.__OOUMPH_KEY__=' + JSON.stringify(key) + ';' +
    '<\/script>';
  return html.replace('<body', script + '\n<body');
}

// ---------------------------------------------------------------------------
// HTML patching
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
// Inject CSP + nonce + handler script
// ---------------------------------------------------------------------------
function injectSecurityAndHandlers(webview, html) {
  const nonce = crypto.randomBytes(16).toString('base64');

  html = html.replace(/<script>/g, '<script nonce="' + nonce + '">');
  html = html.replace('<script id="ooumph-creds">', '<script nonce="' + nonce + '" id="ooumph-creds">');

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
// Handler script — event wiring + full VS Code bridge
// ---------------------------------------------------------------------------
function buildHandlerScript(nonce) {
  const s = [];
  s.push('<script nonce="' + nonce + '">');
  s.push('(function() {');
  s.push('  "use strict";');

  // VS Code API bridge
  s.push('  var vscApi = (function() {');
  s.push('    try { return acquireVsCodeApi(); } catch(e) { return null; }');
  s.push('  })();');
  s.push('');
  s.push('  var editorCtx = { hasContext: false, fileName: "", language: "", content: "", selection: "" };');
  s.push('  var contextEnabled = true;');
  s.push('');

  // Listen for messages FROM extension host
  s.push('  window.addEventListener("message", function(event) {');
  s.push('    var msg = event.data;');
  s.push('    if (!msg || !msg.type) return;');
  s.push('    if (msg.type === "vscContext") {');
  s.push('      editorCtx = msg;');
  s.push('      updateCtxBar();');
  s.push('    }');
  s.push('    if (msg.type === "applyDone") {');
  s.push('      showVscNotif("Applied to " + msg.file + " ✓");');
  s.push('    }');
  s.push('    if (msg.type === "fileContent") {');
  s.push('      appendFileToInput(msg.fileName, msg.content);');
  s.push('    }');
  s.push('    if (msg.type === "openFiles") {');
  s.push('      appendOpenFilesToInput(msg.files);');
  s.push('    }');
  s.push('  });');
  s.push('');

  // Context bar UI
  s.push('  function updateCtxBar() {');
  s.push('    var bar = document.getElementById("ooumph-ctx-bar");');
  s.push('    if (!bar) return;');
  s.push('    if (editorCtx.hasContext) {');
  s.push('      bar.style.display = "flex";');
  s.push('      var label = document.getElementById("ooumph-ctx-label");');
  s.push('      if (label) {');
  s.push('        var txt = editorCtx.fileName + " (" + editorCtx.language + ")";');
  s.push('        if (editorCtx.selection) txt += " — selection";');
  s.push('        label.textContent = txt;');
  s.push('      }');
  s.push('    } else {');
  s.push('      bar.style.display = "none";');
  s.push('    }');
  s.push('  }');
  s.push('');

  // Notification helper
  s.push('  function showVscNotif(text) {');
  s.push('    var n = document.createElement("div");');
  s.push('    n.textContent = text;');
  s.push('    n.style.cssText = "position:fixed;bottom:70px;left:50%;transform:translateX(-50%);' +
         'background:#2a7a2a;color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;' +
         'z-index:9999;pointer-events:none;";');
  s.push('    document.body.appendChild(n);');
  s.push('    setTimeout(function() { n.remove(); }, 2500);');
  s.push('  }');
  s.push('');

  // Append file content to input
  s.push('  function appendFileToInput(fname, content) {');
  s.push('    var inp = document.getElementById("input");');
  s.push('    if (!inp) return;');
  s.push('    inp.value += (inp.value ? "\\n" : "") +');
  s.push('      "```\\n" + content.slice(0, 8000) + "\\n```";');
  s.push('    if (typeof autoResize === "function") autoResize(inp);');
  s.push('    if (typeof updateSend === "function") updateSend();');
  s.push('  }');
  s.push('');

  s.push('  function appendOpenFilesToInput(files) {');
  s.push('    var inp = document.getElementById("input");');
  s.push('    if (!inp) return;');
  s.push('    var block = files.slice(0, 3).map(function(f) {');
  s.push('      return "**" + f.fileName + "**\\n```" + f.language + "\\n" +');
  s.push('        f.content.slice(0, 4000) + "\\n```";');
  s.push('    }).join("\\n\\n");');
  s.push('    inp.value += (inp.value ? "\\n\\n" : "") + block;');
  s.push('    if (typeof autoResize === "function") autoResize(inp);');
  s.push('    if (typeof updateSend === "function") updateSend();');
  s.push('  }');
  s.push('');

  // Add "Apply" buttons to code blocks in AI messages
  s.push('  function addApplyButtons(root) {');
  s.push('    (root || document).querySelectorAll("pre code").forEach(function(block) {');
  s.push('      if (block.dataset.vsApply) return;');
  s.push('      block.dataset.vsApply = "1";');
  s.push('      var wrap = document.createElement("div");');
  s.push('      wrap.style.cssText = "display:flex;gap:6px;margin:4px 0 2px;";');
  // Apply button
  s.push('      var applyBtn = document.createElement("button");');
  s.push('      applyBtn.textContent = "⚡ Apply to Editor";');
  s.push('      applyBtn.style.cssText = "padding:3px 9px;background:#c96442;color:#fff;' +
         'border:none;border-radius:4px;cursor:pointer;font-size:11px;";');
  s.push('      applyBtn.onclick = function() {');
  s.push('        if (!vscApi) return showVscNotif("No VS Code API");');
  s.push('        vscApi.postMessage({ type: "applyEdit", code: block.textContent });');
  s.push('      };');
  // Insert at cursor button
  s.push('      var insertBtn = document.createElement("button");');
  s.push('      insertBtn.textContent = "↵ Insert at Cursor";');
  s.push('      insertBtn.style.cssText = "padding:3px 9px;background:#383838;color:#ccc;' +
         'border:1px solid rgba(255,255,255,0.15);border-radius:4px;cursor:pointer;font-size:11px;";');
  s.push('      insertBtn.onclick = function() {');
  s.push('        if (!vscApi) return showVscNotif("No VS Code API");');
  s.push('        vscApi.postMessage({ type: "insertAtCursor", code: block.textContent });');
  s.push('      };');
  s.push('      wrap.appendChild(applyBtn);');
  s.push('      wrap.appendChild(insertBtn);');
  s.push('      block.parentNode.insertBefore(wrap, block);');
  s.push('    });');
  s.push('  }');
  s.push('');

  // MutationObserver — add Apply buttons as AI messages stream in
  s.push('  var observer = new MutationObserver(function(mutations) {');
  s.push('    mutations.forEach(function(m) {');
  s.push('      m.addedNodes.forEach(function(node) {');
  s.push('        if (node.nodeType === 1) addApplyButtons(node);');
  s.push('      });');
  s.push('    });');
  s.push('  });');
  s.push('  observer.observe(document.body, { childList: true, subtree: true });');
  s.push('');

  // Inject context bar above compose area
  s.push('  function injectCtxBar() {');
  s.push('    if (document.getElementById("ooumph-ctx-bar")) return;');
  s.push('    var compose = document.querySelector(".compose") || document.querySelector("#compose");');
  s.push('    if (!compose) return;');
  s.push('    var bar = document.createElement("div");');
  s.push('    bar.id = "ooumph-ctx-bar";');
  s.push('    bar.style.cssText = "display:none;align-items:center;gap:6px;padding:4px 10px;' +
         'background:#232323;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#8a8a8a;";');
  // File label
  s.push('    var label = document.createElement("span");');
  s.push('    label.id = "ooumph-ctx-label";');
  s.push('    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";');
  // Toggle button
  s.push('    var toggle = document.createElement("button");');
  s.push('    toggle.style.cssText = "padding:2px 7px;border-radius:3px;font-size:10px;' +
         'background:#c96442;color:#fff;border:none;cursor:pointer;flex-shrink:0;";');
  s.push('    toggle.textContent = "Context ON";');
  s.push('    toggle.onclick = function() {');
  s.push('      contextEnabled = !contextEnabled;');
  s.push('      toggle.textContent = contextEnabled ? "Context ON" : "Context OFF";');
  s.push('      toggle.style.background = contextEnabled ? "#c96442" : "#555";');
  s.push('    };');
  // Attach file button
  s.push('    var attachBtn = document.createElement("button");');
  s.push('    attachBtn.textContent = "📂 Add File";');
  s.push('    attachBtn.style.cssText = "padding:2px 7px;border-radius:3px;font-size:10px;' +
         'background:#2a2a2a;color:#ccc;border:1px solid rgba(255,255,255,0.15);cursor:pointer;flex-shrink:0;";');
  s.push('    attachBtn.onclick = function() {');
  s.push('      if (vscApi) vscApi.postMessage({ type: "openFile" });');
  s.push('    };');
  s.push('    bar.appendChild(label);');
  s.push('    bar.appendChild(toggle);');
  s.push('    bar.appendChild(attachBtn);');
  s.push('    compose.parentNode.insertBefore(bar, compose);');
  s.push('  }');
  s.push('');

  // Override send() to prepend editor context
  s.push('  function patchSend() {');
  s.push('    var orig = window.send;');
  s.push('    if (!orig || window.__ooumphSendPatched) return;');
  s.push('    window.__ooumphSendPatched = true;');
  s.push('    window.send = function() {');
  s.push('      if (contextEnabled && editorCtx.hasContext) {');
  s.push('        var inp = document.getElementById("input");');
  s.push('        if (inp && inp.value.trim()) {');
  s.push('          var ctx;');
  s.push('          if (editorCtx.selection) {');
  s.push('            ctx = "\\n\\n[VS Code: " + editorCtx.fileName + " — selected lines]\\n```" +');
  s.push('              editorCtx.language + "\\n" + editorCtx.selection + "\\n```";');
  s.push('          } else {');
  s.push('            ctx = "\\n\\n[VS Code: " + editorCtx.fileName + " (line " +');
  s.push('              editorCtx.cursorLine + ")]\\n```" + editorCtx.language + "\\n" +');
  s.push('              editorCtx.content + "\\n```";');
  s.push('          }');
  s.push('          inp.value = inp.value + ctx;');
  s.push('        }');
  s.push('      }');
  s.push('      orig.apply(this, arguments);');
  s.push('    };');
  s.push('  }');
  s.push('');

  // Main wire function
  s.push('  function wire() {');
  // Credentials
  s.push('    try { if(window.__OOUMPH_ENDPOINT__) AZURE_BASE = window.__OOUMPH_ENDPOINT__; } catch(e) {}');
  s.push('    try { if(window.__OOUMPH_KEY__)      AZURE_KEY  = window.__OOUMPH_KEY__;      } catch(e) {}');
  // Original button handlers
  s.push('    function on(sel, evt, fn) {');
  s.push('      var el = typeof sel === "string" ? document.querySelector(sel) : sel;');
  s.push('      if (el) el.addEventListener(evt, fn);');
  s.push('    }');
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
  // VS Code bridge setup
  s.push('    injectCtxBar();');
  s.push('    patchSend();');
  s.push('    addApplyButtons();');
  // Request initial context from extension host
  s.push('    if (vscApi) vscApi.postMessage({ type: "getContext" });');
  s.push('  }');
  s.push('');
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
// Cache helpers
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

function bustCache(context) {
  try { fs.unlinkSync(getCachePath(context)); } catch (_) {}
}

function getCachePath(context) {
  return path.join(context.globalStorageUri.fsPath, 'chat.html');
}

// ---------------------------------------------------------------------------
// HTTP download
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
    '(<kbd>Ctrl+Shift+P</kbd> then <em>Developer: Reload Window</em>).</p>' +
    '</body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
