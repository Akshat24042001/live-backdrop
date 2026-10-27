import 'dotenv/config';
import express from 'express';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { DECISION_SCHEMA, KINDS, decisionPrompt, decisionInput, localPick, scriptRule, SWEEP_SCHEMA, sweepPrompt, sweepInput } from './lib/picker.js';
import { PROVIDERS, pick, listModels } from './lib/llm.js';
import { Segmenter, transcribe, VoiceActivity } from './lib/stt.js';
const voice = new VoiceActivity(); // measures real silence in the incoming audio
import { PRESETS } from './lib/presets.js';
import { TEST_SPEECH } from './lib/test-speech.js';
import { createSpeakers } from './lib/speakers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, 'data');
const LOGS = path.join(__dirname, 'logs');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const PORT = Number(process.env.PORT) || 3000;
const CONTROL_KEY = process.env.CONTROL_KEY || 'jito';
const DEMO = process.argv.includes('--demo') || process.env.MOCK_LLM === '1';
const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

/* ---------------- secrets (API keys): .env, overridable from the operator panel ---------------- */
// Files edited by hand on Windows may start with a byte-order mark; JSON.parse rejects it.
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
// Saved files survive a power cut: write a temp file, keep the previous version as .bak, then swap.
// A file that cannot be read falls back to its .bak, loudly, instead of silently to defaults.
function writeJson(f, data) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch {}
  fs.renameSync(tmp, f);
}
function readJsonSafe(f) {
  try { return readJson(f); } catch (e) {
    if (fs.existsSync(f) && fs.existsSync(f + '.bak')) { console.error(`  ${path.basename(f)} is damaged (${e.message}); using the backup copy.`); return readJson(f + '.bak'); }
    throw e;
  }
}
const SECRETS_FILE = path.join(DATA, 'secrets.json');
const KEY_NAMES = ['xai', 'anthropic', 'openai', 'gemini', 'groq', 'sarvam', 'soniox'];
const ENV_KEYS = { xai: 'XAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', sarvam: 'SARVAM_API_KEY', soniox: 'SONIOX_API_KEY' };
const secrets = Object.fromEntries(KEY_NAMES.map((k) => [k, process.env[ENV_KEYS[k]] || '']));
try { for (const [k, v] of Object.entries(readJsonSafe(SECRETS_FILE))) if (v && KEY_NAMES.includes(k)) secrets[k] = v; } catch {}
const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');
// Which key each speech engine needs (browser speech needs none).
const STT_KEY = { soniox: 'soniox', groq: 'groq', sarvam: 'sarvam' };
const AI_NAMES = Object.keys(PROVIDERS);

/* ---------------- settings (operator panel only, never shown on the backdrop) ---------------- */
// Every setting is declared once here; the panel and the validator both read this.
const SCHEMA = {
  // live behaviour
  approveMode: { type: 'bool', def: true },
  paused: { type: 'bool', def: false },
  standby: { type: 'bool', def: false },
  maxVisible: { type: 'int', def: 3, min: 1, max: 6 },
  ttlMin: { type: 'int', def: 15, min: 3, max: 120 },
  ttlMax: { type: 'int', def: 22, min: 3, max: 120 },
  minGapSec: { type: 'int', def: 2, min: 0, max: 60 },
  pendingExpireSec: { type: 'int', def: 25, min: 5, max: 120 },
  // content
  eventTitle: { type: 'str', def: 'JITO Bhavnagar' },
  eventTagline: { type: 'str', def: '' },
  eventContext: { type: 'str', def: 'JITO (Jain International Trade Organisation) business community event, Bhavnagar, Gujarat, India' },
  speaker: { type: 'str', def: '' },
  speakerRole: { type: 'str', def: '' },
  topic: { type: 'str', def: '' },
  standbyText: { type: 'str', def: 'Welcome' },
  terms: { type: 'str', def: '' },
  blocklist: { type: 'str', def: '' },
  // speech
  sttEngine: { type: 'enum', def: 'soniox', options: ['soniox', 'groq', 'sarvam', 'browser'] },
  sttFailover: { type: 'bool', def: true },
  endpointMs: { type: 'int', def: 1000, min: 500, max: 3000 },
  pauseMs: { type: 'int', def: 450, min: 250, max: 2000 },
  browserLang: { type: 'enum', def: 'en-IN', options: ['en-IN', 'hi-IN', 'gu-IN', 'mr-IN', 'en-US', 'en-GB'] },
  languageHints: { type: 'list', def: ['hi', 'gu', 'en'], options: ['hi', 'gu', 'en', 'mr', 'bn', 'ta', 'te', 'kn', 'pa', 'ur'] },
  sttLanguage: { type: 'enum', def: 'hi', options: ['auto', 'hi', 'gu', 'en', 'mr'] },
  groqModel: { type: 'enum', def: 'whisper-large-v3-turbo', options: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
  sarvamModel: { type: 'enum', def: 'saaras:v3', options: ['saaras:v3', 'saaras:v4'] },
  sarvamMode: { type: 'enum', def: 'codemix', options: ['codemix', 'transcribe', 'translit', 'translate'] },
  // AI
  aiEngine: { type: 'enum', def: 'xai', options: [...AI_NAMES, 'offline'] },
  aiBackup: { type: 'enum', def: 'none', options: ['none', ...AI_NAMES] },
  modelXai: { type: 'str', def: PROVIDERS.xai.defaultModel },
  modelGroq: { type: 'str', def: PROVIDERS.groq.defaultModel },
  modelClaude: { type: 'str', def: PROVIDERS.claude.defaultModel },
  modelOpenai: { type: 'str', def: PROVIDERS.openai.defaultModel },
  modelGemini: { type: 'str', def: PROVIDERS.gemini.defaultModel },
  outputStyle: { type: 'enum', def: 'hinglish', options: ['hinglish', 'mixed', 'native', 'as-spoken', 'english'] }, // older single choice, kept for old settings files
  scriptHi: { type: 'enum', def: 'roman', options: ['roman', 'native'] }, // Hindi on screen: English letters or Devanagari
  scriptGu: { type: 'enum', def: 'roman', options: ['roman', 'native'] }, // Gujarati on screen: English letters or Gujarati script
  translate: { type: 'bool', def: false }, // show everything in English
  // 'wait' by default: the committee's demo feedback was that half statements on screen look broken.
  unfinished: { type: 'enum', def: 'wait', options: ['early', 'wait'] },
  aiFallback: { type: 'bool', def: false },
  minWords: { type: 'int', def: 2, min: 1, max: 8 },
  maxWords: { type: 'int', def: 6, min: 2, max: 12 },
  aiInstructions: { type: 'str', def: '' },
  // look
  theme: { type: 'enum', def: 'navyoday', options: ['navyoday', 'success', 'midnight', 'aurora', 'saffron', 'royal', 'ivory', 'chroma', 'transparent'] },
  layout: { type: 'enum', def: 'upper', options: ['upper', 'scatter', 'stack', 'hero'] },
  accent: { type: 'color', def: '' },
  accent2: { type: 'color', def: '' },
  fontScale: { type: 'num', def: 1, min: 0.5, max: 2 },
  fontFamily: { type: 'enum', def: 'poppins', options: ['poppins', 'inter', 'playfair', 'mukta', 'system'] },
  animation: { type: 'enum', def: 'rise', options: ['rise', 'zoom', 'blur', 'type', 'none'] },
  showTitle: { type: 'bool', def: true },
  showSpeaker: { type: 'bool', def: false },
  showCaptions: { type: 'bool', def: false },
  emphasizeKeyword: { type: 'bool', def: true },
  animatedBg: { type: 'bool', def: true },
  logoUrl: { type: 'str', def: '/assets/navyoday.png' },
  logoLeft: { type: 'str', def: '/assets/jito-emblem.png' },
  logoRight: { type: 'str', def: '/assets/jito-wings.png' },
  safeMargin: { type: 'int', def: 4, min: 0, max: 20 },
  // speaker photo panel
  showPhoto: { type: 'bool', def: true },
  showLabels: { type: 'bool', def: true }, // small labels on items: question, milestone year, who a line is credited to
  // Show lock: during the live event, tests, demo tools and anything that could put non-speech on the LED are refused,
  // and the backdrop window cannot leave fullscreen or open its drawer by a stray key.
  showLock: { type: 'bool', def: false },
  // Sweeper: every 20 s a second AI look at the last ~45 s of speech adds any key point that never got a card.
  sweeper: { type: 'bool', def: true },
  // Content the committee may rule out: money amounts (gupt daan) and humour lines.
  showMoney: { type: 'bool', def: true },
  allowHumor: { type: 'bool', def: true },
  photoSide: { type: 'enum', def: 'left', options: ['left', 'right'] },
  textShare: { type: 'int', def: 68, min: 50, max: 80 }, // % of the width for highlights when the photo is shown
  speakerPhoto: { type: 'str', def: '' },
  activeSpeakerId: { type: 'str', def: '' },
  clearOnSpeakerChange: { type: 'bool', def: true },
  reserveBottom: { type: 'int', def: 30, min: 0, max: 60 },
};
const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.def]));
const SETTINGS_FILE = path.join(DATA, 'settings.json');
let settings = { ...DEFAULTS };
try { applySettings(readJsonSafe(SETTINGS_FILE), false); } catch {}

function coerce(s, v, cur) {
  switch (s.type) {
    case 'bool': return !!v;
    case 'int': case 'num': {
      let n = Number(v);
      if (!Number.isFinite(n)) return cur;
      if (s.type === 'int') n = Math.round(n);
      return Math.min(s.max, Math.max(s.min, n));
    }
    case 'str': return String(v ?? '').slice(0, 4000);
    case 'enum': return s.options.includes(v) ? v : cur;
    case 'color': return /^#[0-9a-f]{6}$/i.test(String(v)) || v === '' ? String(v) : cur;
    case 'list': { const l = Array.isArray(v) ? v.filter((x) => s.options.includes(x)) : []; return l.length ? l : cur; }
  }
  return cur;
}
function applySettings(p, save = true) {
  const s = { ...settings };
  for (const [k, v] of Object.entries(p || {})) if (SCHEMA[k]) s[k] = coerce(SCHEMA[k], v, s[k]);
  if (s.ttlMax < s.ttlMin) s.ttlMax = s.ttlMin;
  if (s.maxWords < s.minWords) s.maxWords = s.minWords;
  settings = s;
  if (save) try { writeJson(SETTINGS_FILE, settings); } catch {}
}

