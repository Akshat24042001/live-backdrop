// Recall test: plays a scripted speech into the running server as recognised text, at speaking pace,
// and checks which key points reached the backdrop. Usage: SPEECH=business|tribute|tricky node scripts/recall-test.mjs [runs]
// Needs the server running. It uses the browser-speech path, so no audio or STT credit is spent; the AI is real.
import WebSocket from 'ws';

const HOST = 'ws://127.0.0.1:3000/ws';
const KEY = process.env.CONTROL_KEY || 'jito';
const WPS = 2.6; // words per second, a normal stage pace
// Optional: LINES=2-11 plays only those lines; GAP=8000 pauses that long after each (to stay under a free AI tier's rate limit).
const [FROM, TO] = (process.env.LINES || '1-999').split('-').map((x) => Number(x) - 1);
const GAP = Number(process.env.GAP || 0);

// say: what the recogniser would write. points: each point is a list of alternatives; any one on screen counts.
// filler: nothing from this line should be shown.
const BUSINESS = [
  { say: 'नमस्कार, जय जिनेंद्र, मंच पर उपस्थित सभी महानुभावों का हार्दिक स्वागत।', filler: true },
  { say: '1987 में मेरे पिताजी ने भावनगर में सिर्फ़ 2 मशीनों से यह फैक्ट्री शुरू की थी।', points: [['1987'], ['2 mach', '2 mash']] },
  { say: 'पहले तीन साल हमें एक भी बड़ा ऑर्डर नहीं मिला, बैंक ने लोन देने से मना कर दिया।', points: [['loan', 'bank']] },
  { say: 'तब पिताजी कहते थे, बेटा, धंधे में इज्जत पहले, पैसा बाद में।', points: [['izzat', 'ijjat', 'izzat', 'ijat']] },
  { say: 'आज वही कंपनी 450 लोगों को रोज़गार देती है, 18 देशों में एक्सपोर्ट करती है और हमारा टर्नओवर 320 करोड़ रुपए है।', points: [['450'], ['18'], ['320']] },
  { say: 'But numbers are not our real success.' },
  { say: 'Our real success is that in 39 years we never delayed a single salary.', points: [['salary']] },
  { say: 'હું યુવાનોને એક જ વાત કહું છું, નોકરી શોધનાર નહીં, નોકરી આપનાર બનો.', points: [['aapn', 'apnar', 'job giver', 'job creator']] },
  { say: 'Failure is not the opposite of success, it is the tuition fee of success.', points: [['tuition']] },
  { say: 'मुझे याद है, 2008 की मंदी में हमारा 40% बिज़नेस एक ही महीने में चला गया।', points: [['2008'], ['40']] },
  { say: 'उस वक्त हमने एक भी कर्मचारी को नहीं निकाला, सबकी तनख्वाह आधी की और मेरी ज़ीरो कर दी।', points: [['nikala', 'nikaala', 'zero', 'ek bhi']] },
  { say: 'मेरी वाइफ़ ने कहा, आपकी सैलरी तो पहले भी किसी को दिखती नहीं थी।', points: [['dikh']] },
  { say: 'Friends, let me tell you three things that built this company.', filler: true },
  { say: 'Quality, consistency and character.', points: [['consistency'], ['character']] },
  { say: 'भगवान महावीर ने कहा था, परिग्रह सबसे बड़ा बंधन है।', points: [['parigrah', 'parigraha']] },
  { say: 'इसीलिए हमने तय किया है कि हमारे मुनाफे का 10% हर साल समाज को जाएगा।', points: [['10%', '10 %', '10 pratishat', '10 percent']] },
  { say: 'And today, on this stage, I am happy to announce that our family will donate 1 crore rupees for the new JITO girls hostel in Bhavnagar.', points: [['1 crore'], ['hostel']] },
  { say: 'क्या आप अपनी कमाई का एक हिस्सा भी समाज के लिए रखते हैं?', points: [['hissa', 'hissa', 'kamai']] },
  { say: 'JATF के ज़रिए पिछले 5 साल में भावनगर से 23 बच्चे IAS और IPS बने हैं।', points: [['23'], ['ias']] },
  { say: 'હવે આપણું લક્ષ્ય છે 2030 સુધી 100 વિદ્યાર્થીઓ.', points: [['2030'], ['100']] },
  { say: 'ઈમાનદારી એ જ સૌથી મોટી મૂડી છે.', points: [['imandari', 'imaandari', 'emandari', 'eemandari', 'imaandaari', 'iimaandaari']] },
  { say: 'मेरा बेटा अभी अमेरिका से MBA करके आया है, पर मैंने उससे कहा पहले दो साल फैक्ट्री के फ्लोर पर काम करो।', points: [['floor']] },
  { say: 'Legacy is not what you leave for your children, it is what you leave in them.', points: [['legacy']] },
  { say: '2047 तक भारत विकसित राष्ट्र बनेगा, और इसमें MSME का बहुत बड़ा योगदान होगा।', points: [['2047'], ['msme']] },
  { say: 'और यह तभी होगा जब हम सब मिलकर सेवा, शिक्षा और संस्कार को साथ लेकर चलें।', points: [['shiksha', 'siksha', 'shiksa']] },
  { say: 'मैं JITO भावनगर की पूरी टीम का और सभी sponsors का दिल से आभार व्यक्त करता हूं।', filler: true },
  { say: 'जय जिनेंद्र, जय महावीर।', filler: true },
];

