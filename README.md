# Live Backdrop

Listens to the speaker and puts their key points on the LED wall behind them, live, in about a second. Hindi, Gujarati and English, mixed freely. The audience only ever sees the backdrop; every control lives in the operator panel (or a hidden drawer on the backdrop).

```
 mic / sound-desk line-out ─► Operator panel (Chrome) ─audio─► server.js ─► Soniox: speech → text, word by word (Hindi + Gujarati + English)
                                                                    │      ─► Grok: "new / update / nothing" decision, ~0.8 s
                                                                    ▼
                                                        Backdrop page on the LED (light event themes)
```

**Measured on this laptop:** highlights appear 0.8–1.0 s after the speaker pauses (Grok `grok-4.20-0309-non-reasoning`). Greetings, thanks and MC announcements are skipped. A half-said idea waits for the rest, or shows early and is completed in place.

## Start it

Double-click **`Start Backdrop.bat`**. It starts the server (it restarts itself within 2 s if it ever crashes), opens the backdrop fullscreen on the second screen and the operator panel on the laptop. Windows display mode must be **Extend** (`Win + P`).

## 1-minute system test (the switch)

**Rehearsal → 1-minute system test** (or **1-minute test** on the Live tab):
- **▶ Play test speech**: a 64-second Hindi + Gujarati + English recording runs through the real system (Soniox → AI → backdrop), no mic needed. Ends with a scorecard: what was said, what the backdrop showed, and how many seconds after each sentence.
- **🎙 Read it myself**: the same ten lines appear on the panel; read them into the mic, then press **Stop listening** for the scorecard.

Both start a fresh session. Press **Start fresh session** again before the real talk. Measured with real Soniox: typically 1.0–1.3 s after each sentence, slowest 1.6 s. The recording is rebuilt with `node scripts/make-test-audio.mjs`.

## Catch-rate test (does every key point reach the screen?)

`node scripts/recall-test.mjs 3` plays a 3-minute business speech (27 lines, Hindi + Gujarati + English, 31 marked key points: stats, years, lessons, a pledge, a list of three, a question, a shloka, humour) into the running server at speaking pace, three times, and prints which points reached the backdrop and which were missed. It uses the real AI but no Soniox credit. It resets the session and puts cards on any open backdrop, so run it before the event, not during. `LINES=2-11 GAP=20000` plays part of it slowly (for a rate-limited free AI key).

## AI health

Both AIs (main and backup) are checked at start-up and every 3 minutes. A dead key or an **empty account** shows in red on the panel ("OUT OF CREDITS or spending limit reached") before the talk, not as a blank backdrop during it. xAI blocks the whole account when its credit or monthly spending limit runs out.

## Engines

| Job | Engine | Why |
|---|---|---|
| Speech → text | **Soniox** (paid, about ₹10 per hour) | The only option that streams word by word **and** follows Hindi, Gujarati and English mixed in one sentence. Needed for the ~1 s goal. |
| Backup speech | Groq Whisper (free key) | Takes over automatically if Soniox has no key or no credit. Slower (2–4 s) and one language at a time. |
| Highlight decisions | **Grok** `grok-4.20-0309-non-reasoning` | Best balance in tests: ~0.85 s, kept Gujarati as Gujarati, never invented numbers. |
| Backup AI | Groq `gpt-oss-120b` | Used only when Grok fails. Its **free tier is not a real backup**: in testing it hit its rate limit within a few sentences even at one sentence every 20 s. Add billing to the Groq account (or another paid provider) before the event. |

Rejected after testing: Grok 4.3 / Build (5–10 s), Groq Qwen (fast but invented a number and translated Gujarati into Hindi), Whisper as the main engine (translates Hindi to English on auto-detect, forces one language, needs a pause).

## Event presets

**Speaker & event → Event preset.** One click loads the look, titles, logos, the context the AI reads, and the names recognition must spell right:
- **Navyoday 2026–2028** — light cream theme with the poster's geometric border, golden sun, Navyoday logo, JITO emblem and wing badges.
- **Behind the Success** — a light version of the poster: ivory stage, warm gold spotlights, gold serif title.

Logos are in `public/assets/` and are rebuilt from `assets-src/` with `node scripts/make-assets.mjs`.

## On the day: runbook