/* ---------------- logging ---------------- */
const logFile = () => path.join(LOGS, `session-${new Date().toISOString().slice(0, 10)}.jsonl`);
const log = (obj) => { try { fs.appendFileSync(logFile(), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch {} };

/* ---------------- speakers ---------------- */
const speakers = createSpeakers({ dataDir: DATA, photoDir: path.join(__dirname, 'public', 'assets', 'speakers'), log });
const activeSpeaker = () => speakers.get(settings.activeSpeakerId);
// Names and words recognition must spell right: the event's list plus the speaker on stage.
const allTerms = () => {
  const sp = activeSpeaker();
  return [...new Set(['JITO', ...listOf(settings.terms), ...(sp ? [sp.name, ...listOf(sp.terms)] : [])].filter(Boolean))];
};

function activateSpeaker(id) {
  const sp = speakers.get(id);
  const prev = settings.activeSpeakerId;
  applySettings(sp
    ? { activeSpeakerId: sp.id, speaker: sp.name, speakerRole: sp.role, speakerPhoto: sp.photo, ...(sp.topic ? { topic: sp.topic } : {}) }
    : { activeSpeakerId: '', speaker: '', speakerRole: '', speakerPhoto: '' });
  if (prev !== settings.activeSpeakerId && settings.clearOnSpeakerChange) {
    // The previous speaker's highlights and half-heard words must not follow the new speaker.
    for (const x of [...live]) hideItem(x.id);
    pending = [];
    clearQueue();
    resetSpeech(); speech.context = '';
  }
  if (prev !== settings.activeSpeakerId) forgetShown('speaker change'); // a new speaker may say what the last one said
  log({ ev: 'speaker_change', id: settings.activeSpeakerId, name: settings.speaker });
  pushControl(); pushDisplay();
  if (stt.wanted && stt.ws) { try { stt.ws.close(); } catch {} } // reconnects with the new speaker's names
}

/* ---------------- clients ---------------- */
const clients = new Set();
let clientSeq = 1;
const sendWs = (ws, obj) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
const sendTo = (role, obj) => {
  let s;
  try { s = JSON.stringify(obj); } catch (e) { log({ ev: 'send_error', type: obj?.type, msg: String(e.message) }); return; } // never let one bad message stop updates
  for (const c of clients) if (c.role === role && c.readyState === WebSocket.OPEN) c.send(s);
};
const displayCount = () => [...clients].filter((c) => c.role === 'display' && !c.preview && c.readyState === WebSocket.OPEN).length;
const controlCount = () => [...clients].filter((c) => c.role === 'control' && c.readyState === WebSocket.OPEN).length;
const toast = (msg, level = 'info') => sendTo('control', { type: 'toast', msg, level });

/* ---------------- highlight state ---------------- */
let nextId = 1;
let pending = [];
let live = [];
const history = [];
const recentTexts = [];
// Timestamped speech and cards, for the sweeper's second look (kept ~2.5 minutes).
const finalsLog = [];
const shownLog = [];
const status = {
  stt: 'idle', sttMsg: '', ai: 'ok', aiMsg: '', aiBackupMsg: '', displayWarn: '', aiMs: 0, listening: false, captureBy: '', captureEngine: '',
  aiCalls: 0, shown: 0, latencyMs: 0, failover: '',
};

// Only plain fields go to the panel (entries also hold timers, which cannot be serialised).
const publicLive = () => live.map(({ id, text, keyword, kind, person, complete, source, created, pinned, expires }) => ({ id, text, keyword, kind, person, complete, source, created, pinned, ttlLeft: pinned ? null : Math.max(0, Math.round((expires - Date.now()) / 1000)) }));
const fullState = () => ({
  type: 'full',
  settings,
  schema: SCHEMA,
  pending,
  live: publicLive(),
  history: history.slice(-30),
  status: { ...status, remembered: recentTexts.length, displays: displayCount(), panels: controlCount(), demo: DEMO, test: testRun ? { kind: testRun.kind, progress: testRun.progress || 0 } : null },
  testSpeech: TEST_SPEECH,
  keys: Object.fromEntries(KEY_NAMES.map((k) => [k, mask(secrets[k])])),
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, key: p.key, defaultModel: p.defaultModel, console: p.console }])),
  presets: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, { label: p.label, when: p.when }])),
  speakers: speakers.all(),
});
let pushTimer = null;
const pushControl = () => { if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; sendTo('control', fullState()); }, 30); };
const setStatus = (p) => { Object.assign(status, p); pushControl(); };

const LOOK_KEYS = ['showLock', 'showLabels', 'showPhoto', 'photoSide', 'textShare', 'speakerPhoto', 'eventTitle', 'eventTagline', 'speaker', 'speakerRole', 'standby', 'standbyText', 'theme', 'layout', 'accent', 'accent2', 'fontScale', 'fontFamily', 'animation', 'showTitle', 'showSpeaker', 'showCaptions', 'emphasizeKeyword', 'animatedBg', 'logoUrl', 'logoLeft', 'logoRight', 'safeMargin', 'reserveBottom', 'maxVisible'];
const displayItem = ({ id, text, keyword, kind, person, complete, expires, pinned }) => ({ id, text, keyword, kind, person, complete, ttl: pinned ? 0 : Math.max(1, (expires - Date.now()) / 1000) });
const displayState = () => ({ type: 'state', look: Object.fromEntries(LOOK_KEYS.map((k) => [k, settings[k]])), live: live.map(displayItem) });
const pushDisplay = () => sendTo('display', displayState());

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const listOf = (s) => s.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const isBlocked = (t) => { const n = t.toLowerCase(); return listOf(settings.blocklist).some((w) => n.includes(w.toLowerCase())); };
const similar = (a0, b0) => {
  // Different numbers are different facts, however many words the lines share ("₹25 crore · hostel" vs "₹2 crore · hostel").
  const na = numbersIn(a0).join(), nb = numbersIn(b0).join();
  if (na && nb && na !== nb) return false;
  const a = new Set(norm(a0).split(' ')), b = new Set(norm(b0).split(' '));
  const inter = [...a].filter((x) => b.has(x)).length;
  // A one- or two-word line inside a longer one is not a repeat ("Seva" vs "Seva is our sanskar"): compare with the longer line.
  const small = Math.min(a.size, b.size);
  return inter / Math.max(1, small <= 2 ? Math.max(a.size, b.size) : small) >= 0.75;
};
const isKeyword = (k) => k === 'keyword';
// A keyword repeats only if the same keyword was shown, or the idea is already on screen right now.
// Lines (quotes, stats, takeaways) repeat if they share most of their words with an earlier line.
function tooSimilar(t, kind = 'quote', exceptId) {
  const shown = [...live, ...pending, ...queue].filter((x) => x.id !== exceptId);
  if (isKeyword(kind)) {
    const n = norm(t);
    return recentTexts.some((r) => isKeyword(r.kind) && r.n === n) || shown.some((x) => isKeyword(x.kind) && norm(x.text) === n);
  }
  return recentTexts.some((r) => !isKeyword(r.kind) && similar(t, r.n)) || shown.some((x) => !isKeyword(x.kind) && similar(t, x.text));
}
const rememberText = (t, kind = 'quote') => { recentTexts.push({ n: norm(t), kind }); if (recentTexts.length > 60) recentTexts.shift(); };

function cleanText(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’.,;:!]+$/g, '').trim();
  if (text) text = text.charAt(0).toUpperCase() + text.slice(1); // sentence case for Latin text; other scripts are unaffected
  return text;
}

function hideItem(id) {
  const i = live.findIndex((x) => x.id === id);
  if (i < 0) return;
  clearTimeout(live[i].timer);
  clearTimeout(live[i].staleTimer);
  live.splice(i, 1);
  sendTo('display', { type: 'hide', id });
  pushControl();
}

// While the speaker is talking, keep the last card up a little longer rather than leave an empty screen.
function expire(entry) {
  const talking = status.listening && Date.now() - speech.lastTokenAt < 15000;
  if (live.length === 1 && live[0] === entry && talking && Date.now() - entry.created < 45000) {
    entry.expires = Date.now() + 6000;
    return armTimer(entry);
  }
  hideItem(entry.id);
}

function armTimer(entry) {
  clearTimeout(entry.timer);
  clearTimeout(entry.staleTimer);
  if (entry.pinned) return;
  entry.timer = setTimeout(() => expire(entry), Math.max(0, entry.expires - Date.now()));
  // An early line the speaker never completed must not stay on the backdrop as a fragment.
  if (!entry.complete) entry.staleTimer = setTimeout(() => { if (!entry.complete) { log({ ev: 'stale_removed', text: entry.text }); hideItem(entry.id); } }, 8000);
}

function showItem(item) {
  while (live.length >= settings.maxVisible) {
    const victim = live.find((x) => !x.pinned) || live[0];
    hideItem(victim.id);
  }
  const ttl = settings.ttlMin + Math.random() * (settings.ttlMax - settings.ttlMin);
  const entry = { id: item.id, text: item.text, keyword: item.keyword || '', kind: item.kind || 'insight', person: item.person || '', complete: item.complete !== false, source: item.source, created: Date.now(), expires: Date.now() + ttl * 1000, pinned: false };
  armTimer(entry);
  live.push(entry);
  rememberText(item.text, item.kind);
  shownLog.push({ at: Date.now(), text: item.text });
  history.push({ id: item.id, text: item.text, t: Date.now(), source: item.source });
  if (history.length > 300) history.shift();
  status.shown++;
  sendTo('display', { type: 'show', item: displayItem(entry) });
  log({ ev: 'show', id: item.id, text: item.text, source: item.source, complete: entry.complete });
  pushControl();
  return entry;
}

// Rewrite a highlight in place: the speaker completed or sharpened that idea.
function updateItem(id, { text, keyword, complete, kind, person }) {
  const entry = live.find((x) => x.id === id);
  if (entry) {
    entry.text = text;
    entry.keyword = keyword || '';
    if (kind) entry.kind = kind;
    if (person !== undefined) entry.person = person;
    entry.complete = complete !== false;
    entry.expires = Math.max(entry.expires, Date.now() + settings.ttlMin * 1000);
    armTimer(entry);
    rememberText(text, entry.kind);
    shownLog.push({ at: Date.now(), text });
    const h = history.find((x) => x.id === id);
    if (h) h.text = text;
    sendTo('display', { type: 'update', item: displayItem(entry) });
    log({ ev: 'update', id, text, complete: entry.complete });
    pushControl();
    return true;
  }
  const p = pending.find((x) => x.id === id);
  if (p) { Object.assign(p, { text, keyword: keyword || '', complete: complete !== false, ts: Date.now(), ...(kind ? { kind } : {}) }); log({ ev: 'update_pending', id, text }); pushControl(); return true; }
  return false;
}

function publish(raw, { force = false, keyword = '', kind = '', person = '', complete = true, source = 'ai', id = 0 } = {}) {
  const text = cleanText(raw);
  if (!text) return null;
  if (!force && (isBlocked(text) || tooSimilar(text, kind || 'quote'))) { log({ ev: 'skipped', text }); return null; }
  const item = { id: id || nextId++, text, keyword: keyword && text.includes(keyword) ? keyword : '', kind, person, complete, source, ts: Date.now() };
  if (force || !settings.approveMode || testRun) return showItem(item); // tests measure the real on-screen timing
  pending.push(item);
  if (pending.length > 10) { const gone = pending.shift(); log({ ev: 'proposal_dropped', text: gone.text }); toast('Too many proposals waiting: the oldest was dropped. Approve (A) or reject (R) faster.', 'warn'); }
  log({ ev: 'proposed', id: item.id, text });
  pushControl();
  return item;
}

setInterval(() => {
  const before = pending.length;
  pending = pending.filter((p) => {
    const keep = Date.now() - p.ts < settings.pendingExpireSec * 1000;
    if (!keep) log({ ev: 'proposal_expired', text: p.text }); // the operator did not approve in time: a point the audience never saw
    return keep;
  });
  if (pending.length !== before) pushControl();
}, 1000);
setInterval(() => { if (live.length) pushControl(); }, 1000); // keeps the countdowns in the panel fresh

/* ---------------- speech state ---------------- */
// fresh: final text the AI has not judged yet. context: recent text it already judged.
const speech = { fresh: '', context: '', nonFinal: '', lastTokenAt: 0, endpoint: false, finalizeSent: false, tags: {}, held: '', heldTags: {}, heldCount: 0 };
let heard = '';
let captionTimer = null;

function pushHeard() {
  sendTo('control', { type: 'transcript', final: heard.slice(-500), partial: speech.nonFinal });
  if (!captionTimer) captionTimer = setTimeout(() => {
    captionTimer = null;
    if (settings.showCaptions && !settings.paused && !settings.standby) sendTo('display', { type: 'caption', text: (heard + speech.nonFinal).slice(-260) });
  }, 100);
}
// confirm: these words were already heard as provisional text, so they are not new speech and must not
// restart the pause clock (that added ~0.7 s to every sentence ending in a comma).
// Recognisers write "two thousand five hundred" as "2,000,500". Repair that pattern before anyone reads it.
function repairNumbers(text) {
  return text.replace(/\b(\d{1,2}),000,(\d)00\b/g, (m, a, b) => { log({ ev: 'number_repaired', from: m, to: `${a},${b}00` }); return `${a},${b}00`; });
}

