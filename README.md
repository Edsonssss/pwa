# Ежедневник — PWA для iOS 📱✅

Личный ежедневник с напоминаниями и меню проектов, оформленный как Progressive Web App.
Работает **без серверного приложения**: статическая сборка размещается в подпапке сайта
(например, `https://ediai.ru/pwa/`), данные хранятся на устройстве (localStorage, JSON)
и автоматически синхронизируются через крошечный PHP-эндпоинт `api.php` в той же папке.
Устанавливается на iPhone/iPad с главного экрана и работает как отдельное приложение,
в том числе офлайн.

**Рабочий адрес:** https://ediai.ru/pwa/

## Возможности

- **Ежедневник** — лента дней с автопрокруткой к сегодняшнему, напоминания с датой,
  временем, приоритетом и заметкой; создание, редактирование, удаление (с подтверждением),
  отметка «выполнено»; разделы «В работе» / «Выполнено», метка «Просрочено», прогресс дня,
  режимы «День» и «Все дела» с группировкой «Сегодня / Завтра / Вчера».
- **Меню «Проекты»** — карточки ссылок на другие страницы и проекты: emoji-значок,
  название, описание, открытие в новой вкладке; добавление, редактирование, удаление.
- **Несколько пользователей** — профили с именем и цветом, опциональный 4-значный PIN-код
  (хеш SHA-256 + соль через Web Crypto, PIN никогда не хранится открыто), изоляция данных
  по профилю, быстрое переключение, автовход на устройстве.
- **Синхронизация между устройствами** — всё хранится в localStorage устройства и
  автоматически копируется на сервер (`api.php` → файл `storage/db.json` на хостинге):
  профиль, напоминания и ссылки переносятся между iPhone/iPad/компьютером. В настройках:
  адрес сервера, ключ, автосинхронизация, кнопки «Загрузить» и «Отправить», а также ручной
  **Экспорт JSON** (резервная копия файлом) и **Импорт JSON**.
- **Push-уведомления в точное время** — если у дела указано время, в назначенный момент
  iPhone получает системное уведомление (даже когда приложение закрыто). Требуется iOS 16.4+,
  установка на «Экран Домой» и cron-задача в панели хостинга: `storage/push-sender.php`
  (чистый PHP без зависимостей) раз в минуту находит напоминания, срок которых наступил
  (с учётом часового пояса устройства), и рассылает Web Push через сервисы Apple/Google
  (VAPID ES256 + шифрование RFC 8291 aes128gcm реализованы в самом скрипте). Включение —
  в «Ещё» → «Push-уведомления». Запасной вариант отправки на Node.js — `deploy/push-sender/`.
- **Скрытие от поисковиков** — папка приложения закрыта от индексации тремя уровнями:
  `<meta name="robots" content="noindex,nofollow">` в страницах, заголовок
  `X-Robots-Tag: noindex, nofollow` (`.htaccess`), `Disallow: /pwa` в корневом robots.txt.
- **Офлайн и PWA** — service worker: страницы network-first с офлайн-фолбэком, иконки
  cache-first; манифест с maskable-иконкой, safe-area для «челки» и жеста «домой».

## Как это работает

Приложение — статический экспорт Next.js (`output: "export"`, basePath `/pwa`).
Хранилище `src/lib/local-store.ts` читает и пишет единый JSON-ключ
`localStorage["planner.db.v1"]` со структурой:

```json
{
  "users":     [{ "id", "name", "color", "pinSalt", "pinHash", "createdAt" }],
  "reminders": [{ "id", "userId", "title", "note", "date", "time", "priority", "completed", "…dates" }],
  "links":     [{ "id", "userId", "title", "url", "description", "icon", "createdAt" }]
}
```

Все операции с данными проходят через очередь (`enqueue`), чтобы быстрые нажатия не
затирали друг друга. Интерфейс `src/lib/api-client.ts` сохранён прежним, поэтому
компоненты не зависят от того, где лежат данные.

Синхронизация (`src/lib/endpoint-sync.ts`) — по простому протоколу:

- `GET api.php?action=db` — прочитать данные (404 = на сервере ещё пусто);
- `POST api.php` — записать данные целиком одним запросом;
- `GET api.php?action=push` — публичный VAPID-ключ для подписки на уведомления;
- `POST api.php?action=subscribe` / `action=unsubscribe` — подписка устройства на push
  (хранится в `storage/push-subscriptions.json`);
- ключ передаётся в заголовке `X-Sync-Key` (константа `SYNC_KEY` в api.php).

Клиент push (`src/lib/push-client.ts`): по нажатию кнопки запрашивает разрешение iOS,
создаёт подписку `PushManager.subscribe` (service worker из `public/sw.js` обрабатывает
события `push` и `notificationclick`) и отправляет её на сервер вместе с часовым поясом
устройства — по нему скрипт отправки считает срок напоминания. Отправку делает
`deploy/push-sender/push-sender.php` (чистый PHP без зависимостей; cron каждую минуту):
читает `db.json`, находит напоминания со временем в окне «сейчас», подписывает VAPID
(ECDSA P-256 на GMP/BCMath), шифрует payload по RFC 8291 и отправляет в push-сервис;
отметки «отправлено» — в `storage/push-state.json`, недействительные подписки
(HTTP 404/410) удаляются. Альтернатива на Node.js — `deploy/push-sender/push-sender.mjs`.

