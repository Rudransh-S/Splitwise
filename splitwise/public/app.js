// ============================================================
//  SplitWise frontend
//  Talks to the backend REST API and renders the dashboard,
//  group views, and the expense modal (4 split modes).
// ============================================================

// ---- tiny API helper ----
async function api(url, method = "GET", body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    toast(err.error || `Error ${res.status}`);
    throw new Error(err.error || res.status);
  }
  return res.json();
}

// ---- formatting / helpers ----
const fmt = (n) => "\u20b9" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = (n) => "\u20b9" + Math.round(n).toLocaleString("en-IN");
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Formats a "YYYY-MM-DD" (or "...-MM-DD HH:MM:SS") string as "13 May 2025".
function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
// Same convention without the year - for tight spaces like chart axis ticks.
function formatDateShort(dateStr) {
  if (!dateStr) return "";
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// ============================================================
//  DROPDOWN MENU (generic - powers custom selects + action menus)
// ============================================================
const svgChevronDown = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

let openDropdownEl = null;
let openDropdownTrigger = null;

function closeDropdown() {
  if (openDropdownEl) openDropdownEl.remove();
  if (openDropdownTrigger) openDropdownTrigger.classList.remove("open");
  openDropdownEl = null;
  openDropdownTrigger = null;
}
document.addEventListener("click", closeDropdown);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDropdown(); });
// The menu is positioned once, at open time, from the trigger's on-screen
// rect. If a scrollable ancestor (e.g. a tall modal body) scrolls afterward,
// the trigger moves but the menu doesn't, so they drift apart - close it
// instead of leaving a stale, misaligned menu. Capture:true so this also
// catches scroll events on nested scrollable elements (they don't bubble).
// Scrolling *inside* the open menu's own item list is exempt.
window.addEventListener("scroll", (e) => {
  if (openDropdownEl && !openDropdownEl.contains(e.target)) closeDropdown();
}, true);

// ============================================================
//  MODAL SCROLL LOCK
// ============================================================
// Every modal just toggles its .modal-backdrop's `hidden` attribute (see
// the various open/close functions below) - rather than touching each of
// those individually, watch all backdrops and lock/unlock the page's own
// scroll whenever any of them becomes visible. Padding-right compensates
// for the vanished scrollbar so the page doesn't shift width when locked.
function updateBodyScrollLock() {
  const anyOpen = Array.from(document.querySelectorAll(".modal-backdrop")).some((m) => !m.hidden);
  if (anyOpen) {
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    document.body.style.paddingRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : "";
  } else {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
  }
}
document.querySelectorAll(".modal-backdrop").forEach((m) => {
  new MutationObserver(updateBodyScrollLock).observe(m, { attributes: true, attributeFilter: ["hidden"] });
});

// anchor: trigger element. items: array of {label, icon, danger, checked, onClick} or the string "divider".
// opts.align "right" right-aligns the menu to the anchor's right edge (for menus opening off a
// right-side icon button that would otherwise overflow the viewport).
function openDropdown(anchor, items, opts = {}) {
  const reopening = openDropdownTrigger === anchor;
  closeDropdown();
  if (reopening) return; // clicking the same trigger again just closes it

  // Search box shows automatically once a list is long enough to be worth
  // filtering (checkbox-style select lists), unless the caller overrides it.
  const selectableCount = items.filter((it) => it !== "divider").length;
  const showSearch = opts.search ?? selectableCount > 6;

  const menu = document.createElement("div");
  menu.className = "dropdown-menu";
  const itemsHTML = items.map((it, i) => {
    if (it === "divider") return `<div class="dropdown-divider"></div>`;
    const check = it.checked !== undefined ? `<span class="dd-check">${it.checked ? "✓" : ""}</span>` : (it.icon || "");
    return `<button type="button" class="dropdown-item${it.danger ? " danger" : ""}" data-i="${i}" data-label="${esc(it.label.toLowerCase())}">${check}<span class="label">${esc(it.label)}</span></button>`;
  }).join("");
  menu.innerHTML =
    (showSearch ? `<input type="text" class="dropdown-search" placeholder="Search..." />` : "") +
    `<div class="dropdown-items">${itemsHTML}<div class="dropdown-empty" hidden>No matches</div></div>`;
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const top = Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + window.scrollY;
  let left = (opts.align === "right" ? rect.right - menu.offsetWidth : rect.left) + window.scrollX;
  left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - menu.offsetWidth - 8));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  menu.querySelectorAll(".dropdown-item").forEach((btn) => {
    const it = items[Number(btn.dataset.i)];
    btn.onclick = (e) => { e.stopPropagation(); closeDropdown(); it.onClick(); };
  });
  menu.onclick = (e) => e.stopPropagation();

  if (showSearch) {
    const searchInput = menu.querySelector(".dropdown-search");
    const emptyMsg = menu.querySelector(".dropdown-empty");
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      let visible = 0;
      menu.querySelectorAll(".dropdown-item").forEach((btn) => {
        const match = !q || btn.dataset.label.includes(q);
        btn.hidden = !match;
        if (match) visible++;
      });
      emptyMsg.hidden = visible > 0;
    };
    // Focus after the menu is positioned so the page doesn't jump/scroll.
    requestAnimationFrame(() => searchInput.focus());
  }

  anchor.classList.add("open");
  openDropdownEl = menu;
  openDropdownTrigger = anchor;
}

// Turns a plain <select id="X"> (wrapped in a .select-shell with a
// .select-trigger button, see index.html) into a custom-styled dropdown.
// The real <select> stays in the DOM (hidden) as the single source of
// truth: existing .value reads and onchange handlers keep working
// untouched, since choosing an item just sets select.value and dispatches
// a real "change" event.
function initSelectTrigger(selectId) {
  const select = document.getElementById(selectId);
  const trigger = document.getElementById(selectId + "-trigger");
  if (!select || !trigger || trigger.dataset.wired) return;
  trigger.dataset.wired = "1";
  trigger.onclick = (e) => {
    e.stopPropagation();
    const items = Array.from(select.options).map((o) => ({
      label: o.textContent,
      checked: o.value === select.value,
      onClick: () => {
        select.value = o.value;
        select.dispatchEvent(new Event("change"));
        syncSelectTrigger(selectId);
      },
    }));
    openDropdown(trigger, items);
  };
  syncSelectTrigger(selectId);
}

// Call this after repopulating a select's <option>s (e.g. select.innerHTML = ...)
// so the visible trigger label stays in sync with the underlying select.
function syncSelectTrigger(selectId) {
  const select = document.getElementById(selectId);
  const trigger = document.getElementById(selectId + "-trigger");
  if (!select || !trigger) return;
  const label = select.options[select.selectedIndex]?.textContent || "Select...";
  trigger.querySelector(".label").textContent = label;
}

// Wire the custom dropdown triggers once; each gets kept in sync via
// syncSelectTrigger() wherever its underlying <select>'s options or value
// are set programmatically elsewhere in the file.
["viewerSelect", "mGroup", "mPayer", "mSplitType"].forEach(initSelectTrigger);

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---- app state ----
let viewer = localStorage_get("viewer") || "";   // name of the person viewing
let people = [];                                   // all distinct member names
let isAdmin = false;                               // true if the logged-in account has admin rights
let currentView = "dashboard";
let openGroupId = null;

// localStorage is blocked in some embedded contexts; guard it.
function localStorage_get(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorage_set(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ============================================================
//  NAV / ROUTING
// ============================================================
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    openGroupId = null;
    if (view === "dashboard") showDashboard();
    else if (view === "groups") showGroups();
    else if (view === "activity") showActivity();
    else if (view === "expenses") showExpenses();
    else if (view === "balances") showBalances();
    else if (view === "friends") showFriends();
    else if (view === "statistics") showStatistics();
    else showPlaceholder(btn.textContent.trim());
    closeMobileNav();
  };
});