function addFinal(text, { confirm = false } = {}) {
  if (!text || !text.trim()) return;
  text = repairNumbers(text);
  speech.fresh += text;
  finalsLog.push({ at: Date.now(), text });
  while (finalsLog.length && finalsLog[0].at < Date.now() - 150000) finalsLog.shift();
  if (!confirm) speech.lastTokenAt = Date.now();
  heard = (heard + text).slice(-2000);
  log({ ev: 'final', text });
}
function setNonFinal(text) {
  if (text !== speech.nonFinal) { speech.nonFinal = text; if (text) speech.lastTokenAt = Date.now(); }
}
const markEndpoint = () => { speech.endpoint = true; };
function resetSpeech() { Object.assign(speech, { fresh: '', nonFinal: '', endpoint: false, finalizeSent: false, tags: {}, held: '', heldTags: {}, heldCount: 0 }); }

/* ---------------- AI decisions ---------------- */
const modelFor = (p) => settings['model' + p[0].toUpperCase() + p.slice(1)] || PROVIDERS[p].defaultModel;
const providerLabel = (p) => PROVIDERS[p]?.label || p;

// Fire a second identical request if the first is slow or fails; use whichever answers first.
function hedged(fn, afterMs) {
  return new Promise((resolve, reject) => {
    let settled = false, running = 0, second = false, timer;
    const run = () => {
      running++;
      fn().then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
        (e) => {
          running--;
          if (settled) return;
          if (!second) { second = true; clearTimeout(timer); run(); } // retry at once on an error
          else if (running === 0) { settled = true; reject(e); }
        },
      );
    };
    timer = setTimeout(() => { if (!settled && !second) { second = true; run(); } }, afterMs);
    run();
  });
}

async function askAI(provider, fresh, tags, { held = 0, lastChance = false, note = '' } = {}) {
  lastAiAt = Date.now();
  const now = Date.now();
  const onScreen = [...live, ...pending, ...queue].map((x) => ({ id: x.id, text: x.text, kind: x.kind, person: x.person, complete: x.complete, age: Math.round((now - (x.created || x.ts || now)) / 1000) }));
  const extra = [
    settings.aiInstructions,
    !settings.showMoney && 'Never show money amounts (₹, crore, lakh, rupees): for a donation or turnover, show the cause or achievement without the amount.',
    !settings.allowHumor && 'Never use the humor kind.',
  ].filter(Boolean).join('\n');
  const system = decisionPrompt({ minWords: settings.minWords, maxWords: settings.maxWords, context: settings.eventContext, extra, scriptHi: settings.scriptHi, scriptGu: settings.scriptGu, translate: settings.translate, unfinished: settings.unfinished });
  const user = decisionInput({
    speaker: [settings.speaker, settings.speakerRole].filter(Boolean).join(', '),
    about: activeSpeaker()?.about || '',
    people: speakers.all().filter((x) => x.id !== settings.activeSpeakerId).map((x) => [x.name, x.role].filter(Boolean).join(' – ')).join('; '),
    topic: settings.topic,
    terms: allTerms().join(', '),
    onScreen,
    shown: recentTexts.slice(-14).map((r) => r.n),
    context: speech.context,
    fresh,
    tags,
    held,
    lastChance,
    note,
  });
  const tMs = provider === 'gemini' ? 12000 : 6000;
  // Gemini's free-tier response time is 3-4 s; firing a hedge at 1.4 s would start a second request before the
  // first finishes, doubling quota usage and triggering rate limits. Only hedge near the actual timeout.
  const afterMs = provider === 'gemini' ? tMs - 1000 : 1400;
  return hedged(() => pick(provider, { key: secrets[PROVIDERS[provider].key], model: modelFor(provider), system, user, schema: DECISION_SCHEMA, timeoutMs: tMs }), afterMs);
}

function offlineDecision(fresh) {
  const h = localPick(fresh, { minWords: settings.minWords, maxWords: settings.maxWords });
  return h ? { action: 'new', kind: /\d/.test(h.keyword) ? 'stat' : 'quote', target: 0, highlight: h.highlight, keyword: h.keyword, complete: true } : { action: 'none' };
}

async function decideWith(fresh, tags, opts) {
  if (settings.aiEngine === 'offline' || DEMO) return { ...offlineDecision(fresh), engine: 'offline' };
  const order = [settings.aiEngine, settings.aiBackup].filter((p, i, a) => p && p !== 'none' && a.indexOf(p) === i && secrets[PROVIDERS[p]?.key]);
  if (!order.length) {
    status.ai = 'error'; status.aiMsg = `${providerLabel(settings.aiEngine)} key not set (Engines tab)`;
    return settings.aiFallback ? { ...offlineDecision(fresh), engine: 'offline (fallback)' } : { action: 'none', engine: 'none' };
  }
  let lastErr;
  // A provider that just failed for a lasting reason (no credits, bad key, rate limit) is skipped for a while,
  // so each sentence does not first wait for it to fail again. If every provider is resting, try them anyway.
  // If every provider is resting, try only the one that wakes soonest (usually a rate limit about to clear).
  const awake = order.filter((p) => !(aiRestUntil[p] > Date.now()));
  for (const p of awake.length ? awake : [...order].sort((a, b) => aiRestUntil[a] - aiRestUntil[b]).slice(0, 1)) {
    try {
      const d = await askAI(p, fresh, tags, opts);
      delete aiRestUntil[p];
      if (p === settings.aiEngine) { status.ai = 'ok'; status.aiMsg = ''; } else { status.ai = 'backup'; status.aiMsg = `main AI failed (${aiHealth[settings.aiEngine]?.msg || 'error'}), using ${providerLabel(p)}`; }
      return { ...d, engine: p, usage: d.usage };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      log({ ev: 'ai_error', provider: p, msg });
      aiHealth[p] = { ok: false, msg: msg.slice(0, 160), at: Date.now() };
      if (e.status === 429) aiRestUntil[p] = Date.now() + 20000;
      else if (e.status === 401 || e.status === 402 || e.status === 403) aiRestUntil[p] = Date.now() + 120000;
    }
  }
  status.ai = 'error';
  status.aiMsg = String(lastErr?.message || lastErr).slice(0, 160);
  return settings.aiFallback ? { ...offlineDecision(fresh), engine: 'offline (fallback)' } : { action: 'none', engine: 'none', failed: true };
}

// Both AIs are checked every few minutes, listening or not, so an empty account or a dead key shows up
// on the panel before the talk instead of as a blank backdrop during it.
const aiHealth = {}, aiRestUntil = {};
const PING_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
async function checkAI() {
  if (DEMO) return;
  for (const p of [settings.aiEngine, settings.aiBackup]) {
    if (!PROVIDERS[p] || !secrets[PROVIDERS[p].key]) continue;
    try {
      await pick(p, { key: secrets[PROVIDERS[p].key], model: modelFor(p), system: 'Reply with JSON {"ok":true}.', user: 'ok', schema: PING_SCHEMA, timeoutMs: 10000 });
      aiHealth[p] = { ok: true, at: Date.now() };
      delete aiRestUntil[p];
    } catch (e) {
      aiHealth[p] = { ok: false, msg: String(e.message || e).slice(0, 160), at: Date.now() };
      log({ ev: 'ai_check_failed', provider: p, msg: aiHealth[p].msg });
    }
  }
  const main = aiHealth[settings.aiEngine], backup = settings.aiBackup !== settings.aiEngine && aiHealth[settings.aiBackup];
  if (main && !main.ok) { setStatus({ ai: 'error', aiMsg: main.msg }); toast(`Main AI is NOT working: ${main.msg}`, 'bad'); }
  else if (main?.ok && status.ai === 'error') setStatus({ ai: 'ok', aiMsg: '' });
  setStatus({ aiBackupMsg: backup && !backup.ok ? backup.msg : '' });
}
setTimeout(checkAI, 3000);
setInterval(() => { if (!inflight) checkAI(); }, 180000);

// Commands that could put rehearsal or setup content on the LED, refused while Show lock is on.
const SHOW_LOCKED = new Set(['play-test', 'read-test', 'inject', 'identify', 'drill-drop-stt', 'reset-look', 'preset', 'set-keys', 'speaker-delete', 'reset-session', 'test-stt']);

// Display health: every real backdrop window reports every 2 s. Not fullscreen, hidden, or silent for 6 s = warning.
function updateDisplayHealth() {
  const shows = [...clients].filter((c) => c.role === 'display' && !c.preview && c.readyState === WebSocket.OPEN);
  const bad = shows.filter((c) => !c.health || Date.now() - c.health.at > 6000 || !c.health.fs || !c.health.visible);
  const msg = !shows.length ? '' : bad.length ? `${bad.length} backdrop window${bad.length > 1 ? 's' : ''} NOT fullscreen or hidden — click it and press F` : '';
  if (msg !== status.displayWarn) setStatus({ displayWarn: msg });
}
setInterval(updateDisplayHealth, 2000);

// New highlights wait here when they arrive inside the minimum gap, and go on screen one by one in order.
// (One slot was not enough: a second point in the same gap used to overwrite the first, which was then lost.)
let queue = [];
let queueTimer = null;
let lastNewAt = 0;
function enqueue(x) {
  queue.push({ id: nextId++, ...x });
  drainQueue();
}
function drainQueue() {
  clearTimeout(queueTimer); queueTimer = null;
  if (!queue.length) return;
  const wait = (queue[0].burst ? 900 : settings.minGapSec * 1000) - (Date.now() - lastNewAt);
  if (wait > 0) { queueTimer = setTimeout(drainQueue, wait); return; }
  const x = queue.shift();
  lastNewAt = Date.now();
  publishReady(x);
  // Further points from the same sentence follow quickly (0.9 s), so they still match what was just said.
  if (queue.length) queueTimer = setTimeout(drainQueue, queue[0].burst ? 900 : settings.minGapSec * 1000);
}
// The operator wrote or edited this card: the AI may not rewrite it.
function lockEntry(id) { const e = live.find((x) => x.id === id); if (e) e.locked = true; }
function clearQueue() { clearTimeout(queueTimer); queueTimer = null; queue = []; }

// Which language the speech was mostly in: Soniox word tags first, the script as a fallback.
function dominantLanguage(fresh, tags) {
  const t = Object.entries(tags || {});
  const total = t.reduce((a, [, n]) => a + n, 0);
  if (total) { const [l, n] = t.sort((a, b) => b[1] - a[1])[0]; return n / total >= 0.7 ? l : 'mixed'; }
  const c = (re) => (fresh.match(re) || []).length;
  const hi = c(/[\u0900-\u097F]/g), gu = c(/[\u0A80-\u0AFF]/g), en = c(/[A-Za-z]/g), all = hi + gu + en || 1;
  return gu / all >= 0.7 ? 'gu' : hi / all >= 0.7 ? 'hi' : en / all >= 0.8 ? 'en' : 'mixed';
}

// Only words that cannot end a finished thought. Hindi and Gujarati lines may end on se/ka/ki/ma ("dil se"),
// and English on is/are ("who you are"), so those are allowed.
// Whole words only: "investor", "sector", "gyan" and "duniya" end in the same letters and are fine.
const DANGLING = /(?:^|\s)(and|or|but|the|an|to|of|with|for|never|our|my|your|that|which|aur|ya|ane|jo|jab|tab|lekin|kyunki|parantu)\s*$/i;

