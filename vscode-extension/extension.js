// Ooumph AI Chat – VS Code Extension
// extension.js  (main entry point)
// -------------------------------------------------------
// Handles:  azureRequest, getConfig, getActiveFile,
//           applyEdit, getWorkspaceFiles, readFile,
//           writeFile, showInfo, showError
// -------------------------------------------------------

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

/** @type {vscode.WebviewPanel | undefined} */
let panel;

function activate(context) {

  // ── Register sidebar webview provider ──────────────────
  const provider = new OoumphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OoumphViewProvider.viewType, provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Register palette / shortcut command ────────────────
  const cmd = vscode.commands.registerCommand('ooumph.openChat', () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
    panel = vscode.window.createWebviewPanel(
      'ooumphChat', 'Ooumph AI Chat',
      vscode.ViewColumn.Beside,
      getWebviewOptions(context.extensionUri)
    );
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
    setupMessageHandler(panel.webview, context, panel.webview);
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });

  context.subscriptions.push(cmd);
}

// ── Sidebar WebviewView provider ─────────────────────────
class OoumphViewProvider {
  static viewType = 'ooumph.chatView';
  constructor(extensionUri) { this._extensionUri = extensionUri; }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = getWebviewOptions(this._extensionUri);
    webviewView.webview.html    = getWebviewContent(webviewView.webview, this._extensionUri);
    setupMessageHandler(webviewView.webview, { extensionUri: this._extensionUri }, webviewView.webview);
  }
}

// ── Central message handler ───────────────────────────────
function setupMessageHandler(webview, _context, replyTarget) {

  webview.onDidReceiveMessage(async (message) => {
    const reply = (msg) => replyTarget.postMessage(msg);

    switch (message.command || message.type) {

      // ── Config request ────────────────────────────────
      case 'getConfig': {
        const cfg = vscode.workspace.getConfiguration('ooumph');
        reply({
          command: 'config', type: 'config',
          azureEndpoint:   cfg.get('azureEndpoint',   ''),
          azureApiKey:     cfg.get('azureApiKey',     ''),
          azureApiVersion: cfg.get('azureApiVersion', '2025-01-01-preview'),
          models:          cfg.get('models',          ['DeepSeek-R1', 'DeepSeek-V3', 'gpt-4o']),
          defaultModel:    cfg.get('defaultModel',    'DeepSeek-R1')
        });
        break;
      }

      // ── Open Settings page ────────────────────────────
      case 'openSettings': {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:ooumph.ooumph-ai-chat');
        break;
      }

      // ── Azure API proxy (streaming) ───────────────────
      case 'apiRequest':
      case 'azureRequest': {
        try {
          const cfg = vscode.workspace.getConfiguration('ooumph');
          const endpoint   = message.endpoint   || cfg.get('azureEndpoint',   '');
          const apiKey     = message.apiKey      || cfg.get('azureApiKey',     '');
          const apiVersion = message.apiVersion  || cfg.get('azureApiVersion', '2025-01-01-preview');

          if (!endpoint || !apiKey) {
            reply({ command: 'apiError', type: 'apiError', requestId: message.requestId,
              error: 'Azure credentials not configured. Open Settings and search ooumph.' });
            break;
          }

          const url = endpoint.replace(/\/$/, '') +
            '/openai/deployments/' + encodeURIComponent(message.model) +
            '/chat/completions?api-version=' + apiVersion;

          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
            body: JSON.stringify({
              messages:    message.messages,
              stream:      message.stream !== false,
              temperature: message.temperature ?? 0.7,
              max_tokens:  message.maxTokens   ?? 4096
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            reply({ command: 'apiError', type: 'apiError', requestId: message.requestId,
              error: 'Azure API error ' + response.status + ': ' + errText });
            break;
          }

          if (message.stream !== false) {
            const reader  = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop();
              for (const line of lines) {
                const t = line.trim();
                if (!t || t === 'data: [DONE]') continue;
                if (t.startsWith('data: ')) {
                  try {
                    const chunk = JSON.parse(t.slice(6));
                    reply({ command: 'apiChunk', type: 'apiChunk', requestId: message.requestId, chunk });
                  } catch (_) {}
                }
              }
            }
            reply({ command: 'apiDone', type: 'apiDone', requestId: message.requestId });
          } else {
            const data = await response.json();
            reply({ command: 'apiResponse', type: 'apiResponse', requestId: message.requestId, data });
          }
        } catch (err) {
          reply({ command: 'apiError', type: 'apiError', requestId: message.requestId, error: err.message });
        }
        break;
      }

      // ── Get active editor file content ────────────────
      case 'getActiveFile': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          reply({ command: 'activeFile', type: 'activeFile',
            content:  editor.document.getText(),
            fileName: editor.document.fileName,
            language: editor.document.languageId
          });
        } else {
          reply({ command: 'activeFile', type: 'activeFile', content: null, fileName: null, language: null });
        }
        break;
      }

      // ── Apply edited content to active file ───────────
      case 'applyEdit': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Ooumph: No active editor to apply edit to.'); break; }
        const edit      = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(editor.document.getText().length)
        );
        edit.replace(editor.document.uri, fullRange, message.content);
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage('Ooumph: Edit applied to ' + path.basename(editor.document.fileName));
        break;
      }

      // ── List workspace files ──────────────────────────
      case 'getWorkspaceFiles': {
        const pattern = message.pattern || '**/*';
        const exclude = message.exclude || '**/node_modules/**';
        const limit   = message.limit   || 100;
        const files   = await vscode.workspace.findFiles(pattern, exclude, limit);
        reply({ command: 'workspaceFiles', type: 'workspaceFiles',
          files: files.map(f => vscode.workspace.asRelativePath(f))
        });
        break;
      }

      // ── Read a specific file ──────────────────────────
      case 'readFile': {
        try {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders) { reply({ command: 'fileContent', type: 'fileContent', error: 'No workspace open' }); break; }
          const fileUri = vscode.Uri.joinPath(folders[0].uri, message.path);
          const bytes   = await vscode.workspace.fs.readFile(fileUri);
          reply({ command: 'fileContent', type: 'fileContent', path: message.path,
            content: Buffer.from(bytes).toString('utf8')
          });
        } catch (err) {
          reply({ command: 'fileContent', type: 'fileContent', path: message.path, error: err.message });
        }
        break;
      }

      // ── Write / create a file ─────────────────────────
      case 'writeFile': {
        try {
          const folders = vscode.workspace.workspaceFolders;
          if (!folders) { vscode.window.showErrorMessage('Ooumph: No workspace open.'); break; }
          const fileUri = vscode.Uri.joinPath(folders[0].uri, message.path);
          await vscode.workspace.fs.writeFile(fileUri, Buffer.from(message.content, 'utf8'));
          reply({ command: 'fileWritten', type: 'fileWritten', path: message.path });
          vscode.window.showInformationMessage('Ooumph: Saved ' + message.path);
        } catch (err) {
          vscode.window.showErrorMessage('Ooumph: Could not write file — ' + err.message);
          reply({ command: 'fileWritten', type: 'fileWritten', path: message.path, error: err.message });
        }
        break;
      }

      // ── Notifications ─────────────────────────────────
      case 'showInfo':  vscode.window.showInformationMessage(message.text); break;
      case 'showError': vscode.window.showErrorMessage(message.text);       break;
    }
  });
}

