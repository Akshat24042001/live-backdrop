// The one-minute test speech: Hindi, Gujarati and English, the way a JITO speaker mixes them.
// The operator panel shows this script to read aloud; `node scripts/make-test-audio.mjs` turns it into audio.
export const TEST_SPEECH = [
  { lang: 'gu', text: 'જય જિનેન્દ્ર, મંચ પર બિરાજમાન સૌ મહાનુભાવો અને મારા વ્હાલા મિત્રો.', expect: 'nothing (greeting)' },
  { lang: 'hi', text: 'दोस्तों, कहते हैं कि नदी में पत्थर सालों पड़ा रहे, फिर भी अंदर से नरम नहीं होता।', expect: 'a line about the stone (may wait for the next sentence)' },
  { lang: 'hi', text: 'वैसे ही जो इंसान सीखना नहीं चाहता, वो कभी नहीं बदलता।', expect: 'completes the stone idea' },
  { lang: 'en', text: 'When I started my business in 1995, I had just one small shop and two people.', expect: 'maybe nothing yet (setup)' },
  { lang: 'en', text: 'Today, our group employs more than four thousand people across eleven states.', expect: 'a number line: 4,000 people, 11 states' },
  { lang: 'gu', text: 'આપણો સમાજ ત્યારે જ આગળ વધે, જ્યારે યુવાનો જવાબદારી લેતા શીખે.', expect: 'Gujarati wording in English letters' },
  { lang: 'hi', text: 'Business में trust सबसे बड़ा asset है, पैसा तो आता जाता रहता है।', expect: 'Trust sabse bada asset' },
  { lang: 'gu', text: 'ગયા વર્ષે આપણે પચીસ કરોડ રૂપિયા ફક્ત શિક્ષણ માટે આપ્યા.', expect: '₹25 crore for education, in Gujarati wording' },
  { lang: 'en', text: 'So my request to every young person here is simple: start small, stay honest, and never stop learning.', expect: 'the closing call to action' },
  { lang: 'hi', text: 'धन्यवाद, जय जिनेन्द्र।', expect: 'nothing (thanks)' },
];
