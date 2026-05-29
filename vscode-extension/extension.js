// Ooumph AI Chat — VS Code Extension
'use strict';

const vscode = require('vscode');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const SOURCE_URL      = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const SECRET_ENDPOINT = 'ooumph.azureEndpoint';
const SECRET_KEY      = 'ooumph.azureKey';

const IGNORE_DIRS = new Set([
  'node_modules','.git','__pycache__','.venv','venv','env',
  'dist','build','.next','.nuxt','coverage','.pytest_cache',
  '.mypy_cache','.ruff_cache','target','out','bin','obj'
]);
const IGNORE_EXTS = new Set([
  '.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2',
  '.ttf','.eot','.mp4','.mp3','.zip','.tar','.gz','.lock',
  '.pyc','.pyo','.class','.exe','.bin','.vsix','.pdf'
]);

let panel       = null;
let sidebarView = null;
let wsFiles     = [];

// ─── Activate ────────────────────────────────────────────────────────────────
function activate(context) {
  try {
    // Register sidebar webview
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'ooumph.chatView',
        new ChatViewProvider(context),
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );

    // Watch for editor changes
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => broadcastCtx()),
      vscode.window.onDidChangeTextEditorSelection(() => broadcastCtx()),
      vscode.workspace.onDidSaveTextDocument(() => { wsFiles = readWsFiles(); broadcastWs(); })
    );

    // Command: open panel
    context.subscriptions.push(
      vscode.commands.registerCommand('ooumph.openChat', async () => {
        if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
        panel = vscode.window.createWebviewPanel(
          'ooumphChat', 'Ooumph AI Chat',
          vscode.ViewColumn.Beside,
          webviewOpts(context.extensionUri)
        );
        panel.webview.html = loadingHtml();
        panel.webview.html = await buildHtml(panel.webview, context).catch(e => errorHtml(String(e)));
        hookMessages(panel.webview, context);
        panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
      })
    );

    // Command: set credentials
    context.subscriptions.push(
      vscode.commands.registerCommand('ooumph.setCredentials', async () => {
        const ep = await vscode.window.showInputBox({
          title: 'Ooumph — Azure Endpoint',
          placeHolder: 'https://YOUR-RESOURCE.openai.azure.com/',
          value: (await context.secrets.get(SECRET_ENDPOINT)) || '',
          ignoreFocusOut: true
        });
        if (ep === undefined) return;
        const k = await vscode.window.showInputBox({
          title: 'Ooumph — Azure API Key', password: true, ignoreFocusOut: true
        });
        if (k === undefined) return;
        await context.secrets.store(SECRET_ENDPOINT, ep.trim());
        await context.secrets.store(SECRET_KEY, k.trim());
        bustCache(context);
        vscode.window.showInformationMessage('Ooumph: credentials saved — reloading...');
        for (const wv of [panel && panel.webview, sidebarView && sidebarView.webview].filter(Boolean)) {
          wv.html = loadingHtml();
          wv.html = await buildHtml(wv, context).catch(e => errorHtml(String(e)));
          hookMessages(wv, context);
        }
      })
    );

    // Command: refresh workspace
    context.subscriptions.push(
      vscode.commands.registerCommand('ooumph.refreshWorkspace', () => {
        wsFiles = readWsFiles();
        broadcastWs();
        vscode.window.showInformationMessage('Ooumph: workspace refreshed — ' + wsFiles.length + ' files');
      })
    );

    // First-run credential prompt
    context.secrets.get(SECRET_KEY).then(k => {
      if (!k) {
        vscode.window.showInformationMessage('Ooumph: set Azure credentials to start.', 'Set Credentials')
          .then(s => { if (s) vscode.commands.executeCommand('ooumph.setCredentials'); });
      }
    }).catch(() => {});

    // Index workspace
    wsFiles = readWsFiles();

  } catch (err) {
    vscode.window.showErrorMessage('Ooumph activation error: ' + String(err));
  }
}

