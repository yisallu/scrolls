import test from "node:test";
import assert from "node:assert/strict";

import { igneousLockedOut, adoptExhentaiSession } from "../server/lib/fetcher.js";

const MEMBER = "ipb_member_id=1; ipb_pass_hash=abc; igneous=deaddeaddeaddead1; sk=oldsessionkeyoldsessionkey";

test("igneous=mystery on an empty body is a rejected session, not a logged-out account", () => {
  assert.equal(igneousLockedOut(["igneous=mystery; Max-Age=300; path=/"], 0), true);
  assert.equal(igneousLockedOut("igneous=mystery; Max-Age=300", 40), true);
  // a real page that happens to mention the cookie is not a lockout
  assert.equal(igneousLockedOut(["igneous=mystery; Max-Age=300"], 8000), false);
  assert.equal(igneousLockedOut(["igneous=freshfreshfresh12; Max-Age=2592000"], 0), false);
  assert.equal(igneousLockedOut([], 0), false);
});

test("refresh drops the rejected session and keeps the login plus a new pair", () => {
  const next = adoptExhentaiSession(MEMBER, [
    "igneous=freshfreshfresh12; expires=Thu, 22-Oct-2026 12:19:02 GMT; Max-Age=2592000; path=/",
    "sk=newsessionkeynewsessionkey12; Max-Age=31536000; path=/",
    "yay=louder; path=/",
  ]);
  assert.equal(
    next,
    "ipb_member_id=1; ipb_pass_hash=abc; igneous=freshfreshfresh12; sk=newsessionkeynewsessionkey12"
  );
});

test("a mystery reissue is not stored, and the dead pair is still forgotten", () => {
  const next = adoptExhentaiSession(MEMBER, ["igneous=mystery; Max-Age=300; path=/"]);
  assert.equal(next, "ipb_member_id=1; ipb_pass_hash=abc");
});
