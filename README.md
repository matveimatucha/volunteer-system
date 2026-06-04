# volunteer-system
Сайт для регистрации волонтёров

## Проверка критичных сценариев

В проект добавлены smoke-тесты для контроля ключевой логики:

- блокировка регистрации для мероприятий со статусом `closed`;
- транзакция Firestore при записи волонтёра (без переполнения мест);
- корректное определение `reply_to` для EmailJS;
- согласованность текста шаблона вопросов в админке.

Запуск:

```bash
npm test
```

Отдельный запуск:

```bash
npm run test:smoke
npm run test:e2e
```

E2E-тесты используют Playwright с браузерными моками Firebase/EmailJS, чтобы проверять пользовательский сценарий регистрации без реального доступа к облачным сервисам.

## Сбор данных

Каждая заявка в Firestore (`registrations`):

- `answers` — ответы по ключам вопросов;
- `answersLabeled` — те же ответы с подписями («Имя», «Telegram»…);
- `contactEmail`, `contactPhone` — для поиска и защиты от дублей;
- `status` — `confirmed` (место занято) или `waitlist` (лист ожидания).

В админке: поиск, фильтры, удаление заявок, перевод из листа ожидания, CSV-экспорт.

Шаблон анкеты включает **согласие на обработку ПДн** (10 вопросов).

### Вход в админку (Firebase Auth)

1. Firebase Console → **Authentication** → включить **Email/Password**.
2. Создать пользователя с email из списка `ALLOWED_ADMIN_EMAILS` в `admin.html`.
3. (Рекомендуется) Опубликовать правила из `firestore.rules`.

Индексы Firestore (создаются по ссылке из консоли при первой ошибке):

- `registrations`: `eventId` + `contactEmail`
- `registrations`: `eventId` + `contactPhone`

## Интеграция с Google Sheets

Готовый шаблон с формулами и пошаговой настройкой:

- `GOOGLE_SHEETS_TEMPLATE.md`
- `GOOGLE_APPS_SCRIPT.md` — авто-импорт CSV из Google Drive с `import_log`, уведомлениями (Telegram/email) и листами по мероприятиям