// ============================================================
//  MOBILE NAV (hamburger + slide-out drawer)
// ============================================================
function openMobileNav() {
  document.querySelector(".sidebar").classList.add("open");
  document.getElementById("sidebarBackdrop").classList.add("show");
}
function closeMobileNav() {
  document.querySelector(".sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.remove("show");
}
document.getElementById("mobileNavToggle").onclick = openMobileNav;
document.getElementById("sidebarBackdrop").onclick = closeMobileNav;

function setViews(active) {
  ["dashboard", "group", "placeholder", "activity", "expenses", "balances", "friends", "statistics", "profile", "groups", "admin"].forEach((v) => {
    document.getElementById("view-" + v).hidden = v !== active;
  });
}

// ============================================================
//  LOGIN / SIGN UP
// ============================================================
let authMode = "login";

function showAuthScreen() {
  document.getElementById("appShell").hidden = true;
  document.getElementById("view-auth").hidden = false;
  authMode = "login";
  renderAuthForm();
}

function renderAuthForm() {
  const el = document.getElementById("authFormArea");
  const isLogin = authMode === "login";
  // Login is by User ID (a generated 6-character code, not the display
  // name - names aren't unique enough to be a login credential). Signup
  // still takes a display Name; the User ID is generated and shown to you
  // once, right after.
  el.innerHTML = `
    <h2>${isLogin ? "Welcome back 👋" : "Create your account"}</h2>
    <p class="subtle">${isLogin ? "Login to continue" : "Join SplitWise to start splitting bills"}</p>
    <label class="field">
      <span>${isLogin ? "User ID" : "Name"}</span>
      <input type="text" id="authIdentifier" placeholder="${isLogin ? "e.g. AB12CD" : "Your name"}" autocomplete="username" style="${isLogin ? "text-transform:uppercase" : ""}" />
    </label>
    ${isLogin ? "" : `<label class="field">
      <span>Email</span>
      <input type="email" id="authEmail" placeholder="you@example.com" autocomplete="email" />
    </label>`}
    <label class="field">
      <span>Password</span>
      <input type="password" id="authPassword" placeholder="${isLogin ? "Enter your password" : "At least 6 characters"}" autocomplete="${isLogin ? "current-password" : "new-password"}" />
    </label>
    ${isLogin ? `<p class="auth-forgot"><a id="authForgotLink">Forgot password?</a></p>` : ""}
    <div class="auth-error" id="authError" hidden></div>
    <button class="btn-primary" id="authSubmit" style="width:100%;margin-top:6px">${isLogin ? "Log in" : "Sign up"}</button>
    <p class="auth-switch">${isLogin ? "Don't have an account?" : "Already have an account?"} <a id="authSwitchLink">${isLogin ? "Sign up" : "Log in"}</a></p>`;

  document.getElementById("authSwitchLink").onclick = () => {
    authMode = isLogin ? "signup" : "login";
    renderAuthForm();
  };
  if (isLogin) document.getElementById("authForgotLink").onclick = renderForgotPasswordInfo;
  document.getElementById("authSubmit").onclick = submitAuthForm;
  document.getElementById("authIdentifier").onkeydown = (e) => { if (e.key === "Enter") document.getElementById("authPassword").focus(); };
  document.getElementById("authPassword").onkeydown = (e) => { if (e.key === "Enter") submitAuthForm(); };
  document.getElementById("authIdentifier").focus();
}

async function submitAuthForm() {
  const identifier = document.getElementById("authIdentifier").value.trim();
  const password = document.getElementById("authPassword").value;
  const errEl = document.getElementById("authError");
  errEl.hidden = true;
  const isLogin = authMode === "login";

  if (!identifier || !password) {
    errEl.textContent = isLogin ? "Enter your User ID and password." : "Enter a name and password.";
    errEl.hidden = false;
    return;
  }
  const email = isLogin ? "" : document.getElementById("authEmail").value.trim();
  if (!isLogin && (!email || !email.includes("@"))) {
    errEl.textContent = "Enter a valid email address.";
    errEl.hidden = false;
    return;
  }

  const endpoint = isLogin ? "/api/auth/login" : "/api/auth/signup";
  const body = isLogin ? { userId: identifier, password } : { name: identifier, email, password };
  let data;
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || "Something went wrong."; errEl.hidden = false; return; }
  } catch (err) {
    errEl.textContent = "Network error - try again.";
    errEl.hidden = false;
    return;
  }

  if (isLogin) {
    await enterApp(data.name, data.isAdmin);
  } else {
    renderSignupSuccess(data);
  }
}

// Shown once, right after signup - the generated User ID is the only way
// to log back in, so make sure it's actually seen before entering the app.
function renderSignupSuccess(data) {
  const el = document.getElementById("authFormArea");
  el.innerHTML = `
    <h2>You're all set 🎉</h2>
    <p class="subtle">Save your User ID - you'll need it to log in next time.</p>
    <div class="auth-userid-box">
      <div class="group-meta">Your User ID</div>
      <div class="auth-userid-value">${esc(data.userId)}</div>
    </div>
    <button class="btn-primary" id="authContinueBtn" style="width:100%;margin-top:16px">Continue to SplitWise</button>`;
  document.getElementById("authContinueBtn").onclick = () => enterApp(data.name, data.isAdmin);
}

// There's no email sending in this app, so there's no self-service reset
// link to send - resets go through an admin instead (Admin Panel has a
// "Reset password" action per account). This just explains that.
function renderForgotPasswordInfo() {
  const el = document.getElementById("authFormArea");
  el.innerHTML = `
    <h2>Forgot your password?</h2>
    <p class="subtle">There's no email-based reset here. Ask your admin to reset it for you from the Admin Panel, then log in with the new password they give you.</p>
    <button class="btn-ghost" id="authBackToLogin" style="width:100%;margin-top:16px">Back to login</button>`;
  document.getElementById("authBackToLogin").onclick = () => { authMode = "login"; renderAuthForm(); };
}

async function enterApp(name, adminFlag = false) {
  viewer = name;
  isAdmin = adminFlag;
  localStorage_set("viewer", name);
  document.getElementById("view-auth").hidden = true;
  document.getElementById("appShell").hidden = false;
  await loadPeople();
  clearNavActive();
  document.querySelector('.nav-item[data-view="dashboard"]').classList.add("active");
  await showDashboard();
}

// ============================================================
//  VIEWER PICKER
// ============================================================
async function loadPeople() {
  // Non-admins are locked to their own logged-in identity - the backend
  // rejects ?name= for anyone else now anyway, so letting the picker offer
  // other names would just be a dead end. Admins keep the full switcher.
  if (!isAdmin) {
    people = [viewer].filter(Boolean);
  } else {
    const distinctPeople = await api("/api/people");
    // A freshly logged-in name might not be a member of any group yet - keep
    // it selectable instead of the dropdown silently falling back to
    // whoever happens to be first in the member list.
    people = viewer && !distinctPeople.includes(viewer) ? [viewer, ...distinctPeople] : distinctPeople;
  }

  const sel = document.getElementById("viewerSelect");
  if (people.length === 0) {
    sel.innerHTML = '<option value="">(no members yet)</option>';
    viewer = "";
  } else {
    if (!viewer || !people.includes(viewer)) viewer = people[0];
    sel.innerHTML = people.map((p) => `<option value="${esc(p)}"${p === viewer ? " selected" : ""}>${esc(p)}</option>`).join("");
  }
  sel.disabled = !isAdmin;
  document.getElementById("viewerSelect-trigger").disabled = !isAdmin;
  // Non-admins can't switch identity anyway (locked to themselves) - no
  // point showing a picker with nothing to pick.
  document.getElementById("viewerPickWrap").hidden = !isAdmin;
  document.getElementById("welcomeLine").textContent = viewer ? `Welcome back, ${viewer}` : "Welcome to SplitWise";
  updateTopbarAvatar();
  syncSelectTrigger("viewerSelect");
}
document.getElementById("viewerSelect").onchange = (e) => {
  viewer = e.target.value;
  localStorage_set("viewer", viewer);
  document.getElementById("welcomeLine").textContent = viewer ? `Welcome back, ${viewer}` : "Welcome to SplitWise";
  updateTopbarAvatar();
  if (openGroupId) showGroup(openGroupId);
  else showDashboard();
};

// Keeps the persistent topbar avatar (visible on every page) in sync with
// whoever is currently selected in "Viewing as".
function updateTopbarAvatar() {
  document.getElementById("topbarAvatar").textContent = viewer ? initials(viewer) : "?";
}
function clearNavActive() {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
}

document.getElementById("profileAvatarBtn").onclick = (e) => {
  e.stopPropagation();
  openDropdown(e.currentTarget, [
    { label: "My Profile", icon: svgUser, onClick: () => { clearNavActive(); showProfile(); } },
    { label: "Payment Methods", icon: svgCard, onClick: async () => {
      if (!viewer) { toast('Pick a name from "Viewing as" first'); return; }
      openEditProfileModal(await api(`/api/profile?name=${encodeURIComponent(viewer)}`));
    } },
    { label: "Settings", icon: svgSettings, onClick: () => { clearNavActive(); showPlaceholder("Settings"); } },
    { label: "Help & Support", icon: svgHelp, onClick: () => { clearNavActive(); showPlaceholder("Help & Support"); } },
    ...(isAdmin ? ["divider", { label: "Admin Panel", icon: svgShield, onClick: () => { clearNavActive(); showAdminPanel(); } }] : []),
    "divider",
    { label: "Log out", icon: svgLogout, danger: true, onClick: logOut },
  ], { align: "right" });
};

// There's no real auth, so "log out" just clears the selected viewer -
// the next visit (or picking a name again) is the only way "back in".
async function logOut() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  viewer = "";
  localStorage_set("viewer", "");
  showAuthScreen();
}

