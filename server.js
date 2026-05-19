const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const AZURE_BASE    = process.env.AZURE_BASE    || "https://ai-praveenmishraai8491456994967768.services.ai.azure.com";
const AZURE_API_KEY = process.env.AZURE_API_KEY || "Fq04ZUOnjv0YpY39JUp9YZ922aZqTpc7glsIpbBl2Ki11ZIAmb0qJQQJ99CEACYeBjFXJ3w3AAAAACOGQ9Nb";
const API_VERSION   = process.env.API_VERSION   || "2024-05-01-preview";
const PORT          = process.env.PORT          || 3000;
const AZURE_HOST    = AZURE_BASE.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const DEPLOYMENTS = [
  "DeepSeek-V4-Flash",
  "DeepSeek-V4-Flash-2",
  "DeepSeek-V4-Flash-3",
  "DeepSeek-V3-0324",
  "DeepSeek-V3.2",
  "Kimi-K2.6",
];

const SKILLS_FILE = path.join(__dirname, "skills.json");
const CHATS_FILE  = path.join(__dirname, "chats.json");

const DEFAULT_SKILLS = [
  { id:"code-expert",      name:"Code Expert",      description:"Senior engineer mode — detailed, production-ready code", icon:"💻", prompt:"You are a senior software engineer. Always write production-ready, well-commented code. Prefer explicit error handling. When showing code, always specify the language and add a brief explanation after." },
  { id:"concise",          name:"Concise Mode",     description:"Short, direct answers only",                             icon:"⚡", prompt:"Reply in as few words as possible. No preamble, no filler. Bullet points preferred. Max 3 sentences unless code is required." },
  { id:"document-analyst", name:"Document Analyst", description:"Extract, summarize and analyse uploaded documents",      icon:"📄", prompt:"You are a document analysis expert. When given a document, first provide a structured summary with key sections, then answer questions about it with direct references to the source text." },
  { id:"creative",         name:"Creative Writer",  description:"Rich, creative and expressive writing",                  icon:"✍️", prompt:"You are a creative writing assistant. Write with vivid language, strong narrative flow, and emotional depth. Always offer to iterate or explore alternate directions." },
];

const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".json":"application/json", ".ico":"image/x-icon" };

