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
const COST_POSITIONNEMENT = 2; // point hebdomadaire E31/E32 : plus court qu'une évaluation E33

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

/* ---------- Référentiel E31/E32 (point hebdomadaire) ----------
   Source : grilles officielles CCF Bac Pro MCV (Vente-conseil E31,
   Suivi des ventes E32). Échelle à 4 niveaux nommés, comme sur les
   grilles réelles : Novice / Débrouillé / Averti / Expert. */
const NIVEAUX = ["Novice", "Débrouillé", "Averti", "Expert"];

const COMMUNICATION_CRITERE = {
  nom: "Adaptation de la communication verbale et non verbale au contexte de la vente",
  niveaux: [
    "S'exprime avec difficulté en n'adaptant pas sa communication non verbale",
    "S'exprime avec des approximations concernant la clarté de ses propos et sa communication non verbale",
    "S'exprime clairement et met en œuvre une communication non verbale adaptée",
    "S'exprime clairement et met en œuvre un vocabulaire et une communication non verbale professionnels et adaptés au contexte de la vente"
  ]
};

const COMPETENCES_E31E32 = {
  "C1.1": {
    bloc: 1, epreuve: "E31", libelle: "Assurer la veille commerciale",
    criteres: [{
      nom: "Qualité, maîtrise et utilisation pertinente des informations relevées et sélectionnées sur le marché, l'entreprise et ses produits",
      niveaux: [
        "Ne collecte pas les informations issues du marché, de l'entreprise et de ses produits",
        "Collecte des informations partielles et/ou imprécises",
        "Collecte, hiérarchise et sélectionne correctement les informations",
        "Collecte, hiérarchise, sélectionne correctement les informations et les exploite de façon pertinente"
      ]
    }]
  },
  "C1.2": {
    bloc: 1, epreuve: "E31", libelle: "Réaliser la vente dans un cadre omnicanal",
    criteres: [
      {
        nom: "Qualité du questionnement, de l'écoute et de la reformulation des besoins du client",
        niveaux: [
          "Ne questionne pas et n'est pas à l'écoute des besoins du client",
          "Réalise un questionnement imprécis et pratique une écoute superficielle",
          "Procède à un questionnement permettant de cerner les principaux besoins et attentes. Écoute le client et reformule les principaux apports du questionnement",
          "Réalise un questionnement de nature à identifier l'ensemble des besoins et attentes du client en appliquant les principes de l'écoute active (empathie, reformulation, assertivité)"
        ]
      },
      {
        nom: "Proposition d'une offre de produits et/ou de services adaptée et cohérente",
        niveaux: [
          "Ne propose pas d'offre de produits et/ou services",
          "Propose une offre de produits et/ou de services peu adaptée qui répond partiellement aux attentes du client",
          "Propose une offre de produits et/ou de services qui répond aux principaux besoins et attentes du client",
          "Propose une offre de produits et/ou de services répondant aux principaux besoins et attentes du client et s'assure de son adhésion"
        ]
      },
      {
        nom: "Mise en œuvre d'une argumentation convaincante et efficace",
        niveaux: [
          "Ne réalise pas d'argumentation",
          "Réalise une argumentation peu cohérente",
          "Réalise une argumentation adaptée",
          "Réalise une argumentation adaptée dont l'efficacité est renforcée par une communication verbale et non-verbale convaincantes"
        ]
      }
    ]
  },
  "C1.3": {
    bloc: 1, epreuve: "E31", libelle: "Assurer l'exécution de la vente",
    criteres: [{
      nom: "Mise en place des modalités de règlement et de livraison conformes aux engagements pris vis-à-vis du client, aux intérêts de l'entreprise ainsi qu'à la législation et à la réglementation en vigueur",
      niveaux: [
        "Ne met pas en place de modalités de règlement, ni de livraison",
        "Met approximativement en place des modalités de règlement et de livraison",
        "Met correctement en place des modalités de règlement et de livraison",
        "Met correctement en place des modalités de règlement et de livraison et se montre capable d'orienter le client vers le choix qui concilie au mieux ses intérêts et ceux de l'entreprise"
      ]
    }]
  },
  "C2.1": {
    bloc: 2, epreuve: "E32", libelle: "Assurer le suivi de la commande du produit et/ou du service",
    criteres: [{
      nom: "Traitement du suivi de la commande",
      niveaux: [
        "N'assure aucun suivi de la commande",
        "Réalise de façon partielle le suivi de la commande",
        "Traite correctement le suivi de la commande",
        "Traite correctement le suivi de la commande et informe le client des délais et des modalités de mise à disposition"
      ]
    }]
  },
  "C2.2": {
    bloc: 2, epreuve: "E32", libelle: "Assurer les services associés à la vente",
    criteres: [{
      nom: "Mise en œuvre du ou des services associés",
      niveaux: [
        "Ne met pas en œuvre le ou les services associés",
        "Met en œuvre avec des omissions ou des erreurs le ou les services associés",
        "Met en œuvre correctement le ou les services associés",
        "Met en œuvre correctement le ou les services associés et en assure le suivi"
      ]
    }]
  },
  "C2.3": {
    bloc: 2, epreuve: "E32", libelle: "Traiter les retours et les réclamations du client",
    criteres: [
      {
        nom: "Écoute et diagnostic du ou des problèmes rencontrés par le client",
        niveaux: [
          "Ne questionne pas le client",
          "Questionne sommairement le client",
          "Questionne de façon pertinente le client pour identifier le ou les problèmes rencontrés",
          "Questionne de façon pertinente le client pour identifier le ou les problèmes rencontrés et reformule le ou les problèmes rencontrés par celui-ci"
        ]
      },
      {
        nom: "Proposition d'une solution adaptée",
        niveaux: [
          "Ne propose pas de solution",
          "Propose une solution partiellement adaptée au(x) problème(s) du client",
          "Propose une solution adaptée au(x) problème(s) rencontré(s) par le client",
          "Propose une solution adaptée au(x) problème(s) rencontré(s) par le client et s'assure de son adhésion"
        ]
      }
    ]
  },
  "C2.4": {
    bloc: 2, epreuve: "E32", libelle: "S'assurer de la satisfaction du client",
    criteres: [
      {
        nom: "Recueil et analyse de l'information sur la satisfaction client",
        niveaux: [
          "Ne collecte pas d'informations sur la satisfaction client",
          "Recherche et saisit des informations incomplètes sur la satisfaction client",
          "Transmet une information exploitable sur la satisfaction client",
          "Transmet une information exploitable sur la satisfaction client et en fait une analyse"
        ]
      },
      {
        nom: "Préconisation d'actions d'amélioration",
        niveaux: [
          "Ne préconise pas d'action d'amélioration de la satisfaction client",
          "Préconise des actions d'amélioration inadaptées aux attentes du client",
          "Préconise des actions d'amélioration adaptées aux attentes du client",
          "Préconise des actions d'amélioration adaptées aux attentes du client et au contexte de l'entreprise"
        ]
      }
    ]
  }
};