// ─── Sidebar Provider ─────────────────────────────────────────────────────────
class ChatViewProvider {
  constructor(ctx) { this._ctx = ctx; }
  async resolveWebviewView(v) {
    sidebarView = v;
    v.webview.options = webviewOpts(this._ctx.extensionUri);
    v.webview.html = loadingHtml();
    v.webview.html = await buildHtml(v.webview, this._ctx).catch(e => errorHtml(String(e)));
    hookMessages(v.webview, this._ctx);
    v.onDidDispose(() => { sidebarView = null; });
  }
}

// ─── Webview Options ─────────────────────────────────────────────────────────
function webviewOpts(extUri) {
  return {
    enableScripts: true,
    localResourceRoots: extUri ? [vscode.Uri.joinPath(extUri, 'media')] : []
  };
}

// ─── Build Webview HTML ───────────────────────────────────────────────────────
async function buildHtml(webview, context) {
  // 1. Try globalStorage cache
  let html = readCache(context);

  // 2. Fall back to bundled media/chat.html
  if (!html) {
    const bundled = path.join(context.extensionUri.fsPath, 'media', 'chat.html');
    if (fs.existsSync(bundled)) html = fs.readFileSync(bundled, 'utf8');
  }

  // 3. Last resort: download
  if (!html) {
    const raw = await fetchUrl(SOURCE_URL);
    html = patchHtml(raw);
    writeCache(context, html);
  }

  // Background refresh
  fetchUrl(SOURCE_URL).then(r => writeCache(context, patchHtml(r))).catch(() => {});

  // Inject credentials + security
  const ep  = (await context.secrets.get(SECRET_ENDPOINT)) || '';
  const key = (await context.secrets.get(SECRET_KEY)) || '';
  return finalise(webview, html, ep, key);
}

// ─── HTML Patching ────────────────────────────────────────────────────────────
function patchHtml(html) {
  // Strip version-check snippet
  html = html.replace(/<script>!function\(\)[^<]+_ov[^<]+<\/script>/g, '');
  // Make Azure vars reassignable
  html = html.replace(/\bconst (AZURE_BASE\s*=)/, 'let $1');
  html = html.replace(/\bconst (AZURE_KEY\s*=)/, 'let $1');
  // Clear default credential values
  html = html.replace(/(let\s+AZURE_BASE\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/(let\s+AZURE_KEY\s*=\s*)['"][^'"]*['"]/, "$1''");
  // DO NOT strip inline event handlers — keep them working with unsafe-inline CSP
  // Remove disabled from send button
  html = html.replace(/(<button[^>]+id="send-btn"[^>]+)\s+disabled\b/, '$1');
  // Add injection point before last </body>
  html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, '<!--OOUMPH_INJECT-->\n</body>');
  return html;
}

// ─── Finalise: nonce + CSP + credentials + bridge ────────────────────────────
function finalise(webview, html, endpoint, apiKey) {
  const nonce = crypto.randomBytes(16).toString('base64');

  // Nonce all inline scripts
  html = html.replace(/<script(\s*(?!nonce)[^>]*)>/g, (m, attrs) => '<script' + attrs + ' nonce="' + nonce + '">');

  // CSP — 'unsafe-inline' required so the app's inline event handlers & scripts work
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' 'nonce-" + nonce + "' " + webview.cspSource +
      " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline' " + webview.cspSource + " https://cdnjs.cloudflare.com",
    "font-src https:",
    "img-src data: https: " + webview.cspSource,
    "connect-src https:"
  ].join('; ');
  html = html.replace('<head>', '<head>\n<meta http-equiv="Content-Security-Policy" content="' + csp + '">');

  // Credentials script
  const credScript = '<script nonce="' + nonce + '">' +
    'window.__EP__=' + JSON.stringify(endpoint) + ';' +
    'window.__KEY__=' + JSON.stringify(apiKey) + ';' +
    '</script>';

  // Bridge script (all event handlers + VS Code integration)
  const bridgeScript = '<script nonce="' + nonce + '">' + getBridgeCode() + '</script>';

  const inject = credScript + '\n' + bridgeScript;

  if (html.includes('<!--OOUMPH_INJECT-->')) {
    html = html.replace('<!--OOUMPH_INJECT-->', inject);
  } else {
    html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, inject + '\n</body>');
  }

  return html;
}

