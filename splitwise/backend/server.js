// server.js
// The web server. It does two jobs:
//   1. Serves the frontend files (HTML/CSS/JS) from the /public folder.
//   2. Exposes a REST API that the frontend calls to read/write data.
//
// A REST API is just a set of URLs the frontend can request. Each URL +
// HTTP method (GET/POST/DELETE) maps to an action on the database.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { computeBalances, simplifyDebts } = require("./balances");

const app = express();
const PORT = 3000;
const SESSION_COOKIE = "sw_session";
const SESSION_DAYS = 30;

// Middleware: lets the server read JSON sent in request bodies.
app.use(express.json());
// Serve everything in /public as static files (index.html, app.js, etc).
app.use(express.static(path.join(__dirname, "..", "public")));

// node:sqlite returns INTEGER ids as BigInt. This helper converts them
// to normal numbers so they serialize cleanly to JSON.
function num(v) {
  return typeof v === "bigint" ? Number(v) : v;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ====================================================================
//  AUTH HELPERS (password hashing + cookie sessions, no extra deps -
//  crypto is built into Node, same spirit as using node:sqlite in db.js)
// ====================================================================

// The login credential: 6 alphanumeric characters (well past the "at least
// 5" bar), drawn from a set with the visually-confusable characters (0/O,
// 1/I) removed so people can actually read theirs back correctly.
const USER_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateUserId() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = crypto.randomBytes(6);
    let id = "";
    for (let i = 0; i < 6; i++) id += USER_ID_CHARS[bytes[i] % USER_ID_CHARS.length];
    if (!db.prepare("SELECT 1 FROM profiles WHERE user_id = ?").get(id)) return id;
  }
  throw new Error("could not generate a unique user id");
}

// Accounts created before user_id existed (or bulk-seeded ones) may not
// have one yet - generate and persist one the first time it's needed.
function ensureUserId(profileId) {
  const row = db.prepare("SELECT user_id FROM profiles WHERE id = ?").get(profileId);
  if (row.user_id) return row.user_id;
  const userId = generateUserId();
  db.prepare("UPDATE profiles SET user_id = ? WHERE id = ?").run(userId, profileId);
  return userId;
}

// Used for admin-generated one-off passwords (bulk account creation,
// forgot-password resets) - a random 12-character string.
function generatePassword() {
  return crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "").slice(0, 12);
}

// scrypt is a built-in, deliberately-slow KDF - a good default for
// password hashing without pulling in bcrypt. Stored as "salt:hash" hex.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  // Lengths must match before timingSafeEqual will even compare - a
  // corrupt/foreign stored hash just fails closed here.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// Sessions link to profiles by id, not name - takes the profile's numeric
// id (never a name string), so a session keeps resolving to the right
// account regardless of what its display name is at lookup time.
function createSession(profileId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, ?)").run(token, profileId, expiresAt);
  return token;
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 86400;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Reads the session cookie, resolves it to a profile_id, then looks that
// profile up fresh - so the id is the only thing actually trusted from the
// cookie/session row itself; name and is_admin always come from the
// current row in `profiles`.
function currentSessionProfile(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!session || new Date(session.expires_at) < new Date()) return null;
  return db.prepare("SELECT * FROM profiles WHERE id = ?").get(session.profile_id) || null;
}

function currentSessionName(req) {
  return currentSessionProfile(req)?.name || null;
}

// --- Helper: load everything needed to compute a group's state --------
function loadGroupData(groupId) {
  const members = db
    .prepare("SELECT * FROM members WHERE group_id = ?")
    .all(groupId);
  const expenses = db
    .prepare("SELECT * FROM expenses WHERE group_id = ? ORDER BY date DESC, id DESC")
    .all(groupId);
  const expenseSplits = db
    .prepare(
      `SELECT es.* FROM expense_splits es
       JOIN expenses e ON e.id = es.expense_id
       WHERE e.group_id = ?`
    )
    .all(groupId);
  const settlements = db
    .prepare("SELECT * FROM settlements WHERE group_id = ?")
    .all(groupId);
  return { members, expenses, expenseSplits, settlements };
}

// ====================================================================
//  GROUPS
// ====================================================================

// Create a group. Body: { name }
app.post("/api/groups", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const info = db.prepare("INSERT INTO groups (name) VALUES (?)").run(name);
  res.json({ id: num(info.lastInsertRowid), name });
});

// List all groups.
app.get("/api/groups", (req, res) => {
  const groups = db.prepare("SELECT * FROM groups ORDER BY id DESC").all();
  res.json(groups);
});

