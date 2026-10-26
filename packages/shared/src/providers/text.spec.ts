import { describe, expect, it } from 'vitest';
import { sanitizeArticle } from './text.js';

const article = {
  title: 'A useful title',
  body_html: '<p>Safe <strong>text</strong>.</p>',
  image_prompt: 'A landscape',
};
describe('generated content validation', () => {
  it('preserves readable text and supported formatting while removing unsafe markup', () => {
    const content = {
      ...article,
      body_html:
        '<p onclick="bad()">x < 5 and y > 2 <strong>works</strong><script>alert(1)</script><img src=x onerror=bad()></p>',
    };

    const sanitized = sanitizeArticle(content);
    expect(content.body_html).toContain('onclick');
    expect(sanitized.body_html).toBe('<p>x &lt; 5 and y &gt; 2 <strong>works</strong></p>');
    const safe = { ...article };
    expect(sanitizeArticle(safe).body_html).toBe(article.body_html);
  });
  it.each([' ', '<p><script>alert(1)</script><img src=x></p>', '<p>&nbsp;</p>'])(
    'rejects content with no visible text: %s',
    (body_html) => {
      expect(() => sanitizeArticle({ ...article, body_html })).toThrow('empty fields');
    },
  );
});