// ─── Bridge Code (runs inside webview) ───────────────────────────────────────
function getBridgeCode() {
  // NOTE: no backtick characters inside this template literal — they would end it.
  // Use \x60 (hex escape for backtick) where backticks are needed in the output.
  return `
(function() {
  'use strict';
  var api = (function(){ try { return acquireVsCodeApi(); } catch(e) { return null; } })();
  var ctx  = { hasContext: false };
  var wsf  = [];
  var ctxOn = true;
  var TICK = '\x60';
  var FENCE = '\x60\x60\x60';

  // ── System prompt ──────────────────────────────────────────────────────────
  var SYS = [
    'You are Ooumph AI, a coding assistant with full access to the VS Code workspace.',
    'You behave like Claude Code — you can read, understand, and edit any file.',
    '',
    'When finding issues ALWAYS:',
    '1. List every issue with exact file:line — e.g. filename.py:42 — description',
    '2. Then show the complete corrected file in a code block',
    '3. End with: Click Apply to File to apply this fix.',
    '',
    'Issue report format:',
    '**Issues found:**',
    '1. config.py:15 — Missing validation',
    '2. utils.py:42 — Null reference risk',
    '',
    '**Fix:**',
    '(complete corrected file in a fenced code block)',
    '',
    'Rules:',
    '- Always output COMPLETE file content when editing (not just the changed part)',
    '- Reference files by exact relative path',
    '- You have full workspace context below'
  ].join('\\n');

  // ── Listen for messages from extension host ────────────────────────────────
  window.addEventListener('message', function(ev) {
    var m = ev.data;
    if (!m || !m.type) return;
    if (m.type === 'vscContext')    { ctx = m; updateBar(); }
    if (m.type === 'workspaceFiles'){ wsf = m.files || []; updateBar(); }
    if (m.type === 'applyDone')     { toast('Applied to ' + m.file + ' ✓', '#2a7a2a'); }
    if (m.type === 'addToInput')    {
      var inp = document.getElementById('input');
      if (!inp) return;
      inp.value = (inp.value ? inp.value + '\\n\\n' : '') + m.text;
      if (typeof autoResize === 'function') autoResize(inp);
      if (typeof updateSend  === 'function') updateSend();
      inp.focus();
    }
  });

  // ── Intercept fetch — inject context invisibly ─────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function(url, opts) {
    try {
      var s = String(url || '');
      var isAzure = s.indexOf('openai.azure.com') > -1 ||
        (typeof AZURE_BASE !== 'undefined' && AZURE_BASE && s.indexOf(AZURE_BASE) > -1);
      if (isAzure && ctxOn && opts && opts.body) {
        var body = JSON.parse(opts.body);
        if (body && Array.isArray(body.messages)) {
          var lines = [SYS, ''];
          if (ctx.hasContext) {
            lines.push('## Active file: ' + ctx.relPath + ' (' + ctx.language + ', ' + ctx.lineCount + ' lines, cursor:' + ctx.cursorLine + ')');
            if (ctx.selection) {
              lines.push('Selected:\\n' + FENCE + ctx.language + '\\n' + ctx.selection + '\\n' + FENCE);
            }
          }
          if (wsf.length) {
            lines.push('\\n## Workspace files (' + wsf.length + ' total):');
            wsf.forEach(function(f) {
              lines.push('\\n### ' + f.relPath);
              lines.push(FENCE + f.language);
              var numbered = f.content.split('\\n').map(function(l, i) { return (i+1) + '  ' + l; }).join('\\n');
              lines.push(numbered);
              lines.push(FENCE);
            });
          }
          var sysMsgContent = lines.join('\\n');
          var idx = body.messages.findIndex(function(m) {
            return m.role === 'system' && m.content && m.content.indexOf('Ooumph AI') > -1;
          });
          if (idx >= 0) {
            body.messages[idx].content = sysMsgContent;
          } else {
            var at = 0;
            while (at < body.messages.length && body.messages[at].role === 'system') at++;
            body.messages.splice(at, 0, { role: 'system', content: sysMsgContent });
          }
          opts = Object.assign({}, opts, { body: JSON.stringify(body) });
        }
      }
    } catch(e) {}
    return _fetch.apply(this, arguments);
  };

  // ── Apply / Insert buttons on code blocks ─────────────────────────────────
  function addButtons(root) {
    (root || document).querySelectorAll('pre code').forEach(function(block) {
      if (block.dataset.ob) return;
      block.dataset.ob = '1';
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:5px;margin:3px 0 2px;flex-wrap:wrap;';
      function btn(label, bg, fn) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:2px 9px;border-radius:3px;font-size:11px;cursor:pointer;border:none;color:#fff;background:' + bg + ';';
        b.onclick = fn;
        return b;
      }
      row.appendChild(btn('⚡ Apply to File', '#c96442', function() {
        if (api) api.postMessage({ type: 'applyEdit', code: block.textContent });
      }));
      row.appendChild(btn('↵ Insert at Cursor', '#3a3a3a', function() {
        if (api) api.postMessage({ type: 'insertAtCursor', code: block.textContent });
      }));
      block.parentNode.insertBefore(row, block);
    });
    // Make file:line refs clickable
    (root || document).querySelectorAll('p,li,td').forEach(function(el) {
      if (el.dataset.ll) return;
      el.dataset.ll = '1';
      el.innerHTML = el.innerHTML.replace(/([a-zA-Z0-9_\-./]+\.[a-z]{1,6}):(\d+)/g, function(_, f, l) {
        return '<a href="#" style="color:#c96442;font-family:monospace;text-decoration:underline;" data-f="' + f + '" data-l="' + l + '">' + f + ':' + l + '</a>';
      });
    });
    document.querySelectorAll('a[data-f]').forEach(function(a) {
      if (a.dataset.wired) return;
      a.dataset.wired = '1';
      a.addEventListener('click', function(e) {
        e.preventDefault();
        if (api) api.postMessage({ type: 'goToLine', filePath: a.dataset.f, line: +a.dataset.l });
      });
    });
  }
  new MutationObserver(function(ms) {
    ms.forEach(function(m) { m.addedNodes.forEach(function(n) { if (n.nodeType===1) addButtons(n); }); });
  }).observe(document.body, { childList: true, subtree: true });

  // ── Context bar ────────────────────────────────────────────────────────────
  function mkBar() {
    if (document.getElementById('obar')) return;
    var anchor = document.querySelector('.compose') || document.querySelector('form');
    if (!anchor) return;
    var bar = document.createElement('div');
    bar.id = 'obar';
    bar.style.cssText = 'display:none;align-items:center;gap:5px;padding:3px 8px;font-size:11px;color:#888;background:#1e1e1e;border-top:1px solid rgba(255,255,255,0.07);flex-wrap:wrap;';
    var lbl = document.createElement('span');
    lbl.id = 'obar-lbl';
    lbl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;';
    function mkBtn2(t, bg, fn) {
      var b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = 'padding:1px 6px;border-radius:3px;font-size:10px;border:none;cursor:pointer;color:#fff;background:' + bg + ';flex-shrink:0;';
      b.onclick = fn; return b;
    }
    var tog = mkBtn2('Context ON', '#c96442', function() {
      ctxOn = !ctxOn;
      tog.textContent = ctxOn ? 'Context ON' : 'Context OFF';
      tog.style.background = ctxOn ? '#c96442' : '#555';
    });
    var ref = document.createElement('button');
    ref.textContent = '🔄'; ref.title = 'Refresh workspace';
    ref.style.cssText = 'padding:1px 5px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;';
    ref.onclick = function() { if (api) api.postMessage({ type: 'refreshWorkspace' }); };
    var af = document.createElement('button');
    af.textContent = '📂 Add File';
    af.style.cssText = 'padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;';
    af.onclick = function() { if (api) api.postMessage({ type: 'openFile' }); };
    bar.appendChild(lbl); bar.appendChild(tog); bar.appendChild(ref); bar.appendChild(af);
    anchor.parentNode.insertBefore(bar, anchor);
  }
  function updateBar() {
    var bar = document.getElementById('obar');
    var lbl = document.getElementById('obar-lbl');
    if (!bar) return;
    var show = ctx.hasContext || wsf.length > 0;
    bar.style.display = show ? 'flex' : 'none';
    if (lbl) {
      var t = ctx.hasContext ? (ctx.fileName + (ctx.selection ? ' — selection' : '') + ' L' + ctx.cursorLine) : '';
      if (wsf.length) t += (t ? '  ·  ' : '') + wsf.length + ' files indexed';
      lbl.textContent = t;
    }
  }

  // ── Toast notification ─────────────────────────────────────────────────────
  function toast(msg, bg) {
    var n = document.createElement('div');
    n.textContent = msg;
    n.style.cssText = 'position:fixed;bottom:68px;left:50%;transform:translateX(-50%);padding:5px 14px;border-radius:5px;font-size:12px;color:#fff;z-index:9999;pointer-events:none;background:' + (bg||'#444') + ';';
    document.body.appendChild(n);
    setTimeout(function(){ n.remove(); }, 2500);
  }

  // ── Wire event handlers ────────────────────────────────────────────────────
  var _wireRetries = 0;
  function wire() {
    // Retry up to 30x with 100ms gaps if app functions not ready yet
    if (typeof send !== 'function' || typeof onKey !== 'function') {
      if (_wireRetries++ < 30) { setTimeout(wire, 100); return; }
    }
    _wireRetries = 0;

    // Set Azure creds
    try { if (window.__EP__)  AZURE_BASE = window.__EP__;  } catch(e) {}
    try { if (window.__KEY__) AZURE_KEY  = window.__KEY__; } catch(e) {}

    function on(sel, evt, fn) {
      var els;
      if (typeof sel === 'string') {
        // Use querySelectorAll so multi-match selectors like .compose-btn get all elements
        els = Array.prototype.slice.call(document.querySelectorAll(sel));
      } else {
        els = sel ? [sel] : [];
      }
      els.forEach(function(el) { el.addEventListener(evt, fn); });
    }

    // Only attach our listeners if the element doesn't already have onclick/onkeydown
    // (inline handlers were kept in the HTML so they fire natively — we add as backup)
    on('#input', 'keydown', function(e){
      try { onKey(e); } catch(ex) {}
    });
    on('#input', 'input', function(){
      try { autoResize(this); updateSend(); } catch(ex) {}
    });
    on('#send-btn', 'click', function(){
      try { send(); } catch(ex) {}
    });
    on('#sparkle-btn', 'click', function(){
      try { toggleTray(); } catch(ex) {}
    });
    on('#file-input', 'change', function(){
      try { handleFiles(this.files); } catch(ex) {}
    });
    on('.btn-add-skill', 'click', function(){
      try { openSkillPanel(null); } catch(ex) {}
    });
    on('#btn-del-skill', 'click', function(){
      try { deleteSkillPanel(); } catch(ex) {}
    });
    on('.topbar-toggle', 'click', function(){
      try { toggleSidebar(false); } catch(ex) {}
    });
    on('#sb-overlay', 'click', function(){
      try { toggleSidebar(); } catch(ex) {}
    });
    on('.btn-new', 'click', function(){
      try { newChat(); } catch(ex) {}
    });
    on('#tab-chats', 'click', function(){
      try { switchSbTab('chats'); } catch(ex) {}
    });
    on('#tab-graphify', 'click', function(){
      try { switchSbTab('graphify'); } catch(ex) {}
    });
    on('#search', 'input', function(){
      try { renderChatList(); } catch(ex) {}
    });
    on('#model-pill', 'click', function(){
      try { toggleModelDrop(); } catch(ex) {}
    });
    on('.ctx-rename', 'click', function(){ try { ctxRename(); } catch(ex) {} });
    on('.ctx-star',   'click', function(){ try { ctxStar();   } catch(ex) {} });
    on('.ctx-delete', 'click', function(){ try { ctxDelete(); } catch(ex) {} });

    // Attach-file button (exclude sparkle)
    document.querySelectorAll('.compose-btn').forEach(function(b) {
      if (b.id === 'sparkle-btn') return;
      b.addEventListener('click', function(){
        var fi = document.getElementById('file-input');
        if (fi) fi.click();
      });
    });

    var icons = document.querySelectorAll('.topbar-icon');
    if (icons[0]) icons[0].addEventListener('click', function(){ try { openGhModal();   } catch(ex) {} });
    if (icons[1]) icons[1].addEventListener('click', function(){ try { openInstModal(); } catch(ex) {} });
    if (icons[2]) icons[2].addEventListener('click', function(){ try { showHelp();      } catch(ex) {} });

    var ib = document.querySelectorAll('.inst-modal button');
    if (ib[0]) ib[0].addEventListener('click', function(){ try { closeInstModal(); } catch(ex) {} });
    if (ib[1]) ib[1].addEventListener('click', function(){ try { saveInst();       } catch(ex) {} });

    var gb = document.querySelectorAll('.gh-modal button');
    if (gb[0]) gb[0].addEventListener('click', function(){ try { closeGhModal();    } catch(ex) {} });
    if (gb[1]) gb[1].addEventListener('click', function(){ try { saveGhSettings();  } catch(ex) {} });

    // VS Code integration init
    mkBar();
    addButtons();
    if (api) api.postMessage({ type: 'getContext' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
`;
}

