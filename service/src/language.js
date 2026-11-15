// Keeps comments and names civil. Plain functions with no database or network,
// so every rule here is unit-tested (test/rules.test.js).
//
// It catches swearing, slurs and threats, including the usual ways of dodging a
// filter: numbers and symbols standing in for letters (sh1t, b!tch), stretched
// words (fuuuuck) and spelled-out letters (f u c k). It errs toward letting
// ordinary words through: "grape", "Scunthorpe", "cocktail" and "assess" are
// fine. Mild words (damn, hell, crap) are allowed. What it cannot judge is
// meaning: a polite-sounding insult gets past it, which is what the Report
// button and the owner's Remove and Block are for.

// Matched anywhere inside a word.
const INSIDE = ['fuck', 'fuk', 'fck', 'phuck', 'shit', 'bitch', 'biatch', 'asshole', 'arsehole', 'dickhead', 'motherf', 'bastard', 'whore', 'slut', 'wank',
  'bullshit', 'jackass', 'dumbass', 'douche', 'nigg', 'fagg', 'retard', 'wetback', 'tranny', 'porn', 'blowjob', 'handjob', 'jizz', 'cumshot'];
// Matched only as a whole word, because they sit inside innocent ones.
const WHOLE = new Set(['ass', 'asses', 'arse', 'cunt', 'cunts', 'cock', 'cocks', 'dick', 'dicks', 'prick', 'pricks', 'pussy', 'pussies', 'piss', 'pissed', 'twat', 'tits', 'titties',
  'boob', 'boobs', 'cum', 'rape', 'raped', 'rapist', 'fag', 'fags', 'dyke', 'spic', 'chink', 'kike', 'coon', 'gook', 'kys', 'stfu', 'gtfo', 'milf', 'thot', 'pedo', 'pedos', 'nazi', 'nazis']);
// Attacks on a person, matched across word gaps.
const THREATS = ['kill yourself', 'kill urself', 'kill your self', 'go die', 'hope you die', 'hope u die', 'i will kill', 'ill kill you', 'gonna kill you', 'going to kill you',
  'neck yourself', 'hang yourself', 'shoot you', 'stab you', 'beat you up', 'find where you live', 'know where you live', 'rape you', 'you should die', 'drink bleach'];

const LOOKALIKE = { '@': 'a', 4: 'a', 3: 'e', 1: 'i', '!': 'i', '|': 'i', 0: 'o', $: 's', 5: 's', 7: 't', '+': 't', 8: 'b', 9: 'g' };

function plain(text) {
  return String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // accents off
    .toLowerCase()
    .replace(/[@4310$57+89!|]/g, (c) => LOOKALIKE[c] ?? c);
}

// 'language' for swearing or a slur, 'threat' for an attack on someone, or null when it is fine.
export function badLanguage(text) {
  const lowered = plain(text);
  const spaced = lowered.replace(/[^a-z]+/g, ' ').trim();
  if (THREATS.some((t) => (' ' + spaced + ' ').includes(' ' + t + ' '))) return 'threat';

  const words = spaced.split(' ').filter(Boolean);
  // Letters spelled out one at a time ("f u c k") are read as one word.
  const joined = [];
  let run = '';
  for (const w of words) {
    if (w.length === 1) { run += w; continue; }
    if (run.length >= 3) joined.push(run);
    run = '';
    joined.push(w);
  }
  if (run.length >= 3) joined.push(run);

  for (const w of joined) {
    const tight = w.replace(/(.)\1{2,}/g, '$1$1'); // fuuuuck -> fuuck
    const single = w.replace(/(.)\1+/g, '$1'); // fuuck -> fuck (only tested against the long, unambiguous list)
    if (WHOLE.has(w) || WHOLE.has(tight)) return 'language';
    if (INSIDE.some((bad) => {
      if (tight.includes(bad)) return true;
      // Stretched spellings: compare with every repeated letter squeezed to one. Only for
      // stems that stay long and distinctive when squeezed: "nigg" would become "nig",
      // which sits inside "night", so the two short doubled stems get their own pattern.
      const squeezed = bad.replace(/(.)\1+/g, '$1');
      return squeezed.length >= 4 && single.includes(squeezed);
    })) return 'language';
    if (/n+i+g{2,}|f+a+g{2,}/.test(w)) return 'language';
  }
  return null;
}

// Mostly capital letters, in something long enough to be shouting rather than "OK" or an acronym.
export function shouting(text) {
  const letters = String(text ?? '').replace(/[^A-Za-z]/g, '');
  if (letters.length < 14) return false;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
}

export const LANGUAGE_MESSAGES = {
  language: 'Keep it clean. That has language that is not allowed here, so it was not posted.',
  threat: 'That reads as an attack on someone, so it was not posted.',
  shouting: 'No need to shout. Turn off caps lock and try again.',
};
