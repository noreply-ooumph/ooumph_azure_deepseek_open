// Ooumph AI Chat -- VS Code Extension
// extension.js

const vscode = require('vscode');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const SOURCE_URL      = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const SECRET_ENDPOINT = 'ooumph.azureEndpoint';
const SECRET_KEY      = 'ooumph.azureKey';

let panel;
let sidebarView;

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

  // Push fresh context on file/selection switch
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => broadcastContext(context))
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => broadcastContext(context))
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

  // Prompt on first install
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

function broadcastContext(context) {
  const ctx = getEditorContext();
  if (sidebarView) postTo(sidebarView.webview, { type: 'vscContext', ...ctx });
  if (panel)       postTo(panel.webview,       { type: 'vscContext', ...ctx });
}

// ---------------------------------------------------------------------------
// Message handler: webview → extension host
// ---------------------------------------------------------------------------
function wireMessageHandler(webview, context) {
  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {

      case 'getContext':
        postTo(webview, { type: 'vscContext', ...getEditorContext() });
        break;

      // Return workspace file tree (relative paths only, no content)
      case 'getWorkspaceTree': {
        const tree = buildWorkspaceTree();
        postTo(webview, { type: 'workspaceTree', tree });
        break;
      }

      // Read specific file(s) by relative path
      case 'readFiles': {
        const results = [];
        for (const relPath of (msg.paths || [])) {
          try {
            const abs = resolveWorkspacePath(relPath);
            if (abs) {
              const content = fs.readFileSync(abs, 'utf8');
              results.push({ path: relPath, content, language: langFromExt(relPath) });
            }
          } catch (_) {}
        }
        postTo(webview, { type: 'fileContents', files: results });
        break;
      }

      // Read ALL open editor tabs
      case 'getOpenFiles': {
        const files = vscode.workspace.textDocuments
          .filter(d => !d.isUntitled && d.uri.scheme === 'file')
          .map(d => ({
            path:     vscode.workspace.asRelativePath(d.fileName),
            content:  d.getText(),
            language: d.languageId
          }));
        postTo(webview, { type: 'fileContents', files });
        break;
      }

      // Pick a file via OS dialog
      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: true
        });
        if (uris && uris.length) {
          const files = uris.map(u => ({
            path:     vscode.workspace.asRelativePath(u.fsPath),
            content:  fs.readFileSync(u.fsPath, 'utf8'),
            language: langFromExt(u.fsPath)
          }));
          postTo(webview, { type: 'fileContents', files });
        }
        break;
      }

      // Apply code to active editor (replace selection or whole file)
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
            const all = new vscode.Range(0, 0, editor.document.lineCount, 0);
            eb.replace(all, msg.code);
          }
        });
        postTo(webview, { type: 'applyDone', file: path.basename(editor.document.fileName) });
        vscode.window.showInformationMessage(
          'Ooumph: applied to ' + path.basename(editor.document.fileName)
        );
        break;
      }

      // Insert at cursor
      case 'insertAtCursor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) break;
        await editor.edit(eb => eb.insert(editor.selection.active, msg.code));
        vscode.window.showInformationMessage('Ooumph: inserted at cursor.');
        break;
      }

      // Create a new file in workspace
      case 'createFile': {
        const wf = vscode.workspace.workspaceFolders;
        if (!wf || !wf.length) break;
        const abs = path.join(wf[0].uri.fsPath, msg.filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, msg.content, 'utf8');
        const doc = await vscode.workspace.openTextDocument(abs);
        await vscode.window.showTextDocument(doc);
        postTo(webview, { type: 'createFileDone', path: msg.filePath });
        break;
      }
    }
  });
}

function postTo(webview, data) {
  try { webview.postMessage(data); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Editor context
// ---------------------------------------------------------------------------
function getEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { hasContext: false };
  const doc      = editor.document;
  const selText  = doc.getText(editor.selection);
  const fullText = doc.getText();
  return {
    hasContext:  true,
    fileName:    path.basename(doc.fileName),
    relPath:     vscode.workspace.asRelativePath(doc.fileName),
    language:    doc.languageId,
    selection:   selText,
    content:     fullText.length > 20000 ? fullText.slice(0, 20000) + '\n...[truncated]' : fullText,
    lineCount:   doc.lineCount,
    cursorLine:  editor.selection.active.line + 1
  };
}

// ---------------------------------------------------------------------------
// Workspace tree (paths only, no content)
// ---------------------------------------------------------------------------
function buildWorkspaceTree() {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return [];
  const root = wf[0].uri.fsPath;
  const results = [];
  const IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv',
    'dist', 'build', '.next', '.nuxt', 'coverage', '.pytest_cache']);
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (IGNORE.has(e.name)) continue;
      const relPath = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else results.push(relPath);
    }
  };
  walk(root, '');
  return results.slice(0, 500);  // cap at 500 files
}

