// Ooumph AI Chat -- VS Code Extension
// extension.js — Claude Code-style full workspace context

const vscode = require('vscode');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const SOURCE_URL      = 'https://noreply-ooumph.github.io/ooumph_azure_deepseek_open/';
const SECRET_ENDPOINT = 'ooumph.azureEndpoint';
const SECRET_KEY      = 'ooumph.azureKey';

const IGNORE_DIRS  = new Set(['node_modules','.git','__pycache__','.venv','venv','env',
  'dist','build','.next','.nuxt','coverage','.pytest_cache','.mypy_cache',
  '.ruff_cache','target','out','bin','obj','.idea','.vs']);
const IGNORE_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.woff',
  '.woff2','.ttf','.eot','.mp4','.mp3','.zip','.tar','.gz','.lock',
  '.pyc','.pyo','.class','.o','.so','.dll','.exe','.bin','.vsix','.pdf']);
const MAX_FILE_BYTES  = 60000;   // 60 KB per file
const MAX_TOTAL_BYTES = 400000;  // 400 KB total workspace context

let panel;
let sidebarView;
let workspaceFiles = [];   // [{relPath, language, content}]  cached on host side

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

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => broadcastContext())
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => broadcastContext())
  );
  // Re-read workspace when files are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      workspaceFiles = readWorkspaceFiles();
      broadcastWorkspace();
    })
  );

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
        password: true, ignoreFocusOut: true
      });
      if (key === undefined) return;
      await context.secrets.store(SECRET_ENDPOINT, endpoint.trim());
      await context.secrets.store(SECRET_KEY, key.trim());
      bustCache(context);
      vscode.window.showInformationMessage('Ooumph: credentials saved. Reloading...');
      const reload = async (wv) => {
        wv.html = getLoadingHtml();
        try { wv.html = await buildWebviewHtml(wv, context); wireMessageHandler(wv, context); }
        catch (e) { wv.html = getErrorHtml(e.message); }
      };
      if (panel)       reload(panel.webview);
      if (sidebarView) reload(sidebarView.webview);
    })
  );

  context.secrets.get(SECRET_KEY).then(k => {
    if (!k) {
      vscode.window.showInformationMessage(
        'Ooumph AI Chat: set your Azure credentials to start chatting.',
        'Set Credentials'
      ).then(s => { if (s === 'Set Credentials') vscode.commands.executeCommand('ooumph.setCredentials'); });
    }
  });

  // Pre-load workspace files at startup
  workspaceFiles = readWorkspaceFiles();
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------
function broadcastContext() {
  const ctx = getEditorContext();
  if (sidebarView) postTo(sidebarView.webview, { type: 'vscContext', ...ctx });
  if (panel)       postTo(panel.webview,       { type: 'vscContext', ...ctx });
}

function broadcastWorkspace() {
  if (sidebarView) postTo(sidebarView.webview, { type: 'workspaceFiles', files: workspaceFiles });
  if (panel)       postTo(panel.webview,       { type: 'workspaceFiles', files: workspaceFiles });
}

// ---------------------------------------------------------------------------
// Read ALL workspace files into memory
// ---------------------------------------------------------------------------
function readWorkspaceFiles() {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return [];
  const root = wf[0].uri.fsPath;
  const results = [];
  let totalBytes = 0;

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && !['env','.env'].includes(e.name)) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const relPath = rel ? rel + '/' + e.name : e.name;
      const abs     = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, relPath);
      } else {
        if (totalBytes >= MAX_TOTAL_BYTES) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;
        try {
          const stat = fs.statSync(abs);
          if (stat.size > MAX_FILE_BYTES * 2) continue;  // skip very large files
          let content = fs.readFileSync(abs, 'utf8');
          if (content.length > MAX_FILE_BYTES) {
            content = content.slice(0, MAX_FILE_BYTES) + '\n...[truncated]';
          }
          totalBytes += content.length;
          results.push({
            relPath,
            language: langFromExt(e.name),
            content
          });
        } catch (_) {}
      }
    }
  };

  walk(root, '');
  return results;
}

