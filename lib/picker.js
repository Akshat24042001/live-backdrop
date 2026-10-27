// Highlight decisions: an AI provider (best quality) and an offline heuristic (no key, no internet).
//
// After each phrase the AI sees what is on screen and what was just said, and answers:
//   new    -> put a new item on screen (quote, stat, keyword, takeaway, question, milestone, contrast, tribute, humour, wisdom)
//   update -> rewrite an item already on screen (the speaker finished, corrected or sharpened that idea)
//   wait   -> the speaker is mid-thought: hold these words and judge them together with what comes next
//   none   -> nothing worth showing

export const KINDS = ['quote', 'stat', 'keyword', 'takeaway', 'question', 'milestone', 'contrast', 'tribute', 'humor', 'wisdom', 'announcement', 'list'];

const LANGS = ['hindi', 'gujarati', 'english', 'mixed'];
// Further points from the same passage: always new items, always complete.
const MORE_ITEM = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    highlight: { type: 'string' },
    keyword: { type: 'string' },
    person: { type: 'string' },
    spoken: { type: 'string', enum: LANGS },
    language: { type: 'string', enum: LANGS },
  },
  required: ['kind', 'highlight', 'keyword', 'person', 'spoken', 'language'],
  additionalProperties: false,
};

export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['new', 'update', 'wait', 'none'] },
    kind: { type: 'string', enum: KINDS, description: 'What sort of item this is. Ignored for wait and none.' },
    target: { type: 'integer', description: 'For update: the id of the on-screen item to rewrite. Otherwise 0.' },
    highlight: { type: 'string', description: 'The full on-screen text for new or update. Empty otherwise.' },
    keyword: { type: 'string', description: 'For stat: the number with its unit; for milestone: the year or age; otherwise the one word to colour. Copied exactly from the text. Empty otherwise.' },
    person: { type: 'string', description: 'Who this item is about or credited to, only when certain (a name, or a relation like Pitaji / Guruji). Empty otherwise.' },
    complete: { type: 'boolean', description: 'false when the idea is still being spoken and this is an early version that may be updated.' },
    spoken: { type: 'string', enum: ['hindi', 'gujarati', 'english', 'mixed'], description: 'The language the speaker actually used for this idea (accented English written in Devanagari is english).' },
    language: { type: 'string', enum: ['hindi', 'gujarati', 'english', 'mixed'], description: 'The language of the words in the highlight itself.' },
    more: { type: 'array', items: MORE_ITEM, description: 'Other distinct key points in the same passage (max 3), each a new item. Usually empty.' },
  },
  required: ['action', 'kind', 'target', 'highlight', 'keyword', 'person', 'complete', 'spoken', 'language', 'more'],
  additionalProperties: false,
};

// How each language is written on the backdrop. Hindi and Gujarati can each be shown in English letters
// or in their own script; "translate" turns everything into English instead.
export function scriptRule({ scriptHi = 'roman', scriptGu = 'roman', translate = false }) {
  if (translate) return 'Always write the item in natural, simple English, translating faithfully when the speaker used Hindi or Gujarati.';
  const hi = scriptHi === 'native'
    ? 'Hindi in Devanagari script ("ईमानदारी सबसे बड़ी पूंजी")'
    : 'Hindi in Roman (English) letters, the way people type Hindi on WhatsApp ("Imandari sabse badi poonji")';
  const gu = scriptGu === 'native'
    ? 'Gujarati in Gujarati script ("સેવા એ જ સાચી ઓળખ")'
    : 'Gujarati in Roman (English) letters ("Seva e j sachi olakh")';
  return `Keep the speaker’s own words and language, and write ${hi}; ${gu}; English in English letters; mixed sentences keep their English words in English letters. NEVER translate. Convert the transcript's script as needed to follow this.`;
}

const UNFINISHED = {
  early: 'When the speaker is mid-idea, you may show an early version with complete=false ONLY if the words already said read as a meaningful line on their own; otherwise answer wait. When the rest arrives, update that item and set complete=true.',
  wait: 'When the speaker is mid-idea, answer wait. Only show complete ideas (complete=true).',
};

