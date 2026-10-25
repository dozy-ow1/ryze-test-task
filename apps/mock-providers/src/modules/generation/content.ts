import { createHash } from 'node:crypto';
import sharp from 'sharp';

// What the mocks generate. Everything is derived from a hash of the input: the same brief always
// yields the same article, the same prompt the same picture.

export interface Article {
  title: string;
  body_html: string;
  image_prompt: string;
  usage: { input_tokens: number; output_tokens: number };
}

const MAX_TITLE = 70;

const TAGLINES = [
  'A Practical Guide',
  'What You Need to Know',
  'Tips and Common Mistakes',
  'The Complete Checklist',
  'A Guide for Beginners',
  'Ideas That Work',
  'Everything to Consider',
  'Expert Advice',
];

const HEADINGS = [
  'Why It Matters',
  'Getting Started',
  'Common Mistakes to Avoid',
  'What the Experts Recommend',
  'A Simple Checklist',
  'Key Takeaways',
];

const STYLES = [
  'soft natural light',
  'bright minimal composition',
  'warm tones and shallow depth of field',
  'clean flat illustration',
  'wide shot at golden hour',
];

const WORDS =
  `the a and for with your to of in on is can will more every most practical guide budget season
team customers simple steps quality results plan choose compare local online better everyday
tools tips common mistakes easy reliable growth value time money checklist routine goals experts
beginners options features benefits trends small business home garden kitchen travel health
energy savings clear useful quickly carefully often week month year start build improve measure
review learn share keep track focus balance strategy approach method process product service
brand story idea question answer reason example detail decision priority habit skill project
feedback support community audience content search readers price cost safety comfort style
design durable affordable modern classic seasonal`.split(/\s+/);

export function writeArticle(brief: string): Article {
  const rand = mulberry32(hash(brief).readUInt32BE(0));
  const title = titleFor(brief, pick(rand, TAGLINES));

  const body_html = [
    paragraph(rand),
    paragraph(rand),
    `<h2>${pick(rand, HEADINGS)}</h2>`,
    paragraph(rand),
    paragraph(rand),
    paragraph(rand),
  ].join('\n');

  return {
    title,
    body_html,
    image_prompt: `Editorial cover image for the article "${title}", ${pick(rand, STYLES)}.`,
    usage: {
      input_tokens: 500 + Math.ceil(brief.length / 4),
      output_tokens: Math.ceil(countWords(body_html) * 1.4),
    },
  };
}

function countWords(html: string): number {
  return html
    .replace(/<[^>]+>/g, ' ')
    .trim()
    .split(/\s+/).length;
}

// A 1792x1024 PNG in one solid colour.
export function renderImage(prompt: string): Promise<Buffer> {
  const [r, g, b] = hash(prompt);

  return sharp({ create: { width: 1792, height: 1024, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

// The brief's own words (so different briefs get different titles), sentence-cased, then a tagline
// if it still fits. Letters, digits, hyphens and apostrophes only: the title ends up in a slug.
function titleFor(brief: string, tagline: string): string {
  let topic = '';

  for (const word of brief.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu) ?? []) {
    const next = topic ? `${topic} ${word}` : word;

    if (next.length > MAX_TITLE) {
      break;
    }

    topic = next;
  }

  if (!topic) {
    return tagline;
  }

  const title = `${capitalise(topic)}: ${tagline}`;

  return title.length <= MAX_TITLE ? title : capitalise(topic);
}

// About 60 words: five sentences of 8 to 16 words.
function paragraph(rand: () => number): string {
  const sentences = Array.from({ length: 5 }, () => {
    const words = Array.from({ length: 8 + Math.floor(rand() * 9) }, () => pick(rand, WORDS));

    return `${capitalise(words.join(' '))}.`;
  });

  return `<p>${sentences.join(' ')}</p>`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

function hash(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

// mulberry32: a tiny seeded PRNG, plenty for picking words.
function mulberry32(seed: number): () => number {
  let a = seed;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