// Every number on screen must have been spoken. Numbers are compared as values ("72,000+" = 72000, "15k" = 15000).
const numbersIn = (t) => (String(t).match(/\d[\d,]*(?:\.\d+)?\s*k?\b/gi) || []).map((x) => {
  const k = /k\s*$/i.test(x);
  const v = parseFloat(x.replace(/[,\sk]/gi, ''));
  return k ? v * 1000 : v;
}).filter((v) => Number.isFinite(v));
// Numbers said as words count as spoken too: "four thousand" = 4000, "teen saal" = 3, "ढाई" = 2.5, "બે" = 2.
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, bees: 20, tees: 30, pachas: 50, pachaas: 50, dedh: 1.5, dhai: 2.5, adhi: 2.5,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'पंद्रह': 15, 'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पचास': 50, 'डेढ़': 1.5, 'ढाई': 2.5,
  'એક': 1, 'બે': 2, 'ત્રણ': 3, 'ચાર': 4, 'પાંચ': 5, 'છ': 6, 'સાત': 7, 'આઠ': 8, 'નવ': 9, 'દસ': 10, 'અગિયાર': 11, 'બાર': 12, 'પંદર': 15, 'વીસ': 20, 'પચીસ': 25, 'ત્રીસ': 30, 'ચાલીસ': 40, 'પચાસ': 50, 'દોઢ': 1.5, 'અઢી': 2.5,
};
const NUM_SCALE = { hundred: 100, sau: 100, 'सौ': 100, 'સો': 100, thousand: 1000, hazar: 1000, hazaar: 1000, 'हज़ार': 1000, 'हजार': 1000, 'હજાર': 1000 };
function spokenNumbers(t) {
  const out = [];
  let total = 0, cur = 0, open = false;
  const end = () => { if (open) out.push(total + cur); total = 0; cur = 0; open = false; };
  for (const raw of String(t).toLowerCase().split(/[\s,;:!?।॥]+/)) {
    const w = raw.replace(/[^\p{L}\p{M}\p{N}.]/gu, '').replace(/\.$/, '');
    const v = /^\d+(\.\d+)?$/.test(w) ? parseFloat(w) : NUM_WORDS[w];
    const scale = NUM_SCALE[w];
    if (v !== undefined) {
      out.push(v);
      if (open && cur >= 100 && cur % 100 === 0 && v < 100) cur += v; // "one hundred (and) twenty"
      else if (open && cur >= 20 && cur % 10 === 0 && v < 10) cur += v; // "twenty five"
      else if (open && cur === 0) cur = v; // "two thousand FIVE hundred"
      else { end(); cur = v; open = true; }
    } else if (open && (w === 'and' || w === 'aur')) {
      // "one hundred AND twenty": the number goes on
    } else if (scale && open) {
      if (scale === 100) cur = (cur || 1) * 100;
      else { total += (cur || 1) * scale; cur = 0; }
    } else end();
  }
  end();
  return out;
}
function unspokenNumbers(text, heardText) {
  const said = [...numbersIn(heardText), ...spokenNumbers(heardText)];
  if (!said.length) return [];
  return numbersIn(text).filter((v) => !said.includes(v));
}
// Money: "12 crore rupee" -> "₹12 crore"; the rupee word goes, the ₹ sign comes first.
function rupees(text, heardText) {
  const money = /rupe|rupaye|rupiya|रुप|રૂપ|₹/i.test(heardText + text);
  let t = text.replace(/\s*\b(rupees?|rupaye|rupiya|rupaiya)\b/gi, '');
  // Latin \b does not work after Indian scripts, so Devanagari and Gujarati units are matched without it.
  // A count is not money: "2 crore members" keeps no ₹.
  if (money) t = t.replace(/(^|[^₹\d])(\d[\d,.]*\s*(crore\b|lakh\b|lac\b|cr\b|करोड़|करोड|लाख|કરોડ|લાખ))(?!़?\s*\+?\s*(members?|people|log|lok|sadasya|families|parivar|students|vidyarthi|jobs|naukri|youth|yuva|trees|लोग|सदस्य|परिवार|छात्र|સભ્યો|પરિવાર|વિદ્યાર્થી|લોકો))/gi, '$1₹$2');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// Checks one AI answer against the house rules. Returns { item } when it can go on screen, or the problem.
// A problem with a `note` can be fixed by asking the AI again with that note; a missing point is worse
// than one extra AI call, so failed lines get one more chance instead of being dropped.
// lenient: the second try. The line may then be longer: the backdrop shrinks long text to fit.
function vet(d, fresh, { lenient = false } = {}) {
  const heardText = speech.context + ' ' + fresh;
  const text = rupees(cleanText(d.highlight), fresh); // money words only from the speech being judged
  let kind = KINDS.includes(d.kind) ? d.kind : 'quote';
  const person = String(d.person || '').trim().slice(0, 60);
  if (!text) return { ev: 'empty' };
  const n = wordCount(text);
  // A 'keyword' that came back as a sentence is shown as a quote.
  if (kind === 'keyword' && n > 3) kind = 'quote';
  // A line that opens with a year ("1987 · pehli factory") is a milestone, whatever the AI called it.
  if (/^(1[89]\d\d|20\d\d)\b/.test(text) && !['stat', 'announcement', 'list'].includes(kind)) kind = 'milestone';
  // A milestone needs its year or age; without one it is really a tribute (credited to someone) or a quote.
  if (kind === 'milestone' && !/\d/.test(text)) kind = person ? 'tribute' : 'quote';
  // Content the committee switched off.
  if (!settings.allowHumor && kind === 'humor') return { ev: 'humor_off', text };
  if (!settings.showMoney && /₹|\b(crore|lakh|lac|rupees?|rupaye)\b|करोड|लाख|રૂપ|કરોડ|લાખ/i.test(text)) return { ev: 'money_off', text };
  // The backdrop shrinks long lines to fit, so a sentence the speaker needed 14 words for is shown, not lost.
  const target = kind === 'stat' ? 8 : kind === 'announcement' ? 10 : kind === 'contrast' || kind === 'list' ? 14 : Math.max(14, settings.maxWords + 8);
  if (n > (lenient ? target + 6 : target)) return { ev: 'too_long', text, kind, note: `"${text}" has ${n} words, too long for the screen. Shorten it to at most ${target} words: keep the speaker's own key words and language, drop filler.` };
  if (isBlocked(text)) return { ev: 'blocked', text };
  const wrong = unspokenNumbers(text, heardText);
  if (wrong.length) return { ev: 'number_mismatch', text, numbers: wrong, note: `"${text}" contains ${wrong.join(', ')}, which is not in the transcript. Write numbers exactly as the speaker said them, or leave the number out.` };
  // A line that stops on a joining word is a fragment ("…stay honest never", "…today our group employs and").
  if (DANGLING.test(text)) return { ev: 'fragment', text, note: `"${text}" stops on a joining word. Give a line that is complete on its own.` };
  // The AI itself says the speaker used Hindi or Gujarati, yet wrote the line in English: a translation.
  // (Recogniser tags are not used here: accented English written in Devanagari gets tagged as Hindi.)
  if (!settings.translate && (d.spoken === 'hindi' || d.spoken === 'gujarati') && d.language === 'english') return { ev: 'translated', text, spoken: d.spoken, note: `"${text}" is English, but you marked the speech as ${d.spoken}. Use the speaker's own ${d.spoken} words, not a translation. If the words in the transcript really are English, mark spoken as english.` };
  // The reverse: English speech written as Hindi or Gujarati ("When we started this business in 1998" -> "1998 · business shuru kiya").
  if (!settings.translate && d.spoken === 'english' && (d.language === 'hindi' || d.language === 'gujarati')) return { ev: 'translated', text, spoken: d.spoken, note: `"${text}" is ${d.language}, but the speaker said it in English. Use the speaker's own English words.` };
  if (wrongScript(text)) return { ev: 'wrong_script', text, note: `"${text}" is in the wrong script. ${scriptRule(settings)}` };
  const keyword = d.keyword && text.includes(d.keyword) ? d.keyword : kind === 'keyword' ? text : kind === 'milestone' ? (text.match(/\b(1[89]\d\d|20\d\d)\b/) || [''])[0] : '';
  return { item: { text, keyword, kind, person, complete: d.complete !== false } };
}

// The answer as a list of on-screen changes: the main item, then any further points from the same passage.
// The AI may send "more" as something other than a list (plain-JSON fallback): never let that throw.
const moreTexts = (d) => (Array.isArray(d.more) ? d.more : []).map((m) => m?.highlight || "");
function answerParts(d) {
  if (d.action !== 'new' && d.action !== 'update') return [];
  const extra = (Array.isArray(d.more) ? d.more : []).slice(0, 3).map((m) => ({ ...m, action: 'new', target: 0, complete: true }));
  return [d, ...extra].filter((p) => String(p.highlight || '').trim());
}

// Same idea: they share a number, or most of the old line's content words are still there.
const FILLER_WORDS = new Set('the and for you are was were this that with from our your his her they them hai hain tha the bhi aur ane che chhe nahi nathi kar karo ko ka ki ke ma ne se'.split(' '));
const contentWords = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 2 && !FILLER_WORDS.has(w)));
function sameIdea(oldText, newText) {
  const a = numbersIn(oldText), b = numbersIn(newText);
  if (a.length && b.length && a.some((v) => b.includes(v))) return true;
  const o = contentWords(oldText), n = contentWords(newText);
  if (!o.size || !n.size) return true;
  // Measured against the shorter line: a completed line keeps its key words but adds new ones.
  return [...o].filter((w) => n.has(w)).length / Math.min(o.size, n.size) >= 0.4;
}

function applyItem({ text, keyword, complete, kind, person }, action, targetId, spokeAt, source, burst = false) {
  if (action === 'update' && targetId) {
    const cur = [...live, ...pending, ...queue].find((x) => x.id === targetId);
    // An update must be the same idea: finishing an unfinished line, or the same fact sharpened or corrected.
    // In the 24-Oct demo the AI "updated" older cards with new, unrelated points; the old card was overwritten
    // and the new point never got its own card. Such an update is shown as a new item instead.
    if (cur && cur.complete !== false && !sameIdea(cur.text, text)) { log({ ev: 'update_as_new', from: cur.text, to: text }); action = 'new'; }
    // A card the operator approved with an edit, typed or pinned is theirs: the AI never rewrites it.
    else if (cur && (cur.pinned || cur.locked)) { log({ ev: 'update_locked', from: cur.text, to: text }); action = 'new'; }
  }
  if (action === 'update' && targetId) {
    const cur = [...live, ...pending, ...queue].find((x) => x.id === targetId);
    // A stat whose number jumps tenfold is almost always a mishearing ("12 crore" -> "1200 crore"), not a correction.
    const before = Math.max(0, ...numbersIn(cur?.text || '')), after = Math.max(0, ...numbersIn(text));
    if (cur && before && after && (after / before >= 8 || before / after >= 8)) { log({ ev: 'implausible_change', from: cur.text, to: text }); return false; }
    if (cur && norm(cur.text) === norm(text) && cur.complete === complete) { log({ ev: 'update_noop', text }); return false; }
    const waiting = queue.find((x) => x.id === targetId);
    if (waiting) { Object.assign(waiting, { text, keyword, complete, kind, person }); return true; }
    // Approve mode covers rewrites too: the change waits for the operator like any new line.
    if (settings.approveMode && !testRun && live.some((x) => x.id === targetId)) {
      const p = pending.find((x) => x.replaces === targetId);
      if (p) Object.assign(p, { text, keyword, complete, kind, person, ts: Date.now() });
      else pending.push({ id: nextId++, replaces: targetId, text, keyword, complete, kind, person, source, ts: Date.now() });
      log({ ev: 'proposed_update', target: targetId, text });
      pushControl();
      return true;
    }
    if (updateItem(targetId, { text, keyword, complete, kind, person })) { recordLatency(spokeAt, 'update', text); return true; }
  }
  if (tooSimilar(text, kind)) { log({ ev: 'skipped', text, kind }); return false; }
  enqueue({ text, keyword, complete, kind, person, source, spokeAt, burst });
  return true;
}

