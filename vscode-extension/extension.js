// Ooumph AI Chat – VS Code Extension
// extension.js  (main entry point)
// -------------------------------------------------------
// This extension opens a WebviewPanel containing the full
// Ooumph AI Chat UI.  API credentials are read from VS Code
// settings so they are never hard-coded.
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
      OoumphViewProvider.viewType, provider, {webviewOptions: {retainContextWhenHidden: true}}
    )
  );

  // ── Register palette command  ───────────────────────────
  const cmd = vscode.commands.registerCommand('ooumph.openChat', () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'ooumphChat',
      'Ooumph AI Chat',
      vscode.ViewColumn.Beside,
      getWebviewOptions(context.extensionUri)
    );
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
    setupMessageHandler(panel.webview, context);
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });

  context.subscriptions.push(cmd);
}

// ── Sidebar WebviewView provider ─────────────────────────
class OoumphViewProvider {
  static viewType = 'ooumph.chatView';

  constructor(extensionUri) {
    this._extensionUri = extensionUri;
  }

  resolveWebviewView(webviewView, _ctx, _token) {
    this._view = webviewView;
    webviewView.webview.options = getWebviewOptions(this._extensionUri);
    webviewView.webview.html   = getWebviewContent(webviewView.webview, this._extensionUri);
    setupMessageHandler(webviewView.webview, {extensionUri: this._extensionUri});
  }
}

// ── Message handler (webview ↔ extension host) ────────────
function setupMessageHandler(webview, context) {
  webview.onDidReceiveMessage(async (message) => {
    switch (message.command) {

      // Webview requests the current Azure config
      case 'getConfig': {
        const cfg = vscode.workspace.getConfiguration('ooumph');
        webview.postMessage({
          command: 'config',
          azureEndpoint : cfg.get('azureEndpoint', ''),
          azureApiKey   : cfg.get('azureApiKey',   ''),
          azureApiVersion: cfg.get('azureApiVersion', '2025-01-01-preview'),
          models        : cfg.get('models',        ['DeepSeek-R1', 'DeepSeek-V3', 'gpt-4o']),
          defaultModel  : cfg.get('defaultModel',  'DeepSeek-R1')
        });
        break;
      }

      // Webview wants to open VS Code Settings for this extension
      case 'openSettings': {
        vscode.commands.executeCommand(
          'workbench.action.openSettings', '@ext:ooumph.ooumph-ai-chat'
        );
        break;
      }

      // Webview sends a chat API request – extension proxies it
      // (avoids CORS issues inside the webview sandbox)
      case 'apiRequest': {
        try {
          const cfg = vscode.workspace.getConfiguration('ooumph');
          const endpoint   = cfg.get('azureEndpoint', '');
          const apiKey     = cfg.get('azureApiKey',   '');
          const apiVersion = cfg.get('azureApiVersion', '2025-01-01-preview');

          if (!endpoint || !apiKey) {
            webview.postMessage({
              command: 'apiError',
              requestId: message.requestId,
              error: 'Azure credentials not configured. Open Settings → Ooumph AI Chat.'
            });
            break;
          }

          const url = endpoint.replace(/\/$/, '') +
            '/openai/deployments/' + encodeURIComponent(message.model) +
            '/chat/completions?api-version=' + apiVersion;

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey
            },
            body: JSON.stringify({
              messages: message.messages,
              stream: message.stream !== false,
              temperature: message.temperature ?? 0.7,
              max_tokens: message.maxTokens ?? 4096
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            webview.postMessage({
              command: 'apiError',
              requestId: message.requestId,
              error: 'Azure API error ' + response.status + ': ' + errText
            });
            break;
          }

          if (message.stream !== false) {
            // Stream SSE chunks back to webview
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, {stream: true});
              const lines = buffer.split('\n');
              buffer = lines.pop(); // keep incomplete line
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (trimmed.startsWith('data: ')) {
                  try {
                    const chunk = JSON.parse(trimmed.slice(6));
                    webview.postMessage({command: 'apiChunk', requestId: message.requestId, chunk});
                  } catch (e) { /* ignore malformed chunk */ }
                }
              }
            }
            webview.postMessage({command: 'apiDone', requestId: message.requestId});
          } else {
            const data = await response.json();
            webview.postMessage({command: 'apiResponse', requestId: message.requestId, data});
          }
        } catch (err) {
          webview.postMessage({
            command: 'apiError',
            requestId: message.requestId,
            error: err.message
          });
        }
        break;
      }

      // Webview wants to show a VS Code notification
      case 'showInfo':
        vscode.window.showInformationMessage(message.text);
        break;
      case 'showError':
        vscode.window.showErrorMessage(message.text);
        break;
    }
  });
}

// ── Webview helpers ───────────────────────────────────────
function getWebviewOptions(extensionUri) {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'media')
    ]
  };
}

function getWebviewContent(webview, extensionUri) {
  // Load the bundled webview HTML from media/chat.html
  const htmlPath = vscode.Uri.joinPath(extensionUri, 'media', 'chat.html');
  let html;
  try {
    html = fs.readFileSync(htmlPath.fsPath, 'utf8');
  } catch (e) {
    return getFallbackHtml(webview);
  }

  // Inject the VS Code bridge script just before </body>
  const bridge = getBridgeScript();
  html = html.replace('</body>', bridge + '\n</body>');
  return html;
}

