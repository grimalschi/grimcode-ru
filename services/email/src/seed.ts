import { DEFAULT_LOCALE } from '@template/contracts';

import type { EditorDocument } from './types.js';

/**
 * Seed templates.
 *
 * They are created directly in the editor's own document format, so the very first template a
 * project opens is a real editable document rather than imported markup. There is no migration
 * from an older editor format in the template.
 *
 * The wording is deliberately plain and belongs to the project that copies this repository. It is
 * in the template's default language; a project that speaks another one edits these five documents
 * or adds a version in its own language, which is what the locale on a version is for.
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
  return paragraph(text('Если кнопка не работает, откройте адрес: '), variable(urlVariable));
}

function document(...content: unknown[]): EditorDocument {
  return { type: 'doc', content: content as EditorDocument['content'] };
}

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    key: 'auth-welcome',
    name: 'Приветствие',
    description: 'Отправляется сразу после регистрации и несёт первую ссылку подтверждения.',
    variables: ['email', 'verificationUrl'],
    locale: DEFAULT_LOCALE,
    subject: 'Подтвердите адрес почты',
    document: document(
      heading('Добро пожаловать'),
      paragraph(text('Для адреса '), variable('email'), text(' создан аккаунт.')),
      paragraph(text('Подтвердите адрес, чтобы мы могли связаться с вами, когда это будет важно.')),
      button('Подтвердить адрес', 'verificationUrl'),
      fallbackLink('verificationUrl'),
    ),
  },
  {
    key: 'auth-verify-email',
    name: 'Подтверждение адреса',
    description: 'Повторная ссылка подтверждения: по просьбе человека или от администратора.',
    variables: ['email', 'verificationUrl'],
    locale: DEFAULT_LOCALE,
    subject: 'Подтвердите адрес почты',
    document: document(
      heading('Подтвердите адрес'),
      paragraph(text('Подтвердите адрес '), variable('email'), text(' по ссылке ниже.')),
      button('Подтвердить адрес', 'verificationUrl'),
      fallbackLink('verificationUrl'),
      paragraph(text('Если вы этого не запрашивали, письмо можно не читать.')),
    ),
  },
  {
    key: 'auth-password-reset',
    name: 'Восстановление пароля',
    description: 'Одноразовая ссылка восстановления. Работает один раз и быстро истекает.',
    variables: ['email', 'resetUrl'],
    locale: DEFAULT_LOCALE,
    subject: 'Восстановление пароля',
    document: document(
      heading('Восстановление пароля'),
      paragraph(text('Для адреса '), variable('email'), text(' запросили смену пароля.')),
      button('Задать новый пароль', 'resetUrl'),
      fallbackLink('resetUrl'),
      paragraph(
        text('Ссылка работает один раз и скоро истекает. Если запрос не ваш, ничего не '),
        text('изменилось и письмо можно не читать.'),
      ),
    ),
  },
  {
    key: 'auth-confirm-email-change',
    name: 'Подтверждение нового адреса',
    description: 'Отправляется на новый адрес, когда человек меняет почту.',
    variables: ['email', 'confirmUrl'],
    locale: DEFAULT_LOCALE,
    subject: 'Подтвердите новый адрес почты',
    document: document(
      heading('Подтвердите новый адрес'),
      paragraph(text('Вы попросили использовать для аккаунта адрес '), variable('email'), text('.')),
      button('Подтвердить новый адрес', 'confirmUrl'),
      fallbackLink('confirmUrl'),
    ),
  },
  {
    key: 'auth-email-changed',
    name: 'Адрес изменён',
    description: 'Уведомление на прежний адрес, чтобы угон аккаунта был заметен.',
    variables: ['email', 'previousEmail'],
    locale: DEFAULT_LOCALE,
    subject: 'Адрес почты вашего аккаунта изменён',
    document: document(
      heading('Адрес почты изменён'),
      paragraph(
        text('Адрес '),
        variable('previousEmail'),
        text(' больше не используется для этого аккаунта.'),
      ),
      paragraph(text('Если это были не вы, немедленно обратитесь в поддержку.')),
    ),
  },
];