function resolveWorkspacePath(relPath) {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return null;
  const abs = path.join(wf[0].uri.fsPath, relPath);
  return fs.existsSync(abs) ? abs : null;
}

function langFromExt(filePath) {
  const ext = path.extname(filePath).slice(1);
  const map = { js: 'javascript', ts: 'typescript', py: 'python', rs: 'rust',
    go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c',
    html: 'html', css: 'css', json: 'json', md: 'markdown', sh: 'bash',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', env: 'bash' };
  return map[ext] || ext || 'text';
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
// Build HTML
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

function injectCredentials(html, endpoint, key) {
  const script =
    '<script id="ooumph-creds">' +
    'window.__OOUMPH_ENDPOINT__=' + JSON.stringify(endpoint) + ';' +
    'window.__OOUMPH_KEY__=' + JSON.stringify(key) + ';' +
    '<\/script>';
  return html.replace('<body', script + '\n<body');
}

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

function injectSecurityAndHandlers(webview, html) {
  const nonce = crypto.randomBytes(16).toString('base64');
  html = html.replace(/<script>/g, '<script nonce="' + nonce + '">');
  html = html.replace('<script id="ooumph-creds">', '<script nonce="' + nonce + '" id="ooumph-creds">');
  const cspParts = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "' " + webview.cspSource +
      " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline' " + webview.cspSource + " https://cdnjs.cloudflare.com",
    "font-src https:",
    "img-src data: https: " + webview.cspSource,
    "connect-src https:"
  ];
  html = html.replace('<head>', '<head>\n  <meta http-equiv="Content-Security-Policy" content="' +
    cspParts.join('; ') + '">');
  const hs = buildHandlerScript(nonce);
  html = html.includes('<!-- VSC_HANDLERS_PLACEHOLDER -->')
    ? html.replace('<!-- VSC_HANDLERS_PLACEHOLDER -->', hs)
    : html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, hs + '\n</body>');
  return html;
}

