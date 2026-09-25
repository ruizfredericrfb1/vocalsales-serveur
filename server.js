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
// Voix Azure (facultatif) : si absent, le navigateur utilise sa propre voix.
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || "";
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "";
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

/* ---------- Voix Azure (facultatif) ---------- */
let azureTokenCache = { token: "", expiresAt: 0 };

async function getAzureToken() {
  if (azureTokenCache.token && Date.now() < azureTokenCache.expiresAt) return azureTokenCache.token;
  const r = await fetch(`https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY, "content-length": "0" }
  });
  if (!r.ok) throw new Error("azure_token_error");
  const token = await r.text();
  azureTokenCache = { token, expiresAt: Date.now() + 9 * 60 * 1000 };
  return token;
}

function azureVoice(gender) {
  return gender === "female" ? "fr-FR-DeniseNeural" : "fr-FR-HenriNeural";
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

app.post("/api/speech", requireStudent, async (req, res) => {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    return res.status(503).json({ error: "azure_non_configure" });
  }
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "requete_invalide" });
  const voice = azureVoice(req.body.gender);
  const ssml = `<speak version="1.0" xml:lang="fr-FR"><voice name="${voice}">${escapeXml(text)}</voice></speak>`;

  try {
    const token = await getAzureToken();
    const r = await fetch(`https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + token,
        "content-type": "application/ssml+xml",
        "x-microsoft-outputformat": "audio-16khz-64kbitrate-mono-mp3"
      },
      body: ssml
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("Erreur Azure TTS:", r.status, detail.slice(0, 300));
      return res.status(502).json({ error: "azure_error" });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("content-type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    console.error("Erreur Azure TTS:", e && e.message);
    res.status(502).json({ error: "azure_error" });
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