// ---------------------------------------------------------------------------
// Message handler: webview → extension host
// ---------------------------------------------------------------------------
function wireMessageHandler(webview, context) {
  // Send full workspace immediately when webview connects
  postTo(webview, { type: 'vscContext', ...getEditorContext() });
  postTo(webview, { type: 'workspaceFiles', files: workspaceFiles });

  webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {

      case 'getContext':
        postTo(webview, { type: 'vscContext', ...getEditorContext() });
        postTo(webview, { type: 'workspaceFiles', files: workspaceFiles });
        break;

      case 'refreshWorkspace':
        workspaceFiles = readWorkspaceFiles();
        postTo(webview, { type: 'workspaceFiles', files: workspaceFiles });
        vscode.window.showInformationMessage('Ooumph: workspace refreshed (' + workspaceFiles.length + ' files)');
        break;

      case 'openFile': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true, canSelectFolders: false, canSelectMany: true
        });
        if (uris && uris.length) {
          const files = uris.map(u => ({
            relPath:  vscode.workspace.asRelativePath(u.fsPath),
            content:  fs.readFileSync(u.fsPath, 'utf8'),
            language: langFromExt(u.fsPath)
          }));
          postTo(webview, { type: 'addFilesToInput', files });
        }
        break;
      }

      case 'getOpenFiles': {
        const files = vscode.workspace.textDocuments
          .filter(d => !d.isUntitled && d.uri.scheme === 'file')
          .map(d => ({
            relPath:  vscode.workspace.asRelativePath(d.fileName),
            content:  d.getText(),
            language: d.languageId
          }));
        postTo(webview, { type: 'addFilesToInput', files });
        break;
      }

      case 'applyEdit': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Ooumph: no active editor.'); break; }
        // If a specific file is requested, open it first
        if (msg.filePath) {
          const abs = resolveWorkspacePath(msg.filePath);
          if (abs) {
            const doc = await vscode.workspace.openTextDocument(abs);
            await vscode.window.showTextDocument(doc);
          }
        }
        const ed = vscode.window.activeTextEditor;
        await ed.edit(eb => {
          const sel = ed.selection;
          if (!sel.isEmpty) {
            eb.replace(sel, msg.code);
          } else {
            eb.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), msg.code);
          }
        });
        // Refresh workspace cache after edit
        workspaceFiles = readWorkspaceFiles();
        postTo(webview, { type: 'applyDone', file: path.basename(ed.document.fileName) });
        vscode.window.showInformationMessage('Ooumph: applied to ' + path.basename(ed.document.fileName));
        break;
      }

      case 'insertAtCursor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) break;
        await editor.edit(eb => eb.insert(editor.selection.active, msg.code));
        vscode.window.showInformationMessage('Ooumph: inserted at cursor.');
        break;
      }

      case 'goToLine': {
        // Jump to a specific file:line when user clicks an issue reference
        const abs = resolveWorkspacePath(msg.filePath);
        if (!abs) break;
        const doc = await vscode.workspace.openTextDocument(abs);
        const ed  = await vscode.window.showTextDocument(doc);
        const line = Math.max(0, (msg.line || 1) - 1);
        const pos  = new vscode.Position(line, 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        break;
      }

      case 'createFile': {
        const wf = vscode.workspace.workspaceFolders;
        if (!wf || !wf.length) break;
        const abs = path.join(wf[0].uri.fsPath, msg.filePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, msg.content, 'utf8');
        const doc = await vscode.workspace.openTextDocument(abs);
        await vscode.window.showTextDocument(doc);
        workspaceFiles = readWorkspaceFiles();
        postTo(webview, { type: 'createFileDone', path: msg.filePath });
        break;
      }
    }
  });
}

function postTo(webview, data) { try { webview.postMessage(data); } catch (_) {} }

// ---------------------------------------------------------------------------
// Editor context
// ---------------------------------------------------------------------------
function getEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { hasContext: false };
  const doc = editor.document;
  const sel = editor.selection;
  return {
    hasContext:  true,
    fileName:    path.basename(doc.fileName),
    relPath:     vscode.workspace.asRelativePath(doc.fileName),
    language:    doc.languageId,
    selection:   doc.getText(sel),
    content:     doc.getText().slice(0, 60000),
    lineCount:   doc.lineCount,
    cursorLine:  sel.active.line + 1
  };
}

function resolveWorkspacePath(relPath) {
  const wf = vscode.workspace.workspaceFolders;
  if (!wf || !wf.length) return null;
  const abs = path.join(wf[0].uri.fsPath, relPath);
  return fs.existsSync(abs) ? abs : null;
}

