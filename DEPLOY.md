# The Clarity Console — Deployment Guide (Render)

This is a real Node.js + PostgreSQL web app. Buyers log in with an email and
password you control, and their numbers are saved to a real database, tied
to their account.

## What's in this folder

- `server.js` — the backend (login, signup, sessions, save/load data)
- `public/index.html` — the entire frontend (login screen + all 8 tools)
- `schema.sql` — run this once to set up your database tables
- `package.json` — the list of code libraries the app needs

## Step 1 — Create the database on Render

1. Log into Render → **New** → **PostgreSQL**
2. Give it any name (e.g. `clarity-console-db`) → choose the **Free** plan → **Create Database**
3. Once it's ready, open it and find **Internal Database URL** (or **External
   Database URL** if connecting from outside Render). Copy this — you'll need
   it in Step 3. It looks like:
   `postgres://user:password@host/dbname`

## Step 2 — Set up the tables

1. On the database page, find the **Connect** section and open **PSQL
   Command** (or use any Postgres client you're comfortable with, like
   TablePlus or pgAdmin, with the connection details Render gives you).
2. Paste in the entire contents of `schema.sql` and run it.
3. You should now have 3 tables: `users`, `user_data`, and `session`.

## Step 3 — Deploy the web app

1. Put these files in a GitHub repository (create a new repo, upload
   `server.js`, `public/index.html`, `schema.sql`, `package.json`,
   `package-lock.json` if present, and `.gitignore`).
2. On Render → **New** → **Web Service** → connect that GitHub repo.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment Variables**, add:
   - `DATABASE_URL` → paste the Internal Database URL from Step 1
   - `SESSION_SECRET` → any long, random string (e.g. mash your keyboard for
     40+ characters — this is used to secure login sessions, keep it private)
   - `NODE_ENV` → `production`
5. Click **Create Web Service**. Render will install everything and start
   the app. This usually takes 2–5 minutes the first time.
6. Once it's live, Render gives you a URL like
   `https://clarity-console.onrender.com` — that's what you give to buyers.

## Step 4 — Test it yourself first

1. Visit your new URL.
2. Click **Create Account**, sign up with a test email and password.
3. Enter some numbers into the Cash Truth Check tool.
4. Refresh the page or close the tab and reopen — you should still be logged
   in and your numbers should still be there.
5. Click **Log out**, then log back in with the same email/password to
   confirm your data is still saved.

## Notes on the free tier

- Render's free web services "spin down" after periods of no traffic, so the
  very first visit after a quiet period may take 30-60 seconds to wake back
  up. This is normal on the free tier — upgrading to a paid plan removes
  this delay if it becomes an issue for buyers.
- Render's free PostgreSQL database is deleted after 90 days of inactivity
  unless you upgrade. Keep an eye on this if you're not getting steady
  traffic yet.

## If something breaks

Render shows live logs under your web service's **Logs** tab. If a buyer
reports an error, check there first — most issues will show a clear error
message you can paste back for help fixing.
