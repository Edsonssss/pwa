#!/bin/bash
# Публикация Ежедневника на GitHub Pages (репозиторий Edsonssss/pwa).
# Репозиторий = исходники + docs/ (готовая статика для Pages) + docs/data/db.json (данные).
set -euo pipefail
: "${GH_TOKEN:?Установите переменную окружения GH_TOKEN с токеном GitHub}"

REPO_DIR="/home/z/pwa-pages"
SRC="/home/z/my-project"
TOKEN="${GH_TOKEN:-}"
REMOTE="https://${TOKEN}@github.com/Edsonssss/pwa.git"

# 1. Чистый staging
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"

# 2. Исходники проекта (без dev-артефактов)
cd "$SRC"
for item in .gitignore README.md bun.lock components.json eslint.config.mjs next.config.ts package.json postcss.config.mjs public scripts src tailwind.config.ts tsconfig.json; do
  cp -r "$item" "$REPO_DIR/"
done
# Скрипт публикации содержит токен — в публичный репозиторий не попадает
rm -f "$REPO_DIR/scripts/publish_pages.sh"

# 3. Свежая статическая сборка → docs/ (манифест и пути уже с basePath /pwa)
rm -rf "$REPO_DIR/docs"
cp -r out "$REPO_DIR/docs"
rm -rf "$REPO_DIR/docs/.next"

# 4. Чистый seed файла данных (папка сайта, куда приложение синхронизирует данные)
mkdir -p "$REPO_DIR/docs/data"
python3 - <<'PY'
import json, datetime
seed = {
    "app": "ezhednik",
    "version": 1,
    "exportedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
    "data": {"users": [], "reminders": [], "links": []},
}
with open("/home/z/pwa-pages/docs/data/db.json", "w", encoding="utf-8") as f:
    json.dump(seed, f, ensure_ascii=False, indent=2)
print("seed written")
PY

# 5. Коммит и force-push (одна чистая история)
cd "$REPO_DIR"
git init -q
git config user.name "Edsonssss"
git config user.email "edsonsss@yandex.ru"
git config http.postBuffer 524288000
git remote add origin "$REMOTE"
git add -A
git commit -q -m "PWA «Ежедневник» v2.1: статическое приложение для GitHub Pages с синхронизацией данных в папку сайта (docs/data/db.json) через GitHub API"
git branch -M main
git push -q --force origin main

echo "PUSH OK"
# 6. Проверка удалённого состояния
git ls-remote origin refs/heads/main | head -1
