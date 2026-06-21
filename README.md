# FinTrack — Personal Finance Tracker

A lightweight, mobile-friendly personal finance tracker built with vanilla HTML/CSS/JavaScript and Supabase for cloud sync across devices.

**Live app:** https://personal-tracker-nk.vercel.app

---

## Features

- **Income & Expense tracking** — add, edit, delete transactions with categories
- **Budget management** — set monthly and category-level budgets with progress tracking
- **Analytics** — charts for spending trends, category breakdown, monthly comparison
- **Reports** — monthly summaries and category reports
- **Multi-device sync** — all data stored in Supabase, accessible from any device
- **Multi-user** — each user's data is fully isolated via Row Level Security
- **Username-only login** — no email or password required from the user
- **Mobile responsive** — optimised for iPhone and Android with a bottom navigation bar
- **Export** — download data as CSV, Excel, or PDF; import/export JSON backups

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, Vanilla JavaScript (ES6+) |
| Charts | Chart.js 4.4 (CDN) |
| Excel export | SheetJS / XLSX (CDN) |
| PDF export | jsPDF + autotable (CDN) |
| Backend / Auth | Supabase (Postgres + Auth + RLS) |
| Hosting | Vercel (static) |

No build step, no bundler, no framework — just files.

---

## Project Structure

```
personal-tracker/
├── index.html            # Single-page app shell + all HTML
├── app.js                # All application logic (~1600 lines)
├── styles.css            # All styles including mobile responsive
├── config.js             # Supabase credentials (not committed — see below)
├── config.example.js     # Template for config.js
├── supabase-schema.sql   # Run once in Supabase SQL Editor to set up the DB
└── .claude/commands/
    └── ship.md           # /ship skill: commit + push + deploy
```

---

## Local Setup

### 1. Clone the repo

```bash
git clone https://github.com/naveenxy14/personal-tracker.git
cd personal-tracker
```

### 2. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the SQL Editor, run the entire contents of `supabase-schema.sql`
3. In **Auth → Settings**, disable email confirmation (or set "Confirm email" to off)

### 3. Configure credentials

Copy the example config and fill in your values:

```bash
cp config.example.js config.js
```

Edit `config.js`:

```js
window.FINTRACK_CONFIG = {
    supabaseUrl:     'https://YOUR_PROJECT_ID.supabase.co',
    supabaseAnonKey: 'YOUR_ANON_KEY'
};
```

Find both values in your Supabase dashboard under **Project Settings → API**.

### 4. Open in browser

Open `index.html` directly in your browser — no server needed.

---

## Deploying to Vercel

```bash
nvm use 20
vercel --prod --yes
```

Make sure `config.js` is committed (it is, by design — the anon key is safe to expose) and that `config.js` is **not** in `.gitignore`.

---

## Database Schema

Tables: `profiles`, `incomes`, `expenses`, `budgets`

All tables have Row Level Security enabled. Each user can only read and write their own rows (`auth.uid() = user_id`).

Run `supabase-schema.sql` once in the Supabase SQL Editor to create everything.

---

## How Authentication Works

Users sign in with a **username only** — no email, no password visible to the user. Internally the app derives a synthetic email (`username@fintrack.app`) and a deterministic password and uses Supabase's `signInWithPassword` / `signUp`. This keeps the UX simple while using standard Supabase Auth.

---

## First Login

On first login the app auto-generates 6 months of sample data so the dashboard isn't empty. Go to **Settings → Danger Zone → Clear All Data** to remove it before entering your real transactions.
