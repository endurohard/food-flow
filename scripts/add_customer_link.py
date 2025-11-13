#!/usr/bin/env python3
"""
Скрипт для добавления ссылки на сайт заказов во все страницы админ панели
"""

import os
import re

ADMIN_DIR = "/Users/bagamedovyusup/work/food-flow/frontend/admin-panel"

# Список файлов для обновления
FILES = [
    "tables.html",
    "kds.html",
    "staff.html",
    "inventory.html",
    "menu.html",
    "loyalty.html",
    "analytics.html",
    "calls.html",
    "user-profile.html",
    "hall-designer.html",
]

# HTML для вставки
INSERT_HTML = '''            <div style="border-top: 1px solid #e1e8ed; margin: 12px 0;"></div>
            <a href="/customer-app/index.html" class="sidebar-item" target="_blank" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; margin: 8px; border-radius: 8px;">
                <span class="sidebar-icon">🌐</span>
                <span>Сайт заказов</span>
                <span style="margin-left: auto; font-size: 12px;">↗</span>
            </a>'''

def update_file(filepath):
    """Обновляет HTML файл, добавляя ссылку на сайт заказов"""

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Проверяем, нет ли уже ссылки
    if 'Сайт заказов' in content:
        return 'already_exists'

    # Паттерн для поиска места вставки
    # Ищем последний sidebar-item перед </div></div>
    pattern = r'(</a>\s*)(</div>\s*</div>)'

    # Находим все вхождения
    matches = list(re.finditer(pattern, content))

    if not matches:
        return 'pattern_not_found'

    # Берем последнее вхождение (должно быть после Настроек)
    last_match = matches[-1]

    # Проверяем, что перед этим есть "Настройки" в пределах 500 символов
    before_match = content[max(0, last_match.start() - 500):last_match.start()]
    if 'Настройки' not in before_match:
        return 'settings_not_found'

    # Вставляем HTML
    new_content = (
        content[:last_match.start()] +
        '</a>\n' +
        INSERT_HTML + '\n' +
        content[last_match.start() + len('</a>'):]
    )

    # Сохраняем файл
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)

    return 'updated'


def main():
    print("🚀 Добавление ссылки на сайт заказов в админ панель\n")

    updated = 0
    already_exists = 0
    errors = 0

    for filename in FILES:
        filepath = os.path.join(ADMIN_DIR, filename)

        if not os.path.exists(filepath):
            print(f"⚠️  {filename} - файл не найден")
            errors += 1
            continue

        result = update_file(filepath)

        if result == 'updated':
            print(f"✅ {filename} - успешно обновлен")
            updated += 1
        elif result == 'already_exists':
            print(f"ℹ️  {filename} - ссылка уже существует")
            already_exists += 1
        else:
            print(f"❌ {filename} - ошибка ({result})")
            errors += 1

    print(f"\n📊 Результаты:")
    print(f"   Обновлено: {updated}")
    print(f"   Уже существует: {already_exists}")
    print(f"   Ошибок: {errors}")
    print(f"\n✨ Готово!")


if __name__ == "__main__":
    main()