function langFromExt(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return { js:'javascript', ts:'typescript', tsx:'tsx', jsx:'jsx',
    py:'python', rs:'rust', go:'go', java:'java', cs:'csharp',
    cpp:'cpp', c:'c', rb:'ruby', php:'php', swift:'swift', kt:'kotlin',
    html:'html', css:'css', scss:'css', json:'json', md:'markdown',
    sh:'bash', bash:'bash', yaml:'yaml', yml:'yaml', toml:'toml',
    env:'bash', sql:'sql', graphql:'graphql' }[ext] || ext || 'text';
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
    try { v.webview.html = await buildWebviewHtml(v.webview, this._ctx); }
    catch (e) { v.webview.html = getErrorHtml(e.message); }
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
  const s = '<script id="ooumph-creds">window.__OOUMPH_ENDPOINT__=' +
    JSON.stringify(endpoint) + ';window.__OOUMPH_KEY__=' + JSON.stringify(key) + ';<\/script>';
  return html.replace('<body', s + '\n<body');
}

function patchHtml(html) {
  html = html.replace(/<script>!function\(\)[^<]+_ov[^<]+<\/script>/, '<!-- version-check removed -->');
  html = html.replace(/\bconst (AZURE_BASE\s*=)/, 'let   $1');
  html = html.replace(/\bconst (AZURE_KEY\s*=)/,  'let   $1');
  html = html.replace(/(let\s+AZURE_BASE\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/(let\s+AZURE_KEY\s*=\s*)['"][^'"]*['"]/, "$1''");
  html = html.replace(/\s*onclick="[^"]*"/g, '');
  html = html.replace(/\s*onkeydown="[^"]*"/g, '');
  html = html.replace(/\s*oninput="[^"]*"/g, '');
  html = html.replace(/\s*onchange="[^"]*"/g, '');
  html = html.replace(/(<button[^>]+id="send-btn"[^>]+)\bdisabled\b/, '$1');
  html = html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, '<!-- VSC_HANDLERS_PLACEHOLDER -->\n</body>');
  return html;
}

function injectSecurityAndHandlers(webview, html) {
  const nonce = crypto.randomBytes(16).toString('base64');
  html = html.replace(/<script>/g, '<script nonce="' + nonce + '">');
  html = html.replace('<script id="ooumph-creds">', '<script nonce="' + nonce + '" id="ooumph-creds">');
  const csp = [
    "default-src 'none'",
    "script-src 'nonce-" + nonce + "' " + webview.cspSource + " https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'unsafe-inline' " + webview.cspSource + " https://cdnjs.cloudflare.com",
    "font-src https:", "img-src data: https: " + webview.cspSource, "connect-src https:"
  ].join('; ');
  html = html.replace('<head>', '<head>\n  <meta http-equiv="Content-Security-Policy" content="' + csp + '">');
  const hs = buildHandlerScript(nonce);
  html = html.includes('<!-- VSC_HANDLERS_PLACEHOLDER -->')
    ? html.replace('<!-- VSC_HANDLERS_PLACEHOLDER -->', hs)
    : html.replace(/(<\/body>)(?![\s\S]*<\/body>)/, hs + '\n</body>');
  return html;
}

