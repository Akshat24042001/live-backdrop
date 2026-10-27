// Generates public/assets/test-speech.pcm (16 kHz mono 16-bit) from the test speech with Soniox text-to-speech,
// plus test-speech.json with where each sentence ends. The panel's "Play test speech" streams it like a live mic.
// Run: node scripts/make-test-audio.mjs   (uses the Soniox key saved in data/secrets.json)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_SPEECH } from '../lib/test-speech.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = process.env.SONIOX_API_KEY || JSON.parse(fs.readFileSync(path.join(root, 'data', 'secrets.json'), 'utf8').replace(/^﻿/, '')).soniox;
if (!key) { console.error('No Soniox key. Add it in the panel (Engines & keys) first.'); process.exit(1); }

const RATE = 16000;
const gap = (sec) => Buffer.alloc(Math.round(sec * RATE) * 2); // silence between sentences, like a speaker breathing
const parts = [gap(1)];
const marks = [];
let samples = RATE;

for (const [i, s] of TEST_SPEECH.entries()) {
  const res = await fetch('https://tts-rt.soniox.com/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'tts-rt-v2', language: s.lang, voice: 'Adrian', audio_format: 'pcm_s16le', sample_rate: RATE, text: s.text }),
  });
  if (!res.ok) { console.error(`Sentence ${i + 1}: ${res.status} ${await res.text()}`); process.exit(1); }
  const pcm = Buffer.from(await res.arrayBuffer());
  const startsAtMs = Math.round((samples / RATE) * 1000);
  parts.push(pcm);
  samples += pcm.length / 2;
  marks.push({ i, startsAtMs, endsAtMs: Math.round((samples / RATE) * 1000), ...s });
  const pause = i === 1 ? 0.9 : 1.6; // a short breath inside the proverb, so the halves arrive separately
  parts.push(gap(pause));
  samples += pause * RATE;
  console.log(`${i + 1}. ${s.lang}  ${(pcm.length / 2 / RATE).toFixed(1)} s  ${s.text}`);
}
parts.push(gap(2));
fs.writeFileSync(path.join(root, 'public', 'assets', 'test-speech.pcm'), Buffer.concat(parts));
fs.writeFileSync(path.join(root, 'public', 'assets', 'test-speech.json'), JSON.stringify(marks, null, 2));
console.log(`\nTotal ${(samples / RATE).toFixed(1)} s -> public/assets/test-speech.pcm`);