// ============================================================
//  DASHBOARD
// ============================================================
async function showDashboard() {
  currentView = "dashboard";
  setViews("dashboard");
  const el = document.getElementById("view-dashboard");
  const d = await api("/api/dashboard?name=" + encodeURIComponent(viewer));

  const statCards = `
    <div class="summary-grid">
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owed">${svgOwed}</div>
          <div><div class="stat-label">You are owed</div></div></div>
        <div class="stat-value pos">${fmt(d.youAreOwed)}</div>
        <div class="stat-sub">across your groups</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owe">${svgOwe}</div>
          <div><div class="stat-label">You owe</div></div></div>
        <div class="stat-value neg">${fmt(d.youOwe)}</div>
        <div class="stat-sub">to others</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico bal">${svgWallet}</div>
          <div><div class="stat-label">Total balance</div></div></div>
        <div class="stat-value ${d.totalBalance >= 0 ? "pos" : "neg"}">${fmt(Math.abs(d.totalBalance))}</div>
        <div class="stat-sub">${d.totalBalance >= 0 ? "in your favor" : "you owe overall"}</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico exp">${svgPie}</div>
          <div><div class="stat-label">Total expenses</div></div></div>
        <div class="stat-value">${fmt0(d.totalExpensesThisMonth)}</div>
        <div class="stat-sub">this month</div>
      </div>
    </div>`;

  const groupCards = d.groups.length
    ? d.groups.map((g) => {
        const cls = g.yourBalance > 0 ? "pos" : g.yourBalance < 0 ? "neg" : "";
        const label = !g.inGroup ? "not a member" : g.yourBalance > 0 ? "You are owed" : g.yourBalance < 0 ? "You owe" : "Settled up";
        const val = g.inGroup && g.yourBalance !== 0 ? fmt0(Math.abs(g.yourBalance)) : (g.inGroup ? "\u20b90" : "\u2014");
        return `<div class="group-card" onclick="showGroup(${g.id})">
          <div class="group-thumb">${g.emoji || groupEmoji(g.name)}</div>
          <div class="group-info">
            <div class="group-name">${esc(g.name)}</div>
            <div class="group-meta">${g.memberCount} member${g.memberCount === 1 ? "" : "s"}</div>
            <div class="group-bal-label">${label}</div>
            <div class="group-bal ${cls}">${val}</div>
          </div></div>`;
      }).join("")
    : "";

  const groupsPanel = `
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Your Groups</span></div>
      <div class="panel-body">
        <div class="group-cards">
          ${groupCards}
          <div class="group-card add" onclick="openGroupModal()">
            <div><div class="plus">+</div>New Group</div>
          </div>
        </div>
      </div>
    </div>`;

  const recentRows = d.recentExpenses.length
    ? d.recentExpenses.map((e) => `
        <tr>
          <td>${esc(e.description)}</td>
          <td>${esc(e.groupName)}</td>
          <td><div class="who"><div class="avatar sm">${initials(e.paidByName)}</div>${esc(e.paidByName === viewer ? "You" : e.paidByName)}</div></td>
          <td class="amt">${fmt(e.amount)}</td>
          <td><span class="group-meta">split ${e.splitCount} ways</span></td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="empty">No expenses yet. Add your first one.</td></tr>`;

  const recentPanel = `
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Recent Expenses</span></div>
      <div class="panel-body">
        <table class="tbl">
          <thead><tr><th>Description</th><th>Group</th><th>Paid by</th><th>Amount</th><th>Split</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      </div>
    </div>`;

  const activityItems = d.recentExpenses.slice(0, 5).map((e) => `
    <div class="feed-item">
      <div class="avatar sm">${initials(e.paidByName)}</div>
      <div class="feed-body">
        <div class="feed-text"><strong>${esc(e.paidByName === viewer ? "You" : e.paidByName)}</strong> added an expense</div>
        <div class="feed-meta">${esc(e.description)} \u00b7 ${esc(e.groupName)}</div>
      </div>
      <div class="feed-amt">${fmt0(e.amount)}</div>
    </div>`).join("") || `<div class="empty">Nothing yet.</div>`;

  const sidePanel = `
    <div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Simplify payments</span></div>
        <div class="panel-body">
          <p class="subtle" style="margin-bottom:10px">SplitWise settles balances with the fewest transactions. Open a group to see who should pay whom.</p>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Recent Activity</span></div>
        <div class="panel-body">${activityItems}</div>
      </div>
    </div>`;

  el.innerHTML = statCards + `<div class="content-grid"><div>${groupsPanel}${recentPanel}</div>${sidePanel}</div>`;
}

// ============================================================
//  GROUPS (full list, distinct from the Dashboard's "top groups")
// ============================================================
let groupsCache = [];

async function showGroups() {
  currentView = "groups";
  setViews("groups");
  const el = document.getElementById("view-groups");
  const d = await api("/api/dashboard?name=" + encodeURIComponent(viewer));
  groupsCache = d.groups;

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Groups</h1><div class="subtle">All your groups</div></div>
      <button class="btn-primary" onclick="openGroupModal()">+ New Group</button>
    </div>
    <div class="panel">
      <div class="panel-body" style="padding-top:18px">
        <input type="text" id="groupsSearch" class="input-bare" style="width:100%;margin-bottom:16px" placeholder="Search groups..." />
        <div class="group-cards" id="groupsGrid"></div>
      </div>
    </div>`;

  document.getElementById("groupsSearch").oninput = renderGroupCards;
  renderGroupCards();
}

function renderGroupCards() {
  const q = document.getElementById("groupsSearch").value.trim().toLowerCase();
  const filtered = groupsCache.filter((g) => g.name.toLowerCase().includes(q));

  const cards = filtered.map((g) => {
    const cls = g.yourBalance > 0 ? "pos" : g.yourBalance < 0 ? "neg" : "";
    const label = !g.inGroup ? "not a member" : g.yourBalance > 0 ? "You are owed" : g.yourBalance < 0 ? "You owe" : "Settled up";
    const val = g.inGroup && g.yourBalance !== 0 ? fmt0(Math.abs(g.yourBalance)) : (g.inGroup ? "₹0" : "—");

    const shown = g.memberNames.slice(0, 3);
    const extra = g.memberNames.length - shown.length;
    const avatarStack = shown.map((n) => `<div class="avatar sm">${initials(n)}</div>`).join("")
      + (extra > 0 ? `<div class="avatar sm more">+${extra}</div>` : "");

    return `<div class="group-card" onclick="showGroup(${g.id})">
      <div class="group-thumb">${g.emoji || groupEmoji(g.name)}</div>
      <div class="group-info">
        <div class="group-name">${esc(g.name)}</div>
        <div class="group-meta">${g.memberCount} member${g.memberCount === 1 ? "" : "s"}</div>
        <div class="group-bal-label">${label}</div>
        <div class="group-bal ${cls}">${val}</div>
        <div class="group-card-foot">
          <div class="avatar-stack">${avatarStack}</div>
          <button class="group-card-menu" title="Group actions" onclick="event.stopPropagation(); openGroupCardMenu(this, ${g.id})">${svgDots}</button>
        </div>
      </div></div>`;
  }).join("");

  document.getElementById("groupsGrid").innerHTML = cards +
    `<div class="group-card add" onclick="openGroupModal()"><div><div class="plus">+</div>New Group</div></div>`;
}

function openGroupCardMenu(anchor, groupId) {
  const g = groupsCache.find((x) => x.id === groupId);
  if (g) openGroupActionsMenu(anchor, g);
}

// ============================================================
//  GROUP DETAIL
// ============================================================
async function showGroup(groupId) {
  openGroupId = groupId;
  currentView = "group";
  setViews("group");
  const el = document.getElementById("view-group");
  const s = await api(`/api/groups/${groupId}/state`);
  const nameById = {};
  s.members.forEach((m) => (nameById[m.id] = m.name));
  const group = (await api("/api/groups")).find((g) => g.id === groupId) || { name: "Group", emoji: null };
  const groupName = group.name;
  const groupIcon = group.emoji || groupEmoji(groupName);

  const membersChips = s.members.map((m) => `<div class="member-chip"><div class="avatar sm">${initials(m.name)}</div>${esc(m.name)}</div>`).join("");

  const expRows = s.expenses.length
    ? s.expenses.map((e) => `
        <tr>
          <td>${esc(e.description)}</td>
          <td><div class="who"><div class="avatar sm">${initials(nameById[e.paid_by] || "?")}</div>${esc(nameById[e.paid_by] === viewer ? "You" : nameById[e.paid_by])}</div></td>
          <td class="amt">${fmt(e.amount)}</td>
          <td><span class="group-meta">${e.splitAmong.length} people</span></td>
          <td><span class="group-meta">${esc(formatDate(e.date))}</span></td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" title="Expense actions" onclick="event.stopPropagation(); openExpenseActionsMenu(this, ${e.id}, ${groupId})">${svgDots}</button>
            </div>
          </td>
        </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No expenses in this group yet.</td></tr>`;

  const balRows = s.members.map((m) => {
    const v = Math.round((s.balances[m.id] || 0) * 100) / 100;
    const cls = v > 0 ? "pos" : v < 0 ? "neg" : "";
    const txt = v > 0 ? "is owed " + fmt(v) : v < 0 ? "owes " + fmt(-v) : "settled up";
    return `<div class="bal-row"><div class="who"><div class="avatar sm">${initials(m.name)}</div>${esc(m.name)}</div><span class="${cls}" style="font-weight:600">${txt}</span></div>`;
  }).join("") || `<div class="empty">No members.</div>`;

  const settleRows = s.settleUp.length
    ? s.settleUp.map((t) => {
        const fromName = (nameById[t.from] || "").replace(/'/g, "\\'");
        const toName = (nameById[t.to] || "").replace(/'/g, "\\'");
        const groupNameSafe = groupName.replace(/'/g, "\\'");
        return `
        <div class="settle-row">
          <div class="who">
            <span class="pill neg">${esc(nameById[t.from])}</span>
            <span style="color:var(--muted-2)">\u2192</span>
            <span class="pill pos">${esc(nameById[t.to])}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="amt">${fmt(t.amount)}</span>
            <button class="mini-btn" onclick="openSettleModal({fromName:'${fromName}',toName:'${toName}',amount:${t.amount},groupId:${groupId},paidBy:${t.from},paidTo:${t.to},groupName:'${groupNameSafe}'})">settle up</button>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">Everyone is settled up.</div>`;

  el.innerHTML = `
    <button class="back-link" onclick="showDashboard()">${svgChevronLeft} Back to dashboard</button>
    <div class="topbar" style="margin-bottom:16px">
      <div><h1 class="welcome">${groupIcon} ${esc(groupName)}
          <button class="icon-btn" id="groupActionsBtn" title="Group actions" style="vertical-align:middle;margin-left:4px">${svgDots}</button>
        </h1>
        <div class="member-chips">${membersChips}</div></div>
      <div class="topbar-right">
        <button class="btn-ghost" id="addMemberInline">+ Add member</button>
        <button class="btn-primary" onclick="openExpenseModal(${groupId})">+ New Expense</button>
      </div>
    </div>
    <div class="content-grid">
      <div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Expenses</span></div>
          <div class="panel-body">
            <table class="tbl">
              <thead><tr><th>Description</th><th>Paid by</th><th>Amount</th><th>Split</th><th>Date</th><th></th></tr></thead>
              <tbody>${expRows}</tbody>
            </table>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Settle up</span><span class="group-meta">minimum transactions</span></div>
          <div class="panel-body">${settleRows}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Balances</span></div>
        <div class="panel-body">${balRows}</div>
      </div>
    </div>`;

  document.getElementById("addMemberInline").onclick = () => addMemberToGroup(groupId);

  document.getElementById("groupActionsBtn").onclick = (e) => {
    e.stopPropagation();
    openGroupActionsMenu(e.currentTarget, group);
  };
}

async function deleteExpense(id) {
  if (!confirm("Delete this expense? This can't be undone.")) return;
  await api(`/api/expenses/${id}`, "DELETE");
  toast("Expense deleted");
  if (currentView === "expenses") showExpenses();
  else if (openGroupId) showGroup(openGroupId);
  else showDashboard();
}

// ============================================================
//  EXPENSE ACTIONS MENU (group table + Expenses tab rows)
// ============================================================
function openExpenseActionsMenu(anchor, expenseId, groupId) {
  openDropdown(anchor, [
    { label: "View Details", icon: svgEye, onClick: () => showExpenseDetails(expenseId) },
    { label: "Edit Expense", icon: svgEdit, onClick: () => openExpenseModal(groupId, expenseId) },
    { label: "Duplicate Expense", icon: svgCopy, onClick: () => duplicateExpense(expenseId) },
    "divider",
    { label: "Delete Expense", icon: svgTrash, danger: true, onClick: () => deleteExpense(expenseId) },
  ], { align: "right" });
}

async function showExpenseDetails(expenseId) {
  const e = await api(`/api/expenses/${expenseId}`);
  const rows = e.splits.map((s) => `
    <div class="bal-row"><div class="who"><div class="avatar sm">${initials(s.member_name)}</div>${esc(s.member_name)}</div><span style="font-weight:600">${fmt(s.amount_owed)}</span></div>`).join("");

  document.getElementById("expenseDetailsBody").innerHTML = `
    <div style="margin-bottom:4px">
      <div style="font-size:17px;font-weight:700">${esc(e.description)}</div>
      <div class="group-meta">${esc(e.groupName)} · ${esc(formatDate(e.date))}</div>
    </div>
    <div class="bal-row"><span class="group-meta">Amount</span><span style="font-weight:700">${fmt(e.amount)}</span></div>
    <div class="bal-row"><span class="group-meta">Paid by</span><span style="font-weight:600">${esc(e.payerName)}</span></div>
    <div class="panel-title" style="font-size:13px;margin-top:8px">Split</div>
    ${rows}`;
  document.getElementById("expenseDetailsModal").hidden = false;
}
function closeExpenseDetailsModal() { document.getElementById("expenseDetailsModal").hidden = true; }
document.getElementById("closeExpenseDetailsModal").onclick = closeExpenseDetailsModal;
document.getElementById("closeExpenseDetailsBtn").onclick = closeExpenseDetailsModal;

async function duplicateExpense(expenseId) {
  const e = await api(`/api/expenses/${expenseId}`);
  await api(`/api/groups/${e.group_id}/expenses`, "POST", {
    description: e.description,
    amount: e.amount,
    paidBy: e.paid_by,
    splitType: "exact",
    splits: e.splits.map((s) => ({ memberId: s.member_id, amount: s.amount_owed })),
    date: new Date().toISOString().slice(0, 10),
  });
  toast("Expense duplicated");
  if (currentView === "expenses") showExpenses();
  else if (openGroupId === e.group_id) showGroup(e.group_id);
}

// ============================================================
//  SETTLE UP MODAL (record a payment - amount is editable, not just
//  "mark the suggested amount paid")
// ============================================================
let settleContext = null;

function openSettleModal({ fromName, toName, amount, groupId, paidBy, paidTo, groupName }) {
  document.getElementById("settleWho").innerHTML = `${esc(fromName)} <span style="color:var(--muted-2)">→</span> ${esc(toName)}`;
  document.getElementById("settleGroupNote").textContent = groupName ? `Recorded under ${groupName}` : "";
  document.getElementById("settleAmount").value = amount;
  settleContext = { groupId, paidBy, paidTo };
  document.getElementById("settleModal").hidden = false;
}
function closeSettleModal() {
  document.getElementById("settleModal").hidden = true;
  settleContext = null;
}
document.getElementById("closeSettleModal").onclick = closeSettleModal;
document.getElementById("cancelSettle").onclick = closeSettleModal;

document.getElementById("confirmSettle").onclick = async () => {
  const amount = parseFloat(document.getElementById("settleAmount").value);
  if (!amount || amount <= 0) { toast("Enter a valid amount"); return; }
  const { groupId, paidBy, paidTo } = settleContext;
  await api(`/api/groups/${groupId}/settlements`, "POST", { paidBy, paidTo, amount });
  closeSettleModal();
  toast("Payment recorded");
  if (currentView === "group") showGroup(openGroupId);
  else if (currentView === "balances") showBalances();
  else if (currentView === "friends") showFriends();
};

// Cross-group entry point (Balances/Friends): those pages aggregate by
// name across every shared group, so we resolve an actual group + member
// ids to settle under before opening the modal. direction "owed" = they
// owe you (they pay); "owe" = you owe them (you pay).
async function settleWithPerson(personName, amount, direction) {
  const options = await api(`/api/settle-options?a=${encodeURIComponent(viewer)}&b=${encodeURIComponent(personName)}`);
  if (!options.length) { toast("No shared group found to record this in"); return; }
  const opt = options[0];
  const fromName = direction === "owed" ? personName : viewer;
  const toName = direction === "owed" ? viewer : personName;
  const paidBy = direction === "owed" ? opt.memberIdB : opt.memberIdA;
  const paidTo = direction === "owed" ? opt.memberIdA : opt.memberIdB;
  openSettleModal({ fromName, toName, amount, groupId: opt.groupId, paidBy, paidTo, groupName: opt.groupName });
}

// ============================================================
//  ACTIVITY FEED
// ============================================================

// SQLite gives us "YYYY-MM-DD HH:MM:SS" in UTC; turn that into a short
// relative label like "3h ago", falling back to a date once it's old.
function timeAgo(sqliteTs) {
  if (!sqliteTs) return "";
  const then = new Date(sqliteTs.replace(" ", "T") + "Z").getTime();
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function activityRow(e) {
  const who = (name) => esc(name === viewer ? "You" : name);
  let avatarName = "", text = "", meta = "", amt = "";

  if (e.type === "expense_added") {
    avatarName = e.paidByName;
    text = `<strong>${who(e.paidByName)}</strong> added an expense`;
    meta = `${esc(e.description)} · ${esc(e.groupName)} · split ${e.splitCount} way${e.splitCount === 1 ? "" : "s"}`;
    amt = fmt0(e.amount);
  } else if (e.type === "settlement") {
    avatarName = e.paidByName;
    text = `<strong>${who(e.paidByName)}</strong> paid <strong>${who(e.paidToName)}</strong>`;
    meta = esc(e.groupName);
    amt = fmt0(e.amount);
  } else if (e.type === "member_added") {
    avatarName = e.memberName;
    text = `<strong>${who(e.memberName)}</strong> joined the group`;
    meta = esc(e.groupName);
  } else {
    avatarName = e.groupName;
    text = `Group <strong>${esc(e.groupName)}</strong> was created`;
  }

  return `
    <div class="feed-item">
      <div class="avatar sm">${initials(avatarName || "?")}</div>
      <div class="feed-body">
        <div class="feed-text">${text}</div>
        <div class="feed-meta">${meta}${meta ? " · " : ""}${timeAgo(e.created_at)}</div>
      </div>
      ${amt ? `<div class="feed-amt">${amt}</div>` : ""}
    </div>`;
}

async function showActivity() {
  currentView = "activity";
  setViews("activity");
  const el = document.getElementById("view-activity");
  const events = await api("/api/activity");
  const rows = events.length ? events.map(activityRow).join("") : `<div class="empty">No activity yet.</div>`;
  el.innerHTML = `
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Activity</span></div>
      <div class="panel-body">${rows}</div>
    </div>`;
}

// ============================================================
//  EXPENSES (every expense, across every group)
// ============================================================
let expensesCache = [];

async function showExpenses() {
  currentView = "expenses";
  setViews("expenses");
  const el = document.getElementById("view-expenses");
  const [expenses, groups] = await Promise.all([api("/api/expenses"), api("/api/groups")]);
  expensesCache = expenses;

  const groupOptions = `<option value="">All Groups</option>` +
    groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("");

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Expenses</h1><div class="subtle">All expenses across your groups</div></div>
    </div>
    <div class="panel">
      <div class="panel-body" style="padding-top:18px">
        <div class="filter-bar">
          <input type="text" id="expSearch" class="input-bare grow" placeholder="Search expenses..." />
          <div class="select-shell auto">
            <button type="button" class="select-trigger" id="expGroupFilter-trigger"><span class="label">All Groups</span>${svgChevronDown}</button>
            <select id="expGroupFilter">${groupOptions}</select>
          </div>
          <div class="select-shell auto">
            <button type="button" class="select-trigger" id="expRangeFilter-trigger"><span class="label">All Time</span>${svgChevronDown}</button>
            <select id="expRangeFilter">
              <option value="all">All Time</option>
              <option value="month">This Month</option>
              <option value="week">Last 7 Days</option>
            </select>
          </div>
        </div>
        <table class="tbl">
          <thead><tr><th>Description</th><th>Group</th><th>Paid by</th><th>Amount</th><th>Split</th><th>Date</th><th></th></tr></thead>
          <tbody id="expTableBody"></tbody>
        </table>
      </div>
    </div>`;

  document.getElementById("expSearch").oninput = renderExpenseRows;
  document.getElementById("expGroupFilter").onchange = renderExpenseRows;
  document.getElementById("expRangeFilter").onchange = renderExpenseRows;
  initSelectTrigger("expGroupFilter");
  initSelectTrigger("expRangeFilter");
  renderExpenseRows();
}

function renderExpenseRows() {
  const search = document.getElementById("expSearch").value.trim().toLowerCase();
  const groupId = document.getElementById("expGroupFilter").value;
  const range = document.getElementById("expRangeFilter").value;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const now = Date.now();

  const filtered = expensesCache.filter((e) => {
    if (search && !e.description.toLowerCase().includes(search)) return false;
    if (groupId && String(e.groupId) !== groupId) return false;
    if (range === "month" && !(e.date || "").startsWith(monthPrefix)) return false;
    if (range === "week") {
      const t = new Date(`${e.date}T00:00:00Z`).getTime();
      if (now - t > 7 * 86400000) return false;
    }
    return true;
  });

  document.getElementById("expTableBody").innerHTML = filtered.length
    ? filtered.map((e) => `
        <tr>
          <td>${esc(e.description)}</td>
          <td>${esc(e.groupName)}</td>
          <td><div class="who"><div class="avatar sm">${initials(e.paidByName)}</div>${esc(e.paidByName === viewer ? "You" : e.paidByName)}</div></td>
          <td class="amt">${fmt(e.amount)}</td>
          <td><span class="group-meta">split ${e.splitCount} way${e.splitCount === 1 ? "" : "s"}</span></td>
          <td><span class="group-meta">${esc(formatDate(e.date))}</span></td>
          <td>
            <div class="row-actions">
              <button class="icon-btn" title="Expense actions" onclick="event.stopPropagation(); openExpenseActionsMenu(this, ${e.id}, ${e.groupId})">${svgDots}</button>
            </div>
          </td>
        </tr>`).join("")
    : `<tr><td colspan="7" class="empty">No expenses match your filters.</td></tr>`;
}

// ============================================================
//  BALANCES (overall summary across every group)
// ============================================================
async function showBalances() {
  currentView = "balances";
  setViews("balances");
  const el = document.getElementById("view-balances");
  const b = await api(`/api/balances?name=${encodeURIComponent(viewer)}`);

  const owedRows = b.owedToYou.length
    ? b.owedToYou.map((f) => `
        <div class="bal-row"><div class="who"><div class="avatar sm">${initials(f.name)}</div>${esc(f.name)}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="pos" style="font-weight:600">owes you ${fmt(f.amount)}</span>
            <button class="mini-btn" onclick="settleWithPerson('${esc(f.name).replace(/'/g, "\\'")}',${f.amount},'owed')">settle up</button>
          </div></div>`).join("")
    : `<div class="empty">No one owes you anything.</div>`;

  const oweRows = b.youOweList.length
    ? b.youOweList.map((f) => `
        <div class="bal-row"><div class="who"><div class="avatar sm">${initials(f.name)}</div>${esc(f.name)}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="neg" style="font-weight:600">you owe ${fmt(f.amount)}</span>
            <button class="mini-btn" onclick="settleWithPerson('${esc(f.name).replace(/'/g, "\\'")}',${f.amount},'owe')">settle up</button>
          </div></div>`).join("")
    : `<div class="empty">You don't owe anyone.</div>`;

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Balances</h1><div class="subtle">Overview of what you owe and what you are owed</div></div>
    </div>
    <div class="summary-grid cols-3">
      <div class="stat">
        <div class="stat-top"><div class="stat-ico bal">${svgWallet}</div><div><div class="stat-label">Overall balance</div></div></div>
        <div class="stat-value ${b.overallBalance >= 0 ? "pos" : "neg"}">${fmt(Math.abs(b.overallBalance))}</div>
        <div class="stat-sub">${b.overallBalance >= 0 ? "in your favor" : "you owe overall"}</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owed">${svgOwed}</div><div><div class="stat-label">You are owed</div></div></div>
        <div class="stat-value pos">${fmt(b.youAreOwed)}</div>
        <div class="stat-sub">by ${b.owedToYou.length} ${b.owedToYou.length === 1 ? "person" : "people"}</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owe">${svgOwe}</div><div><div class="stat-label">You owe</div></div></div>
        <div class="stat-value neg">${fmt(b.youOwe)}</div>
        <div class="stat-sub">to ${b.youOweList.length} ${b.youOweList.length === 1 ? "person" : "people"}</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-head"><span class="panel-title">You are owed</span></div><div class="panel-body">${owedRows}</div></div>
      <div class="panel"><div class="panel-head"><span class="panel-title">You owe</span></div><div class="panel-body">${oweRows}</div></div>
    </div>`;
}

// ============================================================
//  FRIENDS (everyone you share a group with)
// ============================================================
let friendsCache = [];

async function showFriends() {
  currentView = "friends";
  setViews("friends");
  const el = document.getElementById("view-friends");
  friendsCache = await api(`/api/friends?name=${encodeURIComponent(viewer)}`);

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Friends</h1><div class="subtle">Your friends on SplitWise</div></div>
    </div>
    <div class="panel">
      <div class="panel-body" style="padding-top:18px">
        <input type="text" id="friendSearch" class="input-bare" style="width:100%;margin-bottom:14px" placeholder="Search friends..." />
        <div id="friendRows"></div>
      </div>
    </div>`;

  document.getElementById("friendSearch").oninput = renderFriendRows;
  renderFriendRows();
}

