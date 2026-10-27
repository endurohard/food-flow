#!/usr/bin/env bash
#
# Сборка APK кассы и публикация его для раздачи организациям.
#
# APK один на всю платформу: адрес сервера касса получает из кода привязки
# (QR на странице /admin-panel/pos-download.html), поэтому пересобирать файл
# под каждую организацию не нужно — достаточно положить его рядом со статикой.
#
# Файл в git не хранится (frontend/downloads в .gitignore): это 2 МБ бинарника,
# который меняется на каждом релизе кассы. На прод он уезжает scp.
#
# Использование:
#   scripts/publish-pos-apk.sh                 # собрать и положить локально
#   scripts/publish-pos-apk.sh --skip-build    # опубликовать уже собранный apk
#
# Выкат на прод (из корня репозитория):
#   scripts/publish-pos-apk.sh
#   ssh iTTEST 'mkdir -p ~/food-flow/frontend/downloads'
#   scp frontend/downloads/foodflow-pos.apk  iTTEST:~/food-flow/frontend/downloads/
#   scp frontend/downloads/foodflow-pos.json iTTEST:~/food-flow/frontend/downloads/
# Фронт смонтирован томом (./frontend:/app/public:ro) — пересборка образа не нужна.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/mobile/sigma-pos"
OUT_DIR="$ROOT/frontend/downloads"
APK_SRC="$APP/app/build/outputs/apk/release/app-release.apk"
SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

# JAVA_HOME: системная java на macOS — 1.8, с ней gradle не поедет
if [[ -z "${JAVA_HOME:-}" ]]; then
  for c in /opt/homebrew/opt/openjdk@17 /usr/lib/jvm/java-17-openjdk-amd64; do
    [[ -d "$c" ]] && export JAVA_HOME="$c" && break
  done
fi
if [[ -z "${ANDROID_HOME:-}" && -d /opt/homebrew/share/android-commandlinetools ]]; then
  export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
fi

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "== Сборка release APK"
  (cd "$APP" && ./gradlew --quiet test assembleRelease)
fi

[[ -f "$APK_SRC" ]] || { echo "ОШИБКА: не найден $APK_SRC" >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp "$APK_SRC" "$OUT_DIR/foodflow-pos.apk"

# Версию и minSdk читаем из самого apk, а не из build.gradle: публиковать надо
# то, что реально лежит в файле, иначе страница покажет версию, которой нет.
BT="$(ls -d "${ANDROID_HOME:-}"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
VERSION_NAME=""; VERSION_CODE=""; MIN_SDK=""
if [[ -n "$BT" && -x "$BT/aapt2" ]]; then
  BADGING="$("$BT/aapt2" dump badging "$OUT_DIR/foodflow-pos.apk" 2>/dev/null || true)"
  VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
  VERSION_CODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
  MIN_SDK="$(sed -n "s/^sdkVersion:'\([0-9]*\)'.*/\1/p" <<<"$BADGING" | head -1)"
else
  echo "ПРЕДУПРЕЖДЕНИЕ: aapt2 не найден, версия в метаданных будет пустой" >&2
fi

# Подпись: debug-ключ означает, что файл нельзя раздавать как релиз —
# обновление поверх такой установки не встанет после смены ключа.
SIGNER="неизвестно"
if [[ -n "$BT" && -x "$BT/apksigner" ]]; then
  SIGNER="$("$BT/apksigner" verify --print-certs "$OUT_DIR/foodflow-pos.apk" 2>/dev/null \
    | sed -n 's/.*certificate DN: //p' | head -1)"
  if grep -qi 'Android Debug' <<<"$SIGNER"; then
    echo "ВНИМАНИЕ: apk подписан debug-ключом ($SIGNER)." >&2
    echo "          Для раздачи задайте FF_KEYSTORE/FF_KEY_ALIAS в ~/.gradle/gradle.properties." >&2
  fi
fi

SHA="$(shasum -a 256 "$OUT_DIR/foodflow-pos.apk" | awk '{print $1}')"
SIZE="$(wc -c < "$OUT_DIR/foodflow-pos.apk" | tr -d ' ')"

cat > "$OUT_DIR/foodflow-pos.json" <<JSON
{
  "versionName": "${VERSION_NAME}",
  "versionCode": ${VERSION_CODE:-null},
  "minSdk": ${MIN_SDK:-null},
  "sha256": "${SHA}",
  "size": ${SIZE},
  "signer": "${SIGNER}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "== Опубликовано"
echo "   $OUT_DIR/foodflow-pos.apk  (${SIZE} байт, версия ${VERSION_NAME:-?})"
echo "   SHA-256: $SHA"
echo "   Страница скачивания: https://<поддомен>/admin-panel/pos-download.html"
