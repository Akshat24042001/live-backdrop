// Offline checks of the server's safety rules (numbers, fragments, repeats, updates), taken from server.js as written.
// No server, no AI, no internet. Usage: node scripts/unit-test.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js'), 'utf8');
const grab = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('server.js changed: cannot find ' + from); return src.slice(a, b); };
const code = [
  grab('const norm = ', '\n'),
  grab('const DANGLING', '\n'),
  grab('const numbersIn', '// Money:'),
  grab('function rupees', '\n}\n') + '\n}',
  grab('const FILLER_WORDS', 'function applyItem'),
].join('\n');
const R = new Function(code + '\nreturn { DANGLING, numbersIn, spokenNumbers, unspokenNumbers, rupees, sameIdea };')();

let bad = 0, n = 0;
const eq = (name, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `→ got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// Fragments: whole joining words only.
for (const t of ['Every investor', 'Defence sector', 'Gyan', 'Duniya badal di', 'Seva hi sacho dharma', 'Respect the donor', 'Bharat ki economy', 'Kaam kiya']) eq(`not a fragment: ${t}`, R.DANGLING.test(t), false);
for (const t of ['Stay honest and', 'Seva is our', 'Paisa kamana aur', 'Built for']) eq(`fragment: ${t}`, R.DANGLING.test(t), true);

// Numbers said in words count as spoken.
const has = (t, v) => R.spokenNumbers(t).includes(v);
eq('four thousand', has('employs four thousand people', 4000), true);
eq('eleven', has('across eleven states', 11), true);
eq('two thousand five hundred', has('two thousand five hundred families', 2500), true);
eq('twenty five', has('twenty five years', 25), true);
eq('one hundred and twenty', has('from one hundred and twenty members to four hundred and fifty members', 120), true);
eq('four hundred and fifty', has('from one hundred and twenty members to four hundred and fifty members', 450), true);
eq('"two and three" stay apart', has('two and three', 5), false);
eq('तीन', has('पहले तीन साल हमें', 3), true);
eq('ढाई', has('ढाई लाख रुपए', 2.5), true);
eq('બે હજાર', has('બે હજાર સભ્યો', 2000), true);
eq('4 hazaar', has('4 hazaar log', 4000), true);

// Lines rejected in the real rehearsals that were correct.
eq('rehearsal: "1 small shop · 2 people"', R.unspokenNumbers('1 small shop · 2 people', 'In 1995 I started with one small shop and two people'), []);
eq('rehearsal: "4000+ people · 11 states"', R.unspokenNumbers('4000+ people · 11 states', 'Today 2026 our group employs more than four thousand people across eleven states'), []);
eq('test: "Pehle 3 saal"', R.unspokenNumbers('Pehle 3 saal · koi bada order nahi', '1987 में ... पहले तीन साल हमें एक भी बड़ा ऑर्डर नहीं मिला'), []);
// Invented or misheard numbers are still refused.
eq('invented ₹1200 crore', R.unspokenNumbers('₹1200 crore', 'हमने 12 करोड़ रुपए खर्च किए'), [1200]);
eq('2000 for 2,500', R.unspokenNumbers('2000 parivar', '2,500 परिवार'), [2000]);

// Money gets ₹, counts do not.
eq('₹ on money', R.rupees('12 crore · hostel', '12 करोड़ रुपए'), '₹12 crore · hostel');
eq('no ₹ on members', R.rupees('2 crore members', '2 crore members, 50 crore rupees'), '2 crore members');

// Updates must be the same idea (24-Oct demo: unrelated "updates" erased cards).
eq('update: different point', R.sameIdea('Discipline beats talent when talent is not disciplined', 'Our group employs more than 4000 people'), false);
eq('update: different point 2', R.sameIdea('Self-belief and hard work will always earn you success', 'Building a strong foundation for the youth'), false);
eq('update: different point 3', R.sameIdea('1995 · one small shop', 'Trust compounds faster than money'), false);
eq('update: same stat, new label', R.sameIdea('₹25 crore', '₹25 crore · gaushala mate'), true);
eq('update: corrected number, same label', R.sameIdea('₹25 crore · gaushala mate', '₹50 crore · gaushala mate'), true);
eq('update: completed line', R.sameIdea('Captaincy bhi aisi hoti hai apni team ko empower karo', 'Team ko empower karo, best bahar nikalo'), true);

console.log(bad ? `\n${bad} of ${n} FAILED` : `\nall ${n} passed`);
process.exit(bad ? 1 : 0);
