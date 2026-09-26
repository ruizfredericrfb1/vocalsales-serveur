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
  const code =