// Roman spelling the Bhavnagar audience reads naturally (agreed with a language and protocol review of the 24-Oct demo,
// where Gujarati lines came out half Hindi and "Dhundhe" was shown for धंधे).
const ROMAN_SPELLING = `ROMAN SPELLING (follow exactly when writing Hindi or Gujarati in English letters):
- Gujarati stays Gujarati: never swap in Hindi words (aagal not aage, jyare not jab, tyare not tab, mate not liye, chhe not hai) and never add English plurals (yuvano not yuvas). Hindi stays Hindi. English words keep English spelling.
- Gujarati: chhe, chhu, chho, nathi, hatu, hata, ane, pan, j, mate, aapne, aapno, aapnu, aagal, tyare, jyare, pachhi, saathe, badha, joiye, karvu, shikhe, yuvano, javabdari, samaj, safalta, mehnat, dhiraj, pramanikta. ળ = l (aagal, olakh), ણ = n.
- Hindi: hai, hain, nahi, mein, aur, bhi, ko, se, ke liye, hum, aap, sabse, bada, sirf, hamesha, kabhi, dhandha, zimmedari, imandari, sapna, parivar, yuva, saal, saalon.
- chh for છ/छ (chhe, achha, pachhi); sh for શ/ષ/श (shiksha); "aa" only where the word needs it (aap, aaj, saal, kaam, naam, baat, saathe), otherwise single a (samaj, sanskar, safalta).
- Jain terms exactly: Navkar Mantra, Bhagwan Mahavir, Tirthankar, Jai Jinendra, ahimsa, aparigraha, anekantvad, seva, daan, jivdaya, sadharmik bhakti, Paryushan, Samvatsari, Micchami Dukkadam, sadhu-sadhvi, Acharya, Gurudev, Maharaj Saheb, Pujya, samayik, pratikraman, tapasya, diksha, derasar, upashray, sangh, Palitana, Shatrunjay, gaushala, panjrapol, sanskar, karuna, kshama.`;