// The 24-Oct committee demo: praise of a person, cricket comparisons, mixed languages. Most misses happened here.
const TRIBUTE = [
  { say: 'Hello. કેમ છો, ભાવનગર? मजे में हैं सब?', filler: true },
  { say: 'People usually only see the big milestones.', points: [['milestone']] },
  { say: 'उन्हें TV पर 50 ODI centuries और World Cup के 765 runs दिखते हैं।', points: [['50'], ['765']] },
  { say: 'What they do not see is the endless conditioning, the discipline and the quiet hours of practice.', points: [['conditioning', 'practice']] },
  { say: 'બહારથી બધું શાંત લાગે, પણ અંદર એક આગ હોવી જોઈએ.', points: [['aag']] },
  { say: 'Python, Docker, n8n और Claude APIs के साथ जो घंटों की मेहनत होती है, वो कोई नहीं देखता।', points: [['mehnat', 'ghant', 'docker']] },
  { say: 'That backend development is his version of test cricket.', points: [['test cricket']] },
  { say: 'અને test cricket માં કોઈ shortcut નથી હોતો.', points: [['shortcut']] },
  { say: 'मैं हमेशा कहता हूँ कि self-belief और hard work will always earn you success.', points: [['self-belief', 'self belief']] },
  { say: 'પણ અક્ષત ખાલી પોતાના માટે નથી વિચારતો, he actively passes it on to the next generation.', points: [['next generation']] },
  { say: 'वो एक local computer training institute चलाता है, जहाँ सिर्फ coding सीखना नहीं, it is about building a strong foundation for the youth.', points: [['foundation', 'institute']] },
  { say: 'Captaincy भी ऐसी ही होती है, अपनी team को empower करो और उसमें से best बाहर निकालो।', points: [['empower']] },
  { say: 'You see the exact same leadership when he steps up for the JITO Youth Wing.', points: [['youth wing', 'leadership']] },
  { say: 'What impresses me the most is his pure versatility.', points: [['versatil']] },
  { say: 'તમે પાછા ના પડી શકો. You cannot back down.', points: [['back down', 'pacha', 'paachha', 'pachha', 'pachha']] },
  { say: 'I love playing under pressure. Pressure ના હોય તો મજા જ નથી આવતી.', points: [['pressure']] },
  { say: 'Thank you, Jai Jinendra.', filler: true },
];

// Edge cases: a self-correction, numbers in words, a list built over three sentences, a line said twice in two
// languages, scripture, an MC announcement, a fast run-on sentence. never: words that must not appear on screen.
const TRICKY = [
  { say: 'हमने पिछले साल 600 नहीं, माफ़ कीजिए, 800 परिवारों को राशन किट दी।', points: [['800']], never: ['600'] },
  { say: 'Our chapter grew from one hundred and twenty members to four hundred and fifty members in just two years.', points: [['450', 'four hundred'], ['120', 'one hundred']] },
  { say: 'आज मैं आपसे तीन बातें कहना चाहता हूँ।', filler: true },
  { say: 'पहली, समय की पाबंदी।' },
  { say: 'दूसरी, वचन का पालन।' },
  { say: 'और तीसरी, समाज के प्रति ज़िम्मेदारी।', points: [['paband'], ['vachan'], ['zimmed', 'jimmed', 'jimed', 'zimed', 'zimmad', 'jimmad']] },
  { say: 'ઈમાનદારી એ જ સૌથી મોટી મૂડી છે. Honesty is the biggest capital.', points: [['imaan', 'iman', 'emaan', 'eman', 'imandari', 'honesty']] },
  { say: 'नवकार महामंत्र की पहली पंक्ति है, णमो अरिहंताणं।', points: [['arihant']] },
  { say: 'मेरे गुरु आचार्य श्री ने कहा था, जो बांटता है वही बढ़ता है।', points: [['baant', 'bant']] },
  { say: 'Ladies and gentlemen, please put your phones on silent mode.', filler: true },
  { say: 'In 2019 we launched the scholarship programme, and today it supports 1,200 students every year.', points: [['2019'], ['1,200', '1200']] },
  { say: 'We will double this to 2,500 students by 2028.', points: [['2,500', '2500'], ['2028']] },
  { say: 'क्या हम अपने बच्चों को सिर्फ डिग्री दे रहे हैं, या संस्कार भी?', points: [['sanskar', 'sanskaar']] },
  { say: 'Speed, scale and sustainability, these are the three pillars of our new plant in Sihor which will create five hundred jobs and start production in March next year.', points: [['sihor'], ['500', 'five hundred'], ['sustainab']] },
];

