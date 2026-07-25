import type { EditorDocument } from './types.js';

/**
 * Seed templates.
 *
 * They are created directly in the editor's own document format, so the very first template a
 * project opens is a real editable document rather than imported markup. There is no migration
 * from an older editor format in the template.
 *
 * The wording is deliberately neutral and belongs to the project that copies this repository.
 */

interface SeedTemplate {
  key: string;
  name: string;
  description: string;
  variables: string[];
  locale: string;
  subject: string;
  document: EditorDocument;
}

function text(value: string) {
  return { type: 'text', text: value };
}

function variable(id: string) {
  return { type: 'variable', attrs: { id, fallback: null, required: true } };
}

function paragraph(...content: unknown[]) {
  return { type: 'paragraph', attrs: { textAlign: 'left' }, content };
}

function heading(value: string) {
  return {
    type: 'heading',
    attrs: { textAlign: 'left', level: 2 },
    content: [text(value)],
  };
}

function button(label: string, urlVariable: string) {
  return {
    type: 'button',
    attrs: {
      text: label,
      isTextVariable: false,
      // With `isUrlVariable`, the editor stores the bare variable name — not a `{{…}}` placeholder,
      // which would be rendered literally into the href.
      url: urlVariable,
      isUrlVariable: true,
      alignment: 'left',
      variant: 'filled',
      borderRadius: 'smooth',
      buttonColor: '#1f6feb',
      textColor: '#ffffff',
    },
  };
}

function fallbackLink(urlVariable: string) {
  return paragraph(
    text('If the button does not work, open this address: '),
    variable(urlVariable),
  );
}

function document(...content: unknown[]): EditorDocument {
  return { type: 'doc', content: content as EditorDocument['content'] };
}

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    key: 'auth-welcome',
    name: 'Welcome',
    description: 'Sent right after registration; carries the first email verification link.',
    variables: ['email', 'verificationUrl'],
    locale: 'en',
    subject: 'Confirm your email address',
    document: document(
      heading('Welcome'),
      paragraph(text('Your account has been created for '), variable('email'), text('.')),
      paragraph(text('Please confirm the address so we can reach you when it matters.')),
      button('Confirm email', 'verificationUrl'),
      fallbackLink('verificationUrl'),
    ),
  },
  {
    key: 'auth-verify-email',
    name: 'Verify email',
    description: 'Repeat verification link, requested by the user or resent by an administrator.',
    variables: ['email', 'verificationUrl'],
    locale: 'en',
    subject: 'Confirm your email address',
    document: document(
      heading('Confirm your email'),
      paragraph(text('Use the link below to confirm '), variable('email'), text('.')),
      button('Confirm email', 'verificationUrl'),
      fallbackLink('verificationUrl'),
      paragraph(text('If you did not ask for this, you can ignore this message.')),
    ),
  },
  {
    key: 'auth-password-reset',
    name: 'Password reset',
    description: 'One-time recovery link. The link works once and expires.',
    variables: ['email', 'resetUrl'],
    locale: 'en',
    subject: 'Reset your password',
    document: document(
      heading('Reset your password'),
      paragraph(text('A password reset was requested for '), variable('email'), text('.')),
      button('Choose a new password', 'resetUrl'),
      fallbackLink('resetUrl'),
      paragraph(
        text('The link works once and expires shortly. If you did not request it, nothing has '),
        text('changed and you can ignore this message.'),
      ),
    ),
  },
  {
    key: 'auth-confirm-email-change',
    name: 'Confirm email change',
    description: 'Sent to the new address when a user asks to change their email.',
    variables: ['email', 'confirmUrl'],
    locale: 'en',
    subject: 'Confirm your new email address',
    document: document(
      heading('Confirm your new address'),
      paragraph(text('You asked to use '), variable('email'), text(' for your account.')),
      button('Confirm new address', 'confirmUrl'),
      fallbackLink('confirmUrl'),
    ),
  },
  {
    key: 'auth-email-changed',
    name: 'Email changed',
    description: 'Notice sent to the previous address, so a hijacked account is noticed.',
    variables: ['email', 'previousEmail'],
    locale: 'en',
    subject: 'The email address of your account has changed',
    document: document(
      heading('Your email address changed'),
      paragraph(
        text('The address '),
        variable('previousEmail'),
        text(' is no longer used for this account.'),
      ),
      paragraph(text('If this was not you, contact support immediately.')),
    ),
  },
];