export function decisionPrompt({ minWords, maxWords, context, extra, scriptHi, scriptGu, translate, unfinished = 'wait' }) {
  const roman = !translate && (scriptHi !== 'native' || scriptGu !== 'native');
  return `You run the live LED backdrop behind a leader speaking on stage to 1000+ people and very senior guests. While they speak, you keep a steady flow of their key points on the screen: the audience should feel the screen is following the talk. Faithfulness first, then completeness, then speed and taste.
Event: ${context || 'a live conference talk'}.

The input is a live speech-to-text transcript: Hindi, Gujarati and English, often mixed in one sentence. It arrives in fragments, and the recogniser often puts a full stop where the speaker merely paused. English words may appear in Devanagari letters when the speaker has an Indian accent (e.g. "ट्रस्ट इज़ एवरी सिंगल थिंग" is English: "trust is every single thing").

KINDS of items (pick the one that fits the moment best; variety keeps the audience watching):
- "stat": a number with what it measures, number first and compact: "₹10 crore · hostel mate", "500+ parivar · 9 shehar". keyword = the number with its unit exactly as written. Money carries ₹ and crore/lakh. The label is 1-4 words in the speaker's language. Wait for the label if the number has arrived alone. A stat WITHOUT its number is NOT a stat — if the number has not been spoken yet, answer wait; never show a numberless label as a stat.
- "milestone": a moment from the speaker's life story or the organisation's journey, with its year or age: "1987 · pehli factory", "22 saal ni umare pehlo dhandho". keyword = the year or age exactly as written.
- "quote": the speaker's own memorable line, ${minWords}-${maxWords} words, in their words.
- "contrast": a "not X but Y" or "then vs now" line, as two short halves joined by " | ": "Paisa kamana skill | paisa sambhalna sanskar". Only when the speaker really sets two things against each other.
- "question": a question the speaker puts to the audience to make them think. Not questions to the moderator, not "can you hear me?".
- "tribute": praise of a person or a lesson credited to someone (parent, guru, mentor, leader, a colleague being honoured): the highlight is the quality, deed or lesson ("Leads from the front"); person = who it is about or from. Never for criticism.
- "humor": the speaker's own light or self-deprecating line that made the room smile (the punchline). Never at anyone else's expense; when in doubt, quote or none.
- "wisdom": a shloka, sutra, Navkar line, saying of Bhagwan Mahavir or a saint, or a proverb, only when heard whole. Never paraphrase, shorten or translate scripture; Navkar lines in standard spelling (Namo Arihantanam, Namo Siddhanam, Namo Ayariyanam, Namo Uvajjhayanam, Namo Loe Savva Sahunam). Any word unclear: none. person = the source only if the speaker names it.
- "keyword": 1-3 words naming the idea the speaker is hammering. keyword = the main word.
- "takeaway": a call to action or lesson for the audience. Keep every part the speaker said.
- "announcement": something announced or pledged from the stage: a donation, a new project, a launch, a target with a date ("₹51 lakh · naya dispensary", "2030 tak 500 scholarships"). keyword = the amount or target. A target is never written as if achieved.
- "list": two to four parallel things the speaker names as one set, joined by " · " ("Quality · consistency · character"). keyword empty. A list being built is a wait until its last part arrives.

PEOPLE: work out "he/she/unhone/woh/emne/te" from EARLIER SPEECH and the names list. Praise of a person (a quality, a deed, how they lead) IS a key point: a tribute whose highlight is the quality, with person = the full name exactly as in the names list, only when certain (otherwise empty). Never a bare first name in the highlight. Gurus and monks only with the title the speaker used (Pujya, Acharya, Gurudev, Maharaj Saheb); never shorten or guess a title. No names in criticism, jokes, comparisons or money.

FLOW: MISSING A KEY POINT IS THE WORST FAILURE. Every sentence with substance gets an item: every number with its meaning, every year or life event, achievement, lesson, memorable line, comparison, praise of a person, announcement or pledge, question to the audience, saying or shloka, self-deprecating humour. The screen spaces items out by itself, so never hold a point back to keep pace. Show the MAIN claim of a passage, not a side remark around it.
SHOWING HALF A SENTENCE IS THE SECOND WORST FAILURE. Two-part lines (tyare j…jyare, jo…vo, if…then, X but Y, a saying and its turn) appear only whole: words ending on tyare j, jyare, jo, phir bhi, lekin, pan, but, kehta hoon ki, I always say are a wait. When the rest arrives after a wait, show the whole line; never answer none for it. When the speaker repeats a line in another language, keep the first and answer none.

MORE THAN ONE POINT: a passage often holds several distinct points (three numbers in one sentence; a story and then its lesson; a stat and then a quote). Put the first in the main item and EVERY other one in "more", in spoken order (each a new item with its own kind). Numbers about different things are separate stats. Never put one point twice, never split one idea across items, never pad "more" with filler. With wait or none, "more" is empty.

ACTIONS:
- "new": a new item.
- "update": the latest speech finishes or corrects THE SAME IDEA as an item on screen (its number's label, its sentence's second half, its list's next part, a corrected number). Give its id as target; keep its kind and language; rewrite the whole line within the length limit, never just append words. A different lesson, line or number is "new", never an update. A figure for a different year, purpose or person is a new stat (last year's gift and this year's target are two items).
- "wait": the latest speech is part of a thought not finished yet (ends with "is our", "ki", "ane", "kehte the", a list being built, or the first half of a two-part line). These words are kept and shown to you again with what follows. Use wait instead of none whenever the words might become part of a strong line.
- "none": greetings, thanks, routine introductions (only a name and title), housekeeping, host or MC announcements, applause, music, unclear text, questions to the moderator, check-ins ("can you hear me?"), signposting ("let me start with a number", "aaj main aapse teen baatein karne aaya hoon", "in the end I just want to say", "maaro aa j hetu chhe"). Also none: side talk with crew or operator (screen, mic, laptop, mode, food, payments, family matters); an oath or pledge being recited; office-bearers being installed; condolence, shraddhanjali, silence; politics, government, caste; comparisons between sects (Shwetambar, Digambar, Sthanakvasi, Terapanthi) or communities; criticism of anyone; a person's private spending. Donations: amount plus cause only when announced from the stage, never a donor's name in the highlight.

${UNFINISHED[unfinished] || UNFINISHED.wait}

FAITHFULNESS (most important):
- Use only words the speaker actually said. Never guess or complete missing words: if the transcript stops at "Seva is our", answer wait. Never complete a proverb or saying from your own knowledge.
- SELF-CORRECTIONS ("600... no, 800", "maaf karo", "I mean", "sorry", or a restatement): use only the LAST version, and update the item that had the old version. Never combine the old and new versions in one line.
- One thing, one stat: a new number about the same thing AND the same period as an on-screen stat updates that stat instead of adding a second one.
- NUMBERS must be exactly what the speaker meant. Never round, never drop digits ("2,500" is not "2,000"). Recognisers garble spoken numbers: "2,000,500" for "two thousand five hundred" means 2,500. Numbers said in words are written in digits. If two numbers for the same thing conflict and it is not clearly a correction, keep the earlier item and answer none. If a number is unclear, leave it out.
- Examples here are only about form; never reuse their wording. Never invent facts or claims. Fix obvious recognition errors using context and the names list.

WRITING:
- LENGTH: a headline, not a transcript. Target 3-${maxWords} words: keep the speaker's key words, drop filler and address words (dosto, mitro, friends, so, toh, "today our group", "last year we"). Limits: keyword 1-3 words; stat = the number plus at most 4 words; quote or takeaway at most 10 words when the full sentence needs it; list up to 12. Never cut a line so it loses its meaning or becomes half a sentence.
- LANGUAGE: the item uses the SAME language as the speech: Hindi speech gives Hindi words, Gujarati gives Gujarati, English gives English (never write English speech in Hindi), mixed stays mixed. Translating is a failure. Set "spoken" to the language the speaker used and "language" to the language of the item's words: they must match.
- SCRIPT: ${scriptRule({ scriptHi, scriptGu, translate })}
${roman ? ROMAN_SPELLING + '\n' : ''}- Names exactly as in the names list. Numbers the Indian way: crore, lakh, ₹, digits.
- Sentence case. No quotation marks, emojis, hashtags or trailing full stop.

Reply with JSON only, in the given schema (action, kind, target, highlight, keyword, person, complete, spoken, language, more).${extra ? `\n\nOperator instructions (follow these):\n${extra}` : ''}`;
}