// ─── Message Handler (extension host side) ───────────────────────────────────
function hookMessages(webview, context) {
  // Send initial data
  postMsg(webview, { type: 'vscContext',    ...getCtx() });
  postMsg(webview, { type: 'workspaceFiles', files: wsFiles });

  webview.onDidReceiveMessage(async function(msg) {
    switch (msg.type) {
      case 'getContext':
        postMsg(webview, { type: 'vscContext',    ...getCtx() });
        postMsg(webview, { type: 'workspaceFiles', files: wsFiles });
        break;
      case 'refreshWorkspace':
        wsFiles = readWsFiles();
        postMsg(webview, { type: 'workspaceFiles', files: wsFiles });
        vscode.window.showInformationMessage('Ooumph: refreshed — ' + wsFiles.length + ' files');
        break;
      case 'applyEdit': {
        const ed = vscode.window.activeTextEditor;
        if (!ed) { vscode.window.showWarningMessage('Ooumph: no active editor'); break; }
        if (msg.filePath) {
          const abs = resolveWs(msg.filePath);
          if (abs) { const d = await vscode.workspace.openTextDocument(abs); await vscode.window.showTextDocument(d); }
        }
        const e2 = vscode.window.activeTextEditor;
        await e2.edit(eb => {
          const sel = e2.selection;
          if (!sel.isEmpty) eb.replace(sel, msg.code);
          else eb.replace(new vscode.Range(0,0,e2.document.lineCount,0), msg.code);
        });
        postMsg(webview, { type: 'applyDone', file: path.basename(e2.document.fileName) });
        vscode.window.showInformationMessage('Ooumph: applied to ' + path.basename(e2.document.fileName));
        wsFiles = readWsFiles();
        break;
      }
      case 'insertAtCursor': {
        const ed = vscode.window.activeTextEditor;
        if (!ed) break;
        await ed.edit(eb => eb.insert(ed.selection.active, msg.code));
        break;
      }
      case 'goToLine': {
        const abs = resolveWs(msg.filePath);
        if (!abs) break;
        const doc = await vscode.workspace.openTextDocument(abs);
        const ed  = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(Math.max(0, (msg.line||1)-1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos,pos), vscode.TextEditorRevealType.InCenter);
        break;
      }
      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true });
        if (!uris) break;
        const text = uris.map(u => {
          const rel  = vscode.workspace.asRelativePath(u.fsPath);
          const lang = langOf(u.fsPath);
          const cont = fs.readFileSync(u.fsPath, 'utf8');
          return '**' + rel + '**\n```' + lang + '\n' + cont + '\n```';
        }).join('\n\n---\n\n');
        postMsg(webview, { type: 'addToInput', text });
        break;
      }
    }
  });
}

