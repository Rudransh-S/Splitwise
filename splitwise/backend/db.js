// db.js
// Sets up the SQLite database and creates all tables if they don't exist.
//
// We use node:sqlite, which is BUILT INTO Node.js (v22.5+). That means
// no extra install, no compiling - it just works. SQLite stores the whole
// database in a single file (splitwise.db) with no separate server.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");

// The database file lives next to this script. Created automatically
// if it doesn't exist.
const db = new DatabaseSync(path.join(__dirname, "splitwise.db"));

// Enforce foreign key relationships (off by default in SQLite).
db.exec("PRAGMA foreign_keys = ON;");

// --- Schema -----------------------------------------------------------
// "IF NOT EXISTS" means running this again won't wipe or duplicate data.

db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    emoji       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount      REAL NOT NULL,
    paid_by     INTEGER NOT NULL,
    date        TEXT NOT NULL DEFAULT (date('now')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (paid_by)  REFERENCES members(id) ON DELETE CASCADE
  );

  -- One row per person sharing an expense. This is the heart of the
  -- data model: it records exactly how much each person owes for each
  -- expense. Balances are computed from these rows, never stored directly.
  CREATE TABLE IF NOT EXISTS expense_splits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id  INTEGER NOT NULL,
    member_id   INTEGER NOT NULL,
    amount_owed REAL NOT NULL,
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id)  REFERENCES members(id) ON DELETE CASCADE
  );

  -- Records a payment from one member to another to clear debt.
  CREATE TABLE IF NOT EXISTS settlements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    INTEGER NOT NULL,
    paid_by     INTEGER NOT NULL,
    paid_to     INTEGER NOT NULL,
    amount      REAL NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (paid_by)  REFERENCES members(id) ON DELETE CASCADE,
    FOREIGN KEY (paid_to)  REFERENCES members(id) ON DELETE CASCADE
  );

  -- A profile is a name's optional contact info, bio and payment details.
  -- password_hash is set once that name signs up for real login - until
  -- then it's null and that name can still be picked via "Viewing as" the
  -- old way (no password needed), same as before auth existed.
  CREATE TABLE IF NOT EXISTS profiles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    user_id       TEXT UNIQUE,
    email         TEXT,
    phone         TEXT,
    location      TEXT,
    bio           TEXT,
    avatar_url    TEXT,
    upi_id        TEXT,
    paytm         TEXT,
    gpay          TEXT,
    password_hash TEXT,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per logged-in browser session. token is the opaque value
  -- stored in the sw_session cookie; looking it up is how a request knows
  -- who's logged in. Linked to profiles by id (not name) so a session
  -- keeps resolving to the right account even if its display name ever
  -- changes later.
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );
`);

// Older database files may predate the members.created_at column above
// (CREATE TABLE IF NOT EXISTS doesn't retrofit existing tables). Add it if
// missing so the activity feed has a timestamp to sort "member joined" by.
try {
  // SQLite's ALTER TABLE rejects any non-constant default (including
  // CURRENT_TIMESTAMP) on ADD COLUMN, so add it bare and backfill existing
  // rows with a plain UPDATE instead.
  db.exec("ALTER TABLE members ADD COLUMN created_at TEXT");
} catch (err) {
  // Column already exists - nothing to do.
}
// Runs every startup (not just once): the migrated column has no DB-level
// default, so any member inserted before server.js started setting
// created_at explicitly would otherwise stay NULL forever. Cheap no-op once
// everything is backfilled.
db.exec("UPDATE members SET created_at = datetime('now') WHERE created_at IS NULL");

// Older database files may predate the groups.emoji column - it's nullable
// (no backfill needed; a missing value just falls back to the
// name-derived emoji on the frontend).
try {
  db.exec("ALTER TABLE groups ADD COLUMN emoji TEXT");
} catch (err) {
  // Column already exists - nothing to do.
}

// Older database files may predate expenses.date - backfill it from the
// existing created_at timestamp so pre-existing expenses keep their place
// in date-sorted lists instead of all appearing "dateless".
try {
  db.exec("ALTER TABLE expenses ADD COLUMN date TEXT");
  db.exec("UPDATE expenses SET date = substr(created_at, 1, 10) WHERE date IS NULL");
} catch (err) {
  // Column already exists - nothing to do.
}

// Older database files may predate profiles.password_hash - nullable, no
// backfill (a null hash just means that name hasn't signed up for real
// login yet).
try {
  db.exec("ALTER TABLE profiles ADD COLUMN password_hash TEXT");
} catch (err) {
  // Column already exists - nothing to do.
}

// Older database files may predate profiles.is_admin. 0 is a constant, so
// (unlike the date-based defaults above) SQLite allows it directly here.
try {
  db.exec("ALTER TABLE profiles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
} catch (err) {
  // Column already exists - nothing to do.
}

// Older database files may predate sessions.profile_id - it used to store
// the session's name directly. Backfill by joining that name to the
// matching profile; any row that can't resolve (name was renamed/removed)
// just expires away on its own since sessions are short-lived anyway.
try {
  db.exec("ALTER TABLE sessions ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE");
  db.exec(`
    UPDATE sessions SET profile_id = (SELECT id FROM profiles WHERE profiles.name = sessions.name)
    WHERE profile_id IS NULL
  `);
} catch (err) {
  // Column already exists - nothing to do.
}
// Separate try/catch (idempotent, runs every startup): the old name column
// was NOT NULL, and new session inserts no longer supply it, so it has to
// actually go rather than just go unused.
try {
  db.exec("ALTER TABLE sessions DROP COLUMN name");
} catch (err) {
  // Already dropped (or never existed on a fresh install) - nothing to do.
}

// Older database files may predate profiles.user_id - login used to be by
// name. Nullable and backfilled by server.js the first time each such
// profile is touched (see ensureUserId in server.js), not here, since
// generating it needs the collision-checking helper that lives there.
// SQLite's ALTER TABLE ADD COLUMN doesn't support UNIQUE constraints at
// all (only CREATE TABLE does) - so the column and the uniqueness are two
// separate statements here, unlike the inline "user_id TEXT UNIQUE" above
// which is what fresh installs get straight from CREATE TABLE.
try {
  db.exec("ALTER TABLE profiles ADD COLUMN user_id TEXT");
} catch (err) {
  // Column already exists - nothing to do.
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_id ON profiles(user_id)");

module.exports = db;