function renderFriendRows() {
  const search = document.getElementById("friendSearch").value.trim().toLowerCase();
  const filtered = friendsCache.filter((f) => f.name.toLowerCase().includes(search));

  document.getElementById("friendRows").innerHTML = filtered.length
    ? filtered.map((f) => {
        const cls = f.amount > 0.004 ? "pos" : f.amount < -0.004 ? "neg" : "";
        const label = f.amount > 0.004 ? `owes you ${fmt(f.amount)}` : f.amount < -0.004 ? `you owe ${fmt(-f.amount)}` : "settled up";
        const safeName = esc(f.name).replace(/'/g, "\\'");
        const settleBtn = f.amount > 0.004
          ? `<button class="mini-btn" onclick="settleWithPerson('${safeName}',${f.amount},'owed')">settle up</button>`
          : f.amount < -0.004
            ? `<button class="mini-btn" onclick="settleWithPerson('${safeName}',${-f.amount},'owe')">settle up</button>`
            : "";
        return `<div class="bal-row">
          <div class="who"><div class="avatar sm">${initials(f.name)}</div>${esc(f.name)}
            <span class="group-meta" style="margin-left:8px">${f.groupsShared} group${f.groupsShared === 1 ? "" : "s"}</span></div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="${cls}" style="font-weight:600">${label}</span>
            ${settleBtn}
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">No friends found.</div>`;
}

// ============================================================
//  STATISTICS
// ============================================================
// Validated 8-hue categorical order (dataviz skill default palette) - fixed
// ordering is the CVD-safety mechanism, so it's never reshuffled at render time.
const CATEGORICAL_HUES = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];

let statsRange = "all";

async function showStatistics() {
  currentView = "statistics";
  setViews("statistics");
  const el = document.getElementById("view-statistics");
  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Statistics</h1><div class="subtle">Overview of your spending</div></div>
      <div class="select-shell auto">
        <button type="button" class="select-trigger" id="statsRangeSelect-trigger"><span class="label">All Time</span>${svgChevronDown}</button>
        <select id="statsRangeSelect">
          <option value="all">All Time</option>
          <option value="month">This Month</option>
        </select>
      </div>
    </div>
    <div id="statsBody"></div>`;

  const sel = document.getElementById("statsRangeSelect");
  sel.value = statsRange;
  sel.onchange = (e) => { statsRange = e.target.value; renderStatistics(); };
  initSelectTrigger("statsRangeSelect");
  await renderStatistics();
}

async function renderStatistics() {
  const [stats, groups] = await Promise.all([api(`/api/statistics?range=${statsRange}`), api("/api/groups")]);
  // Color assignment keyed to a stable group order (by id), not the current
  // sorted-by-amount order, so a group's color never shifts as the ranking does.
  const stableNames = groups.slice().sort((a, b) => a.id - b.id).map((g) => g.name);

  document.getElementById("statsBody").innerHTML = `
    <div class="summary-grid">
      <div class="stat">
        <div class="stat-top"><div class="stat-ico exp">${svgPie}</div><div><div class="stat-label">Total expenses</div></div></div>
        <div class="stat-value">${fmt0(stats.totalExpenses)}</div>
        <div class="stat-sub">${statsRange === "month" ? "this month" : "all time"}</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico bal">${svgWallet}</div><div><div class="stat-label">Average per day</div></div></div>
        <div class="stat-value">${fmt0(stats.avgPerDay)}</div>
        <div class="stat-sub">per active day</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owed">${svgOwed}</div><div><div class="stat-label">Total transactions</div></div></div>
        <div class="stat-value">${stats.totalTransactions}</div>
        <div class="stat-sub">expenses logged</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owe">${svgOwe}</div><div><div class="stat-label">Active groups</div></div></div>
        <div class="stat-value">${stats.activeGroups}</div>
        <div class="stat-sub">with spending</div>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Expenses over time</span></div>
        <div class="panel-body">${lineChartSVG(stats.series)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Spend by group</span></div>
        <div class="panel-body">${groupBarsHTML(stats.byGroup, stableNames)}</div>
      </div>
    </div>`;
}

// Single-series line + area chart. One series needs no legend (the panel
// title names it); points carry a native tooltip via <title>.
function lineChartSVG(series) {
  if (!series.length) return `<div class="empty">No expenses yet.</div>`;
  const W = 560, H = 200, padL = 10, padR = 10, padT = 16, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  const maxV = Math.max(...series.map((d) => d.amount), 1);
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v) => padT + innerH - (v / maxV) * innerH;

  const points = series.map((d, i) => `${x(i)},${y(d.amount)}`).join(" ");
  const areaPoints = `${x(0)},${padT + innerH} ${points} ${x(n - 1)},${padT + innerH}`;
  const dots = series.map((d, i) =>
    `<circle cx="${x(i)}" cy="${y(d.amount)}" r="3.5" fill="var(--green-dark)"><title>${esc(formatDate(d.date))} · ${esc(fmt(d.amount))}</title></circle>`
  ).join("");
  const gridLines = [0, 0.5, 1].map((f) => {
    const gy = padT + innerH * (1 - f);
    return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>`;
  }).join("");
  const tickIdxs = [...new Set(n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1])];
  const xLabels = tickIdxs.map((i) =>
    `<text x="${x(i)}" y="${H - 8}" font-size="10.5" fill="var(--muted-2)" text-anchor="middle">${esc(formatDateShort(series[i].date))}</text>`
  ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:100%;display:block">
    ${gridLines}
    <polyline points="${areaPoints}" fill="var(--green-tint)" stroke="none"/>
    <polyline points="${points}" fill="none" stroke="var(--green-dark)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    ${xLabels}
  </svg>`;
}

// Horizontal bar list for group spend. Three of these hues sit below 3:1
// contrast on a white surface, so the group name is always a visible direct
// label next to the bar - never color-alone.
function groupBarsHTML(byGroup, stableNames) {
  if (!byGroup.length) return `<div class="empty">No expenses yet.</div>`;
  const colorFor = (name) => {
    const idx = stableNames.indexOf(name);
    return CATEGORICAL_HUES[(idx >= 0 ? idx : 0) % CATEGORICAL_HUES.length];
  };
  const max = Math.max(...byGroup.map((g) => g.amount), 1);
  return byGroup.map((g) => `
    <div class="bar-row">
      <div class="bar-label">${esc(g.groupName)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, (g.amount / max) * 100)}%;background:${colorFor(g.groupName)}"></div></div>
      <div class="bar-amt">${fmt0(g.amount)}</div>
    </div>`).join("");
}

// ============================================================
//  PROFILE
// ============================================================
async function showProfile() {
  currentView = "profile";
  setViews("profile");
  const el = document.getElementById("view-profile");

  if (!viewer) {
    el.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty">Pick a name from "Viewing as" first.</div></div></div>`;
    return;
  }

  const [profile, dash, activity, stats] = await Promise.all([
    api(`/api/profile?name=${encodeURIComponent(viewer)}`),
    api(`/api/dashboard?name=${encodeURIComponent(viewer)}`),
    api("/api/activity"),
    api("/api/statistics?range=all"),
  ]);
  const groups = await api("/api/groups");
  const stableNames = groups.slice().sort((a, b) => a.id - b.id).map((g) => g.name);

  const photo = profile.avatarUrl
    ? `<img src="${esc(profile.avatarUrl)}" alt="">`
    : initials(viewer);

  const contactRows = [
    profile.email && [svgMail, esc(profile.email)],
    profile.phone && [svgPhone, esc(profile.phone)],
    profile.location && [svgPin, esc(profile.location)],
    profile.joinedAt && [svgCalendar, `Joined ${esc(formatDate(profile.joinedAt))}`],
  ].filter(Boolean).map(([icon, text]) => `<div class="row">${icon}<span>${text}</span></div>`).join("");

  const paymentRows = [
    profile.upiId && ["UPI ID", profile.upiId],
    profile.paytm && ["Paytm", profile.paytm],
    profile.gpay && ["Google Pay", profile.gpay],
  ].filter(Boolean).map(([label, value]) => `
    <div class="bal-row"><span class="group-meta">${esc(label)}</span><span style="font-weight:600">${esc(value)}</span></div>`).join("")
    || `<div class="empty">No payment methods added yet.</div>`;

  const topGroupsRows = dash.groups.length
    ? dash.groups.slice(0, 5).map((g) => {
        const cls = g.yourBalance > 0 ? "pos" : g.yourBalance < 0 ? "neg" : "";
        const label = !g.inGroup ? "not a member" : g.yourBalance > 0 ? "you are owed" : g.yourBalance < 0 ? "you owe" : "settled up";
        return `<div class="bal-row">
          <div class="who">${g.emoji || groupEmoji(g.name)} ${esc(g.name)} <span class="group-meta" style="margin-left:6px">${g.memberCount} member${g.memberCount === 1 ? "" : "s"}</span></div>
          <span class="${cls}" style="font-weight:600">${label}${g.yourBalance ? " · " + fmt(Math.abs(g.yourBalance)) : ""}</span>
        </div>`;
      }).join("")
    : `<div class="empty">Not in any groups yet.</div>`;

  const activityRows = activity.slice(0, 5).map(activityRow).join("") || `<div class="empty">Nothing yet.</div>`;

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">My Profile</h1><div class="subtle">Manage your account and preferences</div></div>
    </div>
    <div class="panel">
      <div class="panel-body" style="padding-top:20px">
        <div class="profile-head">
          <div class="profile-photo">${photo}</div>
          <div style="flex:1;min-width:200px">
            <div class="profile-name">${esc(viewer)} ${profile.userId ? `<span class="group-meta" style="font-weight:500">ID: ${esc(profile.userId)}</span>` : ""}</div>
            ${profile.bio ? `<div class="profile-bio">${esc(profile.bio)}</div>` : ""}
            <div class="profile-contact">${contactRows || `<div class="empty" style="padding:0;text-align:left">No contact info added yet.</div>`}</div>
            <button class="btn-ghost" id="editProfileBtn" style="margin-top:14px">Edit profile</button>
          </div>
        </div>
      </div>
    </div>
    <div class="summary-grid">
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owed">${svgOwed}</div><div><div class="stat-label">You are owed</div></div></div>
        <div class="stat-value pos">${fmt(dash.youAreOwed)}</div>
        <div class="stat-sub">across your groups</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico owe">${svgOwe}</div><div><div class="stat-label">You owe</div></div></div>
        <div class="stat-value neg">${fmt(dash.youOwe)}</div>
        <div class="stat-sub">to others</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico bal">${svgWallet}</div><div><div class="stat-label">Total balance</div></div></div>
        <div class="stat-value ${dash.totalBalance >= 0 ? "pos" : "neg"}">${fmt(Math.abs(dash.totalBalance))}</div>
        <div class="stat-sub">${dash.totalBalance >= 0 ? "in your favor" : "you owe overall"}</div>
      </div>
      <div class="stat">
        <div class="stat-top"><div class="stat-ico exp">${svgPie}</div><div><div class="stat-label">Total expenses</div></div></div>
        <div class="stat-value">${fmt0(dash.totalExpensesThisMonth)}</div>
        <div class="stat-sub">this month</div>
      </div>
    </div>
    <div class="content-grid">
      <div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Top Groups</span><button class="panel-link" onclick="showGroups()">View all</button></div>
          <div class="panel-body">${topGroupsRows}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Payment Methods</span></div>
          <div class="panel-body">${paymentRows}</div>
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Spending by Group</span></div>
          <div class="panel-body">${groupBarsHTML(stats.byGroup, stableNames)}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">Recent Activity</span><button class="panel-link" onclick="showActivity()">View all</button></div>
          <div class="panel-body">${activityRows}</div>
        </div>
      </div>
    </div>`;

  document.getElementById("editProfileBtn").onclick = () => openEditProfileModal(profile);
}

function openEditProfileModal(profile) {
  document.getElementById("pUserIdLine").textContent = profile.userId ? `User ID: ${profile.userId}` : "";
  document.getElementById("pName").value = profile.name;
  document.getElementById("pNameMsg").hidden = true;
  document.getElementById("pAvatarUrl").value = profile.avatarUrl;
  document.getElementById("pEmail").value = profile.email;
  document.getElementById("pPhone").value = profile.phone;
  document.getElementById("pLocation").value = profile.location;
  document.getElementById("pBio").value = profile.bio;
  document.getElementById("pUpi").value = profile.upiId;
  document.getElementById("pPaytm").value = profile.paytm;
  document.getElementById("pGpay").value = profile.gpay;
  document.getElementById("pCurrentPassword").value = "";
  document.getElementById("pNewPassword").value = "";
  document.getElementById("pPasswordMsg").hidden = true;
  document.getElementById("editProfileModal").hidden = false;
}
function closeEditProfileModal() { document.getElementById("editProfileModal").hidden = true; }
document.getElementById("closeEditProfileModal").onclick = closeEditProfileModal;

document.getElementById("updateNameBtn").onclick = async () => {
  const newName = document.getElementById("pName").value.trim();
  const msg = document.getElementById("pNameMsg");
  msg.hidden = true;
  if (!newName) { msg.textContent = "Enter a name."; msg.hidden = false; return; }

  const res = await fetch("/api/auth/change-name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newName }),
  });
  const data = await res.json();
  if (!res.ok) { msg.textContent = data.error || "Could not update name."; msg.hidden = false; return; }

  viewer = data.name;
  localStorage_set("viewer", viewer);
  closeEditProfileModal();
  toast("Name updated");
  await loadPeople();
  showProfile();
};

document.getElementById("updatePasswordBtn").onclick = async () => {
  const currentPassword = document.getElementById("pCurrentPassword").value;
  const newPassword = document.getElementById("pNewPassword").value;
  const msg = document.getElementById("pPasswordMsg");
  msg.hidden = true;

  const res = await fetch("/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error || "Could not update password.";
    msg.hidden = false;
    return;
  }
  document.getElementById("pCurrentPassword").value = "";
  document.getElementById("pNewPassword").value = "";
  toast("Password updated");
};
document.getElementById("cancelEditProfile").onclick = closeEditProfileModal;

document.getElementById("saveEditProfile").onclick = async () => {
  await api("/api/profile", "PATCH", {
    name: viewer,
    avatarUrl: document.getElementById("pAvatarUrl").value.trim(),
    email: document.getElementById("pEmail").value.trim(),
    phone: document.getElementById("pPhone").value.trim(),
    location: document.getElementById("pLocation").value.trim(),
    bio: document.getElementById("pBio").value.trim(),
    upiId: document.getElementById("pUpi").value.trim(),
    paytm: document.getElementById("pPaytm").value.trim(),
    gpay: document.getElementById("pGpay").value.trim(),
  });
  closeEditProfileModal();
  toast("Profile updated");
  showProfile();
};

// ============================================================
//  PLACEHOLDER PAGES
// ============================================================
function showPlaceholder(title) {
  currentView = "placeholder";
  setViews("placeholder");
  document.getElementById("view-placeholder").innerHTML = `
    <div class="panel">
      <div class="panel-body" style="padding:60px 20px;text-align:center">
        <div style="font-size:34px;margin-bottom:12px">${svgSpark}</div>
        <div class="panel-title" style="margin-bottom:6px">${esc(title)}</div>
        <p class="subtle">This section is coming soon. The core expense-splitting features live on the Dashboard.</p>
      </div>
    </div>`;
}

// ============================================================
//  EXPENSE MODAL (4 split modes)
// ============================================================
let modalGroupId = null;
let modalMembers = [];
let editingExpenseId = null;

// Pass an expenseId to edit that expense instead of creating a new one.
// Editing always reopens in "exact" mode, prefilled with each member's
// current amount_owed - that's the only split data the DB actually keeps
// (splitType itself is never stored, only its computed result).
async function openExpenseModal(groupId, expenseId = null) {
  // If no group chosen (from top bar), default to the first group.
  const groups = await api("/api/groups");
  if (groups.length === 0) { toast("Create a group first"); openGroupModal(); return; }

  editingExpenseId = expenseId;
  const editData = expenseId ? await api(`/api/expenses/${expenseId}`) : null;
  modalGroupId = editData ? editData.group_id : (groupId || openGroupId || groups[0].id);

  const gSel = document.getElementById("mGroup");
  gSel.innerHTML = groups.map((g) => `<option value="${g.id}"${g.id === modalGroupId ? " selected" : ""}>${esc(g.name)}</option>`).join("");
  gSel.onchange = async () => { modalGroupId = Number(gSel.value); await loadModalMembers(); };
  syncSelectTrigger("mGroup");
  // Moving an expense between groups isn't supported - the split's member
  // ids belong to whichever group it was created in.
  gSel.disabled = !!editData;
  document.getElementById("mGroup-trigger").disabled = !!editData;

  document.getElementById("mSplitType").value = editData ? "exact" : "equal";
  syncSelectTrigger("mSplitType");
  await loadModalMembers();

  document.getElementById("mDesc").value = editData ? editData.description : "";
  document.getElementById("mAmount").value = editData ? editData.amount : "";
  document.getElementById("mDate").value = editData ? editData.date : new Date().toISOString().slice(0, 10);
  document.getElementById("expenseModalTitle").textContent = editData ? "Edit expense" : "New expense";
  document.getElementById("saveExpense").textContent = editData ? "Save changes" : "Add expense";

  if (editData) {
    document.getElementById("mPayer").value = String(editData.paid_by);
    syncSelectTrigger("mPayer");
    const owedByMember = {};
    editData.splits.forEach((s) => (owedByMember[s.member_id] = s.amount_owed));
    document.querySelectorAll(".sp-amt").forEach((input) => {
      const owed = owedByMember[Number(input.dataset.id)];
      input.value = owed ? owed : "";
    });
    updateSplitHint();
  }

  document.getElementById("expenseModal").hidden = false;
}

async function loadModalMembers() {
  const s = await api(`/api/groups/${modalGroupId}/state`);
  modalMembers = s.members;
  document.getElementById("mPayer").innerHTML = modalMembers.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  syncSelectTrigger("mPayer");
  renderSplitRows();
}

document.getElementById("mSplitType").onchange = renderSplitRows;
document.getElementById("mAmount").addEventListener("input", updateSplitHint);

function renderSplitRows() {
  const mode = document.getElementById("mSplitType").value;
  const box = document.getElementById("mSplitInputs");
  box.innerHTML = modalMembers.map((m) => {
    const av = `<div class="avatar sm">${initials(m.name)}</div>`;
    const nameAttr = `data-name="${esc(m.name.toLowerCase())}"`;
    if (mode === "equal")
      return `<div class="split-line" ${nameAttr}><span class="name">${av}${esc(m.name)}</span><input type="checkbox" class="sp-eq" data-id="${m.id}" checked></div>`;
    if (mode === "exact")
      return `<div class="split-line" ${nameAttr}><span class="name">${av}${esc(m.name)}</span><span style="display:flex;align-items:center;gap:6px"><span class="suffix">\u20b9</span><input type="number" class="sp-amt" data-id="${m.id}" min="0" step="0.01" placeholder="0" oninput="updateSplitHint()"></span></div>`;
    if (mode === "percent")
      return `<div class="split-line" ${nameAttr}><span class="name">${av}${esc(m.name)}</span><span style="display:flex;align-items:center;gap:6px"><input type="number" class="sp-pct" data-id="${m.id}" min="0" step="0.1" placeholder="0" oninput="updateSplitHint()"><span class="suffix">%</span></span></div>`;
    // shares
    return `<div class="split-line" ${nameAttr}><span class="name">${av}${esc(m.name)}</span><span style="display:flex;align-items:center;gap:6px"><input type="number" class="sp-sh" data-id="${m.id}" min="0" step="1" value="1" oninput="updateSplitHint()"><span class="suffix">share(s)</span></span></div>`;
  }).join("");

  const searchBox = document.getElementById("mSplitSearch");
  searchBox.value = "";
  filterSplitRows();
  document.getElementById("selectAllBtn").hidden = mode !== "equal";
  document.getElementById("selectNoneBtn").hidden = mode !== "equal";
  updateSplitHint();
}

// Filters rows in place (hide/show) rather than re-rendering, so values
// already typed for hidden rows (exact/percent/shares) aren't lost.
function filterSplitRows() {
  const q = document.getElementById("mSplitSearch").value.trim().toLowerCase();
  document.querySelectorAll("#mSplitInputs .split-line").forEach((row) => {
    row.hidden = q.length > 0 && !row.dataset.name.includes(q);
  });
}
document.getElementById("mSplitSearch").oninput = filterSplitRows;

document.getElementById("selectAllBtn").onclick = () => {
  document.querySelectorAll("#mSplitInputs .split-line:not([hidden]) .sp-eq").forEach((c) => (c.checked = true));
  updateSplitHint();
};
document.getElementById("selectNoneBtn").onclick = () => {
  document.querySelectorAll("#mSplitInputs .split-line:not([hidden]) .sp-eq").forEach((c) => (c.checked = false));
  updateSplitHint();
};

function updateSplitHint() {
  const mode = document.getElementById("mSplitType").value;
  const amount = parseFloat(document.getElementById("mAmount").value) || 0;
  const hint = document.getElementById("mSplitHint");
  hint.className = "split-hint";

  if (mode === "equal") {
    const n = document.querySelectorAll(".sp-eq:checked").length;
    hint.textContent = n ? `${fmt(amount / (n || 1))} each (${n} people)` : "Select at least one person";
  } else if (mode === "exact") {
    let sum = 0; document.querySelectorAll(".sp-amt").forEach((i) => (sum += parseFloat(i.value) || 0));
    const left = Math.round((amount - sum) * 100) / 100;
    if (!amount) { hint.textContent = "Enter the total amount first"; return; }
    hint.textContent = `${fmt(sum)} of ${fmt(amount)} assigned \u00b7 ${fmt(left)} left`;
    hint.classList.add(Math.abs(left) < 0.01 ? "ok" : "bad");
  } else if (mode === "percent") {
    let sum = 0; document.querySelectorAll(".sp-pct").forEach((i) => (sum += parseFloat(i.value) || 0));
    hint.textContent = `${sum}% of 100% assigned`;
    hint.classList.add(Math.abs(sum - 100) < 0.01 ? "ok" : "bad");
  } else {
    let sum = 0; document.querySelectorAll(".sp-sh").forEach((i) => (sum += parseFloat(i.value) || 0));
    const per = sum > 0 ? amount / sum : 0;
    hint.textContent = sum ? `${sum} shares \u00b7 ${fmt(per)} per share` : "Add some shares";
  }
}

function closeExpenseModal() { document.getElementById("expenseModal").hidden = true; }
document.getElementById("closeModal").onclick = closeExpenseModal;
document.getElementById("cancelExpense").onclick = closeExpenseModal;
document.getElementById("newExpenseBtn").onclick = () => openExpenseModal(openGroupId);

document.getElementById("saveExpense").onclick = async () => {
  const description = document.getElementById("mDesc").value.trim();
  const amount = parseFloat(document.getElementById("mAmount").value);
  const paidBy = Number(document.getElementById("mPayer").value);
  const splitType = document.getElementById("mSplitType").value;
  const date = document.getElementById("mDate").value || new Date().toISOString().slice(0, 10);
  if (!description || !amount || amount <= 0 || !paidBy) { toast("Fill in description, amount and payer"); return; }

  const payload = { description, amount, paidBy, splitType, date };
  if (splitType === "equal") {
    payload.splitAmong = Array.from(document.querySelectorAll(".sp-eq:checked")).map((c) => Number(c.dataset.id));
    if (!payload.splitAmong.length) { toast("Select at least one person"); return; }
  } else if (splitType === "exact") {
    payload.splits = Array.from(document.querySelectorAll(".sp-amt")).map((i) => ({ memberId: Number(i.dataset.id), amount: parseFloat(i.value) || 0 })).filter((s) => s.amount > 0);
  } else if (splitType === "percent") {
    payload.splits = Array.from(document.querySelectorAll(".sp-pct")).map((i) => ({ memberId: Number(i.dataset.id), percent: parseFloat(i.value) || 0 })).filter((s) => s.percent > 0);
  } else {
    payload.splits = Array.from(document.querySelectorAll(".sp-sh")).map((i) => ({ memberId: Number(i.dataset.id), shares: parseFloat(i.value) || 0 })).filter((s) => s.shares > 0);
  }

  if (editingExpenseId) {
    await api(`/api/expenses/${editingExpenseId}`, "PATCH", payload);
    toast("Expense updated");
  } else {
    await api(`/api/groups/${modalGroupId}/expenses`, "POST", payload);
    toast("Expense added");
  }
  closeExpenseModal();
  if (currentView === "expenses") showExpenses();
  else if (openGroupId === modalGroupId) showGroup(modalGroupId);
  else showDashboard();
};

// ============================================================
//  NEW GROUP MODAL
// ============================================================
function openGroupModal() {
  document.getElementById("gName").value = "";
  document.getElementById("gMembers").value = "";
  document.getElementById("groupModal").hidden = false;
}
function closeGroupModal() { document.getElementById("groupModal").hidden = true; }
document.getElementById("closeGroupModal").onclick = closeGroupModal;
document.getElementById("cancelGroup").onclick = closeGroupModal;

document.getElementById("saveGroup").onclick = async () => {
  const name = document.getElementById("gName").value.trim();
  if (!name) { toast("Enter a group name"); return; }
  const memberNames = document.getElementById("gMembers").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const group = await api("/api/groups", "POST", { name });
  for (const mn of memberNames) {
    await api(`/api/groups/${group.id}/members`, "POST", { name: mn });
  }
  closeGroupModal();
  await loadPeople();
  toast("Group created");
  showGroup(group.id);
};

// ============================================================
//  EDIT GROUP MODAL (name + logo)
// ============================================================
const GROUP_EMOJI_OPTIONS = ["💰", "🏖️", "⛰️", "🏠", "🍽️", "✈️", "🎉", "🚗", "🎓", "💼", "🎮", "❤️", "🛍️", "⚽", "🎵", "📚"];
let editGroupId = null;
let editGroupEmoji = null;

function openEditGroupModal(group) {
  editGroupId = group.id;
  editGroupEmoji = group.emoji || groupEmoji(group.name);
  document.getElementById("egName").value = group.name;
  renderEmojiGrid();
  document.getElementById("editGroupModal").hidden = false;
}

function renderEmojiGrid() {
  const grid = document.getElementById("egEmojiGrid");
  grid.innerHTML = GROUP_EMOJI_OPTIONS.map((e) =>
    `<button type="button" class="emoji-swatch${e === editGroupEmoji ? " selected" : ""}" data-emoji="${e}">${e}</button>`
  ).join("");
  grid.querySelectorAll(".emoji-swatch").forEach((btn) => {
    btn.onclick = () => {
      editGroupEmoji = btn.dataset.emoji;
      grid.querySelectorAll(".emoji-swatch").forEach((b) => b.classList.toggle("selected", b === btn));
    };
  });
}

function closeEditGroupModal() { document.getElementById("editGroupModal").hidden = true; }
document.getElementById("closeEditGroupModal").onclick = closeEditGroupModal;
document.getElementById("cancelEditGroup").onclick = closeEditGroupModal;

document.getElementById("saveEditGroup").onclick = async () => {
  const name = document.getElementById("egName").value.trim();
  if (!name) { toast("Enter a group name"); return; }
  await api(`/api/groups/${editGroupId}`, "PATCH", { name, emoji: editGroupEmoji });
  closeEditGroupModal();
  toast("Group updated");
  if (currentView === "groups") showGroups();
  else showGroup(editGroupId);
};

// ============================================================
//  MISC
// ============================================================
function groupEmoji(name) {
  const n = name.toLowerCase();
  if (n.includes("trip") || n.includes("goa") || n.includes("beach")) return "\ud83c\udfdd\ufe0f";
  if (n.includes("manali") || n.includes("mountain") || n.includes("trek")) return "\u26f0\ufe0f";
  if (n.includes("flat") || n.includes("home") || n.includes("room") || n.includes("house")) return "\ud83c\udfe0";
  if (n.includes("lunch") || n.includes("dinner") || n.includes("food") || n.includes("office")) return "\ud83c\udf7d\ufe0f";
  return "\ud83d\udcb0";
}

// simple inline SVG glyphs for the stat icons (no external icon lib)
const svgOwed = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>`;
const svgOwe = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
const svgWallet = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>`;
const svgPie = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`;
const svgSpark = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/><circle cx="12" cy="12" r="4"/></svg>`;
const svgTrash = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
const svgChevronLeft = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
const svgEdit = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const svgMail = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>`;
const svgPhone = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;
const svgPin = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
const svgCalendar = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
const svgUser = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const svgCard = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;
const svgSettings = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const svgHelp = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const svgLogout = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
const svgShield = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