function competenceOrNull(code) {
  return COMPETENCES_E31E32[String(code || "").trim()] || null;
}

const app = express();
app.set("trust proxy", true); // Render est derrière un proxy : nécessaire pour obtenir la vraie IP du visiteur
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Élèves : Supabase en priorité, fichier CSV en secours ---------- */
function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}
// Résultat : { status: "found", student } | { status: "absent" } | { status: "indisponible" }
// "absent" = la base répond et ce code n'existe pas (ou n'est plus actif) : refus net.
// "indisponible" = la base ne répond pas (panne, mise en pause) : seul cas où l'on
// se rabat sur l'ancien fichier CSV, pour ne pas bloquer tous les élèves.
async function lookupStudent(code, { activeOnly = true } = {}) {
  if (!supabaseConfigured()) return { status: "indisponible" };
  try {
    const filter = activeOnly ? "&active=eq.true" : "";
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/students?code=eq.${encodeURIComponent(code)}${filter}&select=code,nom,active,option_choice`,
      { headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` } }
    );
    if (!r.ok) {
      console.error("Base élèves : réponse HTTP", r.status);
      return { status: "indisponible" };
    }
    const rows = await r.json();
    return rows[0] ? { status: "found", student: rows[0] } : { status: "absent" };
  } catch (e) {
    console.error("Erreur lecture élève Supabase:", e && e.message);
    return { status: "indisponible" };
  }
}

