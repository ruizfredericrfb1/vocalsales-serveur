// VocalSales — serveur
// Garde la clé API Anthropic côté serveur (jamais visible des élèves),
// vérifie le code de connexion de chaque élève, et applique un quota
// mensuel (par défaut 85 minutes par mois civil).

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const MONTHLY_LIMIT_MINUTES = Number(process.env.MONTHLY_LIMIT_MINUTES || 85);
// Seuil (en minutes restantes) en dessous duquel on avertit explicitement l'élève.
const WARNING_THRESHOLD_MINUTES = Number(process.env.WARNING_THRESHOLD_MINUTES || 5);
// Supabase (facultatif) : garde un historique permanent des évaluations.
// Si absent, tout continue de fonctionner normalement, juste sans historique.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
// Mot de passe pour la page enseignant (gestion des élèves sans passer par GitHub).
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || "ORT2026";
// Voix OpenAI (facultatif) : si absent, le navigateur utilise sa propre voix.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "tts-1";
// Vitesse d'élocution (0.25 à 4.0 ; 1.0 = normal). Réglable via OPENAI_TTS_SPEED.
const OPENAI_TTS_SPEED = Number(process.env.OPENAI_TTS_SPEED || 1.15);
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
  // Écriture atomique : on écrit dans un fichier temporaire puis on le
  // renomme, pour ne jamais laisser un fichier à moitié écrit en cas de
  // plantage pile pendant la sauvegarde.
  const tmp = USAGE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
  fs.renameSync(tmp, USAGE_FILE);
}
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getStudentUsage(code) {
  const usage = loadUsage();
  const month = monthKey();
  const entry = usage[code];
  if (!entry || entry.month !== month) return { usage, month, minutes: 0 };
  return { usage, month, minutes: entry.minutes };
}

function consumeQuota(code, cost) {
  const { usage, month, minutes } = getStudentUsage(code);
  const next = minutes + cost;
  usage[code] = { month, minutes: next };
  saveUsage(usage);
  return next;
}

const app = express();
app.set("trust proxy", true); // Render est derrière un proxy : nécessaire pour obtenir la vraie IP du visiteur
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Élèves : Supabase en priorité, fichier CSV en secours ---------- */
function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}
async function findStudentInSupabase(code) {
  if (!supabaseConfigured()) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/students?code=eq.${encodeURIComponent(code)}&active=eq.true&select=code,nom`,
      { headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch (e) {
    console.error("Erreur lecture élève Supabase:", e && e.message);
    return null; // en cas de souci réseau, on retombe sur le CSV plutôt que de bloquer l'élève
  }
}

async function requireStudent(req, res, next) {
  const code = String(req.body.code || req.query.code || "").trim();
  if (!code) return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });

  const fromSupabase = await findStudentInSupabase(code);
  if (fromSupabase) {
    req.studentCode = code;
    req.studentName = fromSupabase.nom;
    return next();
  }

  const students = loadStudents(); // repli : ancien fichier CSV
  if (!students.has(code)) {
    return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });
  }
  req.studentCode = code;
  req.studentName = students.get(code);
  next();
}

/* ---------- Espace enseignant : ajouter des élèves sans passer par GitHub ---------- */
// Limite de tentatives : après 8 essais incorrects, on bloque 5 minutes.
// Simple et suffisant pour un usage à l'échelle d'un établissement — pas
// conçu pour résister à une attaque distribuée depuis de nombreuses adresses.
const TEACHER_LOGIN_MAX_ATTEMPTS = 8;
const TEACHER_LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const teacherLoginAttempts = new Map(); // ip -> { count, lockedUntil }

function checkTeacherPassword(req, res) {
  const ip = req.ip || req.socket.remoteAddress || "inconnu";
  const now = Date.now();
  const entry = teacherLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (entry.lockedUntil > now) {
    const minutes = Math.ceil((entry.lockedUntil - now) / 60000);
    res.status(429).json({ error: "trop_de_tentatives", message: `Trop de tentatives incorrectes. Réessayez dans ${minutes} min.` });
    return false;
  }

  // Le mot de passe voyage désormais dans un en-tête plutôt que dans
  // l'adresse (?password=...), pour ne pas finir dans l'historique du
  // navigateur ni d'éventuels journaux d'accès.
  const password = String(req.headers["x-teacher-password"] || req.body.password || "");
  if (password !== TEACHER_PASSWORD) {
    entry.count += 1;
    if (entry.count >= TEACHER_LOGIN_MAX_ATTEMPTS) {
      entry.lockedUntil = now + TEACHER_LOGIN_LOCKOUT_MS;
      entry.count = 0;
    }
    teacherLoginAttempts.set(ip, entry);
    res.status(401).json({ error: "mot_de_passe_invalide", message: "Mot de passe enseignant incorrect." });
    return false;
  }

  teacherLoginAttempts.delete(ip); // succès : on oublie les essais précédents
  return true;
}

async function generateUniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const existing = await findStudentInSupabase(code);
    if (!existing) return code;
  }
  throw new Error("Impossible de générer un code unique après 20 essais.");
}

app.get("/api/teacher/students", async (req, res) => {
  if (!checkTeacherPassword(req, res)) return;
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Base élèves non configurée." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/students?select=code,nom,classe,active,created_at&order=created_at.desc`, {
      headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` }
    });
    const rows = await r.json();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    res.status(502).json({ error: "supabase_erreur", message: "Impossible de charger la liste des élèves." });
  }
});

app.post("/api/teacher/students", async (req, res) => {
  if (!checkTeacherPassword(req, res)) return;
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Base élèves non configurée." });
  const nom = String(req.body.nom || "").trim().slice(0, 120);
  const classe = String(req.body.classe || "").trim().slice(0, 80);
  if (!nom) return res.status(400).json({ error: "requete_invalide", message: "Le nom est obligatoire." });

  try {
    const code = await generateUniqueCode();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/students`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "prefer": "return=representation"
      },
      body: JSON.stringify({ code, nom, classe: classe || null, active: true })
    });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("Erreur création élève:", e && e.message);
    res.status(502).json({ error: "supabase_erreur", message: "Impossible de créer l'élève." });
  }
});

