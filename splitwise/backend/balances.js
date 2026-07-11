// balances.js
// Pure logic for computing balances and simplifying debts.
// Kept separate from the database and web-server code so it's easy to
// read, test, and reason about.

// Given a group's members, expenses (with splits), and settlements,
// return a map of { memberId: netBalance }.
//   positive balance => the group owes this person (they are owed money)
//   negative balance => this person owes the group
function computeBalances(members, expenseSplits, expenses, settlements) {
  const balance = {};
  members.forEach((m) => (balance[m.id] = 0));

  // Each expense: the payer is credited the full amount...
  expenses.forEach((e) => {
    balance[e.paid_by] += e.amount;
  });

  // ...and each person on the split owes their share.
  expenseSplits.forEach((s) => {
    balance[s.member_id] -= s.amount_owed;
  });

  // Settlements move money: the payer's debt shrinks, the receiver's
  // credit shrinks too.
  settlements.forEach((s) => {
    balance[s.paid_by] += s.amount;
    balance[s.paid_to] -= s.amount;
  });

  // Round to 2 decimals to avoid floating-point dust.
  Object.keys(balance).forEach((id) => {
    balance[id] = Math.round(balance[id] * 100) / 100;
  });

  return balance;
}

// Turn a balance map into the minimum set of payments needed to settle
// everyone up. Greedy algorithm: repeatedly match the biggest debtor to
// the biggest creditor.
function simplifyDebts(balance) {
  const creditors = []; // people owed money
  const debtors = []; // people who owe money

  Object.entries(balance).forEach(([id, amt]) => {
    if (amt > 0.01) creditors.push({ id: Number(id), amt });
    else if (amt < -0.01) debtors.push({ id: Number(id), amt: -amt });
  });

  // Biggest amounts first so we clear large debts efficiently.
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transactions = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    transactions.push({
      from: debtors[i].id,
      to: creditors[j].id,
      amount: Math.round(pay * 100) / 100,
    });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.01) i++;
    if (creditors[j].amt < 0.01) j++;
  }

  return transactions;
}

module.exports = { computeBalances, simplifyDebts };
