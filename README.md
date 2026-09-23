# SOSNOVKA RP

Официальный веб-портал проекта SOSNOVKA RP.

## GitHub Pages

Статическая версия сайта находится в `/docs`.

### Включение GitHub Pages

1. Создай репозиторий, например `sosnovka-rp`.
2. Загрузи содержимое этой папки в репозиторий.
3. Открой **Settings → Pages**.
4. В **Build and deployment** выбери **Deploy from a branch**.
5. Branch: `main`, Folder: `/docs`.
6. Сохрани настройки.

После публикации GitHub даст адрес вида:

`https://USERNAME.github.io/sosnovka-rp/`

## Backend

GitHub Pages не запускает Node.js, поэтому настоящий форум, авторизация, база данных, модерация и админ-панель находятся в `/backend` и должны размещаться отдельно на Node.js-хостинге.

Не загружай в публичный GitHub репозиторий:

- `.env`
- `*.sqlite`
- пользовательские загрузки
- секретные ключи
- пароли

## Структура

```text
SOSNOVKA-RP/
├── docs/                    # GitHub Pages
│   ├── index.html
│   ├── forum.js
│   ├── forum.css
│   ├── 403.html
│   ├── 404.html
│   ├── 500.html
│   └── .nojekyll
├── backend/                 # Node.js API
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── create-admin.js
├── .github/
│   └── workflows/
│       └── pages.yml
└── README.md
```