async function requireStudent(req, res, next) {
  const code = String(req.body.code || req.query.code || "").trim();
  if (!code) return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });

  const found = await lookupStudent(code);
  if (found.status === "found") {
    req.studentCode = code;
    req.studentName = found.student.nom;
    req.studentOption = found.student.option_choice || null; // "A" | "B" | null (pas encore choisie)
    return next();
  }
  if (found.status === "absent") {
    return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });
  }

  // Base indisponible : repli sur l'ancien fichier CSV
  const students = loadStudents();
  if (!students.has(code)) {
    return res.status(401).json({ error: "code_invalide", message: "Code de connexion inconnu." });
  }
  req.studentCode = code;
  req.studentName = students.get(code);
  req.studentOption = null;
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
    // On vérifie parmi TOUS les codes, y compris désactivés : un code désactivé
    // ne doit jamais être réattribué à quelqu'un d'autre.
    const existing = await lookupStudent(code, { activeOnly: false });
    if (existing.status === "absent") return code;
    if (existing.status === "indisponible") throw new Error("Base élèves indisponible.");
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
    avertissement: minutesRestantes > 0 && minutesRestantes <= WARNING_THRESHOLD_MINUTES,
    option: req.studentOption
  });
});

// L'élève choisit son option (A ou B) une fois, au premier passage sur le
// module E31/E32 — nécessaire pour que les mises en situation fictives
// restent cohérentes avec son type de vente (magasin vs B2B/rendez-vous).
app.post("/api/student/option", requireStudent, async (req, res) => {
  const option = String(req.body.option || "").trim().toUpperCase();
  if (option !== "A" && option !== "B") {
    return res.status(400).json({ error: "requete_invalide", message: "Option A ou B attendue." });
  }
  if (!supabaseConfigured()) {
    return res.status(503).json({ error: "supabase_non_configure", message: "Non disponible pour le moment." });
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/students?code=eq.${encodeURIComponent(req.studentCode)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "prefer": "return=minimal"
      },
      body: JSON.stringify({ option_choice: option })
    });
    if (!r.ok) throw new Error(await r.text());
    res.json({ ok: true, option });
  } catch (e) {
    console.error("Erreur enregistrement option:", e && e.message);
    res.status(502).json({ error: "supabase_erreur", message: "Impossible d'enregistrer votre option." });
  }
});

/* ---------- Point hebdomadaire E31/E32 : compétence de la semaine ---------- */
app.get("/api/competences", (req, res) => {
  // Référentiel public (contenu pédagogique, pas de donnée personnelle) : utile
  // au menu déroulant de la page enseignant pour choisir la compétence de la semaine.
  const list = Object.entries(COMPETENCES_E31E32).map(([code, c]) => ({ code, bloc: c.bloc, epreuve: c.epreuve, libelle: c.libelle }));
  res.json(list);
});

