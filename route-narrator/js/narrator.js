// Turns points of interest into spoken scripts and speaks them with the
// browser's built-in speech synthesis.

import { formatDistance } from './geo.js';

const ABBREV = /\b(?:St|Mt|Ft|Dr|Mr|Mrs|Ms|Jr|Sr|Rev|Gen|Col|Capt|Lt|Sgt|Gov|Sen|Rep|Pres|Co|Corp|Inc|Ltd|No|vs|approx|ca|c|est|Ave|Blvd|Rd|Hwy|U\.S|U\.K|D\.C|[A-Z])\.$/;

/** Split text into sentences, avoiding common abbreviations and initials. */
export function sentences(text) {
  const out = [];
  let buf = '';
  const parts = text.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9])/);
  for (const part of parts) {
    buf = buf ? `${buf} ${part}` : part;
    if (!ABBREV.test(buf)) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Strip things that sound bad read aloud: pronunciations, nested brackets, refs. */
export function cleanForSpeech(text) {
  let t = text || '';
  // Remove parentheticals (pronunciations, alt names, dates) – repeat for nesting.
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\([^()]*\)/g, '');
  t = t.replace(/\s*\[[^\]]*\]/g, '');
  t = t.replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ');
  // Headings and lists from plain-text extracts.
  t = t.split('\n').filter((l) => l.trim() && !/^=+.*=+$/.test(l.trim())).join(' ');
  return t.trim();
}

const COMING_UP = [
  (d, where, title) => `Coming up in about ${d}, ${where}: ${title}.`,
  (d, where, title) => `In about ${d}, ${where}, you'll find ${title}.`,
  (d, where, title) => `Keep an eye out — in ${d}, ${where}, is ${title}.`,
];
const RIGHT_HERE = [
  (where, title) => `Right about now, ${where}: ${title}.`,
  (where, title) => `We're passing ${title}, ${where}.`,
];
const GENERAL_INTRO = ['Here’s a bit of local history.', 'A little roadside trivia.', 'Something to think about as you drive.'];

let variant = 0;

/**
 * Build the narration for one point of interest.
 * @param poi    point of interest with title/description/extract/offset/side/topics
 * @param ahead  metres between the vehicle and the point along the route
 * @param opts   { units, detail: 'brief'|'normal'|'detailed' }
 */
export function writeScript(poi, ahead, { units = 'imperial', detail = 'normal' } = {}) {
  variant++;
  const nSentences = { brief: 1, normal: 3, detailed: 6 }[detail] ?? 3;
  const where =
    poi.offset < 200
      ? 'right along the road'
      : poi.offset < 600
        ? `just off to your ${poi.side}`
        : `about ${formatDistance(poi.offset, units)} off to your ${poi.side}`;

  let intro;
  if (poi.topics[0] === 'towns' && poi.offset < 2500) {
    intro = ahead > 400 ? `Coming up in about ${formatDistance(ahead, units)}: ${poi.title}.` : `Welcome to ${poi.title}.`;
  } else if (poi.offset > 5000 && poi.topics.includes('towns')) {
    intro = `Off to your ${poi.side}, about ${formatDistance(poi.offset, units)} away, is ${poi.title}.`;
  } else if (ahead > 400) {
    intro = COMING_UP[variant % COMING_UP.length](formatDistance(ahead, units), where, poi.title);
  } else {
    intro = RIGHT_HERE[variant % RIGHT_HERE.length](where, poi.title);
  }

  let body = '';
  const extract = cleanForSpeech(poi.extract || '');
  if (extract) {
    body = sentences(extract).slice(0, nSentences).join(' ');
  } else if (poi.description) {
    body = `${poi.title}: ${poi.description}.`;
  }
  const lead = poi.generalIntro ? `${GENERAL_INTRO[variant % GENERAL_INTRO.length]} ` : '';
  return `${lead}${intro} ${body}`.trim();
}

/**
 * Speech queue. One narration at a time; each narration is split into
 * sentence-sized utterances because some browsers cut off long utterances.
 */
export class Narrator {
  constructor() {
    this.synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
    this.voice = null;
    this.rate = 1;
    this.muted = false;
    this.speaking = false;
    this.paused = false;
    this._token = 0;
    this.onstate = () => {};
  }

  get available() { return !!this.synth; }

  voices() {
    return this.synth ? this.synth.getVoices() : [];
  }

  /** Must be called from a user gesture once, to unlock audio on mobile. */
  unlock() {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.synth.speak(u);
  }

  /** Speak text; resolves when finished or interrupted. */
  async speak(text) {
    this.stop();
    const token = ++this._token;
    this.speaking = true;
    this.paused = false;
    this.onstate();
    if (!this.synth || this.muted) {
      // Text-only: give the reader time proportional to the text.
      let end = Date.now() + Math.min(20000, 2500 + text.length * 35);
      while (token === this._token && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 200));
        if (this.paused) end += 200;
      }
    } else {
      for (const s of sentences(text)) {
        if (token !== this._token) break;
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(s);
          if (this.voice) u.voice = this.voice;
          u.lang = this.voice?.lang || document.documentElement.lang || 'en-US';
          u.rate = this.rate;
          // Safety net: Chrome occasionally never fires onend.
          const guard = setTimeout(resolve, 4000 + s.length * 120 / this.rate);
          u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
          this.synth.speak(u);
        });
        while (this.paused && token === this._token) await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (token === this._token) {
      this.speaking = false;
      this.onstate();
    }
  }

  pause() {
    if (!this.speaking) return;
    this.paused = true;
    this.synth?.pause();
    this.onstate();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.synth?.resume();
    this.onstate();
  }

  stop() {
    this._token++;
    this.paused = false;
    if (this.synth) {
      this.synth.cancel();
      this.synth.resume();
    }
    if (this.speaking) {
      this.speaking = false;
      this.onstate();
    }
  }
}