// Puts every acceptable part of an answer on screen; returns the parts that failed with a fixable problem.
function applyDecision(d, spokeAt, fresh = '', { lenient = false } = {}) {
  const source = d.engine === 'offline' || d.engine === 'offline (fallback)' ? d.engine : providerLabel(d.engine);
  const failed = [];
  for (const [i, p] of answerParts(d).entries()) {
    const r = vet(p, fresh, { lenient });
    if (r.item) { applyItem(r.item, p.action, p.target, spokeAt, source, i > 0); continue; }
    if (r.ev !== 'empty') log({ ev: r.ev, text: r.text, kind: r.kind, numbers: r.numbers, spoken: r.spoken, final: lenient || !r.note });
    if (r.note && !lenient) failed.push({ ...r, part: p });
  }
  return failed;
}

function publishReady({ id, text, keyword, complete, kind, person, source, spokeAt }) {
  if (publish(text, { keyword, complete, kind, person, source, id })) recordLatency(spokeAt, 'show', text);
}

function recordLatency(spokeAt, type, text) {
  if (!spokeAt) return;
  status.latencyMs = Date.now() - spokeAt;
  log({ ev: 'latency', ms: status.latencyMs });
  if (testRun) testRun.events.push({ at: Date.now() - testRun.t0, latency: status.latencyMs, type, text });
}

/* ---------------- one-minute system test ---------------- */
// "play": streams a recorded mixed-language speech through the real pipeline, as if it came from the mic.
// "read": the operator reads the same script into the mic. Both end with a scorecard on the panel.
// Recordings: test-speech (the panel's 1-minute test) and optionally eval-speech (a longer check).
const speechFile = (name, ext) => path.join(__dirname, 'public', 'assets', `${name === 'eval' ? 'eval' : 'test'}-speech.${ext}`);
let testRun = null;

function resetSession() {
  // Before a new talk: forget rehearsal highlights so the AI does not refuse them as repeats.
  for (const x of [...live]) hideItem(x.id);
  pending = []; history.length = 0; recentTexts.length = 0;
  clearQueue();
  heard = ''; resetSpeech(); speech.context = '';
  Object.assign(status, { latencyMs: 0, shown: 0, aiCalls: 0 });
  log({ ev: 'reset_session' });
  pushHeard(); pushControl();
}

function playTest(ws, name = 'test') {
  if (testRun) return sendWs(ws, { type: 'toast', level: 'warn', msg: 'A test is already running.' });
  if (status.listening) return sendWs(ws, { type: 'toast', level: 'warn', msg: 'Stop listening first, then run the test.' });
  let pcm, marks;
  try { pcm = fs.readFileSync(speechFile(name, 'pcm')); marks = readJson(speechFile(name, 'json')); } catch { return sendWs(ws, { type: 'toast', level: 'bad', msg: 'Test audio missing: run node scripts/make-test-audio.mjs' }); }
  // Browser speech cannot take recorded audio; use the best server-side engine instead.
  const engine = settings.sttEngine !== 'browser' ? settings.sttEngine : secrets.soniox ? 'soniox' : 'groq';
  resetSession();
  startCapture(null, engine, 'test speech');
  testRun = { kind: 'play', t0: Date.now(), marks, events: [], engine };
  log({ ev: 'test_start', kind: 'play', engine });
  toast(`Playing the 1-minute test speech through ${engine === 'soniox' ? 'Soniox' : engine}… watch the backdrop.`, 'info');
  const CHUNK = 3200; // 100 ms of 16 kHz 16-bit audio
  let sent = 0;
  testRun.timer = setInterval(() => {
    // Send exactly as much audio as real time allows, like a live microphone.
    const due = Math.min(pcm.length, Math.floor(((Date.now() - testRun.t0) / 100) + 1) * CHUNK);
    while (sent < due) { sttAudio(pcm.subarray(sent, sent + CHUNK)); lastAudioAt = Date.now(); sent += CHUNK; }
    const p = Math.floor((sent / pcm.length) * 20) * 5;
    if (p !== testRun.progress) { testRun.progress = p; pushControl(); }
    if (sent >= pcm.length) { clearInterval(testRun.timer); testRun.timer = setTimeout(() => finishTest(), 4000); }
  }, 50);
}

function finishTest(cancelled = false) {
  const run = testRun;
  if (!run) return;
  testRun = null;
  clearInterval(run.timer); clearTimeout(run.timer);
  if (run.kind === 'play') stopCapture();
  // A highlight belongs to the sentence being spoken when it appeared (the AI needs ~0.3 s of words first).
  // Its delay is measured from the end of that sentence; appearing before the end counts as 0 (shown while speaking).
  const owner = (at) => run.marks.filter((m) => (m.startsAtMs ?? 0) + 300 <= at).pop() || run.marks[0];
  const delay = (e) => (run.marks ? Math.max(0, e.at - owner(e.at).endsAtMs) : e.latency);
  const lat = run.events.map(delay).sort((a, b) => a - b);
  const rows = run.marks
    ? run.marks.map((m) => ({
        said: m.text, lang: m.lang, expect: m.expect,
        results: run.events.filter((e) => owner(e.at) === m).map((e) => ({ type: e.type, text: e.text, ms: delay(e) })),
      }))
    : run.events.map((e) => ({ said: '', results: [{ type: e.type, text: e.text, ms: e.latency }] }));
  const report = {
    type: 'test-report', kind: run.kind, cancelled, engine: run.engine || status.captureEngine || settings.sttEngine,
    count: run.events.length, median: lat.length ? lat[Math.floor(lat.length / 2)] : null, max: lat.length ? lat[lat.length - 1] : null, rows,
  };
  log({ ev: 'test_report', ...report });
  sendTo('control', report);
}

