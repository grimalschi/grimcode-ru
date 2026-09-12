# Grimcode — модульный шаблон приложения

Шаблон с публичным сайтом, приложением, авторизацией, админкой и почтой. Модули работают одним процессом; каждый владеет своим кодом и интерфейсом, а модули с данными — своей схемой PostgreSQL.

## Первый запуск

Нужны Node.js 22.13+ (ветка 22) или 24+, pnpm версии из `package.json` и PostgreSQL. Для локальной установки создайте учётную запись и базу:

```sh
sudo -u postgres createuser --createdb --pwprompt template
sudo -u postgres createdb --owner=template template
pnpm install
cp .env.example .env
```

Заполните `.env` по комментариям в [примере](.env.example): `DATABASE_URL`, `PROJECT_SLUG`, `PORT` и `PUBLIC_SITE_URL`. Затем запустите приложение:

```sh
pnpm dev
```

По адресу из `PUBLIC_SITE_URL` доступны сайт `/`, приложение `/app/` и админка `/admin/`. Зарегистрируйте первый аккаунт и откройте админку: этот аккаунт станет владельцем.

Для параллельной работы создайте [worktree](docs/development.md#worktrees) с отдельной базой и портом.

## Документация

| Документ | Содержание |
| --- | --- |
| [Архитектура](ARCHITECTURE.md) | Устройство проекта, границы и взаимодействие модулей |
| [Работа агента](AGENTS.md) | Инструкции по внесению и проверке изменений |
| [Разработка](docs/development.md) | Worktree, запуск, проверки и внесение изменений |
| [Контракты](contracts/README.md) | Подключение модулей и типизация API |
| [Тесты](tests/README.md) | Проверки приложения и тестовые данные |

## Модули

| Модуль | Ответственность |
| --- | --- |
| [Router](modules/router/README.md) | Внешняя маршрутизация и проверка административного доступа |
| [Web](modules/web/README.md) | Публичный сайт с SSR и пользовательский интерфейс `/app/` |
| [Auth](modules/auth/README.md) | Identity, способы входа и сессии |
| [Users](modules/users/README.md) | Продуктовые профили |
| [Admin](modules/admin/README.md) | Администраторы, права и панель управления |
| [Notifications](modules/notifications/README.md) | События и выбор уведомлений |
| [Email](modules/email/README.md) | Шаблоны писем, отправка и журнал доставок |

Локальный почтовый режим `log` сохраняет письма для просмотра в Admin. Настройки отправки через провайдера описаны в [README Email](modules/email/README.md#transport).
