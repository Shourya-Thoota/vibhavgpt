# 🌟 VibhavGPT

VibhavGPT is a private AI workspace for chat, image creation and study, with memory you control. 🔒 No training on your chats, no data sales, no ads.

🌐 Live at [vibhavgpt.com](https://vibhavgpt.com)

💻 GitHub: [Shourya-Thoota/vibhavgpt](https://github.com/Shourya-Thoota/vibhavgpt)

## ✨ Features

* 💬 **Chat**: fast streaming conversations with saved history
* 🧠 **Memory you control**: it remembers useful facts, sorted into categories, and you can view, edit, import or delete them
* 🔎 **Web search**: answers with current information and sources
* 🎨 **Image creation**: generate images and work with images you upload
* 📚 **Study mode**: guided study sessions that teach step by step
* 🎙️ **Voice**: talk to it live
* 📄 **Documents**: generate documents and export them to Google Docs
* 📎 **Uploads**: attach files and images to a chat
* 💳 **Plans and usage**: free, Plus and Pro tiers with clear usage limits, billed through Stripe
* 🛡️ **Safety**: moderation, bot protection and display-name filtering
* 🔐 **Accounts**: email and Google sign-in, passkeys, and full account deletion
* 🖥️📱 **Apps**: Windows installer and Android APK, linked from the download pages

## 🤝 The VibhavGPT guarantee

* 🚫 **No training on your chats.** Your conversations are never used to train models.
* 💸 **No data sales.** We never sell your data.
* 📵 **No ads.**
* 🧠 **Memory you control.** You can see, edit and delete what it remembers.
* 🗑️ **You can leave.** You can delete your account and its data from the app.
* 🔍 **Check it yourself.** The [code is open source](https://github.com/Shourya-Thoota/vibhavgpt) under AGPL-3.0, so you can read how your data is handled.

## 🗂️ What's in this repo

* `src/`: the API (accounts, chat, memory, billing, usage, search)
* `frontend/`: the web app
* `drizzle/`: database migrations
* `test/`: automated tests

## 🚀 Run it locally

You need Node.js and a PostgreSQL database.

1. Copy the example settings and fill in your own values. Every value in `.env.example` is a placeholder.

```
cp .env.example .env
```

At minimum set `DATABASE_URL`, a `BETTER_AUTH_SECRET` of 32 or more characters, `BETTER_AUTH_URL` and `CLIENT_ORIGINS`. Chat, search, images and voice also need the inference, search and model settings described in `.env.example`.

2. Start the API on port 3001:

```
npm install
npm run db:migrate:programmatic
npm run dev
```

3. Start the web app on port 5173. In development it sends `/api` requests to the local API. Optional `VITE_` settings go in `frontend/.env`.

```
npm install --prefix frontend
npm run dev --prefix frontend
```

4. Run the tests and the production build:

```
npm test
npm run build --prefix frontend
```

📥 The Windows and Android downloads live on the vibhavgpt.com download pages.

## 📜 License

Copyright (C) 2026 Pansophy LLC

VibhavGPT is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See [LICENSE](LICENSE) for the full text. The source code is published at [github.com/Shourya-Thoota/vibhavgpt](https://github.com/Shourya-Thoota/vibhavgpt).

VibhavGPT and Pansophy are trademarks of Pansophy LLC. The names and logos are not covered by the license, so you may not use them to name or promote a modified version.
