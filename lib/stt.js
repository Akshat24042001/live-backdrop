// Phrase-by-phrase speech recognition for engines without a live stream (Groq Whisper, Sarvam).
// Audio arrives as 16 kHz mono 16-bit PCM; we cut it at natural pauses and send each phrase.

const RATE = 16000;
const FRAME = 320; // 20 ms

export class Segmenter {
  constructor({ onSegment, minSec = 4, maxSec = 12, silenceMs = 650 }) {
    Object.assign(this, { onSegment, minSec, maxSec, silenceMs });
    this.reset();
    this.floor = 200; // adaptive noise floor (RMS)
  }
  reset() { this.chunks = []; this.samples = 0; this.speechMs = 0; this.silentMs = 0; this.carry = new Int16Array(0); }

  push(buf) {
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    this.chunks.push(pcm);
    this.samples += pcm.length;
    // Voice activity: frame energy against a slowly adapting noise floor.
    const all = this.carry.length ? concat([this.carry, pcm]) : pcm;
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      let sum = 0;
      for (let j = i; j < i + FRAME; j++) sum += all[j] * all[j];
      const rms = Math.sqrt(sum / FRAME);
      const speech = rms > Math.max(this.floor * 2.8, 350);
      if (speech) { this.speechMs += 20; this.silentMs = 0; } else { this.silentMs += 20; this.floor = this.floor * 0.98 + rms * 0.02; }
    }
    this.carry = all.slice(i);
    const sec = this.samples / RATE;
    if ((sec >= this.minSec && this.silentMs >= this.silenceMs) || sec >= this.maxSec) this.flush();
    else if (this.speechMs === 0 && sec >= 3) this.reset(); // pure silence: drop it, keep latency low
  }

  flush() {
    if (!this.samples) return;
    const pcm = concat(this.chunks), speechMs = this.speechMs;
    this.reset();
    if (speechMs >= 500) this.onSegment(pcm, speechMs); // too little speech: Whisper would invent text
  }
}

function concat(arrs) {
  const out = new Int16Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export function wav(pcm) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Whisper's well-known inventions on noise or applause.
const HALLUCINATION = /^\s*(thank you[.!]*|thanks for watching.*|please subscribe.*|subtitles? by.*|you|bye[.!]*|\.+|music|\[.*\]|\(.*\))\s*$/i;

async function post(url, headers, form, label) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error(`${label}: ${e.name === 'TimeoutError' ? 'timed out' : 'no connection'}`); }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw Object.assign(new Error(`${label}: ${res.status} ${res.status === 401 || res.status === 403 ? 'invalid API key' : json?.error?.message || json?.message || text.slice(0, 160)}`), { status: res.status });
  return json;
}

export async function transcribe(engine, pcm, { key, model, language, mode, prompt, terms }) {
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'phrase.wav');
  let text = '';
  if (engine === 'groq') {
    form.append('model', model || 'whisper-large-v3-turbo');
    form.append('temperature', '0');
    form.append('response_format', 'json');
    if (language && language !== 'auto') form.append('language', language);
    if (prompt) form.append('prompt', prompt.slice(-600));
    text = (await post('https://api.groq.com/openai/v1/audio/transcriptions', { Authorization: `Bearer ${key}` }, form, 'Groq')).text;
  } else if (engine === 'sarvam') {
    const m = model || 'saaras:v3';
    form.append('model', m);
    form.append('language_code', language && language !== 'auto' ? `${language}-IN` : 'unknown');
    if (m === 'saaras:v3' && mode) form.append('mode', mode);
    if (m === 'saaras:v4' && terms?.length) form.append('keyterms', JSON.stringify(terms.slice(0, 50).map((t) => t.slice(0, 64))));
    text = (await post('https://api.sarvam.ai/speech-to-text', { 'api-subscription-key': key }, form, 'Sarvam')).transcript;
  }
  text = String(text || '').trim();
  return HALLUCINATION.test(text) ? '' : text;
}

// Detects when the speaker actually stops, from the sound itself. The transcript is not reliable for this:
// Soniox keeps revising provisional words during silence, which looks like ongoing speech.
export class VoiceActivity {
  constructor() { this.floor = 200; this.lastVoiceAt = 0; this.carry = new Int16Array(0); }
  push(buf) {
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const all = this.carry.length ? concat([this.carry, pcm]) : pcm;
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) {
      let sum = 0;
      for (let j = i; j < i + FRAME; j++) sum += all[j] * all[j];
      const rms = Math.sqrt(sum / FRAME);
      if (rms > Math.max(this.floor * 2.8, 350)) this.lastVoiceAt = Date.now();
      else this.floor = this.floor * 0.98 + rms * 0.02;
    }
    this.carry = all.slice(i);
  }
  silentFor() { return this.lastVoiceAt ? Date.now() - this.lastVoiceAt : 0; }
}