app.get("/api/weekly-focus", requireStudent, async (req, res) => {
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Non disponible pour le moment." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/weekly_focus?select=competence_code,set_at&order=set_at.desc&limit=1`, {
      headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` }
    });
    const rows = await r.json();
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "non_defini", message: "L'enseignant n'a pas encore choisi la compétence de la semaine." });
    const comp = competenceOrNull(row.competence_code);
    if (!comp) return res.status(404).json({ error: "non_defini", message: "Compétence introuvable." });
    res.json({ code: row.competence_code, libelle: comp.libelle, bloc: comp.bloc, epreuve: comp.epreuve, setAt: row.set_at });
  } catch (e) {
    console.error("Erreur lecture compétence de la semaine:", e && e.message);
    res.status(502).json({ error: "supabase_erreur", message: "Impossible de charger la compétence de la semaine." });
  }
});

app.get("/api/teacher/weekly-focus", async (req, res) => {
  if (!checkTeacherPassword(req, res)) return;
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Non disponible pour le moment." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/weekly_focus?select=competence_code,set_at&order=set_at.desc&limit=1`, {
      headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` }
    });
    const rows = await r.json();
    const row = rows[0];
    if (!row) return res.json({ code: null });
    const comp = competenceOrNull(row.competence_code);
    res.json({ code: row.competence_code, libelle: comp ? comp.libelle : null, setAt: row.set_at });
  } catch (e) {
    res.status(502).json({ error: "supabase_erreur", message: "Impossible de charger la compétence de la semaine." });
  }
});

app.post("/api/teacher/weekly-focus", async (req, res) => {
  if (!checkTeacherPassword(req, res)) return;
  const code = String(req.body.code || "").trim();
  const comp = competenceOrNull(code);
  if (!comp) return res.status(400).json({ error: "requete_invalide", message: "Code de compétence inconnu." });
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Non disponible pour le moment." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/weekly_focus`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
        "authorization": `Bearer ${SUPABASE_SECRET_KEY}`,
        "prefer": "return=minimal"
      },
      body: JSON.stringify({ competence_code: code })
    });
    if (!r.ok) throw new Error(await r.text());
    res.status(201).json({ ok: true, code, libelle: comp.libelle });
  } catch (e) {
    console.error("Erreur enregistrement compétence de la semaine:", e && e.message);
    res.status(502).json({ error: "supabase_erreur", message: "Impossible d'enregistrer la compétence de la semaine." });
  }
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

/* ---------- Historique des positionnements E31/E32 (Supabase) ---------- */
function extractNiveauGlobal(text) {
  const m = String(text || "").match(/NIVEAU GLOBAL\s*:\s*(Novice|Débrouillé|Averti|Expert)/i);
  return m ? m[1] : null;
}

async function savePositionnement({ code, name, option, competenceCode, competenceLibelle, evaluationText, transcript }) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/positionnements`, {
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
        option_choice: option || null,
        competence_code: competenceCode,
        competence_libelle: competenceLibelle,
        niveau_global: extractNiveauGlobal(evaluationText),
        evaluation_text: evaluationText,
        transcript: transcript || null
      })
    });
  } catch (e) {
    console.error("Erreur enregistrement positionnement Supabase:", e && e.message);
  }
}

/* ---------- Prompt du professionnel — point hebdomadaire E31/E32 ---------- */
function contexteOption(option) {
  if (option === "B") {
    return "L'élève est en option B (Prospection Clientèle et Valorisation de l'Offre Commerciale) : ses mises en situation relèvent typiquement d'une vente sur rendez-vous ou en B2B (banque, assurance, immobilier, automobile, agence de communication...), pas d'une vente spontanée en rayon.";
  }
  return "L'élève est en option A (Animation et Gestion de l'Espace Commercial) : ses mises en situation relèvent typiquement d'une vente en magasin, avec une clientèle qui entre spontanément dans l'espace de vente.";
}

function POSITIONNEMENT_RULES(competence, option) {
  const criteresTxt = competence.criteres.map(c => `- ${c.nom}`).join("\n");
  return `Tu es un professionnel du secteur commerce/vente qui suit un(e) apprenti(e) de Bac Pro MCV tout au long de l'année, lors d'un point rapide hebdomadaire de 7 minutes en classe — pas un examen, un point d'étape régulier.