// The decision loop: judge the new speech as soon as the speaker pauses, one AI call at a time.
let inflight = false;
let lastFinalizeAt = 0;
// The operator chose how Hindi and Gujarati are written; a line in another script breaks that choice.
function wrongScript(t) {
  const hi = /[\u0900-\u097F]/.test(t), gu = /[\u0A80-\u0AFF]/.test(t);
  if (settings.translate) return hi || gu;
  return (hi && settings.scriptHi === 'roman') || (gu && settings.scriptGu === 'roman');
}
// The recogniser adds a full stop wherever the speaker pauses. If the words end on a joining word
// ("Seva is our.", "पैसा कमाना skill है, और।", "નોકરી શોધવા કરતાં"), the sentence is not over.
const OPEN_END = /(\b(is|are|was|our|my|your|the|a|an|to|of|and|or|but|with|for|that|which|like|than)|\s(और|कि|का|की|के|को|ने|से|में|पर|या|लेकिन|क्योंकि|અને|કે|ને|નો|ની|નું|માં|થી|પણ|કરતાં|જેમ))$/i;
setInterval(async () => {
  if (inflight) return;
  if (settings.paused || settings.standby) { if (speech.fresh || speech.held) speech.context = (speech.context + ' ' + speech.held + ' ' + speech.fresh).slice(-1000); resetSpeech(); return; }
  const fresh = speech.fresh.trim();
  const words = wordCount(fresh);
  const pause = Date.now() - speech.lastTokenAt;
  const heldWords = wordCount(speech.held);
  // Soniox: the speaker paused but words are still provisional. Ask Soniox to finalise them now.
  // Soniox asks that finalize is not sent too often, so at most once every 1.2 s.
  // Silence from the audio when we have it (Soniox, Groq); otherwise from the text (browser speech).
  const silent = voice.lastVoiceAt && Date.now() - lastAudioAt < 1000 ? voice.silentFor() : pause;
  if (speech.nonFinal.trim() && silent >= settings.pauseMs && !speech.finalizeSent && Date.now() - lastFinalizeAt > 1200 && stt.ws && stt.ws.readyState === WebSocket.OPEN) {
    speech.finalizeSent = true;
    lastFinalizeAt = Date.now();
    try { stt.ws.send(JSON.stringify({ type: 'finalize' })); } catch {}
  }
  // Held words with nothing new after them: once the speaker has clearly stopped, take a last look.
  const silentNow = voice.lastVoiceAt && Date.now() - lastAudioAt < 1000 ? voice.silentFor() : pause;
  // After a failed AI call, held words wait a few seconds before the next try, so retries do not hammer a rate limit.
  const lastChance = !words && heldWords && !speech.nonFinal.trim() && silentNow >= 2500 && Date.now() >= (speech.retryAt || 0);
  if (!words && !lastChance) return;
  const settled = !speech.nonFinal.trim();
  // Judge at the end of a sentence (Soniox and Whisper punctuate), so one sentence is not split into two
  // highlights at a comma. Without a full stop, wait for a longer pause. Very long runs are judged anyway.
  const sentenceEnd = /[.?!।॥]["'”’)]*$/.test(fresh) && !OPEN_END.test(fresh.replace(/[.?!।॥,;:"'”’)\s]+$/, ''));
  const ready = lastChance || (settled && sentenceEnd && (speech.endpoint || pause >= 150)) // Soniox closed a full sentence: go now
    || (settled && silent >= Math.max(900, settings.pauseMs)) || words + heldWords >= 30 || pause >= 2500;
  if (!ready || (words + heldWords < 2 && pause < 2500)) return;

  const spokeAt = speech.lastTokenAt;
  // Held words come first, then the new ones, judged as one passage.
  const passage = [speech.held, fresh].filter(Boolean).join(' ');
  const tags = { ...speech.heldTags };
  for (const [l, n] of Object.entries(speech.tags)) tags[l] = (tags[l] || 0) + n;
  const heldCount = speech.heldCount;
  speech.held = ''; speech.heldTags = {}; speech.heldCount = 0;
  speech.tags = {};
  speech.fresh = '';
  speech.endpoint = false;
  speech.finalizeSent = false;
  inflight = true;
  const t0 = Date.now();
  try {
    const opts = { held: heldCount, lastChance: lastChance || heldCount >= 3 || wordCount(passage) > 45 };
    const d = await decideWith(passage, tags, opts);
    status.aiCalls++;
    status.aiMs = Date.now() - t0;
    log({ ev: 'decision', ms: status.aiMs, usage: d.usage, engine: d.engine, action: d.action, target: d.target, kind: d.kind, person: d.person, text: d.highlight, more: moreTexts(d), complete: d.complete, held: heldCount, heard: passage.slice(-220) });
    // Every AI failed (no internet, no credits): keep the words and judge them again with what comes next,
    // so a short outage costs a delay instead of the point.
    const hold = (d.failed || d.action === 'wait') && heldCount < 3 && wordCount(passage) <= 45;
    if (hold) {
      // Mid-thought: keep these words and judge them again together with what the speaker says next.
      speech.held = passage; speech.heldTags = tags; speech.heldCount = heldCount + 1;
      speech.retryAt = d.failed ? Date.now() + 3000 : 0;
      return;
    }
    const failed = applyDecision(d, spokeAt, passage);
    if (failed.length) {
      // A line broke a rule (too long, a number not said, a translation, wrong script). Ask once more with the reason.
      const note = failed.map((r) => r.note).join(' ') + ' Items you already put on screen are listed above: do not repeat them; answer only for the line(s) that need fixing.';
      const d2 = await decideWith(passage, tags, { ...opts, lastChance: true, note });
      log({ ev: 'decision_retry', ms: Date.now() - t0, action: d2.action, kind: d2.kind, text: d2.highlight, more: moreTexts(d2) });
      if (!d2.failed) applyDecision(d2, spokeAt, passage, { lenient: true });
      // The second call itself failed: show the first version if it passes the relaxed rules (a slightly long line
      // beats a missing point). Lines with unspoken numbers or translations still never go up.
      else for (const f of failed) applyDecision({ ...f.part, more: [], engine: d.engine }, spokeAt, passage, { lenient: true });
    }
  } catch (e) {
    setStatus({ ai: 'error', aiMsg: String(e.message || e).slice(0, 160) });
  } finally {
    if (!speech.held) speech.context = (speech.context + ' ' + passage).slice(-1000);
    inflight = false;
    pushControl();
  }
}, 60);

/* ---------------- sweeper: a second look for missed points ---------------- */
// The main loop judges speech sentence by sentence and sometimes misses a point (a wait that ended in none, an AI
// outage, a long passage). Every 20 s the last ~45 s of speech and all cards shown in that time go to the AI once more.
// A missed point must quote the speaker's exact words; the server checks those words are really in the transcript
// and were said in the last 35 s (so nothing appears badly out of step), then the usual checks apply.
let sweepInflight = false, lastSweepTo = 0;
async function sweep() {
  while (shownLog.length && shownLog[0].at < Date.now() - 150000) shownLog.shift();
  if (sweepInflight || !settings.sweeper || !status.listening || settings.paused || settings.standby || DEMO || settings.aiEngine === 'offline') return;
  const now = Date.now(), from = now - 45000, to = now - 6000; // the newest 6 s still belong to the main loop
  const chunks = finalsLog.filter((f) => f.at >= from && f.at <= to);
  if (!chunks.some((f) => f.at > lastSweepTo)) return; // nothing new since the last look
  const transcript = chunks.map((f) => f.text).join('').trim();
  if (wordCount(transcript) < 8) return;
  lastSweepTo = to;
  const shown = [...new Set(shownLog.filter((x) => x.at >= from - 15000).map((x) => x.text).concat(live.map((x) => x.text), queue.map((x) => x.text), pending.map((x) => x.text)))];
  const extra = [settings.aiInstructions, !settings.showMoney && 'Never show money amounts.', !settings.allowHumor && 'Never use the humor kind.'].filter(Boolean).join('\n');
  const system = sweepPrompt({ context: settings.eventContext, scriptHi: settings.scriptHi, scriptGu: settings.scriptGu, translate: settings.translate, extra });
  const user = sweepInput({
    speaker: [settings.speaker, settings.speakerRole].filter(Boolean).join(', '),
    terms: allTerms().join(', '),
    people: speakers.all().filter((x) => x.id !== settings.activeSpeakerId).map((x) => [x.name, x.role].filter(Boolean).join(' – ')).join('; '),
    transcript, shown,
  });
  sweepInflight = true;
  const t0 = Date.now();
  try {
    const order = [settings.aiEngine, settings.aiBackup].filter((p, i, a) => p && p !== 'none' && a.indexOf(p) === i && secrets[PROVIDERS[p]?.key] && !(aiRestUntil[p] > Date.now()));
    let r = null;
    for (const p of order) {
      try { r = await pick(p, { key: secrets[PROVIDERS[p].key], model: modelFor(p), system, user, schema: SWEEP_SCHEMA, timeoutMs: p === 'gemini' ? 15000 : 8000 }); break; }
      catch (e) { log({ ev: 'sweep_error', provider: p, msg: String(e.message || e).slice(0, 160) }); }
    }
    const missed = Array.isArray(r?.missed) ? r.missed.slice(0, 2) : [];
    log({ ev: 'sweep', ms: Date.now() - t0, words: wordCount(transcript), found: missed.map((m) => m.highlight) });
    const all = norm(transcript), recent = norm(finalsLog.filter((f) => f.at >= now - 35000).map((f) => f.text).join(''));
    for (const m of missed) {
      const ev = norm(String(m.evidence || ''));
      if (wordCount(ev) < 3 || !all.includes(ev)) { log({ ev: 'sweep_bad_evidence', text: m.highlight, evidence: m.evidence }); continue; }
      if (!recent.includes(ev)) { log({ ev: 'sweep_too_old', text: m.highlight }); continue; }
      const v = vet({ ...m, action: 'new', target: 0, complete: true }, transcript);
      if (!v.item) { log({ ev: 'sweep_' + v.ev, text: m.highlight }); continue; }
      if (applyItem(v.item, 'new', 0, 0, 'sweeper')) log({ ev: 'sweep_added', text: v.item.text, evidence: m.evidence });
    }
  } catch (e) {
    log({ ev: 'sweep_error', msg: String(e.message || e).slice(0, 160) });
  } finally {
    sweepInflight = false;
  }
}
setInterval(sweep, 20000);

/* ---------------- phrase-based speech engines (Groq Whisper, Sarvam) ---------------- */
let segQueue = Promise.resolve();
const segmenter = new Segmenter({
  minSec: 2.5, silenceMs: 500, maxSec: 9, // short phrases keep the delay low
  onSegment: (pcm) => {
    const engine = status.captureEngine;
    if (engine !== 'groq' && engine !== 'sarvam') return;
    const opts = {
      key: secrets[STT_KEY[engine]],
      model: engine === 'groq' ? settings.groqModel : settings.sarvamModel,
      language: settings.sttLanguage,
      mode: settings.sarvamMode,
      // Whisper reads the prompt as preceding text: names to spell right plus the last words heard.
      prompt: [settings.speaker, settings.topic, ...listOf(settings.terms)].filter(Boolean).join(', ') + '. ' + heard.slice(-200),
      terms: allTerms(),
    };
    // Phrases are transcribed one after another so the text stays in spoken order.
    segQueue = segQueue.then(async () => {
      const t0 = Date.now();
      try {
        const text = await transcribe(engine, pcm, opts);
        setStatus({ stt: 'live', sttMsg: `${engine === 'groq' ? 'Groq Whisper' : 'Sarvam'} · ${Date.now() - t0} ms${status.failover ? ' · ' + status.failover : ''}` });
        if (text) { addFinal(' ' + text); markEndpoint(); pushHeard(); }
      } catch (e) {
        log({ ev: 'stt_error', msg: e.message });
        setStatus({ stt: e.status === 401 || e.status === 403 ? 'error' : 'reconnecting', sttMsg: e.message.slice(0, 200) });
      }
    });
  },
});

/* ---------------- Soniox relay (real-time, Hindi + Gujarati + English in one stream) ---------------- */
const stt = { ws: null, wanted: false, backoff: 700, queue: [], failures: 0 };

function sonioxConfig() {
  const general = [{ key: 'domain', value: settings.eventContext || 'Live conference talk' }];
  if (settings.speaker) general.push({ key: 'speaker', value: settings.speaker });
  if (settings.topic) general.push({ key: 'topic', value: settings.topic });
  const cfg = {
    model: 'stt-rt-v5',
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    language_hints: settings.languageHints,
    enable_endpoint_detection: true,
    enable_language_identification: true, // per-word language tags: tells the AI when accented English is written in Devanagari
    max_endpoint_delay_ms: settings.endpointMs,
    // Soniox's documented low-latency starting point.
    endpoint_latency_adjustment_level: 2,
    endpoint_sensitivity: 0.3,
    context: { general, terms: allTerms().slice(0, 200) },
  };
  if (settings.topic) cfg.context.text = settings.topic;
  return cfg;
}

// Soniox refused us for an account reason (bad key, no credit). Keep the show going on Groq Whisper.
function sonioxFailover(reason) {
  if (!settings.sttFailover || !secrets.groq || status.captureEngine !== 'soniox') return false;
  stt.wanted = false;
  try { stt.ws && stt.ws.close(); } catch {}
  segmenter.reset();
  setStatus({ captureEngine: 'groq', stt: 'live', failover: 'backup engine', sttMsg: 'Groq Whisper (backup)' });
  toast(`Soniox stopped (${reason}). Switched to Groq Whisper backup: slower, fix Soniox when you can.`, 'bad');
  log({ ev: 'stt_failover', reason });
  return true;
}

function sttStart() {
  stt.wanted = true;
  if (stt.ws && stt.ws.readyState <= WebSocket.OPEN) return;
  if (!secrets.soniox) {
    stt.wanted = false;
    if (sonioxFailover('no Soniox key')) return;
    return setStatus({ stt: 'error', sttMsg: 'Soniox API key not set (Engines tab).' });
  }
  setStatus({ stt: 'connecting', sttMsg: '' });
  const ws = new WebSocket(SONIOX_URL, { headers: { Authorization: `Bearer ${secrets.soniox}` }, handshakeTimeout: 5000 });
  stt.ws = ws;
  ws.on('open', () => {
    stt.lastMsgAt = Date.now();
    ws.send(JSON.stringify(sonioxConfig()));
    for (const c of stt.queue) ws.send(c);
    stt.queue = [];
    stt.backoff = 700;
    stt.failures = 0;
    setStatus({ stt: 'live', sttMsg: 'Soniox real-time' });
  });
  ws.on('message', (data) => {
    stt.lastMsgAt = Date.now();
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.error_code) {
      log({ ev: 'stt_error', m });
      const msg = `${m.error_code} ${m.error_type || ''} ${m.error_message || ''}`.slice(0, 200);
      if ([400, 401, 402, 403].includes(m.error_code)) { stt.wanted = false; if (sonioxFailover(msg)) return; }
      return setStatus({ stt: 'error', sttMsg: msg });
    }
    let nonFinal = '', finals = '', ended = false;
    for (const t of m.tokens || []) {
      if (t.text === '<end>' || t.text === '<fin>') { ended = true; continue; }
      if (t.is_final) { finals += t.text; if (t.language && t.text.trim()) speech.tags[t.language] = (speech.tags[t.language] || 0) + 1; } else nonFinal += t.text;
    }
    addFinal(finals, { confirm: !!speech.nonFinal.trim() }); // one log line per message, not per token
    if (ended) markEndpoint();
    setNonFinal(nonFinal);
    pushHeard();
  });
  ws.on('error', (e) => log({ ev: 'stt_ws_error', msg: String(e.message) }));
  ws.on('close', () => {
    if (stt.ws === ws) stt.ws = null;
    setNonFinal('');
    if (stt.wanted) {
      stt.failures++;
      setStatus({ stt: 'reconnecting', sttMsg: `Soniox reconnecting (try ${stt.failures})` });
      setTimeout(() => stt.wanted && sttStart(), stt.backoff);
      stt.backoff = Math.min(stt.backoff * 1.7, 4000);
    } else if (status.stt !== 'error' && status.captureEngine === 'soniox') setStatus({ stt: 'idle' });
  });
}

function sttStop() {
  stt.wanted = false;
  stt.queue = [];
  const ws = stt.ws;
  if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(''); } catch {} }
  setTimeout(() => { try { ws && ws.close(); } catch {} }, 1500);
}

function sttAudio(buf) {
  voice.push(buf);
  if (status.captureEngine === 'groq' || status.captureEngine === 'sarvam') return segmenter.push(buf);
  // The last ~8 s sent are kept, so a connection found dead can be replayed on the new one (see the watchdog below).
  stt.recent = stt.recent || [];
  stt.recent.push({ at: Date.now(), buf });
  if (stt.recent.length > 80) stt.recent.shift();
  if (stt.ws && stt.ws.readyState === WebSocket.OPEN) return stt.ws.send(buf);
  if (stt.wanted) { stt.queue.push(buf); if (stt.queue.length > 60) stt.queue.shift(); } // ~6 s buffered while reconnecting
}

setInterval(() => {
  if (stt.ws && stt.ws.readyState === WebSocket.OPEN) { try { stt.ws.send(JSON.stringify({ type: 'keepalive' })); } catch {} }
}, 15000);