// ─── File helpers ─────────────────────────────────────────────────────────────
function initFile(p, def) { if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2)); }
function readJSON(p)       { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function writeJSON(p, d)   { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

initFile(SKILLS_FILE, DEFAULT_SKILLS);
initFile(CHATS_FILE, []);

// ─── Body parsers ─────────────────────────────────────────────────────────────
function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function parseMultipart(req) {
  const Busboy = require("busboy");
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
    const fields = {}, files = [];
    bb.on("field", (k, v) => fields[k] = v);
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => files.push({ filename: info.filename, mimetype: info.mimeType, buffer: Buffer.concat(chunks) }));
    });
    bb.on("close", () => resolve({ fields, files }));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function processFile({ filename, mimetype, buffer }) {
  if (mimetype.startsWith("image/"))
    return { type: "image_url", image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` } };
  if (mimetype === "application/pdf") {
    try {
      const data = await require("pdf-parse")(buffer);
      return { type: "text", text: `[PDF: ${filename}]\n\n${data.text}` };
    } catch { return { type: "text", text: `[PDF: ${filename}] (text extraction failed)` }; }
  }
  return { type: "text", text: `[File: ${filename}]\n\n${buffer.toString("utf8")}` };
}

// ─── Azure proxy (core — unchanged) ──────────────────────────────────────────
function proxyToAzure(payload, res) {
  const body = JSON.stringify({
    model:       (payload.deployment || DEPLOYMENTS[0]).trim(),
    messages:    payload.messages || [],
    max_tokens:  payload.max_tokens || 2000,
    temperature: payload.temperature ?? 0.7,
    stream:      true,
  });
  const opts = {
    hostname: AZURE_HOST,
    path:     `/models/chat/completions?api-version=${(payload.apiVersion || API_VERSION).trim()}`,
    method:   "POST",
    headers:  { "Content-Type": "application/json", "api-key": AZURE_API_KEY, "Content-Length": Buffer.byteLength(body) },
  };
  const azReq = https.request(opts, azRes => {
    res.writeHead(azRes.statusCode, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    azRes.on("data", c => res.write(c));
    azRes.on("end", () => res.end());
  });
  azReq.on("error", e => { if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: e.message })); } });
  azReq.write(body);
  azReq.end();
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const ok  = (d, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
  const err = (code, msg)     => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: msg })); };

  try {
    // ── Models ──
    if (pathname === "/api/models" && req.method === "GET")
      return ok({ models: DEPLOYMENTS, apiVersion: API_VERSION });

    // ── Skills ──
    if (pathname === "/api/skills") {
      if (req.method === "GET")  return ok(readJSON(SKILLS_FILE) || []);
      if (req.method === "POST") {
        const s = await parseJSONBody(req);
        s.id = s.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const skills = readJSON(SKILLS_FILE) || [];
        skills.push(s); writeJSON(SKILLS_FILE, skills);
        return ok(s, 201);
      }
    }
    const sm = pathname.match(/^\/api\/skills\/(.+)$/);
    if (sm) {
      const id = decodeURIComponent(sm[1]);
      const skills = readJSON(SKILLS_FILE) || [];
      if (req.method === "PUT") {
        const u = await parseJSONBody(req);
        const i = skills.findIndex(s => s.id === id);
        if (i < 0) return err(404, "Not found");
        skills[i] = { ...skills[i], ...u, id }; writeJSON(SKILLS_FILE, skills); return ok(skills[i]);
      }
      if (req.method === "DELETE") { writeJSON(SKILLS_FILE, skills.filter(s => s.id !== id)); res.writeHead(204); return res.end(); }
    }

    // ── Chats ──
    if (pathname === "/api/chats") {
      if (req.method === "GET") {
        const chats = readJSON(CHATS_FILE) || [];
        return ok(chats.map(c => ({ id: c.id, title: c.title, model: c.model, createdAt: c.createdAt, starred: c.starred })));
      }
      if (req.method === "POST") {
        const chat = await parseJSONBody(req);
        const chats = readJSON(CHATS_FILE) || [];
        const i = chats.findIndex(c => c.id === chat.id);
        if (i >= 0) chats[i] = { ...chats[i], ...chat }; else chats.unshift(chat);
        writeJSON(CHATS_FILE, chats); return ok({ ok: true });
      }
    }
    const cm = pathname.match(/^\/api\/chats\/(.+)$/);
    if (cm) {
      const id = decodeURIComponent(cm[1]);
      const chats = readJSON(CHATS_FILE) || [];
      if (req.method === "GET") {
        const c = chats.find(c => c.id === id);
        return c ? ok(c) : err(404, "Not found");
      }
      if (req.method === "DELETE") { writeJSON(CHATS_FILE, chats.filter(c => c.id !== id)); res.writeHead(204); return res.end(); }
    }

    // ── Chat proxy ──
    if (pathname === "/api/chat" && req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("multipart/form-data")) {
        const { fields, files } = await parseMultipart(req);
        const payload = JSON.parse(fields.payload || "{}");
        if (files.length) {
          const fc = await Promise.all(files.map(processFile));
          const msgs = payload.messages || [];
          let li = -1;
          for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === "user") { li = i; break; } }
          if (li >= 0) {
            const lm = msgs[li];
            const tc = typeof lm.content === "string" ? [{ type: "text", text: lm.content }] : (lm.content || []);
            msgs[li].content = [...tc, ...fc];
          }
          payload.messages = msgs;
        }
        return proxyToAzure(payload, res);
      }
      let b = "";
      req.on("data", c => b += c);
      req.on("end", () => {
        let p; try { p = JSON.parse(b); } catch { return err(400, "Invalid JSON"); }
        proxyToAzure(p, res);
      });
      return;
    }

    // ── Static files ──
    let fp = pathname === "/" ? "/index.html" : pathname;
    fp = path.join(__dirname, fp);
    fs.readFile(fp, (e, d) => {
      if (e) { res.writeHead(404); return res.end("404 Not Found"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "text/plain" });
      res.end(d);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) err(500, e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n✅  Azure AI Foundry Chat  →  http://localhost:${PORT}`);
  console.log(`   Base URL : ${AZURE_BASE}`);
  console.log(`   Models   : ${DEPLOYMENTS.join(", ")}\n`);
});
