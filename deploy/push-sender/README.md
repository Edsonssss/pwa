# push-sender (Node.js) — запасной вариант

**Для виртуального хостинга используйте PHP-вариант** — файл
`pwa/storage/push-sender.php` из архива деплоя: он не требует Node.js,
npm и SSH, запускается через «Планировщик (cron)» в панели хостинга.

Эта папка нужна только если вы хотите отправлять push именно через Node.js
(например, на VPS с node-окружением):

```bash
npm install          # ставит web-push
node push-sender.mjs --dry-run   # проверка без отправки
# cron (каждую минуту):
#   * * * * * cd /путь/к/push-sender && /usr/bin/node push-sender.mjs --quiet >> push-sender.log 2>&1
```

Настройки — `config.json` (образец: `config.example.json`): путь к папке
`storage` приложения и VAPID-ключи (приватный ключ здесь, публичный — в api.php).

Скрипт читает те же файлы, что и PHP-вариант: `db.json`,
`push-subscriptions.json`, пишет `push-state.json`. Можно использовать
оба варианта по очереди — они не конфликтуют (dedup общий, в push-state.json).
