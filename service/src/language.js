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

// Symbols, digits and look-alike letters from other alphabets that people use in place of a letter.
const LOOKALIKE = {
  '@': 'a', 4: 'a', 3: 'e', 1: 'i', '!': 'i', '|': 'i', 0: 'o', $: 's', 5: 's', 7: 't', '+': 't', 8: 'b', 9: 'g',
  '¢': 'c', '©': 'c', '€': 'e', '£': 'l', '¥': 'y', 'µ': 'u', 'μ': 'u', '®': 'r', '§': 's', 'ƒ': 'f', '¡': 'i', '×': 'x', 'ø': 'o',
  // Cyrillic and Greek letters that look like Latin ones
  'а': 'a', 'е': 'e', 'о': 'o', 'с': 'c', 'р': 'p', 'у': 'y', 'х': 'x', 'к': 'k', 'і': 'i', 'α': 'a', 'ο': 'o', 'ε': 'e', 'κ': 'k', 'υ': 'u',
};

function plain(text) {
  return String(text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // accents off
    .toLowerCase()
    .replace(/[^a-z\s]/g, (c) => LOOKALIKE[c] ?? c);
}

// A symbol hiding a letter: "f**k", "sh*t", "c-nt". `token` has "?" wherever a
// symbol stood. True when `bad` fits with one or two hidden letters and at least
// two real ones, so a lone "a**" or "***" proves nothing.
function fitsMasked(token, bad, whole) {
  if (whole && token.length !== bad.length) return false;
  for (let i = 0; i + bad.length <= token.length; i++) {
    let hidden = 0, fits = true;
    for (let k = 0; k < bad.length; k++) {
      const c = token[i + k];
      if (c === '?') hidden++;
      else if (c !== bad[k]) { fits = false; break; }
    }
    if (fits && hidden >= 1 && hidden <= 2 && bad.length - hidden >= 2) return true;
  }
  return false;
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

  // Symbols used to hide or split a word. Each written word is looked at twice:
  // with masking symbols taken out ("fu_ck" -> "fuck"), and with every symbol
  // standing for one hidden letter ("f**k", "sh*t"). Apostrophes are just dropped,
  // so "don't" and "it's" stay ordinary words.
  // Only the symbols people mask with count: * _ # % ^ & ~ =. A hyphen, a dash, a
  // slash or a full stop is ordinary punctuation and simply ends the word, or
  // "mother-in-law" and "one-hit wonder" would be caught.
  for (const token of lowered.replace(/['’`]/g, '').split(/[^a-z*_#%^&~=]+/)) {
    if (!/[a-z]/.test(token) || !/[*_#%^&~=]/.test(token)) continue; // no letters, or no mask: checked above or nothing to check
    if (/^f[*_#%^&~=]{2,3}(k|er|ers|ing|ed)?$/.test(token)) return 'language'; // f***, f***ing
    const closed = token.replace(/[*_#%^&~=]+/g, '');
    if (WHOLE.has(closed) || INSIDE.some((bad) => closed.includes(bad))) return 'language';
    const hiddenLetters = token.replace(/[*_#%^&~=]/g, '?');
    if (INSIDE.some((bad) => fitsMasked(hiddenLetters, bad, false))) return 'language';
    for (const bad of WHOLE) if (bad.length >= 4 && fitsMasked(hiddenLetters, bad, true)) return 'language';
  }
  return null;
}

// Names that would pass someone off as the site, its owner or its staff. Read
// with look-alikes undone ("T0rchH1ve", "adm1n") and with numbers dropped
// ("admin2"), so the usual disguises do not get through.
const POSES_INSIDE = ['torchhive', 'torchive', 'torchhlve', 'daddygofaster', 'protectandassist', 'administrator', 'moderator', 'official', 'customerservice', 'customersupport', 'helpdesk'];
const POSES_WHOLE = new Set(['admin', 'admins', 'mod', 'mods', 'staff', 'support', 'owner', 'theowner', 'system', 'security', 'billing', 'payments', 'refunds']);
const POSES_ALONE = new Set(['team', 'theteam', 'root', 'host', 'thehost', 'help']); // reserved only as the whole name: "Team Rocket" is fine
export function posesAsSite(name) {
  // "SiteAdmin" and "THSupport" are read as their separate words.
  const raw = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  for (const text of [plain(raw), raw.replace(/[0-9]+/g, ' ')]) {
    const words = text.replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
    const joined = words.join('');
    const squeezed = joined.replace(/(.)+/g, '$1');
    if (POSES_INSIDE.some((p) => joined.includes(p) || squeezed.includes(p.replace(/(.)+/g, '$1')))) return true;
    if (POSES_WHOLE.has(joined) || POSES_ALONE.has(joined) || words.some((w) => POSES_WHOLE.has(w))) return true;
    if (joined.startsWith('admin') || joined.endsWith('admin')) return true; // "admintrevor", "siteadmin"
  }
  return false;
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