function postMsg(webview, data) { try { webview.postMessage(data); } catch(_) {} }

// ─── Editor Context ───────────────────────────────────────────────────────────
function getCtx() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return { hasContext: false };
  const doc = ed.document;
  return {
    hasContext:  true,
    fileName:    path.basename(doc.fileName),
    relPath:     vscode.workspace.asRelativePath(doc.fileName),
    language:    doc.languageId,
    selection:   doc.getText(ed.selection),
    content:     doc.getText().slice(0, 60000),
    lineCount:   doc.lineCount,
    cursorLine:  ed.selection.active.line + 1
  };
}

function broadcastCtx() {
  const c = getCtx();
  if (sidebarView) postMsg(sidebarView.webview, { type: 'vscContext', ...c });
  if (panel)       postMsg(panel.webview,       { type: 'vscContext', ...c });
}
function broadcastWs() {
  if (sidebarView) postMsg(sidebarView.webview, { type: 'workspaceFiles', files: wsFiles });
  if (panel)       postMsg(panel.webview,       { type: 'workspaceFiles', files: wsFiles });
}

// ─── Workspace File Reader ────────────────────────────────────────────────────
function readWsFiles() {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return [];
  const root = wf[0].uri.fsPath;
  const out  = [];
  let   tot  = 0;
  const MAX_TOTAL = 400000;
  const MAX_FILE  = 60000;

  (function walk(dir, rel) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const rp  = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, rp); continue; }
      if (tot >= MAX_TOTAL) continue;
      if (IGNORE_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      try {
        let c = fs.readFileSync(abs, 'utf8');
        if (c.length > MAX_FILE) c = c.slice(0, MAX_FILE) + '\n...[truncated]';
        tot += c.length;
        out.push({ relPath: rp, language: langOf(e.name), content: c });
      } catch(_) {}
    }
  })(root, '');
  return out;
}

