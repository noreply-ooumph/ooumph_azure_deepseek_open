require("dotenv").config();
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const db = require("./db");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const AZURE_BASE = process.env.AZURE_BASE || "";
const AZURE_API_KEY = process.env.AZURE_API_KEY || "";
const API_VERSION = process.env.API_VERSION || "2024-05-01-preview";
const PORT = process.env.PORT || 3000;
const AZURE_HOST = AZURE_BASE.replace(/^https?:\/\//, "").replace(/\/+$/, "");

const DEPLOYMENTS = [
  "DeepSeek-V4-Flash",
  "DeepSeek-V4-Flash-2",
  "DeepSeek-V4-Flash-3",
  "DeepSeek-V3-0324",
  "DeepSeek-V3.2",
  "Kimi-K2.6",
];

const SKILLS_FILE = path.join(__dirname, "skills.json");
const CHATS_FILE = path.join(__dirname, "chats.json");

const DEFAULT_SKILLS = [
  { id:"code-expert", name:"Code Expert", description:"Senior engineer mode — production-ready code", icon:"💻", prompt:"You are a senior software engineer. Always write production-ready, well-commented code with explicit error handling. Specify the language for every code block and add a brief explanation after.", createdAt: new Date().toISOString() },
  { id:"concise", name:"Concise Mode", description:"Short, direct answers only", icon:"⚡", prompt:"Reply in as few words as possible. No preamble, no filler. Bullet points preferred. Max 3 sentences unless code is required.", createdAt: new Date().toISOString() },
  { id:"document-analyst", name:"Document Analyst", description:"Extract, summarise and analyse uploaded documents", icon:"📄", prompt:"You are a document analysis expert. When given a document, provide a structured summary with key sections, then answer questions with direct references to the source text.", createdAt: new Date().toISOString() },
  { id:"creative", name:"Creative Writer", description:"Rich, creative and expressive writing", icon:"✍️", prompt:"You are a creative writing assistant. Write with vivid language, strong narrative flow, and emotional depth. Always offer to iterate or explore alternate directions.", createdAt: new Date().toISOString() },
];

const MIME = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".json":"application/json", ".ico":"image/x-icon" };

// ─── File helpers ─────────────────────────────────────────────────────────────
function initFile(p, def) { if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2)); }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function writeJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

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