// Update a group's name and/or logo emoji. Body: { name?, emoji? }
app.patch("/api/groups/:groupId", (req, res) => {
  const groupId = Number(req.params.groupId);
  const group = db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId);
  if (!group) return res.status(404).json({ error: "group not found" });

  const name = req.body.name !== undefined ? String(req.body.name).trim() : group.name;
  const emoji = req.body.emoji !== undefined ? req.body.emoji : group.emoji;
  if (!name) return res.status(400).json({ error: "name is required" });

  db.prepare("UPDATE groups SET name = ?, emoji = ? WHERE id = ?").run(name, emoji, groupId);
  res.json({ id: groupId, name, emoji });
});

// Delete a group and everything in it. Foreign keys are ON DELETE CASCADE
// (members, expenses, expense_splits, settlements all chain off group_id or
// off rows that do), so this one statement cleans up the whole group.
app.delete("/api/groups/:groupId", (req, res) => {
  db.prepare("DELETE FROM groups WHERE id = ?").run(Number(req.params.groupId));
  res.json({ ok: true });
});

// ====================================================================
//  MEMBERS
// ====================================================================

// Add a member to a group. Body: { name }
app.post("/api/groups/:groupId/members", (req, res) => {
  const groupId = Number(req.params.groupId);
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  // Set created_at explicitly rather than relying on the column default:
  // databases migrated by the ALTER TABLE in db.js got the column added
  // without one (SQLite disallows a non-constant ALTER TABLE default).
  const info = db
    .prepare("INSERT INTO members (group_id, name, created_at) VALUES (?, ?, datetime('now'))")
    .run(groupId, name);
  res.json({ id: num(info.lastInsertRowid), group_id: groupId, name });
});

// ====================================================================
//  EXPENSES
// ====================================================================

// Given the split mode and the raw input, work out exactly how much each
// person owes. Returns { splits: [{memberId, amountOwed}], error }.
//
// Four modes are supported:
//   "equal"   -> splitAmong: [memberId, ...]           divide amount evenly
//   "exact"   -> splits: [{memberId, amount}, ...]      use amounts as-is
//   "percent" -> splits: [{memberId, percent}, ...]     divide by percentage
//   "shares"  -> splits: [{memberId, shares}, ...]      divide by share weight
function buildSplits(mode, amount, body) {
  if (mode === "exact") {
    const rows = body.splits;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: "exact split needs a splits array" };
    }
    let total = 0;
    const splits = rows.map((r) => {
      total += Number(r.amount);
      return { memberId: Number(r.memberId), amountOwed: Number(r.amount) };
    });
    // The exact amounts must add up to the expense total (allow 1 paisa of
    // rounding slack).
    if (Math.abs(total - amount) > 0.01) {
      return { error: `exact amounts add up to ${total.toFixed(2)}, but the expense is ${amount.toFixed(2)}` };
    }
    return { splits };
  }

  if (mode === "percent") {
    const rows = body.splits;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: "percent split needs a splits array" };
    }
    const totalPct = rows.reduce((sum, r) => sum + Number(r.percent), 0);
    // Percentages must add up to 100 (allow tiny rounding slack).
    if (Math.abs(totalPct - 100) > 0.01) {
      return { error: `percentages add up to ${totalPct}%, but must total 100%` };
    }
    const splits = rows.map((r) => ({
      memberId: Number(r.memberId),
      amountOwed: Math.round((amount * Number(r.percent)) / 100 * 100) / 100,
    }));
    return { splits };
  }

  if (mode === "shares") {
    const rows = body.splits;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { error: "shares split needs a splits array" };
    }
    const totalShares = rows.reduce((sum, r) => sum + Number(r.shares), 0);
    if (totalShares <= 0) {
      return { error: "total shares must be greater than zero" };
    }
    // Each person owes (their shares / total shares) of the amount.
    const splits = rows.map((r) => ({
      memberId: Number(r.memberId),
      amountOwed: Math.round((amount * Number(r.shares)) / totalShares * 100) / 100,
    }));
    return { splits };
  }

  // Default: equal split.
  const ids = body.splitAmong;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: "equal split needs a splitAmong array" };
  }
  const share = Math.round((amount / ids.length) * 100) / 100;
  const splits = ids.map((memberId) => ({ memberId: Number(memberId), amountOwed: share }));
  return { splits };
}