// ---------------------------------------------------------------------------
// The bridge script — injected into webview
// ---------------------------------------------------------------------------
function buildHandlerScript(nonce) {
  const s = [];
  s.push('<script nonce="' + nonce + '">');
  s.push('(function() {');
  s.push('"use strict";');

  s.push('var vscApi = (function(){ try{ return acquireVsCodeApi(); }catch(e){ return null; } })();');
  s.push('var editorCtx = { hasContext:false };');
  s.push('var contextEnabled = true;');
  s.push('var workspaceTree = [];');
  s.push('var pendingFileRequests = {};');
  s.push('');

  // ── Messages from extension host ──────────────────────────────────────────
  s.push('window.addEventListener("message", function(ev) {');
  s.push('  var m = ev.data; if(!m||!m.type) return;');
  s.push('  if (m.type === "vscContext") { editorCtx = m; updateCtxBar(); }');
  s.push('  if (m.type === "applyDone") { showNotif("Applied to " + m.file + " ✓", "#2a7a2a"); }');
  s.push('  if (m.type === "createFileDone") { showNotif("Created " + m.path + " ✓", "#2a7a2a"); }');
  s.push('  if (m.type === "workspaceTree") {');
  s.push('    workspaceTree = m.tree;');
  s.push('    updateCtxBar();');
  s.push('  }');
  // File contents delivered — inject into the pending chat as a hidden system context
  s.push('  if (m.type === "fileContents" && m.files && m.files.length) {');
  s.push('    var block = m.files.map(function(f) {');
  s.push('      return "**" + f.path + "**\\n```" + f.language + "\\n" + f.content + "\\n```";');
  s.push('    }).join("\\n\\n---\\n\\n");');
  s.push('    var inp = document.getElementById("input");');
  s.push('    if (inp) {');
  s.push('      inp.value = (inp.value.trim() ? inp.value + "\\n\\n" : "") + block;');
  s.push('      if(typeof autoResize==="function") autoResize(inp);');
  s.push('      if(typeof updateSend==="function") updateSend();');
  s.push('      inp.focus();');
  s.push('    }');
  s.push('  }');
  s.push('});');
  s.push('');

  // ── Intercept fetch — inject context INVISIBLY into Azure API calls ────────
  s.push('(function() {');
  s.push('  var origFetch = window.fetch;');
  s.push('  window.fetch = function(url, opts) {');
  s.push('    try {');
  s.push('      var urlStr = (url || "").toString();');
  s.push('      var isAzure = urlStr.indexOf("openai.azure.com") !== -1 ||');
  s.push('                    (typeof AZURE_BASE !== "undefined" && AZURE_BASE && urlStr.indexOf(AZURE_BASE) !== -1);');
  s.push('      if (isAzure && contextEnabled && editorCtx.hasContext && opts && opts.body) {');
  s.push('        var body = JSON.parse(opts.body);');
  s.push('        if (body && Array.isArray(body.messages)) {');
  // Build context string
  s.push('          var ctxParts = [];');
  s.push('          ctxParts.push("=== VS Code Workspace Context ===");');
  s.push('          ctxParts.push("Active file: " + editorCtx.relPath +');
  s.push('            " (" + editorCtx.language + ", " + editorCtx.lineCount + " lines)");');
  s.push('          if (workspaceTree.length) {');
  s.push('            ctxParts.push("\\nWorkspace files:");');
  s.push('            ctxParts.push(workspaceTree.slice(0, 80).join("\\n"));');
  s.push('            if (workspaceTree.length > 80) ctxParts.push("...and " + (workspaceTree.length-80) + " more");');
  s.push('          }');
  s.push('          if (editorCtx.selection) {');
  s.push('            ctxParts.push("\\nSelected code in " + editorCtx.fileName + ":");');
  s.push('            ctxParts.push("```" + editorCtx.language + "\\n" + editorCtx.selection + "\\n```");');
  s.push('          } else {');
  s.push('            ctxParts.push("\\nCurrent file content (" + editorCtx.fileName + "):");');
  s.push('            ctxParts.push("```" + editorCtx.language + "\\n" + editorCtx.content + "\\n```");');
  s.push('          }');
  s.push('          ctxParts.push("\\nYou can read, edit, and create files in this workspace.");');
  s.push('          ctxParts.push("When the user asks to edit code, respond with complete corrected code blocks.");');
  // Insert as system message after any existing system messages
  s.push('          var sysMsg = { role: "system", content: ctxParts.join("\\n") };');
  s.push('          var idx = 0;');
  s.push('          while (idx < body.messages.length && body.messages[idx].role === "system") idx++;');
  s.push('          body.messages.splice(idx, 0, sysMsg);');
  s.push('          opts = Object.assign({}, opts, { body: JSON.stringify(body) });');
  s.push('        }');
  s.push('      }');
  s.push('    } catch(e) {}');
  s.push('    return origFetch.apply(this, arguments);');
  s.push('  };');
  s.push('})();');
  s.push('');

  // ── Apply buttons on code blocks ──────────────────────────────────────────
  s.push('function addApplyButtons(root) {');
  s.push('  (root || document).querySelectorAll("pre code").forEach(function(block) {');
  s.push('    if (block.dataset.vscDone) return;');
  s.push('    block.dataset.vscDone = "1";');
  s.push('    var row = document.createElement("div");');
  s.push('    row.style.cssText = "display:flex;gap:5px;margin:3px 0 2px;flex-wrap:wrap;";');
  s.push('    function mkBtn(label, bg, cb) {');
  s.push('      var b = document.createElement("button");');
  s.push('      b.textContent = label;');
  s.push('      b.style.cssText = "padding:2px 8px;border-radius:3px;font-size:11px;cursor:pointer;border:none;color:#fff;background:" + bg + ";";');
  s.push('      b.onclick = cb; return b;');
  s.push('    }');
  s.push('    row.appendChild(mkBtn("⚡ Apply to File", "#c96442", function() {');
  s.push('      if(vscApi) vscApi.postMessage({type:"applyEdit", code:block.textContent});');
  s.push('    }));');
  s.push('    row.appendChild(mkBtn("↵ Insert at Cursor", "#444", function() {');
  s.push('      if(vscApi) vscApi.postMessage({type:"insertAtCursor", code:block.textContent});');
  s.push('    }));');
  s.push('    block.parentNode.insertBefore(row, block);');
  s.push('  });');
  s.push('}');
  s.push('new MutationObserver(function(muts) {');
  s.push('  muts.forEach(function(m) {');
  s.push('    m.addedNodes.forEach(function(n) { if(n.nodeType===1) addApplyButtons(n); });');
  s.push('  });');
  s.push('}).observe(document.body, {childList:true, subtree:true});');
  s.push('');

  // ── Context bar above compose ──────────────────────────────────────────────
  s.push('function injectCtxBar() {');
  s.push('  if (document.getElementById("ooumph-ctx-bar")) return;');
  s.push('  var anchor = document.querySelector(".compose") || document.querySelector("#compose") || document.querySelector("form");');
  s.push('  if (!anchor) return;');
  s.push('  var bar = document.createElement("div");');
  s.push('  bar.id = "ooumph-ctx-bar";');
  s.push('  bar.style.cssText = "display:none;align-items:center;gap:5px;padding:3px 8px;font-size:11px;color:#888;background:#1e1e1e;border-top:1px solid rgba(255,255,255,0.07);flex-wrap:wrap;";');
  s.push('  var lbl = document.createElement("span");');
  s.push('  lbl.id = "ooumph-ctx-lbl";');
  s.push('  lbl.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";');
  // Toggle context
  s.push('  var tog = document.createElement("button");');
  s.push('  tog.id = "ooumph-ctx-tog";');
  s.push('  tog.textContent = "Context ON";');
  s.push('  tog.style.cssText = "padding:1px 6px;border-radius:3px;font-size:10px;border:none;cursor:pointer;background:#c96442;color:#fff;flex-shrink:0;";');
  s.push('  tog.onclick = function() {');
  s.push('    contextEnabled = !contextEnabled;');
  s.push('    tog.textContent = contextEnabled ? "Context ON" : "Context OFF";');
  s.push('    tog.style.background = contextEnabled ? "#c96442" : "#555";');
  s.push('  };');
  // Add file button
  s.push('  var addFile = document.createElement("button");');
  s.push('  addFile.textContent = "📂 Add File";');
  s.push('  addFile.style.cssText = "padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;";');
  s.push('  addFile.onclick = function() { if(vscApi) vscApi.postMessage({type:"openFile"}); };');
  // Add open tabs button
  s.push('  var addTabs = document.createElement("button");');
  s.push('  addTabs.textContent = "📋 Open Tabs";');
  s.push('  addTabs.style.cssText = "padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;";');
  s.push('  addTabs.onclick = function() { if(vscApi) vscApi.postMessage({type:"getOpenFiles"}); };');
  s.push('  bar.appendChild(lbl); bar.appendChild(tog); bar.appendChild(addFile); bar.appendChild(addTabs);');
  s.push('  anchor.parentNode.insertBefore(bar, anchor);');
  s.push('}');
  s.push('');

  s.push('function updateCtxBar() {');
  s.push('  var bar = document.getElementById("ooumph-ctx-bar");');
  s.push('  var lbl = document.getElementById("ooumph-ctx-lbl");');
  s.push('  if (!bar) return;');
  s.push('  if (editorCtx.hasContext) {');
  s.push('    bar.style.display = "flex";');
  s.push('    var t = editorCtx.fileName;');
  s.push('    if (editorCtx.selection) t += " — 🖍 selection";');
  s.push('    if (workspaceTree.length) t += "  |  " + workspaceTree.length + " files in workspace";');
  s.push('    if (lbl) lbl.textContent = t;');
  s.push('  }');
  s.push('}');
  s.push('');

  // Notification
  s.push('function showNotif(text, bg) {');
  s.push('  var n = document.createElement("div");');
  s.push('  n.textContent = text;');
  s.push('  n.style.cssText = "position:fixed;bottom:68px;left:50%;transform:translateX(-50%);' +
         'padding:5px 14px;border-radius:5px;font-size:12px;color:#fff;z-index:9999;pointer-events:none;background:" + (bg||"#444") + ";";');
  s.push('  document.body.appendChild(n);');
  s.push('  setTimeout(function(){n.remove();},2500);');
  s.push('}');
  s.push('');

  // ── wire() — runs at DOMContentLoaded ─────────────────────────────────────
  s.push('function wire() {');
  // Credentials
  s.push('  try{ if(window.__OOUMPH_ENDPOINT__) AZURE_BASE=window.__OOUMPH_ENDPOINT__; }catch(e){}');
  s.push('  try{ if(window.__OOUMPH_KEY__)      AZURE_KEY=window.__OOUMPH_KEY__;       }catch(e){}');
  // Standard button handlers
  s.push('  function on(sel,evt,fn){ var el=typeof sel==="string"?document.querySelector(sel):sel; if(el) el.addEventListener(evt,fn); }');
  s.push('  on(".topbar-toggle","click",function(){ toggleSidebar(false); });');
  s.push('  on("#sb-overlay","click",function(){ toggleSidebar(); });');
  s.push('  on(".btn-new","click",function(){ newChat(); });');
  s.push('  on("#tab-chats","click",function(){ switchSbTab("chats"); });');
  s.push('  on("#tab-graphify","click",function(){ switchSbTab("graphify"); });');
  s.push('  on("#search","input",function(){ renderChatList(); });');
  s.push('  on("#model-pill","click",function(){ toggleModelDrop(); });');
  s.push('  var icons=document.querySelectorAll(".topbar-icon");');
  s.push('  if(icons[0]) icons[0].addEventListener("click",function(){ openGhModal(); });');
  s.push('  if(icons[1]) icons[1].addEventListener("click",function(){ openInstModal(); });');
  s.push('  if(icons[2]) icons[2].addEventListener("click",function(){ showHelp(); });');
  s.push('  on("#input","keydown",function(e){ onKey(e); });');
  s.push('  on("#input","input",function(){ autoResize(this); updateSend(); });');
  s.push('  on("#send-btn","click",function(){ send(); });');
  s.push('  on(".compose-btn:not(#sparkle-btn)","click",function(){ var fi=document.getElementById("file-input"); if(fi) fi.click(); });');
  s.push('  on("#sparkle-btn","click",function(){ toggleTray(); });');
  s.push('  on("#file-input","change",function(){ handleFiles(this.files); });');
  s.push('  on(".btn-add-skill","click",function(){ openSkillPanel(null); });');
  s.push('  on(".topbar-icon.tray-close","click",function(){ closeTray(); });');
  s.push('  on("#btn-del-skill","click",function(){ deleteSkillPanel(); });');
  s.push('  var ib=document.querySelectorAll(".inst-modal button");');
  s.push('  if(ib[0]) ib[0].addEventListener("click",function(){ closeInstModal(); });');
  s.push('  if(ib[1]) ib[1].addEventListener("click",function(){ saveInst(); });');
  s.push('  var gb=document.querySelectorAll(".gh-modal button");');
  s.push('  if(gb[0]) gb[0].addEventListener("click",function(){ closeGhModal(); });');
  s.push('  if(gb[1]) gb[1].addEventListener("click",function(){ saveGhSettings(); });');
  s.push('  on(".ctx-rename","click",function(){ ctxRename(); });');
  s.push('  on(".ctx-star","click",function(){ ctxStar(); });');
  s.push('  on(".ctx-delete","click",function(){ ctxDelete(); });');
  // VS Code bridge init
  s.push('  injectCtxBar();');
  s.push('  addApplyButtons();');
  s.push('  if(vscApi) {');
  s.push('    vscApi.postMessage({type:"getContext"});');
  s.push('    vscApi.postMessage({type:"getWorkspaceTree"});');
  s.push('  }');
  s.push('}');
  s.push('');
  s.push('if(document.readyState==="loading"){');
  s.push('  document.addEventListener("DOMContentLoaded",wire);');
  s.push('} else { wire(); }');
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
    if ((Date.now() - fs.statSync(p).mtimeMs) / 3600000 > 24) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (_) { return null; }
}
async function saveCache(context, html) {
  const dir = context.globalStorageUri.fsPath;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getCachePath(context), html, 'utf8');
}
function bustCache(context) { try { fs.unlinkSync(getCachePath(context)); } catch (_) {} }
function getCachePath(context) { return path.join(context.globalStorageUri.fsPath, 'chat.html'); }

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
            ? res.headers.location : new URL(res.headers.location, u).href;
          return follow(next, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

function getWebviewOptions(extensionUri) { return { enableScripts: true }; }

function getLoadingHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{background:#1a1a1a;color:#ccc;font-family:system-ui;display:flex;align-items:center;' +
    'justify-content:center;height:100vh;margin:0}' +
    '.dot{animation:blink 1.2s infinite}.dot:nth-child(2){animation-delay:.4s}.dot:nth-child(3){animation-delay:.8s}' +
    '@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}</style></head>' +
    '<body><span>Loading Ooumph</span><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></body></html>';
}

function getErrorHtml(msg) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:system-ui;padding:24px;color:#ccc;background:#1a1a1a">' +
    '<strong style="color:#e05252">Failed to load Ooumph AI Chat</strong><br><br>' +
    '<code style="font-size:12px">' + (msg||'Unknown error') + '</code><br><br>' +
    '<p style="font-size:13px">Check your internet and reload (<kbd>Ctrl+Shift+P</kbd> → <em>Developer: Reload Window</em>).</p>' +
    '</body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