// Bridge script injected into the webview HTML.
// It intercepts all fetch() calls to Azure and routes them
// through the extension host via postMessage.
function getBridgeScript() {
  return `
<script id="vscode-bridge">
(function() {
  // Only run inside VS Code webview
  if (typeof acquireVsCodeApi === 'undefined') return;
  const vscode = acquireVsCodeApi();

  // Ask extension for config on startup
  window.__vscodeMode = true;
  window.__vscode     = vscode;

  // Request handlers map: requestId → {resolve, reject}
  window.__pendingRequests = {};
  window.__reqCounter = 0;

  // Override the global fetch for Azure API calls only
  const originalFetch = window.fetch.bind(window);
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.includes('openai.azure.com')) {
      return new Promise((resolve, reject) => {
        const requestId = 'req_' + (++window.__reqCounter);
        let body;
        try { body = JSON.parse(options?.body || '{}'); } catch(e) { body = {}; }

        const isStream = body.stream !== false;

        if (!isStream) {
          // Non-streaming: wait for apiResponse
          window.__pendingRequests[requestId] = {resolve, reject};
          vscode.postMessage({
            command: 'apiRequest',
            requestId,
            model  : url.match(/\/deployments\/([^\/]+)\//)?.[1] || '',
            messages: body.messages || [],
            stream  : false,
            temperature: body.temperature,
            maxTokens  : body.max_tokens
          });
        } else {
          // Streaming: build a fake ReadableStream from SSE chunks
          let controller;
          const readable = new ReadableStream({
            start(c) { controller = c; }
          });

          window.__pendingRequests[requestId] = {
            stream: true,
            controller,
            resolve,
            reject
          };

          // Resolve immediately with a Response-like object
          const encoder = new TextEncoder();
          const mockResponse = {
            ok: true,
            status: 200,
            headers: new Headers({'content-type': 'text/event-stream'}),
            body: readable,
            getReader: () => readable.getReader()
          };
          resolve(mockResponse);

          vscode.postMessage({
            command: 'apiRequest',
            requestId,
            model   : url.match(/\/deployments\/([^\/]+)\//)?.[1] || '',
            messages : body.messages || [],
            stream   : true,
            temperature: body.temperature,
            maxTokens  : body.max_tokens
          });
        }
      });
    }
    return originalFetch(url, options);
  };

  // Handle messages from extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.command) return;

    if (msg.command === 'config') {
      // Inject Azure config into the page's global variables
      if (window.AZURE_BASE !== undefined) window.AZURE_BASE = msg.azureEndpoint;
      if (window.AZURE_KEY  !== undefined) window.AZURE_KEY  = msg.azureApiKey;
      if (window.API_VER    !== undefined) window.API_VER    = msg.azureApiVersion;
      if (msg.models && window.MODELS !== undefined) window.MODELS = msg.models;
      if (window.__configReady) window.__configReady(msg);
      return;
    }

    const pending = window.__pendingRequests[msg.requestId];
    if (!pending) return;

    if (msg.command === 'apiResponse') {
      delete window.__pendingRequests[msg.requestId];
      pending.resolve(new Response(JSON.stringify(msg.data), {
        status: 200,
        headers: {'content-type': 'application/json'}
      }));
    } else if (msg.command === 'apiChunk') {
      if (pending.stream && pending.controller) {
        const enc = new TextEncoder();
        const line = 'data: ' + JSON.stringify(msg.chunk) + '\\n\\n';
        pending.controller.enqueue(enc.encode(line));
      }
    } else if (msg.command === 'apiDone') {
      if (pending.stream && pending.controller) {
        const enc = new TextEncoder();
        pending.controller.enqueue(enc.encode('data: [DONE]\\n\\n'));
        pending.controller.close();
      }
      delete window.__pendingRequests[msg.requestId];
    } else if (msg.command === 'apiError') {
      delete window.__pendingRequests[msg.requestId];
      if (pending.stream && pending.controller) {
        pending.controller.error(new Error(msg.error));
      } else if (pending.reject) {
        pending.reject(new Error(msg.error));
      }
    }
  });

  // Request config from extension
  vscode.postMessage({command: 'getConfig'});

  // If config arrives before init(), stash it for init() to pick up
  window.__configReady = function(cfg) {
    // Re-render model pill if app already started
    if (typeof setModelPill === 'function' && cfg.defaultModel) {
      setModelPill(cfg.defaultModel);
    }
    if (typeof renderChatList === 'function') renderChatList();
  };
})();
<\/script>`;
}

// Fallback HTML shown if media/chat.html is missing
function getFallbackHtml(webview) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>body{font-family:system-ui;padding:24px;background:#1a1a1a;color:#ececec}
a{color:#c96442}.box{background:#2a2a2a;border-radius:10px;padding:20px;margin-top:16px}
code{background:#383838;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body>
<h2>⚠️ Ooumph AI Chat – Setup Required</h2>
<div class="box">
<p>The file <code>media/chat.html</code> is missing from the extension folder.</p>
<p>Please run the setup steps in the extension's README to complete installation.</p>
</div>
<div class="box">
<h3>Quick fix:</h3>
<ol>
<li>Open a terminal in the extension folder</li>
<li>Run: <code>node build.js</code> (this downloads and adapts the web app)</li>
<li>Reload VS Code window (Ctrl+Shift+P → "Reload Window")</li>
</ol>
</div>
</body></html>`;
}

function deactivate() {
  if (panel) { panel.dispose(); panel = undefined; }
}

module.exports = { activate, deactivate };
