// Ooumph AI Chat -- VS Code Extension
// extension.js
//
// Architecture: loads the live GitHub Pages app in a webview.
// No HTML patching, no bridge injection, no CSP conflicts.
// The app runs exactly as it does in a browser -- all buttons,
// dropdowns, and inputs work natively.
// Azure credentials are configured inside the app's own settings
// modal (the GH icon), stored in localStorage -- same as the web version.

const vscode = require('vscode');

// The live URL of the web app
const APP_URL = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';

/** @type {vscode.WebviewPanel | undefined} */
let panel;

function activate(context) {

  // ── Register sidebar webview provider ────────────────
  const provider = new OoumphViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OoumphViewProvider.viewType, provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Register palette / keyboard shortcut command ──────
  const cmd = vscode.commands.registerCommand('ooumph.openChat', () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'ooumphChat',
      'Ooumph AI Chat',
      vscode.ViewColumn.Beside,
      getWebviewOptions()
    );
    panel.webview.html = getWebviewHtml();
    panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  });

  context.subscriptions.push(cmd);
}

// ── Sidebar WebviewView provider ──────────────────────────
class OoumphViewProvider {
  static viewType = 'ooumph.chatView';
  constructor(extensionUri) { this._extensionUri = extensionUri; }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = getWebviewOptions();
    webviewView.webview.html    = getWebviewHtml();
  }
}

// ── Webview options ───────────────────────────────────────
// enableScripts + enableForms: required for the app to work.
// No localResourceRoots restriction so external URLs can load.
function getWebviewOptions() {
  return {
    enableScripts: true,
    enableForms:   true
  };
}

// ── Webview HTML ──────────────────────────────────────────
// Uses an <iframe> pointing at the live GitHub Pages URL.
// The iframe runs in its own origin so all scripts, event
// handlers, fetch() calls, and localStorage work exactly as
// they do in the browser -- zero patching needed.
function getWebviewHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body {
      margin: 0; padding: 0;
      width: 100%; height: 100vh;
      overflow: hidden;
      background: #1a1a1a;
    }
    iframe {
      width: 100%; height: 100%;
      border: none;
      display: block;
    }
  </style>
</head>
<body>
  <iframe
    src="${APP_URL}"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
    allow="clipboard-write; clipboard-read"
  ></iframe>
</body>
</html>`;
}

function deactivate() {
  if (panel) { panel.dispose(); panel = undefined; }
}

module.exports = { activate, deactivate };