const SPEECHES = { business: BUSINESS, tribute: TRIBUTE, tricky: TRICKY };
const SPEECH = SPEECHES[process.env.SPEECH || 'business'];
if (!SPEECH) { console.log('SPEECH must be one of: ' + Object.keys(SPEECHES).join(', ')); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (url) => new Promise((res, rej) => { const w = new WebSocket(url); w.once('open', () => res(w)); w.once('error', rej); });

async function run(n) {
  const display = await open(`${HOST}?role=display&preview=1`);
  const control = await open(`${HOST}?role=control&key=${KEY}&label=recall-test`);
  const cards = new Map(); // id -> { text, person, kind, line }
  let line = -1;
  display.on('message', (d) => {
    const m = JSON.parse(d);
    if ((m.type === 'show' || m.type === 'update') && m.item) {
      const old = cards.get(m.item.id);
      cards.set(m.item.id, { ...old, versions: [...(old?.versions || []), m.item.text], text: m.item.text, person: m.item.person || '', kind: m.item.kind, line: old?.line ?? line });
    }
  });
  const send = (o) => control.send(JSON.stringify(o));
  send({ type: 'reset-session' });
  await sleep(500);
  send({ type: 'start', engine: 'browser', label: 'recall-test' });
  await sleep(800);
  const t0 = Date.now();
  for (let i = FROM; i <= Math.min(TO, SPEECH.length - 1); i++) {
    line = i;
    const words = SPEECH[i].say.split(/\s+/);
    const half = Math.ceil(words.length / 2);
    // Words arrive as provisional text while spoken, then the whole sentence becomes final.
    send({ type: 'stt-text', final: false, text: words.slice(0, half).join(' ') });
    await sleep((half / WPS) * 1000);
    send({ type: 'stt-text', final: false, text: SPEECH[i].say });
    await sleep(((words.length - half) / WPS) * 1000);
    send({ type: 'stt-text', final: true, text: SPEECH[i].say });
    await sleep(GAP || (i % 4 === 3 ? 1200 : 350)); // speakers barely pause between sentences
  }
  await sleep(9000);
  send({ type: 'stop' });
  await sleep(300);
  display.close(); control.close();

  // Every version a card went through counts: the point was on screen at some moment.
  const seen = [...cards.values()].map((c) => (c.versions.join(' ¦ ') + ' ' + c.person).toLowerCase());
  let total = 0, hit = 0;
  const misses = [];
  SPEECH.forEach((s, i) => i >= FROM && i <= TO && (s.points || []).forEach((alts) => {
    total++;
    if (seen.some((c) => alts.some((a) => c.includes(a.toLowerCase())))) hit++;
    else misses.push(`line ${i + 1}: ${alts[0]}  —  ${s.say.slice(0, 70)}`);
  }));
  const fillerShown = [...cards.values()].filter((c) => SPEECH[c.line]?.filler).map((c) => c.text);
  // Anything the speaker took back, or that must never be shown, counts as a failure too.
  const forbidden = SPEECH.flatMap((s) => s.never || []).filter((w) => seen.some((c) => c.includes(w.toLowerCase())));
  if (forbidden.length) console.log('  SHOWN BUT TAKEN BACK BY THE SPEAKER: ' + forbidden.join(', '));
  console.log(`\nRun ${n}: ${hit}/${total} points on screen (${Math.round((hit / total) * 100)}%), ${cards.size} cards, ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const c of cards.values()) console.log(`  [${c.kind}${c.person ? ' · ' + c.person : ''}] ${c.versions.join('  →  ')}`);
  if (misses.length) console.log('  MISSED:\n   ' + misses.join('\n   '));
  if (fillerShown.length) console.log('  Shown during filler lines: ' + fillerShown.join(' | '));
  return { hit, total };
}

const runs = Number(process.argv[2] || 1);
let H = 0, T = 0;
for (let i = 1; i <= runs; i++) { const r = await run(i); H += r.hit; T += r.total; await sleep(1500); }
if (runs > 1) console.log(`\nAll runs: ${H}/${T} (${Math.round((H / T) * 100)}%)`);
process.exit(0);