// A connection can die without closing (a hotspot or WiFi drop): it still reads OPEN while nothing comes back,
// and the backdrop would simply go quiet. If someone has been speaking for 5 s and Soniox has sent nothing,
// the connection is dead: cut it, reconnect, and replay the audio Soniox never answered.
setInterval(() => {
  const ws = stt.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || !stt.lastMsgAt || status.captureEngine !== 'soniox') return;
  const speaking = Date.now() - lastAudioAt < 1500 && voice.lastVoiceAt && voice.lastVoiceAt - stt.lastMsgAt > 5000;
  if (!speaking) return;
  log({ ev: 'stt_dead_socket', silentMs: Date.now() - stt.lastMsgAt });
  toast('Speech recognition stopped answering (network?). Reconnecting and replaying the last seconds…', 'warn');
  stt.queue = (stt.recent || []).filter((c) => c.at > stt.lastMsgAt - 500).map((c) => c.buf).slice(-60);
  stt.lastMsgAt = 0;
  try { ws.terminate(); } catch {}
}, 1000);

/* ---------------- keep the AI warm ---------------- */
// The first AI call after a quiet spell was slow (3.8 s in a real test): the provider's side goes cold.
// A tiny throw-away decision when listening starts, and after 30 s without AI calls, keeps it quick.
let lastAiAt = 0;
function warmAI(why) {
  const p = settings.aiEngine;
  if (!PROVIDERS[p] || !secrets[PROVIDERS[p].key] || DEMO) return;
  const t0 = Date.now();
  askAI(p, 'नमस्ते, आप सबका स्वागत है।', {}).then(() => log({ ev: 'warm', why, ms: Date.now() - t0 }), () => {});
}
setInterval(() => { if (status.listening && !inflight && Date.now() - lastAiAt > 12000) warmAI('idle'); }, 3000);

/* ---------------- capture ownership: exactly one panel listens at a time ---------------- */
let captureOwner = null;
let ownerLostTimer = null;
let lastAudioAt = 0;

// The "already shown, never repeat" memory. It belongs to one talk: after a break of over a minute
// (a re-run of a test, the next session), or a new speaker, it starts empty again.
let lastStopAt = 0;
function forgetShown(why) {
  if (!recentTexts.length) return;
  recentTexts.length = 0;
  log({ ev: 'memory_cleared', why });
  pushControl();
}

function startCapture(ws, engine, label) {
  if (lastStopAt && Date.now() - lastStopAt > 60000) forgetShown('new listening session');
  if (captureOwner && captureOwner !== ws) sendWs(captureOwner, { type: 'capture-stop', reason: `Listening moved to ${label}` });
  captureOwner = ws;
  clearTimeout(ownerLostTimer);
  segmenter.reset();
  resetSpeech();
  setStatus({ listening: true, captureBy: label, captureEngine: engine, failover: '' });
  if (engine === 'soniox') sttStart();
  else {
    if (stt.wanted) sttStop();
    if (STT_KEY[engine] && !secrets[STT_KEY[engine]]) setStatus({ stt: 'error', sttMsg: `${engine} API key not set (Engines tab)` });
    else setStatus({ stt: 'live', sttMsg: engine === 'browser' ? 'browser speech' : `${engine}: waiting for the first phrase` });
  }
  log({ ev: 'listen_start', engine, by: label });
  warmAI('listen start');
}

function stopCapture() {
  lastStopAt = Date.now();
  if (captureOwner) sendWs(captureOwner, { type: 'capture-stop', reason: 'Stopped' });
  captureOwner = null;
  clearTimeout(ownerLostTimer);
  segmenter.flush();
  sttStop();
  setNonFinal('');
  setStatus({ listening: false, captureBy: '', captureEngine: '', stt: 'idle', sttMsg: '', failover: '' });
  log({ ev: 'listen_stop' });
}

// Watchdog: listening but no audio arriving means the mic or the panel stalled. Tell the operator.
setInterval(() => {
  if (status.listening && status.captureEngine !== 'browser' && lastAudioAt && Date.now() - lastAudioAt > 4000) {
    if (status.stt !== 'no audio') setStatus({ stt: 'no audio', sttMsg: 'No sound reaching the server for 4 s: check the mic / panel' });
  }
}, 1000);

/* ---------------- HTTP ---------------- */
const app = express();
// Only this laptop may connect, unless ALLOW_LAN=1 in .env (e.g. to use a phone as a second panel). On venue WiFi,
// anyone who guessed the key could otherwise type text onto the LED or stop the show.
const ALLOW_LAN = process.env.ALLOW_LAN === '1';
const isLocal = (addr = '') => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
app.use((req, res, next) => (ALLOW_LAN || isLocal(req.socket.remoteAddress) ? next() : res.status(403).send('This backdrop only accepts connections from its own laptop.')));
app.use(express.json({ limit: '50kb' }));
const authed = (req) => req.query.key === CONTROL_KEY || req.get('x-control-key') === CONTROL_KEY;
const page = (f) => (_, res) => res.sendFile(path.join(__dirname, 'public', f));

app.get('/', (req, res) => res.redirect('/display'));
app.get('/display', page('display.html'));
app.get('/control', (req, res) => (authed(req) ? page('control.html')(req, res) : res.status(401).send(`<body style="font:16px system-ui;background:#0b0e1a;color:#fff;padding:40px">Wrong or missing key. Open <code>/control?key=YOUR_CONTROL_KEY</code></body>`)));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));
// Fonts are served from this computer so the backdrop never depends on venue internet for them.
app.use('/fonts', express.static(path.join(__dirname, 'node_modules', '@fontsource'), { maxAge: '7d' }));
// Speaker photo upload from the operator panel (raw image body). Saved resized; returns the URL.
app.post('/upload-photo', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  if (!authed(req)) return res.status(401).end();
  try { res.json({ url: await speakers.savePhoto(req.body) }); }
  catch (e) { log({ ev: 'photo_error', msg: e.message }); res.status(400).json({ error: 'Could not read that image. Use a JPG or PNG.' }); }
});
app.get('/health', (_, res) => res.json({ ok: true, stt: status.stt, ai: status.ai, displays: displayCount(), panels: controlCount(), latencyMs: status.latencyMs }));

