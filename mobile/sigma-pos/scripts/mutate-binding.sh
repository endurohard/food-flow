#!/usr/bin/env bash
# Мутационная проверка разбора кода привязки: тест считается написанным,
# когда он ловит намеренную поломку. Запуск из mobile/sigma-pos.
set -euo pipefail

B=app/src/main/java/ru/foodflow/pos/data/Binding.kt
BAK=$(mktemp)
cp "$B" "$BAK"
trap 'cp "$BAK" "$B"; rm -f "$BAK"' EXIT

run() {
  rm -rf app/build/test-results/testDebugUnitTest
  # Код возврата важен: несобравшаяся мутация даёт нулевой отчёт, который
  # выглядит как «тест не поймал», хотя проверять было нечего.
  if ! ./gradlew --rerun-tasks testDebugUnitTest >/tmp/mut.log 2>&1; then
    if grep -q 'Compilation error' /tmp/mut.log; then
      echo "НЕ СКОМПИЛИРОВАЛОСЬ (мутация ничего не проверяет)"
      return
    fi
  fi
  python3 - <<'PY'
import glob, re, sys
tot = fail = 0
for p in glob.glob('app/build/test-results/testDebugUnitTest/*.xml'):
    s = open(p, encoding='utf-8').read()
    m = re.search(r'tests="(\d+)".*?failures="(\d+)"', s)
    if m:
        tot += int(m.group(1)); fail += int(m.group(2))
print(f"tests={tot} failures={fail}")
PY
}

mutate() {
  python3 - "$1" <<'PY'
import sys
p = 'app/src/main/java/ru/foodflow/pos/data/Binding.kt'
s = open(p, encoding='utf-8').read()
m = sys.argv[1]
if m == 'at':
    n = s.replace("if (authority.contains('@')) return null", "")
elif m == 'label':
    n = s.replace('Regex("^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$")', 'Regex(".*")')
elif m == 'path':
    n = s.replace("rest.substringBefore('/')", "rest")
elif m == 'api-ignored':
    # адрес из QR подменяется собранным из метки — касса уедет на чужой сервер.
    # Условие не трогаем: `if (false)` ломает smart-cast и мутация не компилируется,
    # а некомпилируемая мутация ничего не проверяет.
    n = s.replace(
        'val fromUrl = parseUrl(if (api.startsWith("http")) api else "https://$api") ?: return null',
        'val fromUrl = parse(sub, defaultDomain) ?: return null')
else:
    raise SystemExit('unknown mutation ' + m)
assert n != s, 'мутация не применилась: ' + m
open(p, 'w', encoding='utf-8').write(n)
PY
}

echo "baseline: $(run)"
for m in at label path api-ignored; do
  cp "$BAK" "$B"
  mutate "$m"
  echo "mutation $m: $(run)"
done