Автоматика: при запуске приложение подтягивает свежие данные с сервера (если на
устройстве нет несохранённых изменений), каждое изменение отправляется через ~8 секунд
после последней правки и при закрытии приложения. Конфликты не решаются молча: если
данные есть и на сервере, и на устройстве — приложение предложит выбор (отправить или
загрузить с заменой). Пустой сервер никогда не стирает данные устройства.

## Деплой на хостинг (AdminVPS / ediai.ru)

1. Соберите пакет и загрузите папку `pwa/` в document root сайта (через файловый
   менеджер панели или FTP):

```bash
PAGES_BUILD=1 bun run build          # статический экспорт в out/
rm -rf download/ediai-pwa/pwa && mkdir -p download/ediai-pwa/pwa/storage
cp -r out/. download/ediai-pwa/pwa/
cp deploy/.htaccess download/ediai-pwa/pwa/.htaccess
cp deploy/api.php   download/ediai-pwa/pwa/api.php
printf 'Require all denied\nDeny from all\n' > download/ediai-pwa/pwa/storage/.htaccess
cd download/ediai-pwa && zip -r ../ediai-pwa.zip pwa push-sender ЧИТАЙТЕ-ДЕПЛОЙ-EDIAI.txt
```

2. В корневом `robots.txt` **сайта** (ediai.ru/robots.txt) добавьте строку
   `Disallow: /pwa` — это дополнительный уровень к встроенным meta noindex и
   X-Robots-Tag.
3. Проверьте: `https://ediai.ru/pwa/` открывается, а
   `https://ediai.ru/pwa/api.php?action=status&key=<SYNC_KEY>` возвращает
   `{"ok":true,...}`. Файл `storage/db.json` появится после первой синхронизации;
   прямой доступ к нему закрыт `.htaccess` (403).
4. **Push-уведомления**: в панели хостинга создайте cron-задачу «каждую минуту»
   с командой `/usr/bin/php /var/www/<пользователь>/data/www/ediai.ru/pwa/storage/push-sender.php`
   (скрипт уже в пакете, SSH/npm не нужны). На iPhone: установите приложение
   на «Экран Домой», затем «Ещё» → «Push-уведомления» → «Включить».
   Полные шаги — в инструкции.

Подробная пошаговая инструкция для хостинга — в `deploy/ЧИТАЙТЕ-ДЕПЛОЙ-EDIAI.txt`.

**Запасной вариант без PHP** — Cloudflare Worker с тем же протоколом
(`deploy/worker.js`): данные тогда хранятся в приватном репозитории GitHub, а токен —
в секрете воркера (на устройствах не хранится). Адрес воркера указывается в настройках
приложения.

## Локальная разработка

```bash
bun install
bun run dev        # http://localhost:3000 — обычный dev-режим
bun run lint       # ESLint
PAGES_BUILD=1 bun run build   # статический экспорт в out/ (basePath /pwa)
```

Локальный предпросмотр экспорта с эмуляцией api.php (протокол тот же, что у api.php):

```bash
mkdir -p /tmp/site && cp -r out /tmp/site/pwa && cp deploy/api.php /tmp/site/pwa/
node scripts/ediai-test-server.mjs /tmp/site 8090
# открыть http://127.0.0.1:8090/pwa/
# в настройках синхронизации указать http://127.0.0.1:8090/pwa/api.php
```

## Установка на iPhone / iPad

1. Откройте https://ediai.ru/pwa/ в **Safari**.
2. Кнопка «Поделиться» → **«На экран „Домой“»** → «Добавить».
3. Иконка на главном экране — приложение запускается без адресной строки и работает офлайн.

## Структура проекта

```
src/
  app/                    # страница, layout, manifest.webmanifest
  components/             # user-gate, planner-view, projects-view, settings-view, pin-pad…
  lib/
    local-store.ts        # клиентское JSON-хранилище (localStorage + Web Crypto)
    endpoint-sync.ts      # синхронизация с api.php / Worker по протоколу X-Sync-Key
    api-client.ts         # единый интерфейс доступа к данным
    types.ts              # PublicUser, Reminder, ProjectLink
  hooks/use-pwa.ts        # регистрация service worker, standalone-режим
public/
  sw.js                   # service worker (пути от scope: работает и в /, и в /pwa/)
  icons/                  # иконки PWA (генерация: python3 scripts/gen_icons.py)
deploy/
  api.php                 # сервер синхронизации (кладётся в папку pwa/ на хостинг)
  .htaccess               # запрет индексации папки приложения
  storage/.htaccess       # запрет прямого доступа к файлу данных
  worker.js               # запасной вариант синхронизации на Cloudflare Workers
  ЧИТАЙТЕ-ДЕПЛОЙ-EDIAI.txt  # пошаговая инструкция по установке на хостинг
scripts/
  ediai-test-server.mjs   # тестовый сервер (статика + эмуляция api.php)
```