// Recap of the session: everything heard and shown today, as Markdown.
app.get('/export', (req, res) => {
  if (!authed(req)) return res.status(401).end();
  let lines = [];
  try { lines = fs.readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch {}
  const shown = lines.filter((l) => l.ev === 'show' || l.ev === 'update').map((l) => `- ${l.t.slice(11, 19)}  ${l.ev === 'update' ? '(updated) ' : ''}${l.text}`);
  const said = lines.filter((l) => l.ev === 'final').map((l) => l.text).join('');
  res.type('text/markdown').set('Content-Disposition', `attachment; filename="backdrop-recap-${new Date().toISOString().slice(0, 10)}.md"`)
    .send(`# ${settings.eventTitle} — backdrop recap\n\n## Highlights shown (${shown.length})\n${shown.join('\n') || '_none_'}\n\n## Transcript\n${said.trim() || '_none_'}\n`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws') return socket.destroy();
  if (!ALLOW_LAN && !isLocal(req.socket.remoteAddress)) return socket.destroy();
  const role = u.searchParams.get('role');
  if (role === 'control' && u.searchParams.get('key') !== CONTROL_KEY) return socket.destroy();
  if (role !== 'control' && role !== 'display') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = role;
    ws.id = clientSeq++;
    ws.preview = u.searchParams.has('preview');
    ws.label = (u.searchParams.get('label') || `${role} #${ws.id}`).slice(0, 60);
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (ws.role === 'display') { sendWs(ws, displayState()); pushControl(); } else { sendWs(ws, fullState()); pushControl(); }
  ws.on('close', () => {
    clients.delete(ws);
    if (ws === captureOwner) {
      captureOwner = null;
      // The panel may just be reconnecting. Give it 20 seconds before we stop listening.
      ownerLostTimer = setTimeout(() => { if (!captureOwner && status.listening) { stopCapture(); toast('Listening stopped: the panel that captured audio disconnected', 'bad'); } }, 20000);
    }
    pushControl();
  });

  ws.on('message', (data, isBinary) => {
    // The backdrop reports whether it is really fullscreen and in front; the panel warns if not.
    if (ws.role === 'display' && !isBinary && !ws.preview) {
      try { const m = JSON.parse(data.toString()); if (m.type === 'display-health') { ws.health = { fs: !!m.fs, visible: !!m.visible, at: Date.now() }; updateDisplayHealth(); } } catch {}
      return;
    }
    if (ws.role !== 'control') return;
    if (isBinary) {
      if (ws === captureOwner) {
        lastAudioAt = Date.now();
        if (status.stt === 'no audio') setStatus({ stt: 'live', sttMsg: '' });
        sttAudio(data);
      }
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (settings.showLock && (SHOW_LOCKED.has(m.type) || (m.type === 'start' && /test/i.test(String(m.label || ''))))) {
      log({ ev: 'show_lock_refused', cmd: m.type });
      return sendWs(ws, { type: 'toast', level: 'warn', msg: 'Show lock is on: tests and setup tools are disabled during the event. Turn Show lock off on the Live tab first.' });
    }
    switch (m.type) {
      case 'start': lastAudioAt = 0; startCapture(ws, SCHEMA.sttEngine.options.includes(m.engine) ? m.engine : 'browser', String(m.label || ws.label).slice(0, 60)); break;
      case 'resume-capture': if (!captureOwner && status.listening) { captureOwner = ws; clearTimeout(ownerLostTimer); setStatus({ captureBy: ws.label }); } break;
      case 'stop':
        // Only the panel that is listening may stop it, unless the operator confirmed stopping another panel.
        if (captureOwner && ws !== captureOwner && !m.force) { log({ ev: 'stop_refused', by: ws.label }); break; }
        stopCapture(); if (testRun?.kind === 'read') finishTest(); break;
      case 'stt-text': // Browser speech engine: the panel sends text, we treat it like Soniox tokens.
        if (ws !== captureOwner) break;
        if (m.final) { setNonFinal(''); addFinal(' ' + String(m.text || '').trim()); markEndpoint(); } else setNonFinal(' ' + String(m.text || ''));
        pushHeard();
        break;
      case 'stt-status': if (ws === captureOwner) setStatus({ stt: String(m.state || 'live'), sttMsg: String(m.msg || '').slice(0, 200) }); break;
      case 'settings': {
        const ctxKeys = ['languageHints', 'terms', 'speaker', 'topic', 'eventContext', 'endpointMs'];
        const before = JSON.stringify(ctxKeys.map((k) => settings[k]));
        applySettings(m.settings || {});
        log({ ev: 'settings', changed: Object.keys(m.settings || {}).filter((k) => !['fontScale', 'safeMargin', 'reserveBottom', 'textShare'].includes(k)).reduce((o, k) => ({ ...o, [k]: settings[k] }), {}) });
        if (m.settings && 'maxVisible' in m.settings) while (live.length > settings.maxVisible) hideItem(live[0].id);
        pushControl(); pushDisplay();
        if (!settings.showCaptions) sendTo('display', { type: 'caption', text: '' });
        // Recognition context changed: reconnect Soniox so it uses the new names and languages.
        if (before !== JSON.stringify(ctxKeys.map((k) => settings[k])) && stt.wanted && stt.ws) { try { stt.ws.close(); } catch {} }
        break;
      }
      case 'speaker-save': {
        const sp = speakers.upsert(m.speaker || {});
        if (sp.id === settings.activeSpeakerId) activateSpeaker(sp.id); // refresh what is on screen
        pushControl();
        sendWs(ws, { type: 'toast', level: 'ok', msg: `Saved ${sp.name || 'speaker'}` });
        break;
      }
      case 'speaker-delete': speakers.remove(m.id); if (m.id === settings.activeSpeakerId) activateSpeaker(''); pushControl(); break;
      case 'speaker-move': speakers.move(m.id, m.dir === -1 ? -1 : 1); pushControl(); break;
      case 'speaker-activate': activateSpeaker(m.id); break;
      case 'speaker-step': { // next or previous speaker in the running order
        const list = speakers.all();
        if (!list.length) break;
        const i = list.findIndex((x) => x.id === settings.activeSpeakerId);
        const j = i < 0 ? (m.dir === -1 ? list.length - 1 : 0) : i + (m.dir === -1 ? -1 : 1);
        if (j >= 0 && j < list.length) activateSpeaker(list[j].id);
        else sendWs(ws, { type: 'toast', level: 'info', msg: m.dir === -1 ? 'Already at the first speaker' : 'That was the last speaker' });
        break;
      }
      case 'preset': {
        const p = PRESETS[m.name];
        if (!p) break;
        applySettings(p.settings);
        pushControl(); pushDisplay();
        toast(`Loaded "${p.label}"`, 'ok');
        log({ ev: 'preset', name: m.name });
        if (stt.wanted && stt.ws) { try { stt.ws.close(); } catch {} }
        break;
      }
      case 'reset-look': applySettings(Object.fromEntries(LOOK_KEYS.filter((k) => !['eventTitle', 'eventTagline', 'speaker', 'speakerRole', 'speakerPhoto', 'standby', 'standbyText', 'logoUrl', 'logoLeft', 'logoRight'].includes(k)).map((k) => [k, DEFAULTS[k]]))); pushControl(); pushDisplay(); break;
      case 'approve': {
        const i = pending.findIndex((p) => p.id === m.id);
        if (i >= 0) {
          const [it] = pending.splice(i, 1);
          // An approved rewrite changes its card in place; if that card has gone, it is shown as a new one.
          if (!(it.replaces && updateItem(it.replaces, it))) showItem(it);
          log({ ev: 'approved', text: it.text });
        }
        break;
      }
      case 'edit-approve': {
        const i = pending.findIndex((p) => p.id === m.id);
        if (i >= 0) {
          const [it] = pending.splice(i, 1);
          const t = String(m.text || '').slice(0, 160);
          const done = it.replaces && updateItem(it.replaces, { text: cleanText(t), keyword: '', complete: true, kind: it.kind });
          const entry = done ? live.find((x) => x.id === it.replaces) : publish(t, { force: true, kind: it.kind, source: 'edited' });
          lockEntry(entry?.id);
          log({ ev: 'approved_edited', text: t });
        }
        break;
      }
      case 'edit-live': { const e = live.find((x) => x.id === m.id); const t = cleanText(String(m.text || '').slice(0, 160)); if (e && t) { updateItem(e.id, { text: t, keyword: t.includes(e.keyword) ? e.keyword : '', complete: true }); e.locked = true; } break; }
      case 'reject': pending = pending.filter((p) => p.id !== m.id); pushControl(); break;
      case 'remove': hideItem(m.id); break;
      case 'pin': { const e = live.find((x) => x.id === m.id); if (e) { e.pinned = !e.pinned; if (!e.pinned) e.expires = Date.now() + settings.ttlMin * 1000; armTimer(e); pushControl(); pushDisplay(); } break; }
      case 'manual': lockEntry(publish(String(m.text || '').slice(0, 160), { force: true, source: 'manual' })?.id); break;
      case 'reshow': { const h = history.find((x) => x.id === m.id); if (h) publish(h.text, { force: true, source: 'manual' }); break; }
      case 'clear': for (const x of [...live]) hideItem(x.id); pending = []; clearQueue(); pushControl(); break;
      case 'inject': addFinal(' ' + String(m.text || '').slice(0, 4000)); markEndpoint(); pushHeard(); break;
      case 'forget-shown': forgetShown('operator'); toast('Memory cleared: earlier lines may be shown again', 'ok'); break;
      case 'clear-transcript': heard = ''; resetSpeech(); speech.context = ''; pushHeard(); break;
      case 'reset-session': resetSession(); toast('Fresh session: earlier highlights forgotten', 'ok'); break;
      case 'play-test': playTest(ws, m.name); break;
      case 'read-test': // the operator reads the test speech into the mic; scored when they stop listening
        resetSession();
        testRun = { kind: 'read', t0: Date.now(), events: [] };
        log({ ev: 'test_start', kind: 'read' });
        break;
      case 'cancel-test': if (testRun) finishTest(true); break;
      case 'set-keys': {
        for (const k of KEY_NAMES) if (typeof m[k] === 'string') secrets[k] = m[k].trim();
        try { writeJson(SECRETS_FILE, secrets); } catch {}
        toast('API keys saved', 'ok');
        pushControl();
        break;
      }
      case 'test-ai': testAi(ws, PROVIDERS[m.provider] ? m.provider : settings.aiEngine); break;
      case 'test-stt': testStt(ws, STT_KEY[m.engine] ? m.engine : settings.sttEngine); break;
      case 'list-models': listModels(m.provider, secrets[PROVIDERS[m.provider]?.key]).then((models) => sendWs(ws, { type: 'models', provider: m.provider, models }), (e) => sendWs(ws, { type: 'toast', level: 'bad', msg: String(e.message || e).slice(0, 200) })); break;
      case 'identify': sendTo('display', { type: 'identify' }); break;
      case 'drill-drop-stt': if (stt.ws) { log({ ev: 'drill_drop_stt' }); stt.ws.terminate(); } break; // failure drill: simulates a network drop
    }
  });
});

async function testAi(ws, provider) {
  if (provider === 'offline') return sendWs(ws, { type: 'toast', level: 'info', msg: 'The offline picker needs no key.' });
  const sample = 'दोस्तों, कहते हैं कि नदी में पत्थर सालों पड़ा रहे फिर भी अंदर से नरम नहीं होता';
  const t0 = Date.now();
  const label = PROVIDERS[provider].label;
  try {
    const system = decisionPrompt({ minWords: settings.minWords, maxWords: settings.maxWords, context: settings.eventContext, scriptHi: settings.scriptHi, scriptGu: settings.scriptGu, translate: settings.translate, unfinished: settings.unfinished });
    const user = decisionInput({ speaker: settings.speaker, topic: settings.topic, terms: 'JITO', onScreen: [], shown: [], context: '', fresh: sample, tags: {} });
    const out = await pick(provider, { key: secrets[PROVIDERS[provider].key], model: modelFor(provider), system, user, schema: DECISION_SCHEMA, timeoutMs: 8000 });
    sendWs(ws, { type: 'toast', level: 'ok', msg: `${label} works (${Date.now() - t0} ms, ${modelFor(provider)}): “${out.highlight || '(' + out.action + ')'}”` });
  } catch (e) {
    sendWs(ws, { type: 'toast', level: 'bad', msg: `${label} test failed: ${String(e.message || e).slice(0, 220)}` });
  }
}

async function testStt(ws, engine) {
  if (!secrets[STT_KEY[engine]]) return sendWs(ws, { type: 'toast', level: 'bad', msg: `No ${engine} key set` });
  if (engine === 'soniox') {
    const t = new WebSocket(SONIOX_URL, { headers: { Authorization: `Bearer ${secrets.soniox}` } });
    let done = false;
    const finish = (ok, msg) => { if (done) return; done = true; sendWs(ws, { type: 'toast', level: ok ? 'ok' : 'bad', msg }); try { t.close(); } catch {} };
    t.on('open', () => { t.send(JSON.stringify(sonioxConfig())); t.send(Buffer.alloc(32000)); setTimeout(() => finish(true, 'Soniox key works'), 2500); });
    t.on('message', (d) => { try { const m = JSON.parse(d.toString()); if (m.error_code) finish(false, `Soniox: ${m.error_code} ${m.error_message || ''}`); } catch {} });
    t.on('error', (e) => finish(false, `Soniox: ${e.message}`));
    setTimeout(() => finish(false, 'Soniox: timed out'), 8000);
    return;
  }
  // One second of faint noise: enough to prove the key and endpoint work.
  const pcm = new Int16Array(16000).map(() => Math.round((Math.random() - 0.5) * 60));
  const t0 = Date.now();
  try {
    await transcribe(engine, pcm, { key: secrets[STT_KEY[engine]], model: engine === 'groq' ? settings.groqModel : settings.sarvamModel, language: settings.sttLanguage, mode: settings.sarvamMode });
    sendWs(ws, { type: 'toast', level: 'ok', msg: `${engine === 'groq' ? 'Groq Whisper' : 'Sarvam'} key works (${Date.now() - t0} ms)` });
  } catch (e) {
    sendWs(ws, { type: 'toast', level: 'bad', msg: e.message });
  }
}

setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`\nPort ${PORT} is already in use. Is the backdrop already running? Close it or set PORT in .env.\n`); process.exit(1); }
  throw e;
});

// A crash or restart mid-talk must not blank the backdrop or make the AI repeat itself. The cards on screen,
// the lines already shown and the recent speech are saved every 2 s, and restored if the server is back within 3 minutes.
const STATE_FILE = path.join(DATA, 'state.json');
let savedState = '';
setInterval(() => {
  const body = JSON.stringify({
    live: live.map(({ id, text, keyword, kind, person, complete, source, expires, pinned, locked }) => ({ id, text, keyword, kind, person, complete, source, expires, pinned, locked })),
    recentTexts, context: speech.context, nextId,
  });
  if (body === savedState) return;
  savedState = body;
  try { fs.writeFileSync(STATE_FILE + '.tmp', `{"at":${Date.now()},"state":${body}}`); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch {}
}, 2000);
(function restoreState() {
  try {
    const { at, state } = readJson(STATE_FILE);
    if (Date.now() - at > 180000) return;
    nextId = Math.max(nextId, state.nextId || 1);
    recentTexts.push(...(state.recentTexts || []));
    speech.context = state.context || '';
    for (const x of state.live || []) {
      const entry = { ...x, created: Date.now(), expires: Math.max(x.expires || 0, Date.now() + 8000) };
      armTimer(entry);
      live.push(entry);
    }
    log({ ev: 'state_restored', cards: live.length, ageMs: Date.now() - at });
    console.log(`  Restored ${live.length} card(s) from ${Math.round((Date.now() - at) / 1000)} s ago (restart mid-talk).`);
  } catch {}
})();

server.listen(PORT, () => { // dual-stack: answers on localhost via IPv4 and IPv6
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\n  Live Backdrop running${DEMO ? ' (DEMO: offline highlight picker)' : ''}`);
  console.log(`  Backdrop (LED):  http://localhost:${PORT}/display`);
  console.log(`  Operator panel:  http://localhost:${PORT}/control?key=${CONTROL_KEY}`);
  if (ALLOW_LAN) for (const ip of ips) console.log(`  From phone:      http://${ip}:${PORT}/control?key=${CONTROL_KEY}`);
  else console.log('  Other devices on the network are refused (set ALLOW_LAN=1 in .env to allow a phone).');
  if (ALLOW_LAN && CONTROL_KEY.length < 12) console.log('  WARNING: other devices are allowed and CONTROL_KEY is short. Set a long random key in .env.');
  console.log(`  On the backdrop, press Ctrl+Shift+S (or double-click the top-left corner) for hidden settings.`);
  const aiKey = PROVIDERS[settings.aiEngine] && secrets[PROVIDERS[settings.aiEngine].key];
  if (settings.aiEngine !== 'offline' && !aiKey && !DEMO) console.log(`  Note: no ${PROVIDERS[settings.aiEngine].label} key yet (Engines & keys).`);
  if (settings.sttEngine === 'soniox' && !secrets.soniox) console.log(`  Note: no Soniox key yet. ${secrets.groq ? 'Groq Whisper will be used as backup.' : ''}`);
  console.log('');
});

process.on('uncaughtException', (e) => { console.error('uncaught', e); log({ ev: 'uncaught', msg: String(e?.stack || e) }); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); log({ ev: 'unhandled', msg: String(e?.stack || e) }); });
