import mjml2html from 'mjml';
import sanitize from 'sanitize-html';
import { convert } from 'html-to-text';
import { templateVersionSchema } from './schemas.js';

const MAX_HTML_LENGTH = 5_000_000;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export type VariableValue = string | number | boolean;

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

export function collectVariables(...sources: string[]): string[] {
  return [...new Set(sources.flatMap((source) => [...source.matchAll(PLACEHOLDER)].map((match) => match[1]!)))].sort();
}

export function assertDeclaredVariables(source: string, subject: string, declared: readonly string[]): void {
  const unknown = collectVariables(source, subject).filter((name) => !declared.includes(name));
  if (unknown.length) {
    throw new TemplateRenderError(`The template uses variables it does not declare: ${unknown.join(', ')}`);
  }
}

/** Keep email layout and CSS while rejecting active elements and unsafe link schemes. */
export function sanitizeHtml(html: string): string {
  if (html.length > MAX_HTML_LENGTH) throw new TemplateRenderError('Rendered HTML is too large');
  const clean = sanitize(html, {
    allowedTags: [...sanitize.defaults.allowedTags, 'html', 'head', 'body', 'title', 'meta', 'style', 'img', 'center'],
    allowedAttributes: {
      '*': ['class', 'id', 'style', 'title', 'align', 'valign', 'width', 'height', 'role', 'dir', 'lang', 'aria-*', 'hidden'],
      html: ['xmlns'],
      meta: ['charset', 'name', 'content'],
      a: ['href', 'target', 'rel', 'name'],
      img: ['src', 'alt', 'border'],
      table: ['border', 'cellpadding', 'cellspacing', 'bgcolor', 'background'],
      td: ['colspan', 'rowspan', 'bgcolor', 'background'],
      th: ['colspan', 'rowspan', 'scope'],
      style: ['type', 'media'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'background'],
    allowProtocolRelative: false,
    allowVulnerableTags: true,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'iframe', 'object'],
  });
  return /^\s*<!doctype html\b/i.test(html) ? `<!DOCTYPE html>${clean}` : clean;
}

export function htmlToText(html: string): string {
  if (html.length > MAX_HTML_LENGTH) throw new TemplateRenderError('Rendered HTML is too large');
  return convert(html, {
    wordwrap: 100,
    limits: { maxInputLength: MAX_HTML_LENGTH },
    selectors: [
      { selector: 'head', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: '[hidden]', format: 'skip' },
      { selector: '[aria-hidden="true"]', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
        selector, options: { uppercase: false },
      })),
    ],
  }).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function redactOneTimeTokens(content: string): string {
  return content.replace(/((?:\?|&(?:amp;)?)token=)[^&"'#\s<>]+/gi, '$1***');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fill(content: string, variables: Record<string, VariableValue>, transform: (value: string) => string): string {
  return content.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(variables, name) ? transform(String(variables[name])) : match,
  );
}

export function renderSubject(subject: string, variables: Record<string, VariableValue>): string {
  return fill(subject, variables, (value) => value);
}

/** Sanitize after substitution too: an escaped value can still be an unsafe URL. */
export function fillHtml(html: string, variables: Record<string, VariableValue>): string {
  return sanitizeHtml(fill(html, variables, escapeHtml));
}

export function fillText(text: string, variables: Record<string, VariableValue>): string {
  return fill(text, variables, (value) => value);
}

export async function renderMessage(
  source: string,
  subject: string,
  variables: Record<string, VariableValue> = {},
): Promise<{ subject: string; html: string; text: string }> {
  templateVersionSchema.shape.source.parse(source);
  if (/<\s*mj-include\b/i.test(source)) {
    throw new TemplateRenderError('MJML includes are not supported; keep the complete template in its source');
  }
  let compiled: string;
  try {
    const result = await mjml2html(source, {
      ignoreIncludes: true, validationLevel: 'strict', fonts: {},
    });
    compiled = result.html;
  } catch (error) {
    throw new TemplateRenderError(`Invalid MJML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const html = fillHtml(compiled, variables);
  const text = htmlToText(html);
  if (!text) throw new TemplateRenderError('The rendered message has no readable text');
  return { subject: renderSubject(subject, variables), html, text };
}