// ── Webview helpers ───────────────────────────────────────
function getWebviewOptions(extensionUri) {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
}

function getWebviewContent(webview, extensionUri) {
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'chat.html');
  let html;
  try { html = fs.readFileSync(htmlPath.fsPath, 'utf8'); }
  catch (_) { return getFallbackHtml(); }
  html = html.replace('</body>', getBridgeScript() + '\n</body>');
  return html;
}

// ── VS Code Bridge (injected into webview HTML at runtime) ─
function getBridgeScript() {
  const S = [];
  const p = (x) => S.push(x);

  p('<script id="vscode-bridge">');
  p('(function () {');
  p('  if (typeof acquireVsCodeApi === "undefined") return;');
  p('  const vsc = acquireVsCodeApi();');
  p('  window.__vscodeMode = true; window.__vscode = vsc;');
  p('  window.__pending = {}; window.__reqId = 0;');
  p('  function nid() { return "r" + (++window.__reqId); }');

  // ── Public VS Code helpers ─────────────────────────────
  p('  window.vscodeGetActiveFile     = () => vsc.postMessage({ type: "getActiveFile" });');
  p('  window.vscodeApplyEdit         = (c) => vsc.postMessage({ type: "applyEdit",   content: c });');
  p('  window.vscodeGetWorkspaceFiles = (pt) => vsc.postMessage({ type: "getWorkspaceFiles", pattern: pt });');
  p('  window.vscodeReadFile          = (pt) => vsc.postMessage({ type: "readFile",  path: pt });');
  p('  window.vscodeWriteFile         = (pt, c) => vsc.postMessage({ type: "writeFile", path: pt, content: c });');
  p('  window.vscodeOpenSettings      = () => vsc.postMessage({ type: "openSettings" });');

  // ── Override fetch() for Azure calls ──────────────────
  p('  const _of = window.fetch.bind(window);');
  p('  window.fetch = function (url, opts) {');
  p('    if (typeof url === "string" && url.includes("openai.azure.com")) {');
  p('      return new Promise((res, rej) => {');
  p('        const id = nid();');
  p('        let body = {};');
  p('        try { body = JSON.parse(opts&&opts.body||"{}"); } catch(_){}');
  p('        const isStream = body.stream !== false;');
  p('        if (!isStream) {');
  p('          window.__pending[id] = { resolve: res, reject: rej };');
  p('          vsc.postMessage({ type:"azureRequest",requestId:id,');
  p('            model:(url.match(/\\/deployments\\/([^\\/]+)\\//)||[])[1]||"",');
  p('            messages:body.messages||[],stream:false,');
  p('            temperature:body.temperature,maxTokens:body.max_tokens });');
  p('        } else {');
  p('          let ctrl;');
  p('          const stream = new ReadableStream({ start(c){ctrl=c;} });');
  p('          window.__pending[id] = { stream:true, ctrl, resolve:res, reject:rej };');
  p('          res({ ok:true,status:200,headers:new Headers({"content-type":"text/event-stream"}),body:stream });');
  p('          vsc.postMessage({ type:"azureRequest",requestId:id,');
  p('            model:(url.match(/\\/deployments\\/([^\\/]+)\\//)||[])[1]||"",');
  p('            messages:body.messages||[],stream:true,');
  p('            temperature:body.temperature,maxTokens:body.max_tokens });');
  p('        }');
  p('      });');
  p('    }');
  p('    return _of(url, opts);');
  p('  };');

  // ── Dispatch incoming messages ────────────────────────
  p('  window.addEventListener("message", (evt) => {');
  p('    const msg = evt.data; if (!msg) return;');
  p('    const t = msg.type || msg.command;');

  p('    if (t === "config") {');
  p('      if (typeof AZURE_BASE !== "undefined") window.AZURE_BASE = msg.azureEndpoint;');
  p('      if (typeof AZURE_KEY  !== "undefined") window.AZURE_KEY  = msg.azureApiKey;');
  p('      if (typeof API_VER   !== "undefined") window.API_VER    = msg.azureApiVersion;');
  p('      if (msg.models && typeof MODELS !== "undefined") {');
  p('        window.MODELS = msg.models;');
  p('        if (typeof setModelPill === "function") setModelPill(msg.defaultModel || msg.models[0]);');
  p('      }');
  p('      if (typeof window.__onConfig === "function") window.__onConfig(msg);');
  p('      return;');
  p('    }');

  p('    if (t === "activeFile") {');
  p('      if (typeof window.__onActiveFile === "function") window.__onActiveFile(msg);');
  p('      return;');
  p('    }');

  p('    if (t === "workspaceFiles") {');
  p('      if (typeof window.__onWorkspaceFiles === "function") window.__onWorkspaceFiles(msg);');
  p('      return;');
  p('    }');

  p('    if (t === "fileContent") {');
  p('      if (typeof window.__onFileContent === "function") window.__onFileContent(msg);');
  p('      return;');
  p('    }');

  p('    const pn = window.__pending[msg.requestId]; if (!pn) return;');
  p('    if (t === "apiResponse") {');
  p('      delete window.__pending[msg.requestId];');
  p('      pn.resolve(new Response(JSON.stringify(msg.data),{status:200,headers:{"content-type":"application/json"}}));');
  p('    } else if (t === "apiChunk") {');
  p('      if (pn.stream && pn.ctrl) pn.ctrl.enqueue(new TextEncoder().encode("data: " + JSON.stringify(msg.chunk) + "\\n\\n"));');
  p('    } else if (t === "apiDone") {');
  p('      if (pn.stream && pn.ctrl) { pn.ctrl.enqueue(new TextEncoder().encode("data: [DONE]\\n\\n")); pn.ctrl.close(); }');
  p('      delete window.__pending[msg.requestId];');
  p('    } else if (t === "apiError") {');
  p('      delete window.__pending[msg.requestId];');
  p('      pn.stream ? pn.ctrl.error(new Error(msg.error)) : pn.reject(new Error(msg.error));');
  p('    }');
  p('  });');

  // ── Boot ──────────────────────────────────────────────
  p('  vsc.postMessage({ type: "getConfig" });');
  // ── Attach File button injected into input toolbar ───
  p('  function injectAttachBtn() {');
  p('    if (document.getElementById("vsc-attach-btn")) return;');
  p('    const bar = document.querySelector("#input-row,.input-row,#composer,.input-bar");');
  p('    if (!bar) return;');
  p('    const btn = document.createElement("button");');
  p('    btn.id = "vsc-attach-btn";');
  p('    btn.title = "Attach current editor file as context";');
  p('    btn.innerHTML = "<svg width=\'15\' height=\'15\' viewBox=\'0 0 16 16\' fill=\'currentColor\'><path d=\'M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0z\'/></svg>";');
  p('    btn.style.cssText = "flex-shrink:0;opacity:0.7;padding:4px 6px;border-radius:6px;cursor:pointer;background:none;border:none;color:inherit;transition:opacity .15s";');
  p('    btn.onmouseenter = () => btn.style.opacity="1";');
  p('    btn.onmouseleave = () => btn.style.opacity="0.7";');
  p('    btn.onclick = () => window.vscodeGetActiveFile();');
  p('    bar.appendChild(btn);');
  p('  }');

  // ── Handler: received active file ─────────────────────
  p('  window.__onActiveFile = function(msg) {');
  p('    if (!msg.content) return;');
  p('    const fname = msg.fileName ? msg.fileName.replace(/.*[\\/\\/]/,"") : "file";');
  p('    const ctx = "\\`\\`\\`" + (msg.language||"") + "\\n// " + (msg.fileName||fname) + "\\n" + msg.content + "\\n\\`\\`\\`\\n";');
  p('    const ta = document.querySelector("#prompt,#input,textarea");');
  p('    if (ta) { ta.value = ctx + (ta.value ? "\\n" + ta.value : ""); ta.dispatchEvent(new Event("input",{bubbles:true})); ta.focus(); }');
  p('    const btn = document.getElementById("vsc-attach-btn");');
  p('    if (btn) { btn.style.color="#4ec94e"; setTimeout(()=>btn.style.color="",1500); }');
  p('  };');

  // ── Apply to File buttons after AI code blocks ────────
  p('  function addApplyButtons() {');
  p('    document.querySelectorAll(".msg.assistant .msg-bubble pre").forEach(pre => {');
  p('      if (pre.dataset.applyAdded) return;');
  p('      pre.dataset.applyAdded = "1";');
  p('      const code = pre.querySelector("code"); if (!code) return;');
  p('      const w = document.createElement("div");');
  p('      w.style.cssText = "display:flex;gap:6px;margin-top:6px";');
  p('      const ab = document.createElement("button");');
  p('      ab.textContent = "⬆ Apply to File";');
  p('      ab.style.cssText = "font-size:11px;padding:3px 10px;border-radius:5px;background:#c96442;color:#fff;border:none;cursor:pointer";');
  p('      ab.onclick = () => { window.vscodeApplyEdit(code.innerText); ab.textContent="✓ Applied"; setTimeout(()=>{ab.textContent="⬆ Apply to File";},2000); };');
  p('      const cb = document.createElement("button");');
  p('      cb.textContent = "⎘ Copy";');
  p('      cb.style.cssText = "font-size:11px;padding:3px 10px;border-radius:5px;background:rgba(255,255,255,.1);border:none;cursor:pointer;color:inherit";');
  p('      cb.onclick = () => { navigator.clipboard.writeText(code.innerText).then(()=>{ cb.textContent="✓ Copied"; setTimeout(()=>{cb.textContent="⎘ Copy";},1500); }); };');
  p('      w.appendChild(ab); w.appendChild(cb); pre.after(w);');
  p('    });');
  p('  }');

  p('  const obs = new MutationObserver(() => { addApplyButtons(); injectAttachBtn(); });');
  p('  function boot() { obs.observe(document.body,{childList:true,subtree:true}); injectAttachBtn(); addApplyButtons(); }');
  p('  document.readyState==="loading" ? document.addEventListener("DOMContentLoaded",boot) : boot();');
  p('})();');
  p('<\/script>');
  return S.join('\n');
}

// ── Fallback HTML ─────────────────────────────────────────
function getFallbackHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>body{font-family:system-ui;padding:24px;background:#1a1a1a;color:#ececec}' +
    'code{background:#383838;padding:2px 6px;border-radius:4px;font-size:13px}' +
    '.box{background:#2a2a2a;border-radius:10px;padding:20px;margin-top:16px}' +
    'ol{padding-left:20px;line-height:2}</style></head><body>' +
    '<h2>⚠️ Setup Required</h2><div class="box"><p><code>media/chat.html</code> is missing.</p>' +
    '<ol><li>Open a terminal in the extension folder</li>' +
    '<li><code>node build.js</code></li>' +
    '<li>Reload VS Code: Ctrl+Shift+P → Reload Window</li></ol></div></body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