// Add an expense. Body:
//   { description, amount, paidBy, splitType, date, ...split input }
// splitType is "equal" (default), "exact", or "shares". See buildSplits above
// for the shape of the split input each mode expects. date defaults to today
// (YYYY-MM-DD) when omitted.
app.post("/api/groups/:groupId/expenses", (req, res) => {
  const groupId = Number(req.params.groupId);
  const { description, amount, paidBy, splitType = "equal" } = req.body;
  const date = req.body.date || new Date().toISOString().slice(0, 10);

  if (!description || !amount || !paidBy) {
    return res.status(400).json({ error: "description, amount and paidBy are required" });
  }

  // Turn the split input into concrete per-person amounts.
  const { splits, error } = buildSplits(splitType, Number(amount), req.body);
  if (error) return res.status(400).json({ error });

  const insertExpense = db.prepare(
    "INSERT INTO expenses (group_id, description, amount, paid_by, date) VALUES (?, ?, ?, ?, ?)"
  );
  const insertSplit = db.prepare(
    "INSERT INTO expense_splits (expense_id, member_id, amount_owed) VALUES (?, ?, ?)"
  );

  // A transaction ensures the expense and its splits are saved together
  // (all-or-nothing). If any part fails, nothing is written.
  db.exec("BEGIN");
  try {
    const info = insertExpense.run(groupId, description, amount, paidBy, date);
    const expenseId = num(info.lastInsertRowid);
    splits.forEach((s) => {
      insertSplit.run(expenseId, s.memberId, s.amountOwed);
    });
    db.exec("COMMIT");
    res.json({ id: expenseId, description, amount, paid_by: paidBy, date });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: "failed to save expense" });
  }
});

// Fetch one expense with its per-member split amounts - used to prefill the
// edit modal (amount_owed is the only place the actual split breakdown
// lives; splitType itself is never stored, only its computed result).
app.get("/api/expenses/:expenseId", (req, res) => {
  const expenseId = Number(req.params.expenseId);
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(expenseId);
  if (!expense) return res.status(404).json({ error: "expense not found" });

  const group = db.prepare("SELECT name FROM groups WHERE id = ?").get(expense.group_id);
  const payer = db.prepare("SELECT name FROM members WHERE id = ?").get(expense.paid_by);
  const splits = db.prepare(`
    SELECT es.member_id, es.amount_owed, m.name AS member_name
    FROM expense_splits es JOIN members m ON m.id = es.member_id
    WHERE es.expense_id = ?
  `).all(expenseId);

  res.json({ ...expense, groupName: group?.name, payerName: payer?.name, splits });
});

// Edit an expense in place. Body: same shape as create (description, amount,
// paidBy, splitType, date, ...split input). Splits are fully replaced rather
// than diffed - simplest correct approach given how few rows are involved.
app.patch("/api/expenses/:expenseId", (req, res) => {
  const expenseId = Number(req.params.expenseId);
  const existing = db.prepare("SELECT * FROM expenses WHERE id = ?").get(expenseId);
  if (!existing) return res.status(404).json({ error: "expense not found" });

  const { description, amount, paidBy, splitType = "equal" } = req.body;
  const date = req.body.date || existing.date;
  if (!description || !amount || !paidBy) {
    return res.status(400).json({ error: "description, amount and paidBy are required" });
  }

  const { splits, error } = buildSplits(splitType, Number(amount), req.body);
  if (error) return res.status(400).json({ error });

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE expenses SET description = ?, amount = ?, paid_by = ?, date = ? WHERE id = ?")
      .run(description, amount, paidBy, date, expenseId);
    db.prepare("DELETE FROM expense_splits WHERE expense_id = ?").run(expenseId);
    const insertSplit = db.prepare(
      "INSERT INTO expense_splits (expense_id, member_id, amount_owed) VALUES (?, ?, ?)"
    );
    splits.forEach((s) => insertSplit.run(expenseId, s.memberId, s.amountOwed));
    db.exec("COMMIT");
    res.json({ id: expenseId, description, amount, paid_by: paidBy, date });
  } catch (err) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: "failed to update expense" });
  }
});

// Delete an expense (its splits are removed automatically via CASCADE).
app.delete("/api/expenses/:expenseId", (req, res) => {
  db.prepare("DELETE FROM expenses WHERE id = ?").run(Number(req.params.expenseId));
  res.json({ ok: true });
});

// ====================================================================
//  SETTLEMENTS
// ====================================================================

// Record a payment. Body: { paidBy, paidTo, amount }
app.post("/api/groups/:groupId/settlements", (req, res) => {
  const groupId = Number(req.params.groupId);
  const { paidBy, paidTo, amount } = req.body;
  if (!paidBy || !paidTo || !amount) {
    return res.status(400).json({ error: "paidBy, paidTo and amount are required" });
  }
  const info = db
    .prepare(
      "INSERT INTO settlements (group_id, paid_by, paid_to, amount) VALUES (?, ?, ?, ?)"
    )
    .run(groupId, paidBy, paidTo, amount);
  res.json({ id: num(info.lastInsertRowid) });
});

