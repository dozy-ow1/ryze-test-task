import { describe, expect, it } from 'vitest';
import { validateArticle } from './text.js';

const article = {
  title: 'A useful title',
  body_html: '<p>Safe <strong>text</strong>.</p>',
  image_prompt: 'A landscape',
};
describe('generated content validation', () => {
  it('accepts only the supported HTML tags without attributes', () => {
    expect(() => validateArticle(article)).not.toThrow();

    for (const body_html of [
      '<script>alert(1)</script>',
      '<p onclick="alert(1)">x</p>',
      '<a href="https://example.com">x</a>',
      '<!-- hidden -->',
      '<img src=x onerror=alert(1)>',
    ]) {
      expect(() => validateArticle({ ...article, body_html })).toThrow('unsupported HTML');
    }
  });
  it('rejects empty content instead of publishing it', () => {
    expect(() => validateArticle({ ...article, body_html: ' ' })).toThrow('empty fields');
  });
});