**Day before**
1. Buy Soniox credit, paste the key (Engines & keys → Soniox → Save → Test). Test Grok and Groq too.
2. Load the preset. Add the speaker's name and role (Speaker & event). Add names you expect (family names, company names, places) to *Names and special words*.
3. Rehearse with a 10-minute Hindi/Gujarati YouTube talk (Audio → Listen to → A browser tab's sound).
4. Check the latency chip on the panel: "Speech → screen" should be green (under 1.8 s).

5. **Top up xAI and raise its monthly spending limit; add billing to Groq.** The panel's AI chips must both be green. The free Groq tier cannot carry a talk.
6. Run `node scripts/unit-test.mjs` (rules) and `SPEECH=tribute node scripts/recall-test.mjs 3`, `SPEECH=tricky …`, `SPEECH=business …` (catch rate). Read every MISSED line.
7. Agree with the sound vendor: a **post-fader aux with podium mics only** (not the main mix: no MC, videos, music or audience mics). Bring a DI box with ground lift in case of hum.
8. Agree with the LED vendor: the wall's exact pixel size (output exactly that from the laptop, no scaling), and a **fallback slide** (the event backdrop JPG) held on *their* processor, switchable in one press.
9. Agree with the committee: approval mode on or off, money amounts on or off (*Show money amounts*), humour on or off, and **who calls the kill** (one person, one code word: wrong name or photo, any doubtful money line, two garbled lines in 5 minutes, or a red chip → fallback slide at once).

**At the venue (60 minutes before)**
1. Laptop on charger. Windows: Focus assist on, sleep off, no updates pending. Close every other app.
2. Audio: a **cable** from the sound desk (line out / aux) into a USB audio adapter on the laptop. Not WO Mic or Bluetooth: phones pause the mic when they play anything or get a call. Audio tab: pick the device, processing switches off, peaks in green/yellow.
3. LED: Win+P → Extend. Start Backdrop.bat. Press **Identify screens** to confirm the backdrop is on the LED. Look at it from the back row; adjust *Text size* and *Keep bottom clear* (Look tab) so nothing hides behind the podium or chairs.
4. Internet: phone hotspot as the main line, a second phone or SIM as backup. Not the venue Wi-Fi.
5. Rehearsal → **Start fresh session**. Without this, the AI refuses rehearsal lines as repeats.
6. Windows: Settings → Power → USB selective suspend **off** (plugged in and battery), notifications off, Windows Update paused, lid-close action "do nothing".
7. Sit at the sound desk (front of house), not beside the stage. Two people: the operator, and a Gujarati/Hindi-fluent committee member who watches the wall and calls removals.
8. Last step before doors open: **Show lock ON** (Live tab). Tests, demo, identify, presets and reset are then refused, and the LED window cannot leave fullscreen by a stray key. The panel shows a red chip if the backdrop is ever not fullscreen.

**Press P (pause) for every non-speech moment**: MC, national anthem, Navkar Mantra, the oath (Navyoday), office-bearer installation, felicitations, videos, condolences, audience Q&A. The backdrop only knows what it hears; it cannot tell the MC from the chief guest.

**During the talk**
- **Approve mode ON** = a human approves each line (safest, adds your reaction time). **OFF** = fully live, ~1 s. With it off, keep a finger near the keys.
- `C` clears the screen instantly. `B` switches to the standby screen (title only). `P` pauses highlights (MC, anthem, breaks).
- **Edit** fixes a line already on the backdrop in place. **Remove** takes one line down.
- Type your own line in the manual box at any time.
- Status chips: Speech (green = live), AI (yellow = backup in use, red = failing: nothing will be shown), Speech → screen latency, Screens connected.

**If something breaks**
| Symptom | What happens / what to do |
|---|---|
| Soniox key/credit problem | Automatic switch to Groq Whisper (toast on the panel). Highlights get slower. |
| Grok fails | Groq AI takes over (AI chip turns yellow). If every AI fails, the backdrop shows nothing new: never junk. |
| Internet drops | Nothing new appears; the backdrop keeps its look. Use the manual box, or press `B` for standby. |
| Server crash | Restarts within 2 s; the backdrop and panel reconnect by themselves, and the cards on screen are restored. |
| Network blip while Soniox looks connected | Detected after 5 s of speech with no answer: reconnects and replays the missed seconds (toast on the panel). |
| Audio interface unplugged | Red alarm; the laptop's own mic is **not** used instead. Plug it back in: listening resumes by itself. |
| AI account empty | Checked at start-up and every 3 minutes: red AI chip "OUT OF CREDITS" before the talk, not a blank screen during it. |
| No sound reaching the server for 4 s | Speech chip shows "no audio": check the cable / mic. |
| Wrong or awkward line on screen | `Remove` it, or `Edit` it in place. `C` clears everything. |

## Settings worth knowing

- **Highlight language** (Engines): Hinglish (default: the speaker's own words in English letters), Hindi in English letters with Gujarati in Gujarati script, native scripts, or always English.
- **When an idea is half-said**: show early then complete it in place (default), or wait until complete.
- **Judge after a pause of**: 450 ms default. Lower is faster but cuts ideas.
- **Keep bottom clear**: the lower part of the LED that the podium or chairs cover. Highlights stay above it.
- **Live captions** (Look): off by default. The raw transcript shows recognition mistakes, which is not what you want in front of these guests.

Logs of everything heard, every AI decision and its timing are in `logs/`. Rehearsal → Download recap gives a Markdown summary after the event.
