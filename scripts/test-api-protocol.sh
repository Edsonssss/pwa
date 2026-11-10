#!/bin/bash
# Тест протокола api.php (через Node-мок scripts/ediai-test-server.mjs)
set -e
PORT=8091
KEY="5e254577c0cffc3536b691c9368b46ed"
BASE="http://127.0.0.1:${PORT}/pwa/api.php"
TMP=$(mktemp -d)
mkdir -p "$TMP/pwa/storage"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1 (ожидалось $3, получено $2)"; fi }

node /home/z/my-project/scripts/ediai-test-server.mjs "$TMP" $PORT >/dev/null 2>&1 &
SRV=$!
sleep 0.7
trap 'kill $SRV 2>/dev/null' EXIT

# 1. status
S=$(curl -sS "$BASE?action=status&key=$KEY" -w "|%{http_code}")
check "status содержит push:true" "$(echo "$S" | grep -c '"push":true')" "1"
check "status http" "$(echo "$S" | grep -o '[0-9]*$')" "200"

# 2. push (VAPID public key)
S=$(curl -sS "$BASE?action=push" -H "X-Sync-Key: $KEY")
check "push publicKey" "$(echo "$S" | grep -c '"publicKey":"BAWVggx3TiOGr6UxJIqhOpoMgpA')" "1"

# 3. bad key
S=$(curl -sS "$BASE?action=push" -H "X-Sync-Key: wrong" -o /dev/null -w "%{http_code}")
check "неверный ключ → 403" "$S" "403"

# 4. subscribe
S=$(curl -sS -X POST "$BASE?action=subscribe" -H "X-Sync-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://example.org/push/abc","keys":{"p256dh":"AAA","auth":"BBB"},"userId":"u1","userName":"Иван","tzOffsetMin":240}')
check "subscribe ok" "$(echo "$S" | grep -c '"ok":true')" "1"
check "файл подписок создан" "$(test -f "$TMP/pwa/storage/push-subscriptions.json" && echo 1)" "1"

# 5. повторный subscribe (обновление tz)
S=$(curl -sS -X POST "$BASE?action=subscribe" -H "X-Sync-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://example.org/push/abc","keys":{"p256dh":"AAA","auth":"BBB"},"userId":"u1","userName":"Иван","tzOffsetMin":180}')
check "subscribe обновление (1 подписка)" "$(echo "$S" | grep -o '"subscriptions":[0-9]*' | grep -o '[0-9]*$')" "1"
check "tz обновлён" "$(grep -cE '"tzOffsetMin":\s*180' "$TMP/pwa/storage/push-subscriptions.json" || true)" "1"

# 6. subscribe с неполными полями → 400
S=$(curl -sS -X POST "$BASE?action=subscribe" -H "X-Sync-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://x"}' -o /dev/null -w "%{http_code}")
check "subscribe без keys → 400" "$S" "400"

# 7. db: сначала 404
S=$(curl -sS "$BASE?action=db" -H "X-Sync-Key: $KEY" -o /dev/null -w "%{http_code}")
check "db до синхронизации → 404" "$S" "404"

# 8. POST данных
S=$(curl -sS -X POST "$BASE" -H "X-Sync-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"app":"ezhednik","version":1,"exportedAt":"2026-11-10T10:00:00Z","data":{"users":[],"reminders":[{"id":"r1","userId":"u1","title":"Тест","note":"","date":"2026-11-10","time":"09:00","priority":"normal","completed":false,"createdAt":"","updatedAt":"","completedAt":null}],"links":[]}}')
check "POST данных ok" "$(echo "$S" | grep -c '"ok":true')" "1"

# 9. GET db
S=$(curl -sS "$BASE?action=db" -H "X-Sync-Key: $KEY")
check "db содержит напоминание" "$(echo "$S" | grep -c 'r1')" "1"

# 10. unsubscribe
S=$(curl -sS -X POST "$BASE?action=unsubscribe" -H "X-Sync-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://example.org/push/abc"}')
check "unsubscribe ok" "$(echo "$S" | grep -c '"ok":true')" "1"
check "подписок осталось 0" "$(grep -c 'example.org' "$TMP/pwa/storage/push-subscriptions.json" || true)" "0"

# 11. X-Robots-Tag на api.php
S=$(curl -sSI "$BASE?action=status&key=$KEY" | grep -ci "X-Robots-Tag: noindex")
check "X-Robots-Tag noindex" "$S" "1"

echo ""
echo "ИТОГО: pass=$pass, fail=$fail"
rm -rf "$TMP"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