// Which group(s) two names are both members of, with each one's member id
// in that group. Needed to record a settlement from a cross-group view
// (Balances/Friends) where the pair isn't tied to one specific group the
// way it is on a group's own page - settlements still need a group_id and
// real member ids to attach to. Recording it under any shared group is
// equally correct: the balance shown everywhere is a pairwise ledger
// summed across all groups, not scoped to one.
app.get("/api/settle-options", (req, res) => {
  const profile = currentSessionProfile(req);
  if (!profile) return res.status(401).json({ error: "log in first" });
  const a = (req.query.a || "").trim();
  const b = (req.query.b || "").trim();
  if (!profile.is_admin && profile.name !== a && profile.name !== b) {
    return res.status(403).json({ error: "you can only access your own account" });
  }

  const groups = db.prepare("SELECT * FROM groups").all();
  const options = [];
  for (const g of groups) {
    const members = db.prepare("SELECT * FROM members WHERE group_id = ?").all(g.id);
    const memberA = members.find((m) => m.name === a);
    const memberB = members.find((m) => m.name === b);
    if (memberA && memberB) {
      options.push({ groupId: g.id, groupName: g.name, memberIdA: memberA.id, memberIdB: memberB.id });
    }
  }
  res.json(options);
});

// ====================================================================
//  GROUP STATE (members + expenses + balances + settle-up plan)
// ====================================================================

// The frontend calls this to render everything about a group at once.
app.get("/api/groups/:groupId/state", (req, res) => {
  const groupId = Number(req.params.groupId);
  const { members, expenses, expenseSplits, settlements } = loadGroupData(groupId);

  // Attach the list of split member-ids onto each expense for display.
  const splitsByExpense = {};
  expenseSplits.forEach((s) => {
    (splitsByExpense[s.expense_id] ||= []).push(s.member_id);
  });
  const expensesOut = expenses.map((e) => ({
    ...e,
    splitAmong: splitsByExpense[e.id] || [],
  }));

  const balance = computeBalances(members, expenseSplits, expenses, settlements);
  const settleUp = simplifyDebts(balance);

  res.json({
    members,
    expenses: expensesOut,
    balances: balance,
    settleUp,
  });
});

// ====================================================================
//  DASHBOARD (cross-group summary for one person)
// ====================================================================

// The dashboard needs a notion of "you" to show "you are owed" vs "you owe".
// Since there's no login, the frontend passes ?name=... to say who is viewing.
// We match that person by name within each group and total up their position.
//
// Returns:
//   { youAreOwed, youOwe, totalBalance, totalExpensesThisMonth,
//     groups: [{ id, name, memberCount, yourBalance }],
//     recentExpenses: [...], recentActivity: [...] }
app.get("/api/dashboard", (req, res) => {
  const viewerName = requireSelfOrAdmin(req, res, (req.query.name || "").trim());
  if (!viewerName) return;
  const groups = db.prepare("SELECT * FROM groups ORDER BY id DESC").all();

  let youAreOwed = 0;
  let youOwe = 0;
  const groupsOut = [];
  const allExpenses = [];

  const monthPrefix = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  let totalExpensesThisMonth = 0;

  for (const g of groups) {
    const { members, expenses, expenseSplits, settlements } = loadGroupData(g.id);
    const balance = computeBalances(members, expenseSplits, expenses, settlements);

    // Find the viewer within this group by name (if present).
    const me = members.find((m) => m.name === viewerName);
    const yourBalance = me ? Math.round((balance[me.id] || 0) * 100) / 100 : 0;
    if (yourBalance > 0) youAreOwed += yourBalance;
    else if (yourBalance < 0) youOwe += -yourBalance;

    groupsOut.push({
      id: g.id,
      name: g.name,
      emoji: g.emoji,
      memberCount: members.length,
      memberNames: members.map((m) => m.name),
      yourBalance,
      inGroup: !!me,
    });

    // Collect expenses for the recent feed, tagged with group + payer name.
    const nameById = {};
    members.forEach((m) => (nameById[m.id] = m.name));
    expenses.forEach((e) => {
      // Only count spend in groups the viewer actually belongs to - not
      // every expense in every group in the whole app.
      if (me && (e.date || "").startsWith(monthPrefix)) {
        totalExpensesThisMonth += e.amount;
      }
      allExpenses.push({
        id: e.id,
        description: e.description,
        amount: e.amount,
        groupName: g.name,
        paidByName: nameById[e.paid_by] || "?",
        splitCount: expenseSplits.filter((s) => s.expense_id === e.id).length,
        date: e.date,
        created_at: e.created_at,
      });
    });
  }

  // Most recent expenses across all groups, by expense date (falling back to
  // id order for same-day entries so newly-added ones surface first).
  allExpenses.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);

  res.json({
    youAreOwed: Math.round(youAreOwed * 100) / 100,
    youOwe: Math.round(youOwe * 100) / 100,
    totalBalance: Math.round((youAreOwed - youOwe) * 100) / 100,
    totalExpensesThisMonth: Math.round(totalExpensesThisMonth * 100) / 100,
    groups: groupsOut,
    recentExpenses: allExpenses.slice(0, 8),
  });
});

