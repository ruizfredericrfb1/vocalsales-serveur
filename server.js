// VocalSales — serveur
// Garde la clé API Anthropic côté serveur (jamais visible des élèves),
// vérifie le code de connexion de chaque élève, et applique un quota
// hebdomadaire (par défaut 2 h par semaine).

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const WEEKLY_LIMIT_MINUTES = Number(process.env.WEEKLY_LIMIT_MINUTES || 120);
// Voix OpenAI (facultatif) : si absent, le navigateur utilise sa propre voix.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
// Coût estimé (en minutes de quota) de chaque type d'appel.
const COST_TURN = 1;
const COST_EVAL = 3;

const STUDENTS_FILE = path.join(__dirname, "students.csv");
const USAGE_FILE = path.join(__dirname, "data", "usage.json");

if (!fs.existsSync(path.dirname(USAGE_FILE))) fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
if (!fs.existsSync(USAGE_FILE)) fs.writeFileSync(USAGE_FILE, "{}");

function loadStudents() {
  const raw = fs.readFileSync(STUDENTS_FILE, "utf8").trim().split("\n").slice(1);
  const map = new Map();
  for (const line of raw) {
    const [code, ...rest] = line.split(",");
    if (!code) continue;
    map.set(code.trim(), rest.join(",").trim() || "Élève");
  }
  return map;
}

function loadUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { return {}; }
}
function saveUsage(u) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
}
function isoWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

function getStudentUsage(code) {
  const usage = loadUsage();
  const week = isoWeekKey();
  const entry = usage[code];
  if (!entry || entry.week !== week) return { usage, week, minutes: 0 };
  return { usage, week, minutes: entry.minutes };
}

function consumeQuota(code, cost) {
  const { usage, week, minutes } = getStudentUsage(code);
  const next = minutes + cost;
  usage[code] = { week, minutes: next };
  saveUsage(usage);
  return next;
}

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireStudent(req, res, next) {
  const code = String(req.body.code || req.query.code || "").trim();
  const students = loadStudents();
  if (!code || !students.has(code)) {
    return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });
  }
  req.studentCode = code;
  req.studentName = students.get(code);
  next();
}

app.get("/api/status", requireStudent, (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  res.json({
    nom: req.studentName,
    minutesUtilisees: minutes,
    minutesLimite: WEEKLY_LIMIT_MINUTES,
    minutesRestantes: Math.max(0, WEEKLY_LIMIT_MINUTES - minutes)
  });
});

/* ---------- Voix OpenAI (facultatif) ---------- */
// Voix par défaut du catalogue OpenAI (changeables via variables d'environnement
// OPENAI_VOICE_MALE / OPENAI_VOICE_FEMALE si vous voulez essayer d'autres voix :
// alloy, echo, fable, onyx, nova, shimmer).
function openaiVoice(gender) {
  if (gender === "female") return process.env.OPENAI_VOICE_FEMALE || "nova";
  return process.env.OPENAI_VOICE_MALE || "onyx";
}

app.post("/api/speech", requireStudent, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ error: "voix_non_configuree" });
  }
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "requete_invalide" });
  const voice = openaiVoice(req.body.gender);

  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice,
        input: text,
        response_format: "mp3"
      })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("Erreur OpenAI TTS:", r.status, detail.slice(0, 300));
      return res.status(502).json({ error: "voix_erreur" });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("content-type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    console.error("Erreur OpenAI TTS:", e && e.message);
    res.status(502).json({ error: "voix_erreur" });
  }
});

function extractJson(text) {
  try { return JSON.parse(text.trim()); } catch { /* continue */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* continue */ } }
  return null;
}

async function callClaude(messages, maxTokens) {
  if (!ANTHROPIC_API_KEY) {
    const err = new Error("no_api_key");
    err.code = "no_api_key";
    throw err;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages })
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error("anthropic_error");
    err.code = "anthropic_error";
    err.detail = text.slice(0, 300);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const block = (data.content || []).find(b => b.type === "text");
  return block ? block.text : "";
}

// Remarque : le préremplissage de réponse ("assistant" en fin de liste) n'est
// pas supporté par ce modèle (Claude Sonnet 5) — on s'appuie donc uniquement
// sur la consigne stricte du prompt et sur l'extraction tolérante ci-dessus.
async function callClaudeJSON(messages, maxTokens) {
  return await callClaude(messages, maxTokens);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Essaie jusqu'à 3 fois, en silence, avant d'abandonner : un élève en oral
// d'examen ne doit (presque) jamais voir une erreur technique.
async function getValidReply(messages, maxTokens, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const text = await callClaudeJSON(messages, maxTokens);
      const parsed = extractJson(text);
      if (parsed && parsed.replique) return parsed;
      lastErr = { code: "reponse_invalide", raw: text };
    } catch (e) {
      lastErr = e;
      if (e.code === "no_api_key") throw e; // inutile de réessayer sans clé
    }
    if (i < attempts - 1) await sleep(400);
  }
  console.error("Échec après plusieurs tentatives:", lastErr);

  // Filet de sécurité : si Claude a quand même écrit une réplique plausible
  // (juste sans l'emballage JSON demandé), on l'utilise plutôt que de bloquer
  // l'élève avec une erreur — mieux vaut une réplique sans étiquette d'état
  // qu'un écran d'erreur en pleine conversation.
  const raw = lastErr && typeof lastErr.raw === "string" ? lastErr.raw.trim() : "";
  const looksUsable = raw.length > 0 && raw.length < 600 && !raw.startsWith("{") && !/^\s*<|^\s*```/.test(raw);
  if (looksUsable) return { replique: raw, etat: "en_cours" };

  const err = new Error(lastErr && lastErr.code || "reponse_invalide");
  err.code = lastErr && lastErr.code || "reponse_invalide";
  throw err;
}

// Un tour de dialogue (négociation ou oral) : renvoie {replique, etat}
app.post("/api/turn", requireStudent, async (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  if (minutes >= WEEKLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota hebdomadaire atteint. Réessayez la semaine prochaine." });
  }
  const messages = Array.isArray(req.body.messages) ? req.body.messages : null;
  if (!messages || !messages.length) return res.status(400).json({ error: "requete_invalide" });

  try {
    const parsed = await getValidReply(messages, 500);
    consumeQuota(req.studentCode, COST_TURN);
    res.json(parsed);
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "erreur", detail: e.detail || "" });
  }
});

// Évaluation finale : renvoie {text}
app.post("/api/evaluate", requireStudent, async (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  if (minutes >= WEEKLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota hebdomadaire atteint. Réessayez la semaine prochaine." });
  }
  const prompt = String(req.body.prompt || "");
  if (!prompt) return res.status(400).json({ error: "requete_invalide" });

  try {
    const text = await callClaude([{ role: "user", content: prompt }], 1200);
    consumeQuota(req.studentCode, COST_EVAL);
    res.json({ text });
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "erreur", detail: e.detail || "" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, clef: Boolean(ANTHROPIC_API_KEY) }));

app.listen(PORT, () => console.log("VocalSales serveur démarré sur le port " + PORT));
