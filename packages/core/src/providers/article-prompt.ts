import { Permanent } from '../quota.js';

export const ARTICLE_PROMPT = `Write a complete, accurate SEO article from the brief for a general audience.
Use plain, warm prose, a descriptive title under 65 characters and a 600–900 word body.
Introduce the topic, then use three to six useful sections and a short actionable conclusion.
Use the main keyword naturally. Never invent facts, studies, statistics, prices or quotes.
Return title, body_html and image_prompt. The body may contain only h2, h3, p, ul, ol, li,
strong and em tags, without attributes. No links, images, scripts, styles or title heading.
The image prompt should describe a landscape editorial photo or illustration without text,
logos, watermarks or recognizable real people.`;

// Prompt instructions are not a security boundary. Reject unsupported markup before publishing.
export function validateArticle(article: {
  title: string;
  body_html: string;
  image_prompt: string;
}): void {
  if (!article.title.trim() || !article.body_html.trim() || !article.image_prompt.trim()) {
    throw new Permanent('generated article has empty fields');
  }
  const text = article.body_html.replace(/<\/?(?:h2|h3|p|ul|ol|li|strong|em)\s*>/gi, '');
  if (/[<>]/.test(text)) {
    throw new Permanent('generated article contains unsupported HTML');
  }
}
