import { Maily } from '@maily-to/render';
import type { EditorDocument } from './types.js';
import { convert } from 'html-to-text';

const MAX_HTML_LENGTH = 5_000_000;

export type VariableValue = string | number | boolean;

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

/** Values coming from an event are data, never markup. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every variable a document actually references.
 *
 * Maily stores variables as nodes, so they can be collected from the document rather than guessed
 * from the rendered text.
 */
export function collectVariables(document: EditorDocument): string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    const record = node as Record<string, unknown>;
    const attrs = record.attrs as Record<string, unknown> | undefined;

    if (record.type === 'variable') {
      const id = attrs?.id ?? attrs?.name;
      if (typeof id === 'string' && id !== '') found.add(id);
    }

    // A button may carry its link or its label as a variable, in which case the attribute holds
    // the bare variable name rather than a placeholder.
    if (attrs?.isUrlVariable === true && typeof attrs.url === 'string' && attrs.url !== '') {
      found.add(attrs.url);
    }
    if (attrs?.isTextVariable === true && typeof attrs.text === 'string' && attrs.text !== '') {
      found.add(attrs.text);
    }

    for (const value of Object.values(record)) walk(value);
  };

  walk(document.content ?? []);
  return [...found].sort();
}

/**
 * Refuses a document that uses a variable the template does not declare.
 *
 * Publishing is the moment to catch this: a runtime delivery must never discover that a value has
 * no source and silently send an empty placeholder.
 */
export function assertDeclaredVariables(document: EditorDocument, declared: readonly string[]): void {
  const allowed = new Set(declared);
  const unknown = collectVariables(document).filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new TemplateRenderError(
      `The document uses variables the template does not declare: ${unknown.join(', ')}`,
    );
  }
}

/**
 * Removes anything an email client must never execute.
 *
 * The document itself is structured, so this mostly guards against values and pasted content;
 * it runs on every published and previewed result rather than being trusted away.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
}

/**
 * Plain text is generated from the produced HTML, so the two versions can never drift apart:
 * whatever the recipient would see rendered is what the text version describes.
 */
export function htmlToText(html: string): string {
  if (html.trim() === '') return '';
  if (html.length > MAX_HTML_LENGTH) throw new TemplateRenderError('Rendered HTML is too large');

  return convert(html, {
    wordwrap: 100,
    limits: { maxInputLength: MAX_HTML_LENGTH },
    selectors: [
      { selector: '[hidden]', format: 'skip' },
      { selector: '[aria-hidden="true"]', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
    ],
  })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes one-time credentials from a copy of a message kept for the record.
 *
 * Auth stores only the hash of a recovery or confirmation token, so that reading its database does
 * not hand anyone an account. A delivery log that kept the token in the link would undo exactly
 * that: an administrator allowed to read messages could request a reset for someone else and take
 * the link out of the log. The recipient still gets the real one — only the stored copy is blunted.
 */
export function redactOneTimeTokens(content: string): string {
  return content.replace(/([?&]token=)[^&"'\s<>]+/gi, '$1***');
}

export interface RenderedMessage {
  subject: string;
  html: string;
  text: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Replaces `{{name}}` placeholders.
 *
 * A name without a value is left as it is rather than replaced by an empty string, so a missing
 * value shows up instead of silently disappearing.
 */
function fill(
  content: string,
  variables: Record<string, VariableValue>,
  transform: (value: string) => string,
): string {
  return content.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(variables, name) ? transform(String(variables[name])) : match,
  );
}

/** Subjects are plain text, so values go in unescaped. */
export function renderSubject(subject: string, variables: Record<string, VariableValue>): string {
  return fill(subject, variables, (value) => value);
}

/** Values are data, not markup — they are escaped before they enter the published HTML. */
export function fillHtml(html: string, variables: Record<string, VariableValue>): string {
  return fill(html, variables, escapeHtml);
}

export function fillText(text: string, variables: Record<string, VariableValue>): string {
  return fill(text, variables, (value) => value);
}

/**
 * Renders one message from a stored editor document.
 *
 * With no `variables`, the editor's variables stay as `{{name}}` placeholders — that is what
 * publishing stores, because the actual values are only known per recipient at send time. With
 * `variables`, the values are filled in for a preview or a test send.
 *
 * Runtime delivery does **not** call this: it sends the already published HTML and text, so an
 * editor library upgrade can never change a message that was approved earlier.
 */
export async function renderMessage(
  document: EditorDocument,
  subject: string,
  variables?: Record<string, VariableValue>,
): Promise<RenderedMessage> {
  const maily = new Maily(document as never);
  if (variables) {
    /*
     * Values go in raw. The renderer escapes them on its way into the HTML — escaping here as well
     * produced `&amp;amp;` in every preview and test send, so an address or a link with a query
     * string came out wrong exactly where someone was checking it.
     *
     * The sanitiser still runs over the result, so this is not the only thing standing between a
     * value and the output.
     */
    maily.setVariableValues(
      Object.fromEntries(Object.entries(variables).map(([name, value]) => [name, String(value)])),
    );
  }

  let html: string;
  try {
    html = sanitizeHtml(await maily.render());
  } catch (error) {
    throw new TemplateRenderError(
      `The document could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = htmlToText(html);
  if (text === '') throw new TemplateRenderError('The rendered message has no readable text');

  return {
    subject: variables ? renderSubject(subject, variables) : subject,
    html,
    text,
  };
}