${contexteOption(option)}

LA COMPÉTENCE VISÉE AUJOURD'HUI (${competence.epreuve}) : "${competence.libelle}"
Les points précis à explorer :
${criteresTxt}

DÉROULEMENT ATTENDU :
1. Commence TOUJOURS par chercher un vécu réel : demande à l'élève s'il lui est arrivé récemment, en entreprise (PFMP), de vivre une situation en lien avec cette compétence. Une seule question ouverte pour démarrer.
2. S'il a un exemple réel : creuse-le avec 1 à 2 relances précises pour vérifier qu'il maîtrise vraiment les points ci-dessus, pas seulement qu'il décrit les faits.
3. S'il n'a PAS d'exemple réel (trop tôt dans l'année, jamais rencontré cette situation chez son employeur), bascule sur une mise en situation fictive et courte : invente un contexte précis et inédit (un client, un produit, une situation), cohérent avec son option, et demande-lui de réagir comme s'il y était. Ne réutilise jamais un contexte générique ou déjà vu — invente un décor concret à chaque fois.
4. Distingue toujours clairement, dans tes questions, si tu parles du VÉCU RÉEL de l'élève ou d'une MISE EN SITUATION fictive — ne mélange jamais les deux sans que ce soit explicite.
5. Reste concentré sur la seule compétence du jour — ne dévie pas vers d'autres compétences.

RÈGLES :
- Tu es UNIQUEMENT ce professionnel. Ne donne jamais la réponse, ne sors jamais du rôle.
- Une seule réplique courte à la fois, 1 question maximum.
- Registre oral naturel : phrases courtes, parfois inachevées, hésitations légères ("bon", "donc", "alors").
- N'ouvre jamais par "merci", "d'accord", "très bien" — enchaîne directement sur le fond.
- Ne redis jamais mot pour mot une réplique déjà dite dans cet échange.
- Passe "etat" à "conclu" après 2 à 4 échanges de fond avec l'élève (le format est volontairement court, 7 minutes) — jamais après une seule réponse creuse, mais sans t'éterniser non plus.

FORMAT DE RÉPONSE — RÈGLE ABSOLUE : un seul objet JSON valide, rien avant, rien après :
{"replique": "ta réplique à l'oral", "etat": "en_cours" | "conclu"}`;
}

function POSITIONNEMENT_EVAL_PROMPT(competence, transcript) {
  const criteresTxt = competence.criteres.map(c =>
    `${c.nom} :\n  1 (Novice) : ${c.niveaux[0]}\n  2 (Débrouillé) : ${c.niveaux[1]}\n  3 (Averti) : ${c.niveaux[2]}\n  4 (Expert) : ${c.niveaux[3]}`
  ).join("\n\n");
  const commTxt = `${COMMUNICATION_CRITERE.nom} :\n  1 (Novice) : ${COMMUNICATION_CRITERE.niveaux[0]}\n  2 (Débrouillé) : ${COMMUNICATION_CRITERE.niveaux[1]}\n  3 (Averti) : ${COMMUNICATION_CRITERE.niveaux[2]}\n  4 (Expert) : ${COMMUNICATION_CRITERE.niveaux[3]}`;

  return `Tu es un professionnel qui positionne un(e) apprenti(e) de Bac Pro MCV sur la compétence "${competence.libelle}" (${competence.epreuve}), à partir d'un point hebdomadaire de 7 minutes. Positionne STRICTEMENT à partir des preuves présentes dans la transcription — jamais sur une impression générale, jamais sur une capacité supposée.

Transcription complète :
${transcript}

GRILLE OFFICIELLE À APPLIQUER :

${criteresTxt}

${commTxt}

RÈGLES DE POSITIONNEMENT :
- N'attribue jamais "Expert" sans une preuve précise et citable dans la transcription.
- Si la mise en situation était fictive plutôt qu'un vécu réel, dis-le explicitement — ça ne pénalise pas l'élève, mais ça doit être noté.
- Si un critère n'a pas été assez exploré pour juger, dis-le plutôt que de deviner.

