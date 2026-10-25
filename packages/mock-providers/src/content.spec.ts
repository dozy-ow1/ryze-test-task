import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderImage, writeArticle } from './content.js';

const BRIEF = 'Spring lawn care tips for first-time homeowners';

function wordCount(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .trim()
    .split(/\s+/).length;
}

describe('writeArticle', () => {
  it('is deterministic in the brief', () => {
    const article = writeArticle(BRIEF);
    expect(writeArticle(BRIEF)).toEqual(article);
    const other = writeArticle('Winter tyres for small SUVs');
    expect(other.title).not.toBe(article.title);
    expect(other.body_html).not.toBe(article.body_html);
  });

  it('titles the article after the brief, in at most 70 slug-friendly characters', () => {
    expect(writeArticle(BRIEF).title).toMatch(
      /^Spring lawn care tips for first-time homeowners: \w/,
    );
    const briefs = [
      BRIEF,
      'word '.repeat(100),
      'x'.repeat(200),
      '???',
      'Café menus & <b>prices</b>!',
    ];

    for (const brief of briefs) {
      const { title } = writeArticle(brief);
      expect(title.length, brief).toBeGreaterThan(0);
      expect(title.length, brief).toBeLessThanOrEqual(70);
      expect(title, brief).toMatch(/^[\p{L}\p{N}' :-]+$/u);
    }
  });

  it('writes about 300 words of paragraphs and an image prompt that mentions the title', () => {
    for (const brief of [BRIEF, 'a', 'Winter tyres for small SUVs', 'How to brew cold coffee']) {
      const { title, body_html, image_prompt } = writeArticle(brief);
      expect(body_html.match(/<p>/g)).toHaveLength(5);
      expect(body_html.match(/<h2>/g)).toHaveLength(1);
      expect(wordCount(body_html)).toBeGreaterThan(240);
      expect(wordCount(body_html)).toBeLessThan(360);
      expect(image_prompt).toContain(`"${title}"`);
      expect(image_prompt).toMatch(/^[^.]+\.$/);
    }
  });

  it('reports usage from the brief length and the words written', () => {
    const { body_html, usage } = writeArticle(BRIEF);
    expect(usage).toEqual({
      input_tokens: 500 + Math.ceil(BRIEF.length / 4),
      output_tokens: Math.ceil(wordCount(body_html) * 1.4),
    });
  });
});

describe('renderImage', () => {
  it('renders a 1792x1024 PNG in one colour derived from the prompt', async () => {
    const png = await renderImage('a red barn');

    const { format, width, height } = await sharp(png).metadata();
    expect({ format, width, height }).toEqual({ format: 'png', width: 1792, height: 1024 });
    const { channels } = await sharp(png).stats();
    expect(channels.every((c) => c.min === c.max)).toBe(true);
    expect(await renderImage('a red barn')).toEqual(png);
    expect(await renderImage('a blue lake')).not.toEqual(png);
  });
});