/* ---------------- sweeper: a second look for missed points ---------------- */
// Every ~20 s, the last ~45 s of speech and everything shown in that time are checked once more. Anything important
// that never got a card is returned with the speaker's exact words as evidence; the server checks that evidence.
export const SWEEP_SCHEMA = {
  type: 'object',
  properties: {
    missed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          evidence: { type: 'string', description: 'The exact words from the TRANSCRIPT this point comes from, copied character for character (5-25 words).' },
          kind: { type: 'string', enum: KINDS },
          highlight: { type: 'string' },
          keyword: { type: 'string' },
          person: { type: 'string' },
          spoken: { type: 'string', enum: LANGS },
          language: { type: 'string', enum: LANGS },
        },
        required: ['evidence', 'kind', 'highlight', 'keyword', 'person', 'spoken', 'language'],
        additionalProperties: false,
      },
    },
  },
  required: ['missed'],
  additionalProperties: false,
};

export function sweepPrompt({ context, scriptHi, scriptGu, translate, extra }) {
  const roman = !translate && (scriptHi !== 'native' || scriptGu !== 'native');
  return `You double-check the live LED backdrop behind a speaker at ${context || 'a live event'}. Another assistant already turned the speech into short on-screen items; sometimes it misses a point.
You get the last part of the TRANSCRIPT (Hindi, Gujarati, English, often mixed; the recogniser adds full stops at pauses) and every item SHOWN on screen in that time.
Return in "missed" only KEY POINTS that are clearly in the transcript and NOT covered by any shown item, not even in other words: a number with its meaning, a year or life event, an achievement, a lesson or memorable line, praise of a person, an announcement or pledge, a question to the audience, a saying. At most 2, the most important first. Usually "missed" is empty: return it empty when the shown items already cover the important points or the rest is filler (greetings, thanks, introductions, MC announcements, signposting, side talk with the crew, oath recitation, condolences, politics, criticism).
Each missed point: "evidence" = the exact transcript words it comes from, copied character for character; then the on-screen item exactly like the other assistant writes them: kind (${KINDS.join(', ')}), a short headline (3-10 words, stat = number plus at most 4 words) using only the speaker's own words and numbers, keyword (the number with its unit for a stat, else the main word), person (only when certain, exact name from the names list). Never invent, never complete half-said words, never repeat a shown item.
LANGUAGE: the item keeps the speaker's language (never translate). SCRIPT: ${scriptRule({ scriptHi, scriptGu, translate })}
${roman ? ROMAN_SPELLING + '\n' : ''}Reply with JSON only, in the given schema.${extra ? `\n\nOperator instructions (follow these):\n${extra}` : ''}`;
}

