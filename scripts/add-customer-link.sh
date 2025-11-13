#!/bin/bash

# Скрипт для добавления ссылки на сайт заказов во все страницы админ панели

ADMIN_DIR="/Users/bagamedovyusup/work/food-flow/frontend/admin-panel"

# Список страниц для обновления (исключаем уже обновленные)
FILES=(
  "tables.html"
  "kds.html"
  "staff.html"
  "inventory.html"
  "menu.html"
  "loyalty.html"
  "analytics.html"
  "settings.html"
  "calls.html"
  "user-profile.html"
  "hall-designer.html"
)

# Текст для вставки
INSERT_TEXT='      <div style="border-top: 1px solid #e1e8ed; margin: 12px 0;"></div>
      <a href="/customer-app/index.html" class="sidebar-item" target="_blank" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: 8px; border-radius: 8px;">
        <span class="sidebar-icon">🌐</span>
        <span>Сайт заказов</span>
        <span style="margin-left: auto; font-size: 12px;">↗</span>
      </a>'

echo "🚀 Добавление ссылки на сайт заказов..."
echo ""

for file in "${FILES[@]}"; do
  filepath="$ADMIN_DIR/$file"

  if [ ! -f "$filepath" ]; then
    echo "⚠️  Файл не найден: $file"
    continue
  fi

  # Проверяем, не добавлена ли уже ссылка
  if grep -q "Сайт заказов" "$filepath"; then
    echo "✓  $file - уже содержит ссылку"
    continue
  fi

  # Проверяем наличие паттерна для вставки
  if grep -q 'href="settings.html" class="sidebar-item"' "$filepath"; then
    echo "📝 Обновление: $file"

    # Создаем временный файл
    tmp_file=$(mktemp)

    # Вставляем текст после закрывающего тега </a> для settings.html
    awk -v insert="$INSERT_TEXT" '
      /<\/a>/ {
        print
        if (prev_line ~ /Настройки/) {
          in_settings_close = 1
        }
        if (in_settings_close && $0 ~ /<\/a>/) {
          print insert
          in_settings_close = 0
        }
        next
      }
      {
        prev_line = $0
        print
      }
    ' "$filepath" > "$tmp_file"

    # Проверяем, что файл был изменен
    if diff -q "$filepath" "$tmp_file" > /dev/null; then
      echo "   ⚠️  Не удалось обновить (паттерн не найден)"
      rm "$tmp_file"
    else
      mv "$tmp_file" "$filepath"
      echo "   ✅ Успешно обновлен"
    fi
  else
    echo "⚠️  $file - не найден паттерн для вставки"
  fi

  echo ""
done

echo "✨ Готово!"