function resolveWs(relPath) {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return null;
  const abs = path.join(wf[0].uri.fsPath, relPath);
  return fs.existsSync(abs) ? abs : null;
}

function langOf(f) {
  const m = { js:'javascript',ts:'typescript',tsx:'tsx',jsx:'jsx',py:'python',
    rs:'rust',go:'go',java:'java',cs:'csharp',cpp:'cpp',c:'c',
    rb:'ruby',php:'php',html:'html',css:'css',json:'json',
    md:'markdown',sh:'bash',yaml:'yaml',yml:'yaml',toml:'toml',sql:'sql' };
  return m[path.extname(f).slice(1).toLowerCase()] || 'text';
}

// ─── Cache ────────────────────────────────────────────────────────────────────
function cachePath(ctx) { return path.join(ctx.globalStorageUri.fsPath, 'chat.html'); }
function readCache(ctx) {
  try { return fs.readFileSync(cachePath(ctx), 'utf8'); } catch(_) { return null; }
}
function writeCache(ctx, html) {
  try {
    const d = ctx.globalStorageUri.fsPath;
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(cachePath(ctx), html, 'utf8');
  } catch(_) {}
}
function bustCache(ctx) { try { fs.unlinkSync(cachePath(ctx)); } catch(_) {} }

// ─── HTTP Fetch with 15s timeout ─────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : require('http');
      const req = mod.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location : new URL(res.headers.location, u).href;
          return go(next, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        let d = ''; res.setEncoding('utf8');
        res.on('data', c => { d += c; });
        res.on('end',  () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    };
    go(url, 0);
  });
}

// ─── Static HTML ─────────────────────────────────────────────────────────────
function loadingHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>body{background:#1a1a1a;color:#ccc;font-family:system-ui;display:flex;' +
    'align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.d{animation:b 1.2s infinite}.d:nth-child(2){animation-delay:.4s}.d:nth-child(3){animation-delay:.8s}' +
    '@keyframes b{0%,80%,100%{opacity:.2}40%{opacity:1}}</style></head>' +
    '<body><span>Loading Ooumph</span><span class="d">.</span><span class="d">.</span><span class="d">.</span></body></html>';
}
function errorHtml(msg) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:system-ui;padding:24px;color:#ccc;background:#1a1a1a">' +
    '<b style="color:#e05252">Ooumph failed to load</b><br><br>' +
    '<code>' + String(msg).replace(/</g,'&lt;') + '</code><br><br>' +
    '<p>Ctrl+Shift+P → Developer: Reload Window</p></body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = null; } }
module.exports = { activate, deactivate };
