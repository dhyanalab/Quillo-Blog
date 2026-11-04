// Staff roles in one place: the ranking and the rules for who may manage or grant what.
// Every function takes a user (anything with a `role`) or just the role name.
export const RANK = { owner: 5, admin: 4, editor: 3, author: 2, contributor: 1 };

const roleOf = (x) => (typeof x === "string" ? x : x?.role);
const rankOf = (x) => RANK[roleOf(x)] ?? 0;

// A higher rank than the other person (the owner outranks everyone).
export const outranks = (actor, target) => {
  const a = roleOf(actor);
  const t = roleOf(target);
  if (!Object.hasOwn(RANK, a) || !Object.hasOwn(RANK, t)) return false;
  return a === "owner" || RANK[a] > RANK[t];
};

// May this person change another staff account (role, status, email, password, two-step)? Never their own through this rule.
export function mayManage(actor, target) {
  if (!actor || !target) return false;
  if (typeof actor === "object" && typeof target === "object" && actor.id != null && actor.id === target.id) return false;
  const a = roleOf(actor);
  const t = roleOf(target);
  if (!Object.hasOwn(RANK, a) || !Object.hasOwn(RANK, t)) return false;
  return a === "owner" || RANK[a] > RANK[t];
}

// May this person hand out a role? The owner may grant any role but owner; an administrator may grant editor and below.
export function mayGrant(actor, role) {
  const a = roleOf(actor);
  if (!Object.hasOwn(RANK, a) || !Object.hasOwn(RANK, role)) return false;
  if (a === "owner") return role !== "owner";
  return a === "admin" && RANK[role] < RANK.admin;
}

export const roleRank = rankOf;
