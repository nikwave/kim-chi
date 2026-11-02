# Собеседник для амадин

Браузерное приложение: слушает Кима и Чи через микрофон iPad и отвечает нарезкой их собственных криков и песен.
Не генеративная модель и не переводчик.

## Структура
- `prep/` — подготовка на Mac (Python): `slice.py` нарезка, `cluster.py` группы, `review.py` страница проверки.
  Пороги — `prep/config.yaml`, категории из заметок — `prep/categories.yaml`.
- `app/` — статический сайт для iPad (публикуется на GitHub Pages целиком). Только одобренные клипы.
- `tests/` — тесты детектора, подбора клипов, лимитов, метрик и совпадения признаков JS↔Python.
- `docs/ipad-checklist.md` — проверка на iPad без птиц. `docs/veronika.md` — инструкция для сессий.
- `data/raw/`, `data/clips/` — исходная запись и все клипы, в git не попадают.

## Команды
```
uv venv -p 3.12 .venv && uv pip install -p .venv numpy scipy scikit-learn pyyaml matplotlib
.venv/bin/python prep/slice.py        # нарезка (≈1 мин)
.venv/bin/python prep/cluster.py      # группы и спектрограммы
.venv/bin/python prep/review.py       # проверка: http://localhost:8765 → «Сохранить одобренные»
npm test                              # все тесты
.venv/bin/python -m http.server 8770 --directory app   # приложение локально: http://localhost:8770
```
После правок в `app/js` или `app/css` увеличьте номер `?v=` во всех импортах и в `index.html` — иначе Safari покажет старую версию из кеша.

## Публикация
Сайт — ветка `gh-pages` (содержимое `app/`), GitHub Pages отдаёт её как есть.
Обновить сайт после изменений: закоммитить в `main`, затем
```
git push origin main
git push origin "$(git subtree split --prefix app main):refs/heads/gh-pages"
```
Через 1–2 минуты сайт обновится: https://nikwave.github.io/kim-chi/

Повторная нарезка (`slice.py`) пересоздаёт `data/clips/` — решения проверки привязаны к id клипов и потеряют смысл.