// ---------------------------------------------------------------------------
// The complete bridge script injected into the webview
// ---------------------------------------------------------------------------
function buildHandlerScript(nonce) {
  const s = [];
  s.push('<script nonce="' + nonce + '">');
  s.push('(function(){');
  s.push('"use strict";');
  s.push('var vscApi=(function(){try{return acquireVsCodeApi();}catch(e){return null;}})();');
  s.push('var editorCtx={hasContext:false};');
  s.push('var workspaceFiles=[];');  // [{relPath, language, content}]
  s.push('var contextEnabled=true;');
  s.push('');

  // ── System prompt (Claude Code style) ─────────────────────────────────────
  s.push('var SYSTEM_PROMPT = [');
  s.push('  "You are Ooumph AI, a coding assistant with full access to the VS Code workspace.",');
  s.push('  "You behave like Claude Code — you can read, analyze, and edit any file.",');
  s.push('  "",');
  s.push('  "## When finding issues:",');
  s.push('  "- ALWAYS report exact location first: `filename.py:42` — description of the problem",');
  s.push('  "- List ALL issues found before showing any fix",');
  s.push('  "- Format issues as a numbered list with file:line references",');
  s.push('  "- Then provide the complete corrected code in a fenced code block",');
  s.push('  "- End with: \\"Click ⚡ Apply to File to apply this fix.\\"",');
  s.push('  "",');
  s.push('  "## Issue report format:",');
  s.push('  "**Issues found:**",');
  s.push('  "1. `config.py:15` — Missing type annotation on `opla_mode`",');
  s.push('  "2. `utils.py:42` — Potential KeyError on dict access",');
  s.push('  "",');
  s.push('  "**Fix for config.py:**",');
  s.push('  "```python",');
  s.push('  "# complete corrected file here",');
  s.push('  "```",');
  s.push('  "",');
  s.push('  "## General rules:",');
  s.push('  "- Reference files by their exact relative path",');
  s.push('  "- When editing, always output the COMPLETE file content (not just the changed part)",');
  s.push('  "- If asked to read a folder, summarize each file and highlight key logic",');
  s.push('  "- Understand imports and dependencies across files",');
  s.push('  "- You can see the full workspace below"'].join('\n') + '');
  s.push('].join("\\n");');
  s.push('');

  // ── Messages from extension host ──────────────────────────────────────────
  s.push('window.addEventListener("message",function(ev){');
  s.push('  var m=ev.data; if(!m||!m.type) return;');
  s.push('  if(m.type==="vscContext"){ editorCtx=m; updateCtxBar(); }');
  s.push('  if(m.type==="workspaceFiles"){');
  s.push('    workspaceFiles=m.files||[];');
  s.push('    updateCtxBar();');
  s.push('  }');
  s.push('  if(m.type==="applyDone"){ showNotif("✓ Applied to "+m.file,"#2a7a2a"); }');
  s.push('  if(m.type==="createFileDone"){ showNotif("✓ Created "+m.path,"#2a7a2a"); }');
  s.push('  if(m.type==="addFilesToInput"){');
  s.push('    var inp=document.getElementById("input"); if(!inp) return;');
  s.push('    var block=(m.files||[]).map(function(f){');
  s.push('      return "**"+f.relPath+"**\\n```"+f.language+"\\n"+f.content+"\\n```";');
  s.push('    }).join("\\n\\n---\\n\\n");');
  s.push('    inp.value=(inp.value.trim()?inp.value+"\\n\\n":"")+block;');
  s.push('    if(typeof autoResize==="function") autoResize(inp);');
  s.push('    if(typeof updateSend==="function") updateSend();');
  s.push('    inp.focus();');
  s.push('  }');
  s.push('});');
  s.push('');

  // ── Fetch interceptor — inject full workspace context silently ─────────────
  s.push('(function(){');
  s.push('  var origFetch=window.fetch;');
  s.push('  window.fetch=function(url,opts){');
  s.push('    try{');
  s.push('      var urlStr=(url||"").toString();');
  s.push('      var isAzure=urlStr.indexOf("openai.azure.com")!==-1||');
  s.push('        (typeof AZURE_BASE!=="undefined"&&AZURE_BASE&&urlStr.indexOf(AZURE_BASE)!==-1);');
  s.push('      if(isAzure&&contextEnabled&&opts&&opts.body){');
  s.push('        var body=JSON.parse(opts.body);');
  s.push('        if(body&&Array.isArray(body.messages)){');
  // Build full workspace context block
  s.push('          var ctxLines=[SYSTEM_PROMPT,""];');
  s.push('          ctxLines.push("## Active File");');
  if (true) {
    s.push('          if(editorCtx.hasContext){');
    s.push('            ctxLines.push("File: "+editorCtx.relPath+' +
           '"  |  Language: "+editorCtx.language+' +
           '"  |  "+editorCtx.lineCount+" lines  |  Cursor: line "+editorCtx.cursorLine);');
    s.push('            if(editorCtx.selection){');
    s.push('              ctxLines.push("Selected text:");');
    s.push('              ctxLines.push("```"+editorCtx.language);');
    s.push('              ctxLines.push(editorCtx.selection);');
    s.push('              ctxLines.push("```");');
    s.push('            }');
    s.push('          }');
  }
  s.push('          if(workspaceFiles.length){');
  s.push('            ctxLines.push("");');
  s.push('            ctxLines.push("## Full Workspace ("+workspaceFiles.length+" files)");');
  s.push('            workspaceFiles.forEach(function(f){');
  s.push('              ctxLines.push("");');
  s.push('              ctxLines.push("### "+f.relPath);');
  s.push('              ctxLines.push("```"+f.language);');
  // Add line numbers to content
  s.push('              var lines=f.content.split("\\n");');
  s.push('              var numbered=lines.map(function(l,i){');
  s.push('                return (i+1)+"  "+l;');
  s.push('              }).join("\\n");');
  s.push('              ctxLines.push(numbered);');
  s.push('              ctxLines.push("```");');
  s.push('            });');
  s.push('          }');
  // Replace any existing ooumph system message, or insert after other system messages
  s.push('          var sysContent=ctxLines.join("\\n");');
  s.push('          var existingIdx=body.messages.findIndex(function(m){');
  s.push('            return m.role==="system"&&m.content&&m.content.indexOf("Ooumph AI")!==-1;');
  s.push('          });');
  s.push('          if(existingIdx>=0){');
  s.push('            body.messages[existingIdx].content=sysContent;');
  s.push('          } else {');
  s.push('            var insertAt=0;');
  s.push('            while(insertAt<body.messages.length&&body.messages[insertAt].role==="system") insertAt++;');
  s.push('            body.messages.splice(insertAt,0,{role:"system",content:sysContent});');
  s.push('          }');
  s.push('          opts=Object.assign({},opts,{body:JSON.stringify(body)});');
  s.push('        }');
  s.push('      }');
  s.push('    }catch(e){}');
  s.push('    return origFetch.apply(this,arguments);');
  s.push('  };');
  s.push('})();');
  s.push('');

  // ── Apply / GoToLine buttons on AI responses ───────────────────────────────
  s.push('function addApplyButtons(root){');
  s.push('  (root||document).querySelectorAll("pre code").forEach(function(block){');
  s.push('    if(block.dataset.vscDone) return;');
  s.push('    block.dataset.vscDone="1";');
  s.push('    var row=document.createElement("div");');
  s.push('    row.style.cssText="display:flex;gap:5px;margin:3px 0 2px;flex-wrap:wrap;";');
  s.push('    function mkBtn(label,bg,cb){');
  s.push('      var b=document.createElement("button");');
  s.push('      b.textContent=label;');
  s.push('      b.style.cssText="padding:2px 9px;border-radius:3px;font-size:11px;cursor:pointer;border:none;color:#fff;background:"+bg+";";');
  s.push('      b.onclick=cb; return b;');
  s.push('    }');
  s.push('    row.appendChild(mkBtn("⚡ Apply to File","#c96442",function(){');
  s.push('      if(vscApi) vscApi.postMessage({type:"applyEdit",code:block.textContent});');
  s.push('    }));');
  s.push('    row.appendChild(mkBtn("↵ Insert at Cursor","#3a3a3a",function(){');
  s.push('      if(vscApi) vscApi.postMessage({type:"insertAtCursor",code:block.textContent});');
  s.push('    }));');
  s.push('    block.parentNode.insertBefore(row,block);');
  s.push('  });');
  // Make file:line references clickable
  s.push('  (root||document).querySelectorAll(".message-content,.ai-message,p,li").forEach(function(el){');
  s.push('    if(el.dataset.lineLinked) return;');
  s.push('    el.dataset.lineLinked="1";');
  s.push('    el.innerHTML=el.innerHTML.replace(');
  s.push('      /`([^`]+\\.\\w+):(\\d+)`/g,');
  s.push('      function(match,file,line){');
  s.push('        return \'<a href="#" style="color:#c96442;text-decoration:underline;font-family:monospace;font-size:0.95em;" \'+');
  s.push('          \'data-vsc-file="\'+file+\'" data-vsc-line="\'+line+\'">\'+match+\'</a>\';');
  s.push('      }');
  s.push('    );');
  s.push('  });');
  s.push('  document.querySelectorAll("[data-vsc-file]").forEach(function(a){');
  s.push('    if(a.dataset.wired) return;');
  s.push('    a.dataset.wired="1";');
  s.push('    a.addEventListener("click",function(e){');
  s.push('      e.preventDefault();');
  s.push('      if(vscApi) vscApi.postMessage({type:"goToLine",filePath:a.dataset.vscFile,line:parseInt(a.dataset.vscLine)});');
  s.push('    });');
  s.push('  });');
  s.push('}');
  s.push('new MutationObserver(function(muts){');
  s.push('  muts.forEach(function(m){');
  s.push('    m.addedNodes.forEach(function(n){if(n.nodeType===1) addApplyButtons(n);});');
  s.push('  });');
  s.push('}).observe(document.body,{childList:true,subtree:true});');
  s.push('');

  // ── Context bar ────────────────────────────────────────────────────────────
  s.push('function injectCtxBar(){');
  s.push('  if(document.getElementById("ooumph-ctx-bar")) return;');
  s.push('  var anchor=document.querySelector(".compose")||document.querySelector("#compose")||document.querySelector("form");');
  s.push('  if(!anchor) return;');
  s.push('  var bar=document.createElement("div");');
  s.push('  bar.id="ooumph-ctx-bar";');
  s.push('  bar.style.cssText="display:none;align-items:center;gap:5px;padding:3px 8px;font-size:11px;color:#888;background:#1e1e1e;border-top:1px solid rgba(255,255,255,0.07);flex-wrap:wrap;";');
  s.push('  var lbl=document.createElement("span");');
  s.push('  lbl.id="ooumph-ctx-lbl";');
  s.push('  lbl.style.cssText="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;";');
  // Toggle
  s.push('  var tog=document.createElement("button");');
  s.push('  tog.textContent="Context ON";');
  s.push('  tog.style.cssText="padding:1px 6px;border-radius:3px;font-size:10px;border:none;cursor:pointer;background:#c96442;color:#fff;flex-shrink:0;";');
  s.push('  tog.onclick=function(){');
  s.push('    contextEnabled=!contextEnabled;');
  s.push('    tog.textContent=contextEnabled?"Context ON":"Context OFF";');
  s.push('    tog.style.background=contextEnabled?"#c96442":"#555";');
  s.push('  };');
  // Refresh workspace
  s.push('  var ref=document.createElement("button");');
  s.push('  ref.textContent="🔄";');
  s.push('  ref.title="Refresh workspace files";');
  s.push('  ref.style.cssText="padding:1px 5px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;";');
  s.push('  ref.onclick=function(){ if(vscApi) vscApi.postMessage({type:"refreshWorkspace"}); };');
  // Add file
  s.push('  var af=document.createElement("button");');
  s.push('  af.textContent="📂 Add File";');
  s.push('  af.style.cssText="padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;";');
  s.push('  af.onclick=function(){if(vscApi) vscApi.postMessage({type:"openFile"});};');
  // Open tabs
  s.push('  var ot=document.createElement("button");');
  s.push('  ot.textContent="📋 Open Tabs";');
  s.push('  ot.style.cssText="padding:1px 6px;border-radius:3px;font-size:10px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;background:#2a2a2a;color:#ccc;flex-shrink:0;";');
  s.push('  ot.onclick=function(){if(vscApi) vscApi.postMessage({type:"getOpenFiles"});};');
  s.push('  bar.appendChild(lbl);bar.appendChild(tog);bar.appendChild(ref);bar.appendChild(af);bar.appendChild(ot);');
  s.push('  anchor.parentNode.insertBefore(bar,anchor);');
  s.push('}');
  s.push('function updateCtxBar(){');
  s.push('  var bar=document.getElementById("ooumph-ctx-bar");');
  s.push('  var lbl=document.getElementById("ooumph-ctx-lbl");');
  s.push('  if(!bar) return;');
  s.push('  if(editorCtx.hasContext||workspaceFiles.length){');
  s.push('    bar.style.display="flex";');
  s.push('    var t="";');
  s.push('    if(editorCtx.hasContext) t=editorCtx.fileName+(editorCtx.selection?" — 🖍 selection":"")+" (line "+editorCtx.cursorLine+")";');
  s.push('    if(workspaceFiles.length) t+=(t?" · ":"")+workspaceFiles.length+" files indexed";');
  s.push('    if(lbl) lbl.textContent=t;');
  s.push('  }');
  s.push('}');
  s.push('');

  // Notification
  s.push('function showNotif(text,bg){');
  s.push('  var n=document.createElement("div");');
  s.push('  n.textContent=text;');
  s.push('  n.style.cssText="position:fixed;bottom:68px;left:50%;transform:translateX(-50%);padding:5px 14px;border-radius:5px;font-size:12px;color:#fff;z-index:9999;pointer-events:none;background:"+(bg||"#444")+";";');
  s.push('  document.body.appendChild(n);');
  s.push('  setTimeout(function(){n.remove();},2500);');
  s.push('}');
  s.push('');

  // ── wire() ─────────────────────────────────────────────────────────────────
  s.push('function wire(){');
  s.push('  try{if(window.__OOUMPH_ENDPOINT__) AZURE_BASE=window.__OOUMPH_ENDPOINT__;}catch(e){}');
  s.push('  try{if(window.__OOUMPH_KEY__)      AZURE_KEY=window.__OOUMPH_KEY__;}catch(e){}');
  s.push('  function on(sel,evt,fn){var el=typeof sel==="string"?document.querySelector(sel):sel;if(el) el.addEventListener(evt,fn);}');
  s.push('  on(".topbar-toggle","click",function(){toggleSidebar(false);});');
  s.push('  on("#sb-overlay","click",function(){toggleSidebar();});');
  s.push('  on(".btn-new","click",function(){newChat();});');
  s.push('  on("#tab-chats","click",function(){switchSbTab("chats");});');
  s.push('  on("#tab-graphify","click",function(){switchSbTab("graphify");});');
  s.push('  on("#search","input",function(){renderChatList();});');
  s.push('  on("#model-pill","click",function(){toggleModelDrop();});');
  s.push('  var icons=document.querySelectorAll(".topbar-icon");');
  s.push('  if(icons[0]) icons[0].addEventListener("click",function(){openGhModal();});');
  s.push('  if(icons[1]) icons[1].addEventListener("click",function(){openInstModal();});');
  s.push('  if(icons[2]) icons[2].addEventListener("click",function(){showHelp();});');
  s.push('  on("#input","keydown",function(e){onKey(e);});');
  s.push('  on("#input","input",function(){autoResize(this);updateSend();});');
  s.push('  on("#send-btn","click",function(){send();});');
  s.push('  on(".compose-btn:not(#sparkle-btn)","click",function(){var fi=document.getElementById("file-input");if(fi) fi.click();});');
  s.push('  on("#sparkle-btn","click",function(){toggleTray();});');
  s.push('  on("#file-input","change",function(){handleFiles(this.files);});');
  s.push('  on(".btn-add-skill","click",function(){openSkillPanel(null);});');
  s.push('  on(".topbar-icon.tray-close","click",function(){closeTray();});');
  s.push('  on("#btn-del-skill","click",function(){deleteSkillPanel();});');
  s.push('  var ib=document.querySelectorAll(".inst-modal button");');
  s.push('  if(ib[0]) ib[0].addEventListener("click",function(){closeInstModal();});');
  s.push('  if(ib[1]) ib[1].addEventListener("click",function(){saveInst();});');
  s.push('  var gb=document.querySelectorAll(".gh-modal button");');
  s.push('  if(gb[0]) gb[0].addEventListener("click",function(){closeGhModal();});');
  s.push('  if(gb[1]) gb[1].addEventListener("click",function(){saveGhSettings();});');
  s.push('  on(".ctx-rename","click",function(){ctxRename();});');
  s.push('  on(".ctx-star","click",function(){ctxStar();});');
  s.push('  on(".ctx-delete","click",function(){ctxDelete();});');
  s.push('  injectCtxBar();');
  s.push('  addApplyButtons();');
  s.push('  if(vscApi){ vscApi.postMessage({type:"getContext"}); }');
  s.push('}');
  s.push('if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",wire);}else{wire();}');
  s.push('})();');
  s.push('<\/script>');
  return s.join('\n');
}

// ---------------------------------------------------------------------------
// Cache
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

function getWebviewOptions() { return { enableScripts: true }; }

function getLoadingHtml() {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{background:#1a1a1a;color:#ccc;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    '.dot{animation:blink 1.2s infinite}.dot:nth-child(2){animation-delay:.4s}.dot:nth-child(3){animation-delay:.8s}' +
    '@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}</style></head>' +
    '<body><span>Loading Ooumph</span><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></body></html>';
}
function getErrorHtml(msg) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:system-ui;padding:24px;color:#ccc;background:#1a1a1a">' +
    '<strong style="color:#e05252">Failed to load Ooumph AI Chat</strong><br><br>' +
    '<code style="font-size:12px">' + (msg || 'Unknown error') + '</code><br><br>' +
    '<p style="font-size:13px">Check your internet and reload (<kbd>Ctrl+Shift+P</kbd> → <em>Developer: Reload Window</em>).</p>' +
    '</body></html>';
}

function deactivate() { if (panel) { panel.dispose(); panel = undefined; } }
module.exports = { activate, deactivate };