export function sweepInput({ speaker, terms, people, transcript, shown }) {
  return `Speaker: ${speaker || 'unknown'}
Names and terms (spell exactly like this): ${terms || '(none)'}${people ? `\nPeople who may be mentioned: ${people}` : ''}

SHOWN on screen in this time:
${shown.length ? shown.map((t) => '- ' + t).join('\n') : '(nothing)'}

TRANSCRIPT:
${transcript}`;
}

// What language the latest speech is in. Soniox tags each word ("hi", "gu", "en"); those tags are the
// best signal because accented English can be written in Devanagari. Without tags, fall back to the script.
const LANG_NAME = { hi: 'Hindi', gu: 'Gujarati', en: 'English', mr: 'Marathi' };
export function speechLanguage(text, tags) {
  const tagged = Object.entries(tags || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = tagged.reduce((s, [, n]) => s + n, 0);
  if (total) {
    const [top, n] = tagged[0];
    const parts = tagged.filter(([, k]) => k / total >= 0.2).map(([l]) => LANG_NAME[l] || l);
    const name = n / total >= 0.8 ? LANG_NAME[top] || top : parts.join(' + ') + ' mixed';
    const devanagariEnglish = top === 'en' && /[ऀ-ॿ]/.test(text) ? ' (written in Devanagari letters by the recogniser)' : '';
    return name + devanagariEnglish;
  }
  const count = (re) => (text.match(re) || []).length;
  const hi = count(/[ऀ-ॿ]/g), gu = count(/[઀-૿]/g), en = count(/[A-Za-z]/g);
  const all = hi + gu + en;
  if (!all) return 'unknown';
  if (en / all >= 0.8) return 'English';
  if (gu / all >= 0.6) return en / all > 0.15 ? 'Gujarati with some English words' : 'Gujarati';
  if (hi / all >= 0.6) return 'Hindi script (may include English words spoken with an Indian accent)';
  return gu > hi ? 'mixed Gujarati and English' : 'mixed Hindi and English';
}

export function decisionInput({ speaker, about = '', topic, terms, people = '', onScreen, shown, context, fresh, tags, held = 0, lastChance = false, note = '' }) {
  const screen = onScreen.length
    ? onScreen.map((h) => `#${h.id} [${h.kind || 'quote'}${h.person ? ' · ' + h.person : ''}] (${h.age}s ago${h.complete === false ? ', unfinished' : ''}): ${h.text}`).join('\n')
    : '(empty)';
  return `Speaker: ${speaker || 'unknown'}${about ? `\nAbout the speaker (background only, never put on screen unless they say it): ${about}` : ''}
Topic: ${topic || 'unknown'}
Names and terms (spell exactly like this): ${terms || '(none)'}${people ? `\nPeople who may be mentioned: ${people}` : ''}
Already shown earlier (do not repeat these lines): ${shown.join(' | ') || '(none)'}

ON SCREEN NOW:
${screen}

EARLIER SPEECH (already considered):
${context || '(none)'}

LATEST SPEECH${held ? ` (includes words you asked to wait on ${held} time${held > 1 ? 's' : ''})` : ' (new since your last answer)'} — language: ${speechLanguage(fresh, tags)}
${fresh}${lastChance ? '\n\nThe speaker has stopped. This is the last look at these words: answer new or update if ANY key point is in them (put every point in the item and more); none only if the whole passage is filler. Not wait.' : ''}${note ? '\n\nCORRECTION: ' + note : ''}`;
}

/* ---------------- offline heuristic ---------------- */
const STOP = new Set(
  (
    'the a an and or but so to of in on at for with is are was were be been being this that these those it its we you i they he she ' +
    'our your my their us them me as by from not no yes very just really also then than there here what which who whom how when where why ' +
    'will would can could should shall may might do does did have has had am about into over some such only own same too now okay ok well ' +
    'like actually basically thing things lot get got going go one let lets say said know mean right because if all any each every ' +
    'है हैं था थे थी की का के को में से पर और भी यह वह ये वो हम आप मैं तो ही ना नहीं एक कि जो कर करना करते रहे रहा हो होता होते जब तब ' +
    'છે હતું હતા ના ની નું ને માં થી અને પણ આ તે અમે તમે હું તો જ કે એક જે કરી કરવું હોય'
  ).split(/\s+/),
);
const SMALLTALK = /\b(thank|thanks|welcome|namaste|namaskar|good (morning|evening|afternoon)|ladies|gentlemen|applause|mic|audible|hello|jai jinendra)\b|धन्यवाद|स्वागत|નમસ્તે|આભાર|જય જિનેન્દ્ર/i;
const BOOST = /\d|%|crore|lakh|million|billion|percent|must|never|always|future|growth|success|vision|key|important|biggest|first|only|secret|lesson|change|believe|build|create|trust|value|impact|dream|youth|community|purpose|discipline|innovation|सफलता|भविष्य|विश्वास|सपना|सेवा|સફળતા|ભવિષ્ય|વિશ્વાસ|સેવા/i;

const words = (s) => s.split(/\s+/).filter(Boolean);
const clean = (w) => w.replace(/[^\p{L}\p{M}\p{N}%₹$]/gu, '').toLowerCase();

export function localPick(chunk, { minWords = 3, maxWords = 6 } = {}) {
  const sentences = chunk
    .split(/(?<=[.!?।॥])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= minWords && !SMALLTALK.test(s));
  let best = null;
  for (const s of sentences) {
    const w = words(s).map((x) => x.replace(/^[^\p{L}\p{M}\p{N}₹$]+|[^\p{L}\p{M}\p{N}%]+$/gu, '')).filter(Boolean);
    for (let size = Math.min(maxWords, w.length); size >= minWords; size--) {
      for (let i = 0; i + size <= w.length; i++) {
        const win = w.slice(i, i + size);
        if (STOP.has(clean(win[0])) || STOP.has(clean(win[size - 1]))) continue;
        const content = win.filter((x) => !STOP.has(clean(x)) && clean(x).length > 1);
        if (content.length < 2) continue;
        // Phrases that start or end where the sentence does read as complete thoughts on screen.
        const edges = (i === 0 ? 1 : 0) + (i + size === w.length ? 1.5 : 0);
        const score = content.length * 1.4 + win.filter((x) => BOOST.test(x)).length * 3 + (/\d/.test(win.join(' ')) ? 2 : 0) + edges - size * 0.4;
        if (!best || score > best.score) best = { score, win, content };
      }
    }
  }
  if (!best || best.score < 3) return null;
  const keyword = best.win.find((x) => /\d/.test(x)) || best.win.find((x) => BOOST.test(x)) || [...best.content].sort((a, b) => b.length - a.length)[0];
  return { highlight: best.win.join(' '), keyword, kind: /\d/.test(keyword) ? 'number' : 'insight' };
}