// ─── Azure proxy ──────────────────────────────────────────────────────────────
const azureAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function proxyToAzure(payload, res) {
  const body = JSON.stringify({
    model: (payload.deployment || DEPLOYMENTS[0]).trim(),
    messages: payload.messages || [],
    max_tokens: payload.max_tokens || 2048,
    temperature: payload.temperature ?? 0.3,
    top_p: payload.top_p ?? 0.9,
    stream: true,
  });
  const opts = {
    hostname: AZURE_HOST,
    path: `/models/chat/completions?api-version=${(payload.apiVersion || API_VERSION).trim()}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_API_KEY,
      "Content-Length": Buffer.byteLength(body),
    },
    agent: azureAgent,
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const azReq = https.request(opts, azRes => {
    azRes.on("data", chunk => {
      res.write(chunk);
      if (res.flush) res.flush();
    });
    azRes.on("end", () => res.end());
    azRes.on("error", () => { if (!res.writableEnded) res.end(); });
  });
  azReq.on("error", e => {
    if (!res.headersSent) { res.writeHead(502); }
    if (!res.writableEnded) res.end(JSON.stringify({ error: e.message }));
  });
  azReq.write(body);
  azReq.end();
}

// ─── Cosmos / JSON dual-mode helpers ─────────────────────────────────────────
async function cosmosGetAll(container, jsonFile) {
  if (db.isReady() && container) {
    const { resources } = await container.items.readAll().fetchAll();
    return resources;
  }
  return readJSON(jsonFile) || [];
}

async function cosmosUpsert(container, jsonFile, item) {
  if (db.isReady() && container) {
    await container.items.upsert(item);
    return;
  }
  const arr = readJSON(jsonFile) || [];
  const idx = arr.findIndex(x => x.id === item.id);
  if (idx >= 0) arr[idx] = item; else arr.push(item);
  writeJSON(jsonFile, arr);
}

async function cosmosDelete(container, jsonFile, id) {
  if (db.isReady() && container) {
    await container.item(id, id).delete();
    return;
  }
  const arr = (readJSON(jsonFile) || []).filter(x => x.id !== id);
  writeJSON(jsonFile, arr);
}

async function cosmosGetById(container, jsonFile, id) {
  if (db.isReady() && container) {
    try { const { resource } = await container.item(id, id).read(); return resource; } catch { return null; }
  }
  return (readJSON(jsonFile) || []).find(x => x.id === id) || null;
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const ok = (d, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
  const err = (code, msg) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: msg })); };

  try {
    // ── Models ────────────────────────────────────────────────────────────
    if (pathname === "/api/models" && req.method === "GET") {
      return ok({ deployments: DEPLOYMENTS });
    }

    // ── Firebase Config ───────────────────────────────────────────────────
    if (pathname === "/config" && req.method === "GET") {
      return ok({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }

    // ── Skills ────────────────────────────────────────────────────────────
    if (pathname === "/api/skills") {
      const sc = db.getSkillsContainer();
      if (req.method === "GET") {
        return ok(await cosmosGetAll(sc, SKILLS_FILE));
      }
      if (req.method === "POST") {
        const body = await parseJSONBody(req);
        const skill = { ...body, id: body.id || `skill-${Date.now()}`, createdAt: body.createdAt || new Date().toISOString() };
        await cosmosUpsert(sc, SKILLS_FILE, skill);
        return ok(skill, 201);
      }
    }

    const skillMatch = pathname.match(/^\/api\/skills\/(.+)$/);
    if (skillMatch) {
      const id = decodeURIComponent(skillMatch[1]);
      const sc = db.getSkillsContainer();
      if (req.method === "PUT") {
        const body = await parseJSONBody(req);
        const skill = { ...body, id };
        await cosmosUpsert(sc, SKILLS_FILE, skill);
        return ok(skill);
      }
      if (req.method === "DELETE") {
        await cosmosDelete(sc, SKILLS_FILE, id);
        return ok({ ok: true });
      }
    }

    // ── Chats ─────────────────────────────────────────────────────────────
    if (pathname === "/api/chats") {
      const cc = db.getChatsContainer();
      if (req.method === "GET") {
        const chats = await cosmosGetAll(cc, CHATS_FILE);
        return ok(chats.map(c => ({ id:c.id, title:c.title, model:c.model, createdAt:c.createdAt, updatedAt:c.updatedAt, starred:c.starred })));
      }
      if (req.method === "POST") {
        const body = await parseJSONBody(req);
        const chat = {
          id: body.id || `chat-${Date.now()}`,
          title: (body.messages?.find(m => m.role === "user")?.content?.slice(0, 40) || "New Chat"),
          model: body.model || body.deployment || DEPLOYMENTS[0],
          messages: body.messages || [],
          createdAt: body.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          starred: body.starred || false,
          systemPrompt: body.systemPrompt || "",
        };
        await cosmosUpsert(cc, CHATS_FILE, chat);
        return ok(chat);
      }
    }

    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)(\/star)?$/);
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1]);
      const isStar = !!chatMatch[2];
      const cc = db.getChatsContainer();
      if (req.method === "GET" && !isStar) {
        const chat = await cosmosGetById(cc, CHATS_FILE, id);
        return chat ? ok(chat) : err(404, "not found");
      }
      if (req.method === "DELETE" && !isStar) {
        await cosmosDelete(cc, CHATS_FILE, id);
        return ok({ ok: true });
      }
      if (req.method === "PATCH" && isStar) {
        const chat = await cosmosGetById(cc, CHATS_FILE, id);
        if (!chat) return err(404, "not found");
        chat.starred = !chat.starred;
        chat.updatedAt = new Date().toISOString();
        await cosmosUpsert(cc, CHATS_FILE, chat);
        return ok({ starred: chat.starred });
      }
    }

    // ── Chat (proxy) ──────────────────────────────────────────────────────
    if (pathname === "/api/chat" && req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      let payload;

      if (ct.includes("multipart/form-data")) {
        const { fields, files } = await parseMultipart(req);
        payload = JSON.parse(fields.payload || "{}");
        const userMsg = payload.messages?.at(-1);

        for (const f of files) {
          const part = await processFile(f);
          if (part.type === "image_url") {
            if (!Array.isArray(userMsg.content)) userMsg.content = [{ type: "text", text: userMsg.content || "" }];
            userMsg.content.push(part);
          } else {
            payload.messages = [{ role: "system", content: `The user has uploaded a file. Extracted content:\n\n${part.text}` }, ...payload.messages];
          }
        }
      } else {
        payload = await parseJSONBody(req);
      }

      if (Array.isArray(payload.skills) && payload.skills.length > 0) {
        const allSkills = await cosmosGetAll(db.getSkillsContainer(), SKILLS_FILE);
        const active = allSkills.filter(s => payload.skills.includes(s.id));
        if (active.length > 0) {
          const systemContent = active.map(s => s.prompt).join("\n\n");
          payload.messages = [{ role: "system", content: systemContent }, ...payload.messages.filter(m => m.role !== "system")];
        }
      }

      return proxyToAzure(payload, res);
    }

    // ── Static files ──────────────────────────────────────────────────────
    let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      return fs.createReadStream(filePath).pipe(res);
    }

    err(404, "not found");
  } catch (e) {
    console.error(e);
    err(500, e.message);
  }
});

db.init().then(() => {
  server.listen(PORT, () => console.log(` Server running on http://localhost:${PORT}`));
});