// ====================================================================
//  ACTIVITY (who did what, when - across every group)
// ====================================================================

// A single merged, newest-first feed built from four kinds of rows that
// already carry a created_at: groups, members, expenses and settlements.
// There's no separate "activity log" table - the feed is derived from the
// real records instead, so it can never drift out of sync with them.
app.get("/api/activity", (req, res) => {
  const groups = db.prepare("SELECT * FROM groups ORDER BY id DESC").all();
  const events = [];

  for (const g of groups) {
    const { members, expenses, expenseSplits, settlements } = loadGroupData(g.id);
    const nameById = {};
    members.forEach((m) => (nameById[m.id] = m.name));

    events.push({
      type: "group_created",
      groupName: g.name,
      created_at: g.created_at,
    });

    members.forEach((m) => {
      events.push({
        type: "member_added",
        groupName: g.name,
        memberName: m.name,
        created_at: m.created_at,
      });
    });

    expenses.forEach((e) => {
      events.push({
        type: "expense_added",
        groupName: g.name,
        description: e.description,
        amount: e.amount,
        paidByName: nameById[e.paid_by] || "?",
        splitCount: expenseSplits.filter((s) => s.expense_id === e.id).length,
        created_at: e.created_at,
      });
    });

    settlements.forEach((s) => {
      events.push({
        type: "settlement",
        groupName: g.name,
        paidByName: nameById[s.paid_by] || "?",
        paidToName: nameById[s.paid_to] || "?",
        amount: s.amount,
        created_at: s.created_at,
      });
    });
  }

  events.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  res.json(events.slice(0, 100));
});

// List all members across all groups, unique by name - used to populate
// the "who are you?" viewer picker on the dashboard.
app.get("/api/people", (req, res) => {
  const rows = db.prepare("SELECT DISTINCT name FROM members ORDER BY name").all();
  res.json(rows.map((r) => r.name));
});

// ====================================================================
//  AUTH (real password login, session cookie). "Viewing as" still lets you
//  switch between any name for convenience once you're in the app - this
//  gate just controls who gets in, it doesn't lock the UI to one identity.
// ====================================================================

// Body: { name, password }. Claims the name if it's free, or if a profile
// already exists for it (e.g. contact info saved before auth existed) but
// has no password set yet. Logs the new account straight in.
app.post("/api/auth/signup", (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim();
  const password = req.body.password || "";
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!email || !email.includes("@")) return res.status(400).json({ error: "a valid email is required" });
  if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 characters" });

  const existing = db.prepare("SELECT * FROM profiles WHERE name = ?").get(name);
  if (existing?.password_hash) return res.status(409).json({ error: "that name is already registered - try logging in" });

  const passwordHash = hashPassword(password);
  db.prepare(`
    INSERT INTO profiles (name, email, password_hash) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET password_hash = excluded.password_hash, email = excluded.email
  `).run(name, email, passwordHash);
  const newProfile = db.prepare("SELECT id FROM profiles WHERE name = ?").get(name);
  const userId = ensureUserId(newProfile.id);

  const token = createSession(newProfile.id);
  setSessionCookie(res, token);
  // signup never grants admin - that's only ever set in the DB directly
  res.json({ name, userId, isAdmin: false });
});

// Body: { userId, password }. Login is by userId now, not name - names
// aren't unique enough to be a login credential (you can have two people
// with the same name across different groups).
app.post("/api/auth/login", (req, res) => {
  const userId = (req.body.userId || "").trim().toUpperCase();
  const password = req.body.password || "";
  const profile = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);

  if (!profile?.password_hash || !verifyPassword(password, profile.password_hash)) {
    return res.status(401).json({ error: "incorrect user ID or password" });
  }

  const token = createSession(profile.id);
  setSessionCookie(res, token);
  res.json({ name: profile.name, userId: profile.user_id, isAdmin: !!profile.is_admin });
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const profile = currentSessionProfile(req);
  res.json({
    id: profile?.id ?? null,
    name: profile?.name ?? null,
    userId: profile ? ensureUserId(profile.id) : null,
    isAdmin: !!profile?.is_admin,
  });
});

