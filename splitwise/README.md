# Splitwise Clone

A full-stack expense-splitting app: create groups, add expenses (four
different ways to split them), see who owes whom across every group, and
settle up — either the full suggested amount or a partial payment.

## Stack

- **Backend:** Node.js + Express (REST API)
- **Database:** SQLite via Node's built-in `node:sqlite` (a single file, no setup)
- **Frontend:** plain HTML + CSS + JavaScript (no build step, no framework)
- **Auth:** real password login (scrypt-hashed, cookie sessions) — no external
  dependency, built on Node's built-in `crypto`

## Requirements

- Node.js version 22.5 or newer (needed for the built-in SQLite).
  Check yours with: `node --version`

## Run it

```bash
npm install     # installs Express (the only dependency)
npm start       # starts the server
```

Then open your browser to: http://localhost:3000

The database file `backend/splitwise.db` is created automatically the first
time you run it, and your data persists across restarts. This repo tracks
that file directly (see "About the database file" below), so cloning it
gets you the real, current data rather than an empty database.

## Logging in

Every account logs in with a **User ID** (a 6-character code — not your
name) and a password. Login credentials for each person aren't stored in
this repo; if you don't have yours, ask whoever administers this instance,
or use **Sign up** to create a new account (you'll be shown a User ID once —
save it).

The `admin` account can access the **Admin Panel** (via the account menu in
the top bar) to log in as any account without needing its password, and to
reset anyone's password if they forget it.

## Features

- **Dashboard** — balance summary, your groups, recent expenses and activity
- **Groups** — create/edit groups (with an emoji logo), add members, a
  dedicated group page with its own expense list, balances, and settle-up
- **Expenses** — four split modes (equally, exact amounts, percentage,
  shares), editing, duplicating, and a read-only details view; a
  cross-group Expenses tab with search and filters
- **Balances / Friends** — net balance with every person you share a group
  with, aggregated across all groups, with a settle-up action right there
- **Settle up** — records a payment with an editable amount (partial
  payments are fine, not just "mark the full suggested amount paid")
- **Statistics** — spend over time and by group, with real charts
- **Activity feed** — a merged, newest-first log of every group, member,
  expense, and settlement, derived from the real records (no separate log
  to keep in sync)
- **Profile** — contact info, payment methods (UPI/Paytm/Google Pay),
  changeable name and password
- **Admin Panel** — list every account, log in as any of them, reset a
  forgotten password

## Project structure

```
splitwise/
├── package.json          # dependencies + start script
├── .gitignore
├── backend/
│   ├── server.js         # Express server + REST API routes (incl. auth)
│   ├── db.js              # database setup, schema, and migrations
│   ├── balances.js        # balance calculation + debt simplification
│   └── splitwise.db       # the SQLite database (tracked - see below)
└── public/                # the frontend (served by the backend)
    ├── index.html
    ├── style.css
    └── app.js
```

## How it works

1. The frontend (`public/`) makes HTTP requests to the backend API.
2. The backend (`backend/server.js`) handles those requests and reads/writes
   the SQLite database.
3. **Balances are never stored** - they're computed on demand from the
   expenses, splits, and settlements. This keeps the data always consistent.
4. **Identity** is a `profiles` row (name, User ID, hashed password). A
   `members` row is that same name's membership in one specific group —
   expenses and splits reference `members.id`, so renaming an account
   updates the display name everywhere without touching any financial data.

### The data model

- `groups` — a group of people sharing expenses
- `members` — people in a group
- `expenses` — who paid, how much, for what, and when
- `expense_splits` — one row per person sharing each expense (the key table)
- `settlements` — records of payments made to clear debt
- `profiles` — login credentials + optional contact info, one per name
- `sessions` — logged-in browser sessions, linked to `profiles` by id

### Splitting an expense

- **Equally** — divided evenly among the people you tick.
- **By exact amounts** — type exactly what each person owes. The amounts
  must add up to the total (a live hint shows how much is left to assign).
- **By percentage** — assign each person a percentage; they must total 100%.
- **By shares** — give each person a number of shares. Someone with 2 shares
  owes twice as much as someone with 1 share.

All four end up stored the same way: as per-person rows in the
`expense_splits` table. Only the way the amounts are *calculated* differs —
which mode was used isn't itself remembered, only the resulting split.

## About the database file

This repo is set up to **track `backend/splitwise.db` directly**, by
deliberate choice, so that everyone with access to this (private) repo is
working from the same real data — pull to get the latest, push after making
changes. Two things worth knowing:

- It's a binary file, so git can't diff or merge it — if two people change
  data and push around the same time, the second push will conflict and
  need manual resolution (usually: take one version, redo the other
  person's changes through the app).
- `text.md` (a plaintext list of every account's login credentials) is
  **deliberately excluded** via `.gitignore` and stays local-only — anyone
  with repo access could otherwise log in as anyone, including admin.

## Note

When it starts you may see a warning that SQLite is "experimental" — that's
normal and harmless. It just means Node's built-in SQLite is a newer
feature.
