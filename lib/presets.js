// One-click event setups. Loading a preset changes look, wording context and recognition hints together.

const PEOPLE = [
  'Mayuri Vora', 'Pooja Shah', 'Dishant Shah', 'Mahabhadra Shah', 'Pankaj Bhayani', 'Jiten Shah',
];
const JITO_TERMS = [
  'JITO', 'JITO Apex', 'JITO Bhavnagar', 'JITO Ladies Wing', 'JITO Youth Wing', 'JITO Connect', 'JITO Center for Excellence',
  'Bhavnagar', 'Jai Jinendra', 'Navkar', 'Mahavir', 'Tirthankar', 'Palitana', 'Shatrunjay', 'seva', 'sanskar', 'ahimsa', 'samaj',
];

export const PRESETS = {
  navyoday: {
    label: 'Navyoday 2026–2028 · Installation & Oath',
    when: '1 Nov 2026, 11:30 AM · Iscon Club',
    settings: {
      theme: 'navyoday',
      layout: 'upper',
      eventTitle: 'Bhavnagar Chapter · Installation & Oath Taking Ceremony',
      eventTagline: 'New Team • New Commitments • New Heights',
      standbyText: 'New Team • New Commitments • New Heights',
      logoUrl: '/assets/navyoday.png',
      logoLeft: '/assets/jito-emblem.png',
      logoRight: '/assets/jito-wings.png',
      topic: 'Navyoday 2026–2028: installation and oath of the new JITO Bhavnagar team',
      eventContext: 'JITO Bhavnagar "Navyoday 2026–2028" — Installation & Oath Taking Ceremony of the new team of JITO Bhavnagar Chapter, Ladies Wing and Youth Wing. Theme: New Team, New Commitments, New Heights. Iscon Club, Bhavnagar, 1 November 2026. Audience: Jain business community, JITO members and senior dignitaries.',
      terms: ['Navyoday', 'Iscon Club', ...JITO_TERMS, ...PEOPLE].join(', '),
      accent: '', accent2: '',
      fontFamily: 'poppins',
      showTitle: true, showSpeaker: false, showCaptions: false,
    },
  },
  success: {
    label: 'Behind the Success',
    when: '1 Nov 2026, 8:30–11:15 AM · Zaverchand Meghani Auditorium',
    settings: {
      theme: 'success',
      layout: 'upper',
      eventTitle: 'Behind the Success',
      eventTagline: 'The Stories They Don’t Usually Tell.',
      standbyText: 'Where Vision Meets Experience • Where Stories Inspire • Where Success Teaches',
      logoUrl: '',
      logoLeft: '/assets/jito-emblem.png',
      logoRight: '/assets/jito-wings.png',
      topic: 'Behind the Success: the stories successful business leaders do not usually tell',
      eventContext: 'JITO Bhavnagar "Behind the Success — The Stories They Don’t Usually Tell": talks and panel conversations with successful business leaders. Where Vision Meets Experience, Where Stories Inspire, Where Success Teaches. Zaverchand Meghani Auditorium, Bhavnagar, 1 November 2026. Audience: 1000+ Jain business community members, JITO members and senior dignitaries.',
      terms: ['Behind the Success', 'Zaverchand Meghani Auditorium', ...JITO_TERMS, ...PEOPLE].join(', '),
      accent: '', accent2: '',
      fontFamily: 'poppins',
      showTitle: true, showSpeaker: false, showCaptions: false,
    },
  },
};