// Only a session belonging to a profile with is_admin=1 passes. There is
// no API path that lets a user set is_admin on themselves or anyone else -
// it's only ever set directly against the database.
function requireAdmin(req, res) {
  const profile = currentSessionProfile(req);
  if (!profile?.is_admin) {
    res.status(403).json({ error: "admin access required" });
    return null;
  }
  return profile.name;
}

// Gates any endpoint that takes a ?name=/body.name saying "whose data to
// show". Must be logged in. A non-admin session may only ever request its
// own name - admins may request anyone's (or omit it, defaulting to
// themselves). Returns the name to actually use, or null if it already
// wrote an error response.
function requireSelfOrAdmin(req, res, requestedName) {
  const profile = currentSessionProfile(req);
  if (!profile) {
    res.status(401).json({ error: "log in first" });
    return null;
  }
  if (profile.is_admin) return requestedName || profile.name;

  if (requestedName && requestedName !== profile.name) {
    res.status(403).json({ error: "you can only access your own account" });
    return null;
  }
  return profile.name;
}

// List every registered (password-having) account, for the admin panel.
app.get("/api/auth/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT id, name, is_admin, created_at FROM profiles
    WHERE password_hash IS NOT NULL
    ORDER BY name
  `).all();
  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    userId: ensureUserId(r.id),
    isAdmin: !!r.is_admin,
    createdAt: r.created_at,
  })));
});

// Body: { name }. Admin-only "log in as" - swaps the admin's session for a
// fresh session as the target account, without needing that account's
// password. The admin's own session is consumed in the process (this logs
// you IN AS them, not alongside them).
app.post("/api/auth/impersonate", (req, res) => {
  const adminName = requireAdmin(req, res);
  if (!adminName) return;

  const targetName = (req.body.name || "").trim();
  const target = db.prepare("SELECT * FROM profiles WHERE name = ?").get(targetName);
  if (!target?.password_hash) return res.status(404).json({ error: "no such account" });

  const oldToken = parseCookies(req)[SESSION_COOKIE];
  if (oldToken) db.prepare("DELETE FROM sessions WHERE token = ?").run(oldToken);

  const token = createSession(target.id);
  setSessionCookie(res, token);
  res.json({ name: targetName, isAdmin: !!target.is_admin });
});

// Body: { currentPassword, newPassword }. Always acts on the logged-in
// session's own account - there's no "change someone else's password"
// path, even for admins (they'd impersonate and change it as that user
// instead, which still requires knowing... nothing, since impersonation
// doesn't need a password - so this intentionally has no admin bypass of
// currentPassword, that check stays meaningful for self-service changes).
app.post("/api/auth/change-password", (req, res) => {
  const name = currentSessionName(req);
  if (!name) return res.status(401).json({ error: "log in first" });

  const { currentPassword = "", newPassword = "" } = req.body;
  if (newPassword.length < 6) return res.status(400).json({ error: "new password must be at least 6 characters" });

  const profile = db.prepare("SELECT * FROM profiles WHERE name = ?").get(name);
  if (!profile?.password_hash || !verifyPassword(currentPassword, profile.password_hash)) {
    return res.status(401).json({ error: "current password is incorrect" });
  }

  db.prepare("UPDATE profiles SET password_hash = ? WHERE name = ?").run(hashPassword(newPassword), name);
  res.json({ ok: true });
});

// Body: { newName }. Renaming is safe now that sessions link by profile
// id, not name (an earlier change) - your login keeps working through a
// rename. What still has to be kept in sync by hand is every group's
// members.name row for this person (expenses/splits reference members by
// id, so no data moves - only the display name on those rows changes).
app.post("/api/auth/change-name", (req, res) => {
  const name = currentSessionName(req);
  if (!name) return res.status(401).json({ error: "log in first" });

  const newName = (req.body.newName || "").trim();
  if (!newName) return res.status(400).json({ error: "name is required" });
  if (newName === name) return res.json({ name });

  if (db.prepare("SELECT 1 FROM profiles WHERE name = ?").get(newName)) {
    return res.status(409).json({ error: "that name is already taken" });
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE profiles SET name = ? WHERE name = ?").run(newName, name);
    db.prepare("UPDATE members SET name = ? WHERE name = ?").run(newName, name);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "failed to rename" });
  }
  res.json({ name: newName });
});

// Admin-only "forgot password" path: there's no email sending in this app,
// so self-service reset isn't possible. Instead an admin generates a fresh
// password for the account and relays it to that person directly. Body:
// { name }.
app.post("/api/auth/admin-reset-password", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const name = (req.body.name || "").trim();
  const target = db.prepare("SELECT * FROM profiles WHERE name = ?").get(name);
  if (!target?.password_hash) return res.status(404).json({ error: "no such account" });

  const newPassword = generatePassword();
  db.prepare("UPDATE profiles SET password_hash = ? WHERE name = ?").run(hashPassword(newPassword), name);
  // Any existing sessions for this account are invalidated - a password
  // reset should actually log out whatever session was using the old one.
  db.prepare("DELETE FROM sessions WHERE profile_id = ?").run(target.id);
  res.json({ name, newPassword });
});

// ====================================================================
//  PROFILE (a name's optional contact info, bio and payment details -
//  independent of login; unregistered names can still have one)
// ====================================================================

// GET returns a blank-but-shaped profile for a name that's never saved one,
// rather than 404ing - the frontend always has something to render.
app.get("/api/profile", (req, res) => {
  const name = requireSelfOrAdmin(req, res, (req.query.name || "").trim());
  if (!name) return;

  const profile = db.prepare("SELECT * FROM profiles WHERE name = ?").get(name);
  // "Joined" = first time this name shows up as a member anywhere, since
  // there's no signup event to record instead.
  const joined = db.prepare("SELECT MIN(created_at) AS joined FROM members WHERE name = ?").get(name);

  res.json({
    id: profile?.id ?? null,
    userId: profile ? ensureUserId(profile.id) : null,
    name,
    email: profile?.email || "",
    phone: profile?.phone || "",
    location: profile?.location || "",
    bio: profile?.bio || "",
    avatarUrl: profile?.avatar_url || "",
    upiId: profile?.upi_id || "",
    paytm: profile?.paytm || "",
    gpay: profile?.gpay || "",
    joinedAt: joined?.joined || profile?.created_at || null,
  });
});

// Upsert a profile. Body: { name, email?, phone?, location?, bio?,
// avatarUrl?, upiId?, paytm?, gpay? }. name identifies whose profile this
// is and is never itself editable here (it's the same identity used for
// group membership and the viewer picker elsewhere).
app.patch("/api/profile", (req, res) => {
  const name = requireSelfOrAdmin(req, res, (req.body.name || "").trim());
  if (!name) return;

  const { email = "", phone = "", location = "", bio = "", avatarUrl = "", upiId = "", paytm = "", gpay = "" } = req.body;

  db.prepare(`
    INSERT INTO profiles (name, email, phone, location, bio, avatar_url, upi_id, paytm, gpay)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      email = excluded.email, phone = excluded.phone, location = excluded.location,
      bio = excluded.bio, avatar_url = excluded.avatar_url, upi_id = excluded.upi_id,
      paytm = excluded.paytm, gpay = excluded.gpay
  `).run(name, email, phone, location, bio, avatarUrl, upiId, paytm, gpay);

  res.json({ ok: true });
});

// ====================================================================
//  EXPENSES (flat list across every group, for the Expenses tab)
// ====================================================================
app.get("/api/expenses", (req, res) => {
  const groups = db.prepare("SELECT * FROM groups ORDER BY id DESC").all();
  const out = [];

  for (const g of groups) {
    const { members, expenses, expenseSplits } = loadGroupData(g.id);
    const nameById = {};
    members.forEach((m) => (nameById[m.id] = m.name));

    expenses.forEach((e) => {
      const splitNames = expenseSplits
        .filter((s) => s.expense_id === e.id)
        .map((s) => nameById[s.member_id] || "?");
      out.push({
        id: e.id,
        description: e.description,
        amount: e.amount,
        groupId: g.id,
        groupName: g.name,
        paidByName: nameById[e.paid_by] || "?",
        splitCount: splitNames.length,
        splitNames,
        date: e.date,
        created_at: e.created_at,
      });
    });
  }

  out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id);
  res.json(out);
});

// ====================================================================
//  PAIRWISE LEDGER (shared by Balances + Friends)
// ====================================================================

// Builds ledger[creditorName][debtorName] = amount debtorName owes
// creditorName, aggregated across every group in the app. This mirrors how
// real Splitwise computes "balance with a friend": it's the net of every
// expense split and settlement between two people, regardless of who else
// was in the expense or which group it happened in.
function buildPairwiseLedger() {
  const groups = db.prepare("SELECT * FROM groups").all();
  const ledger = {};
  const bump = (creditor, debtor, amount) => {
    if (!creditor || !debtor || creditor === debtor || !amount) return;
    ledger[creditor] = ledger[creditor] || {};
    ledger[creditor][debtor] = (ledger[creditor][debtor] || 0) + amount;
  };

  for (const g of groups) {
    const { members, expenses, expenseSplits, settlements } = loadGroupData(g.id);
    const nameById = {};
    members.forEach((m) => (nameById[m.id] = m.name));

    expenses.forEach((e) => {
      const payerName = nameById[e.paid_by];
      expenseSplits
        .filter((s) => s.expense_id === e.id)
        .forEach((s) => bump(payerName, nameById[s.member_id], s.amount_owed));
    });

    // paidBy pays paidTo => paidBy's debt to paidTo shrinks.
    settlements.forEach((s) => {
      bump(nameById[s.paid_to], nameById[s.paid_by], -s.amount);
    });
  }

  return ledger;
}

// Net balance between two people: positive => debtorCandidate owes viewer.
function netBetween(ledger, a, b) {
  const aOwedByB = ledger[a]?.[b] || 0;
  const bOwedByA = ledger[b]?.[a] || 0;
  return round2(aOwedByB - bOwedByA);
}

// Every person who shares at least one group with viewerName, plus the
// viewer's net balance with each (0 if settled up).
function friendBalances(viewerName) {
  const ledger = buildPairwiseLedger();
  const groups = db.prepare("SELECT * FROM groups").all();
  const sharedCount = {};

  for (const g of groups) {
    const names = db.prepare("SELECT name FROM members WHERE group_id = ?").all(g.id).map((m) => m.name);
    if (!names.includes(viewerName)) continue;
    names.forEach((n) => {
      if (n === viewerName) return;
      sharedCount[n] = (sharedCount[n] || 0) + 1;
    });
  }

  const list = Object.keys(sharedCount).map((name) => ({
    name,
    amount: netBetween(ledger, viewerName, name),
    groupsShared: sharedCount[name],
  }));
  list.sort((a, b) => b.amount - a.amount);
  return list;
}

// ====================================================================
//  BALANCES (overall summary across every group, for the Balances tab)
// ====================================================================
app.get("/api/balances", (req, res) => {
  const viewerName = requireSelfOrAdmin(req, res, (req.query.name || "").trim());
  if (!viewerName) return;
  const list = friendBalances(viewerName);

  const owedToYou = list.filter((f) => f.amount > 0.004).map((f) => ({ name: f.name, amount: f.amount }));
  const youOweList = list
    .filter((f) => f.amount < -0.004)
    .map((f) => ({ name: f.name, amount: -f.amount }))
    .sort((a, b) => b.amount - a.amount);

  const youAreOwed = round2(owedToYou.reduce((sum, f) => sum + f.amount, 0));
  const youOwe = round2(youOweList.reduce((sum, f) => sum + f.amount, 0));

  res.json({
    overallBalance: round2(youAreOwed - youOwe),
    youAreOwed,
    youOwe,
    owedToYou,
    youOweList,
  });
});

// ====================================================================
//  FRIENDS (everyone you share a group with, + net balance with each)
// ====================================================================
app.get("/api/friends", (req, res) => {
  const viewerName = requireSelfOrAdmin(req, res, (req.query.name || "").trim());
  if (!viewerName) return;
  res.json(friendBalances(viewerName));
});

// ====================================================================
//  STATISTICS
// ====================================================================
app.get("/api/statistics", (req, res) => {
  const range = req.query.range === "month" ? "month" : "all";
  const groups = db.prepare("SELECT * FROM groups ORDER BY id DESC").all();
  const monthPrefix = new Date().toISOString().slice(0, 7);

  let totalExpenses = 0;
  let totalTransactions = 0;
  const activeGroupIds = new Set();
  const byDay = {};
  const byGroup = {};
  let minDay = null;
  let maxDay = null;

  for (const g of groups) {
    const { expenses } = loadGroupData(g.id);
    expenses.forEach((e) => {
      if (range === "month" && !(e.date || "").startsWith(monthPrefix)) return;
      const day = e.date || "";
      totalExpenses += e.amount;
      totalTransactions += 1;
      activeGroupIds.add(g.id);
      byDay[day] = (byDay[day] || 0) + e.amount;
      byGroup[g.name] = (byGroup[g.name] || 0) + e.amount;
      if (!minDay || day < minDay) minDay = day;
      if (!maxDay || day > maxDay) maxDay = day;
    });
  }

  const dayCount = minDay ? Math.max(1, Math.round((new Date(maxDay) - new Date(minDay)) / 86400000) + 1) : 1;

  res.json({
    totalExpenses: round2(totalExpenses),
    totalTransactions,
    activeGroups: activeGroupIds.size,
    avgPerDay: round2(totalTransactions ? totalExpenses / dayCount : 0),
    series: Object.keys(byDay).sort().map((d) => ({ date: d, amount: round2(byDay[d]) })),
    byGroup: Object.entries(byGroup)
      .map(([groupName, amount]) => ({ groupName, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
  });
});

app.listen(PORT, () => {
  console.log(`Splitwise clone running at http://localhost:${PORT}`);
});
