interface SeedTemplate {
  key: string;
  name: string;
  description: string;
  variables: string[];
  subject: string;
  source: string;
}

function message(title: string, paragraphs: string[], button?: { label: string; variable: string }): string {
  return `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" />
      <mj-text font-size="16px" line-height="1.5" />
      <mj-button background-color="#1f6feb" align="left" />
    </mj-attributes>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>
          <h2>${title}</h2>
${paragraphs.map((paragraph) => `          <p>${paragraph}</p>`).join('\n')}
        </mj-text>${button ? `
        <mj-button href="{{${button.variable}}}">
          ${button.label}
        </mj-button>
        <mj-text>
          Если кнопка не работает, откройте адрес: {{${button.variable}}}
        </mj-text>` : ''}
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

export const SEED_TEMPLATES: readonly SeedTemplate[] = [
  {
    key: 'auth-welcome', name: 'Приветствие',
    description: 'Первая ссылка подтверждения после регистрации.',
    variables: ['email', 'verificationUrl'], subject: 'Подтвердите адрес почты',
    source: message('Добро пожаловать', ['Для адреса {{email}} создан аккаунт.', 'Подтвердите адрес, чтобы мы могли связаться с вами.'],
      { label: 'Подтвердить адрес', variable: 'verificationUrl' }),
  },
  {
    key: 'auth-verify-email', name: 'Подтверждение адреса',
    description: 'Повторная ссылка подтверждения адреса.',
    variables: ['email', 'verificationUrl'], subject: 'Подтвердите адрес почты',
    source: message('Подтвердите адрес', ['Подтвердите адрес {{email}} по ссылке ниже.', 'Если вы этого не запрашивали, письмо можно не читать.'],
      { label: 'Подтвердить адрес', variable: 'verificationUrl' }),
  },
  {
    key: 'auth-password-reset', name: 'Восстановление пароля',
    description: 'Одноразовая ссылка восстановления пароля.',
    variables: ['email', 'resetUrl'], subject: 'Восстановление пароля',
    source: message('Восстановление пароля', ['Для адреса {{email}} запросили смену пароля.', 'Ссылка работает один раз и скоро истекает. Если запрос не ваш, ничего не изменилось.'],
      { label: 'Задать новый пароль', variable: 'resetUrl' }),
  },
  {
    key: 'auth-confirm-email-change', name: 'Подтверждение нового адреса',
    description: 'Подтверждение смены почты на новом адресе.',
    variables: ['email', 'confirmUrl'], subject: 'Подтвердите новый адрес почты',
    source: message('Подтвердите новый адрес', ['Вы попросили использовать для аккаунта адрес {{email}}.'],
      { label: 'Подтвердить новый адрес', variable: 'confirmUrl' }),
  },
  {
    key: 'auth-email-changed', name: 'Адрес изменён',
    description: 'Уведомление о смене почты на прежний адрес.',
    variables: ['email', 'previousEmail'], subject: 'Адрес почты вашего аккаунта изменён',
    source: message('Адрес почты изменён', ['Адрес {{previousEmail}} больше не используется для этого аккаунта.', 'Если это были не вы, немедленно обратитесь в поддержку.']),
  },
];