// ============================================================
//  ADMIN PANEL (admin-only: view every registered account and
//  log in as any of them without needing their password)
// ============================================================
async function showAdminPanel() {
  currentView = "admin";
  setViews("admin");
  const el = document.getElementById("view-admin");
  const users = await fetch("/api/auth/users").then((r) => r.json());

  const rows = users.map((u) => {
    const isSelf = u.name === viewer;
    const safeName = esc(u.name).replace(/'/g, "\\'");
    return `
    <div class="bal-row">
      <div class="who">
        <div class="avatar sm">${initials(u.name)}</div>${esc(u.name)}
        <span class="group-meta" style="margin-left:8px">${esc(u.userId)}</span>
        ${u.isAdmin ? `<span class="pill pos" style="margin-left:8px">admin</span>` : ""}
        <span class="group-meta" style="margin-left:8px">joined ${esc(formatDate(u.createdAt))}</span>
        ${isSelf ? `<span class="group-meta" style="margin-left:8px">(this is you)</span>` : ""}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn-ghost sm" onclick="adminResetPassword('${safeName}')">Reset password</button>
        ${!isSelf ? `<button class="mini-btn" onclick="impersonate('${safeName}')">Log in as</button>` : ""}
      </div>
    </div>`;
  }).join("") || `<div class="empty">No registered accounts yet.</div>`;

  el.innerHTML = `
    <div class="topbar">
      <div><h1 class="welcome">Admin Panel</h1><div class="subtle">Every registered account - log in as any of them, or reset a forgotten password</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Accounts</span></div>
      <div class="panel-body">${rows}</div>
    </div>`;
}

async function adminResetPassword(name) {
  if (!confirm(`Reset ${name}'s password? Their current password (and any active session) stops working immediately.`)) return;
  const res = await fetch("/api/auth/admin-reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) { toast(data.error || "Could not reset password"); return; }
  alert(`New password for ${data.name}:\n\n${data.newPassword}\n\nShare this with them securely - it won't be shown again.`);
}

async function impersonate(name) {
  const res = await fetch("/api/auth/impersonate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const data = await res.json();
  if (!res.ok) { toast(data.error || "Could not log in as that account"); return; }
  toast(`Logged in as ${data.name}`);
  await enterApp(data.name, data.isAdmin);
}
const svgDots = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;
const svgScale = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 7h4l-2 6a2.5 2.5 0 0 1-2 1 2.5 2.5 0 0 1-2-1z"/><path d="M15 7h4l-2 6a2.5 2.5 0 0 1-2 1 2.5 2.5 0 0 1-2-1z"/><path d="M3 7h18"/></svg>`;
const svgCopy = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const svgEye = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

// ============================================================
//  GROUP ACTIONS MENU (Groups grid card + group detail header)
// ============================================================
function openGroupActionsMenu(anchor, group) {
  openDropdown(anchor, [
    { label: "Edit Group", icon: svgEdit, onClick: () => openEditGroupModal(group) },
    { label: "Add Member", icon: svgUser, onClick: () => addMemberToGroup(group.id) },
    { label: "View Expenses", icon: svgCard, onClick: () => showGroup(group.id) },
    { label: "Settle Up", icon: svgScale, onClick: () => showGroup(group.id) },
    "divider",
    { label: "Delete Group", icon: svgTrash, danger: true, onClick: () => deleteGroupWithConfirm(group) },
  ], { align: "right" });
}

async function addMemberToGroup(groupId) {
  const name = prompt("New member name:");
  if (!name || !name.trim()) return;
  await api(`/api/groups/${groupId}/members`, "POST", { name: name.trim() });
  await loadPeople();
  toast("Member added");
  if (currentView === "group" && openGroupId === groupId) showGroup(groupId);
  else if (currentView === "groups") showGroups();
}

async function deleteGroupWithConfirm(group) {
  const ok = confirm(`Delete "${group.name}"? This permanently removes all its expenses, members and settlements. This can't be undone.`);
  if (!ok) return;
  await api(`/api/groups/${group.id}`, "DELETE");
  toast("Group deleted");
  if (currentView === "groups") showGroups();
  else if (currentView === "group" && openGroupId === group.id) { openGroupId = null; showGroups(); }
  else showDashboard();
}

// map nav icon keywords to small mask SVGs
const NAV_ICONS = {
  home: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  groups: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 .1",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  scale: "M12 3v18M5 7h14l-3 7H8z",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 .1",
  clock: "M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  chart: "M3 3v18h18M7 16v-6M12 16V8M17 16v-3",
  repeat: "M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-4l-.3 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L4 11a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1z",
  help: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
};
document.querySelectorAll(".nav-ico").forEach((el) => {
  const key = el.textContent.trim();
  const path = NAV_ICONS[key] || NAV_ICONS.home;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='${path}'/></svg>`;
  const uri = "url(\"data:image/svg+xml;utf8," + encodeURIComponent(svg) + "\")";
  el.style.webkitMaskImage = uri;
  el.style.maskImage = uri;
  el.textContent = "";
});

// ============================================================
//  BOOT
// ============================================================
(async function init() {
  const me = await fetch("/api/auth/me").then((r) => r.json()).catch(() => ({ name: null }));
  if (me.name) {
    await enterApp(me.name, me.isAdmin);
  } else {
    showAuthScreen();
  }
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