app.get("/api/status", requireStudent, (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  const minutesRestantes = Math.max(0, MONTHLY_LIMIT_MINUTES - minutes);
  res.json({
    nom: req.studentName,
    minutesUtilisees: minutes,
    minutesLimite: MONTHLY_LIMIT_MINUTES,
    minutesRestantes,
    avertissement: minutesRestantes > 0 && minutesRestantes <= WARNING_THRESHOLD_MINUTES
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
        response_format: "mp3",
        speed: OPENAI_TTS_SPEED
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

/* ---------- Historique des évaluations (Supabase, facultatif) ---------- */
function extractScore(text) {
  const m = String(text || "").match(/NOTE GLOBALE\s*:\s*([\d]+(?:[.,][\d]+)?)\s*\/\s*20/i);
  return m ? Number(m[1].replace(",", ".")) : null;
}

async function saveEvaluation({ code, name, diploma, evaluationText, transcript }) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return; // pas configuré : on ignore silencieusement
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/evaluations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "prefer": "return=minimal"
      },
      body: JSON.stringify({
        student_code: code,
        student_name: name,
        diploma: diploma || null,
        score: extractScore(evaluationText),
        evaluation_text: evaluationText,
        transcript: transcript || null
      })
    });
  } catch (e) {
    console.error("Erreur enregistrement Supabase:", e && e.message);
  }
}

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
  if (minutes >= MONTHLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota mensuel atteint. Réessayez le mois prochain." });
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
  if (minutes >= MONTHLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota mensuel atteint. Réessayez le mois prochain." });
  }
  const prompt = String(req.body.prompt || "");
  const diploma = String(req.body.diploma || "").slice(0, 200);
  const transcript = String(req.body.transcript || "").slice(0, 20000);
  if (!prompt) return res.status(400).json({ error: "requete_invalide" });

  try {
    const text = await callClaude([{ role: "user", content: prompt }], 1200);
    consumeQuota(req.studentCode, COST_EVAL);
    saveEvaluation({ code: req.studentCode, name: req.studentName, diploma, evaluationText: text, transcript });
    res.json({ text });
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "erreur", detail: e.detail || "" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, clef: Boolean(ANTHROPIC_API_KEY) }));

// Filet de sécurité : si jamais un message dépasse quand même la limite,
// on renvoie une vraie erreur JSON exploitable par le client, plutôt que
// de laisser Express répondre en texte brut (ce qui donnait un message
// générique et peu clair à l'élève).
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "message_trop_volumineux", message: "Votre échange est devenu trop long pour être envoyé d'un coup. Terminez l'oral et consultez votre évaluation, puis recommencez une nouvelle session si besoin." });
  }
  console.error("Erreur non gérée:", err && err.message);
  res.status(500).json({ error: "erreur_serveur", message: "Une erreur inattendue est survenue. Réessayez." });
});

app.listen(PORT, () => console.log("VocalSales serveur démarré sur le port " + PORT));
