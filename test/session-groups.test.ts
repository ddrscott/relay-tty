import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sortSessions, groupByCwd } from "../app/lib/session-groups.js";
import type { Session } from "../shared/types.js";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    command: "bash",
    args: [],
    cwd: "/Users/test/code/project",
    createdAt: 1000,
    lastActivity: 1000,
    status: "running",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

const ids = (sessions: Session[]) => sessions.map((s) => s.id);

describe("sortSessions name", () => {
  it("ignores animated spinner prefixes so order is stable across title frames", () => {
    // Claude Code animates the terminal title with a leading spinner glyph
    // (braille frames ⠋⠙⠹… or ✳). The glyph must not affect name order.
    const frame1 = [
      makeSession({ id: "a", title: "⠋ alpha task", createdAt: 1 }),
      makeSession({ id: "b", title: "⠹ beta task", createdAt: 2 }),
      makeSession({ id: "c", title: "✳ gamma task", createdAt: 3 }),
    ];
    const frame2 = [
      makeSession({ id: "a", title: "⠼ alpha task", createdAt: 1 }),
      makeSession({ id: "b", title: "⠋ beta task", createdAt: 2 }),
      makeSession({ id: "c", title: "⠧ gamma task", createdAt: 3 }),
    ];
    // Note: "desc" is the default direction and yields A→Z for name sort.
    const order1 = ids(sortSessions(frame1, "name", "desc"));
    const order2 = ids(sortSessions(frame2, "name", "desc"));
    assert.deepEqual(order1, ["a", "b", "c"]);
    assert.deepEqual(order2, order1);
  });

  it("breaks name ties deterministically regardless of input order", () => {
    const a = makeSession({ id: "a", title: "✳ Claude Code", createdAt: 1 });
    const b = makeSession({ id: "b", title: "⠋ Claude Code", createdAt: 2 });
    const c = makeSession({ id: "c", title: "Claude Code", createdAt: 3 });
    const order1 = ids(sortSessions([a, b, c], "name", "desc"));
    const order2 = ids(sortSessions([c, a, b], "name", "desc"));
    const order3 = ids(sortSessions([b, c, a], "name", "desc"));
    assert.deepEqual(order2, order1);
    assert.deepEqual(order3, order1);
  });
});

describe("sortSessions created", () => {
  it("is deterministic regardless of input order, including createdAt ties", () => {
    const a = makeSession({ id: "a", createdAt: 100 });
    const b = makeSession({ id: "b", createdAt: 200 });
    const c = makeSession({ id: "c", createdAt: 200 });
    const order1 = ids(sortSessions([a, b, c], "created", "desc"));
    const order2 = ids(sortSessions([c, b, a], "created", "desc"));
    const order3 = ids(sortSessions([b, a, c], "created", "desc"));
    assert.deepEqual(order1[2], "a");
    assert.deepEqual(order2, order1);
    assert.deepEqual(order3, order1);
  });
});

describe("groupByCwd", () => {
  it("keeps folders alphabetical while sessions sort within each folder", () => {
    const sessions = [
      makeSession({ id: "a", cwd: "/Users/test/zebra", createdAt: 1 }),
      makeSession({ id: "b", cwd: "/Users/test/alpha", createdAt: 2 }),
      makeSession({ id: "c", cwd: "/Users/test/alpha", createdAt: 3 }),
    ];
    const groups = groupByCwd(sessions, "created", "desc");
    assert.deepEqual(groups.map((g) => g.label), ["~/alpha", "~/zebra"]);
    assert.deepEqual(ids(groups[0].sessions), ["c", "b"]);
  });
});