Rédige en français simple, adressé directement à l'élève (tutoiement), texte brut sans Markdown. Structure exacte :

NIVEAU GLOBAL : Novice | Débrouillé | Averti | Expert

CRITÈRES ÉVALUÉS
${competence.criteres.map(c => `${c.nom} : [niveau] — une phrase citant un élément précis`).join("\n")}
${COMMUNICATION_CRITERE.nom} : [niveau] — une phrase

CE QUI A ÉTÉ VU
Une ou deux phrases précisant si l'échange portait sur un vécu réel en PFMP, une mise en situation fictive, ou les deux.

CONSEIL POUR LA PROCHAINE FOIS
Une seule phrase.`;
}

app.post("/api/positionnement/turn", requireStudent, async (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  if (minutes >= MONTHLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota mensuel atteint. Réessayez le mois prochain." });
  }
  const competence = competenceOrNull(req.body.competenceCode);
  if (!competence) return res.status(400).json({ error: "requete_invalide", message: "Compétence inconnue." });
  const option = req.body.option === "B" ? "B" : "A";
  // Seuls les tours de conversation viennent du client ; la consigne du
  // professionnel est reconstruite ici, à partir de la compétence choisie
  // par l'enseignant — jamais transmise (ni modifiable) depuis le navigateur.
  const turns = Array.isArray(req.body.turns) ? req.body.turns : [];
  const messages = [{ role: "user", content: POSITIONNEMENT_RULES(competence, option) }, ...turns];

  try {
    const parsed = await getValidReply(messages, 400);
    consumeQuota(req.studentCode, COST_TURN);
    res.json(parsed);
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "erreur", detail: e.detail || "" });
  }
});

app.post("/api/positionnement/evaluate", requireStudent, async (req, res) => {
  const { minutes } = getStudentUsage(req.studentCode);
  if (minutes >= MONTHLY_LIMIT_MINUTES) {
    return res.status(429).json({ error: "quota_depasse", message: "Quota mensuel atteint. Réessayez le mois prochain." });
  }
  const competence = competenceOrNull(req.body.competenceCode);
  if (!competence) return res.status(400).json({ error: "requete_invalide", message: "Compétence inconnue." });
  const option = req.body.option === "B" ? "B" : "A";
  const transcript = String(req.body.transcript || "").slice(0, 20000);
  if (transcript.length < 50) return res.status(400).json({ error: "requete_invalide", message: "Échange trop court." });

  try {
    const prompt = POSITIONNEMENT_EVAL_PROMPT(competence, transcript);
    const text = await callClaude([{ role: "user", content: prompt }], 900);
    consumeQuota(req.studentCode, COST_POSITIONNEMENT);
    savePositionnement({
      code: req.studentCode, name: req.studentName, option,
      competenceCode: req.body.competenceCode, competenceLibelle: competence.libelle,
      evaluationText: text, transcript
    });
    res.json({ text });
  } catch (e) {
    res.status(e.code === "no_api_key" ? 503 : 502).json({ error: e.code || "erreur", detail: e.detail || "" });
  }
});

app.get("/api/teacher/positionnements", async (req, res) => {
  if (!checkTeacherPassword(req, res)) return;
  if (!supabaseConfigured()) return res.status(503).json({ error: "supabase_non_configure", message: "Base non configurée." });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/positionnements?select=student_code,student_name,competence_code,competence_libelle,niveau_global,created_at&order=created_at.desc&limit=200`, {
      headers: { "apikey": SUPABASE_SECRET_KEY, "authorization": `Bearer ${SUPABASE_SECRET_KEY}` }
    });
    const rows = await r.json();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    res.status(502).json({ error: "supabase_erreur", message: "Impossible de charger les positionnements." });
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
