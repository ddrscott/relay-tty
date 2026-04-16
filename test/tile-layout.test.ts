import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyLayout,
  createLayoutWithTerminal,
  deserializeLayout,
  findColumnOf,
  findNodeBySessionId,
  getAllSessionIds,
  insertAfterColumn,
  insertAtEnd,
  insertAtStart,
  moveColumn,
  reconcile,
  removeSession,
  resizeSplit,
  serializeLayout,
  splitLeafVertical,
  type SplitNode,
  type TileLayout,
} from "../shared/tile-layout.js";

function rootSplit(layout: TileLayout): SplitNode {
  assert.ok(layout.root && layout.root.type === "split", "expected split root");
  return layout.root;
}

describe("tile-layout: construction", () => {
  it("creates an empty layout", () => {
    const l = createEmptyLayout();
    assert.equal(l.root, null);
    assert.equal(l.version, 1);
  });

  it("creates a single-terminal layout", () => {
    const l = createLayoutWithTerminal("sess1");
    assert.ok(l.root && l.root.type === "terminal");
    assert.equal(l.root.sessionId, "sess1");
  });
});

describe("tile-layout: insertAtStart (prepend)", () => {
  it("prepends into empty layout", () => {
    const l = insertAtStart(createEmptyLayout(), "a");
    assert.deepEqual(getAllSessionIds(l), ["a"]);
  });

  it("wraps a single terminal in horizontal root with new at front", () => {
    let l = createLayoutWithTerminal("old");
    l = insertAtStart(l, "new");
    assert.deepEqual(getAllSessionIds(l), ["new", "old"]);
    assert.equal(rootSplit(l).direction, "horizontal");
  });

  it("prepends onto an existing horizontal root with equal sizes", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtStart(l, "b"); // [b, a]
    l = insertAtStart(l, "c"); // [c, b, a]
    assert.deepEqual(getAllSessionIds(l), ["c", "b", "a"]);
    const split = rootSplit(l);
    assert.equal(split.children.length, 3);
    assert.deepEqual(
      split.sizes.map((s) => Math.round(s * 100) / 100),
      [33.33, 33.33, 33.33],
    );
  });
});

describe("tile-layout: insertAtEnd (append)", () => {
  it("appends onto horizontal root", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    l = insertAtEnd(l, "c");
    assert.deepEqual(getAllSessionIds(l), ["a", "b", "c"]);
  });
});

describe("tile-layout: insertAfterColumn", () => {
  it("inserts after the column containing the target", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    l = insertAtEnd(l, "c"); // [a, b, c]
    const target = findNodeBySessionId(l, "b")!;
    const newL = insertAfterColumn(l, target.id, "NEW");
    assert.deepEqual(getAllSessionIds(newL), ["a", "b", "NEW", "c"]);
  });

  it("inserts after column when target is nested in a vertical split", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    const aNode = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, aNode.id, "a2"); // column 0 becomes v-split[a, a2]
    const a2 = findNodeBySessionId(l, "a2")!;
    const newL = insertAfterColumn(l, a2.id, "NEW");
    // Expect [col0(a,a2), NEW, b] — new column sits between old col-0 and col-1.
    const split = rootSplit(newL);
    assert.equal(split.children.length, 3);
    assert.equal(split.children[1].type, "terminal");
    if (split.children[1].type === "terminal") {
      assert.equal(split.children[1].sessionId, "NEW");
    }
  });
});

describe("tile-layout: splitLeafVertical", () => {
  it("promotes a lone root terminal to a vertical split", () => {
    let l = createLayoutWithTerminal("a");
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "b");
    const rs = rootSplit(l);
    assert.equal(rs.direction, "vertical");
    assert.deepEqual(
      rs.children.map((c) => (c.type === "terminal" ? c.sessionId : "?")),
      ["a", "b"],
    );
  });

  it("stacks below a column's lone terminal", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    const b = findNodeBySessionId(l, "b")!;
    l = splitLeafVertical(l, b.id, "b2");
    const rs = rootSplit(l);
    assert.equal(rs.children.length, 2);
    const col1 = rs.children[1];
    assert.ok(col1.type === "split" && col1.direction === "vertical");
    assert.deepEqual(
      col1.children.map((c) => (c.type === "terminal" ? c.sessionId : "?")),
      ["b", "b2"],
    );
  });

  it("appends a sibling inside an existing vertical split (flat stack)", () => {
    let l = createLayoutWithTerminal("a");
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "b"); // root = vertical[a, b]
    const b = findNodeBySessionId(l, "b")!;
    l = splitLeafVertical(l, b.id, "c"); // should become vertical[a, b, c]
    const rs = rootSplit(l);
    assert.equal(rs.direction, "vertical");
    assert.deepEqual(
      rs.children.map((c) => (c.type === "terminal" ? c.sessionId : "nested")),
      ["a", "b", "c"],
    );
    for (const kid of rs.children) assert.equal(kid.type, "terminal");
  });

  it("rejects splitting a non-leaf target", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    const rs = rootSplit(l);
    const before = serializeLayout(l);
    const after = splitLeafVertical(l, rs.id, "x");
    assert.equal(serializeLayout(after), before);
  });
});

describe("tile-layout: removeSession", () => {
  it("clears the layout when removing the only terminal", () => {
    let l = createLayoutWithTerminal("a");
    l = removeSession(l, "a");
    assert.equal(l.root, null);
  });

  it("collapses a single-child split when siblings are removed", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    l = removeSession(l, "b");
    assert.ok(l.root && l.root.type === "terminal");
    if (l.root && l.root.type === "terminal") assert.equal(l.root.sessionId, "a");
  });

  it("collapses a vertical split back to a lone terminal column", () => {
    let l = createLayoutWithTerminal("a");
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "b"); // [v: a, b]
    l = removeSession(l, "b"); // should collapse back to single terminal "a"
    assert.ok(l.root && l.root.type === "terminal");
  });
});

describe("tile-layout: findColumnOf", () => {
  it("returns the column id for a nested node", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "a2");
    const a2 = findNodeBySessionId(l, "a2")!;
    const columnId = findColumnOf(l, a2.id);
    const rs = rootSplit(l);
    assert.equal(columnId, rs.children[0].id);
  });
});

describe("tile-layout: resizeSplit", () => {
  it("updates sizes on the matching split", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    const rs = rootSplit(l);
    const resized = resizeSplit(l, rs.id, [70, 30]);
    assert.deepEqual(rootSplit(resized).sizes, [70, 30]);
  });
});

describe("tile-layout: moveColumn", () => {
  function sessionOrder(layout: ReturnType<typeof rootSplit>): string[] {
    return layout.children.map((c) =>
      c.type === "terminal" ? c.sessionId : c.type === "split" ? `split(${c.children.map((cc) => (cc.type === "terminal" ? cc.sessionId : "?")).join(",")})` : "?",
    );
  }

  it("moves a column to the right (before target past it)", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    l = insertAtEnd(l, "c");
    l = insertAtEnd(l, "d"); // [a, b, c, d]
    const a = rootSplit(l).children[0];
    const c = rootSplit(l).children[2];
    const moved = moveColumn(l, a.id, c.id, "after");
    assert.deepEqual(sessionOrder(rootSplit(moved)), ["b", "c", "a", "d"]);
  });

  it("moves a column to the left (before target)", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    l = insertAtEnd(l, "c"); // [a, b, c]
    const c = rootSplit(l).children[2];
    const a = rootSplit(l).children[0];
    const moved = moveColumn(l, c.id, a.id, "before");
    assert.deepEqual(sessionOrder(rootSplit(moved)), ["c", "a", "b"]);
  });

  it("is a no-op when source equals target", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    const a = rootSplit(l).children[0];
    const before = serializeLayout(l);
    const after = moveColumn(l, a.id, a.id, "before");
    assert.equal(serializeLayout(after), before);
  });

  it("is a no-op when the layout is a single terminal", () => {
    const l = createLayoutWithTerminal("a");
    const before = serializeLayout(l);
    const after = moveColumn(l, "whatever", "another", "after");
    assert.equal(serializeLayout(after), before);
  });

  it("preserves vertical-split columns as whole units", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "a2"); // column 0 becomes v-split[a, a2]
    l = insertAtEnd(l, "c"); // [v(a,a2), b, c]
    const col0 = rootSplit(l).children[0];
    const c = rootSplit(l).children[2];
    const moved = moveColumn(l, col0.id, c.id, "after");
    // Expect [b, c, v(a,a2)]
    const rs = rootSplit(moved);
    assert.equal(rs.children[0].type, "terminal");
    assert.equal(rs.children[1].type, "terminal");
    assert.equal(rs.children[2].type, "split");
  });
});

describe("tile-layout: reconcile", () => {
  it("drops stale sessions and prepends new ones", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b"); // [a, b]
    const reconciled = reconcile(l, ["a", "c"], ["c"]);
    assert.deepEqual(getAllSessionIds(reconciled), ["c", "a"]);
  });

  it("does not duplicate sessions already in the layout", () => {
    const l = createLayoutWithTerminal("a");
    const reconciled = reconcile(l, ["a"], ["a"]);
    assert.deepEqual(getAllSessionIds(reconciled), ["a"]);
  });
});

describe("tile-layout: serialize/deserialize", () => {
  it("roundtrips a complex layout", () => {
    let l = createLayoutWithTerminal("a");
    l = insertAtEnd(l, "b");
    const a = findNodeBySessionId(l, "a")!;
    l = splitLeafVertical(l, a.id, "a2");
    const json = serializeLayout(l);
    const back = deserializeLayout(json);
    assert.equal(serializeLayout(back!), json);
  });

  it("rejects invalid json", () => {
    assert.equal(deserializeLayout("{not json"), null);
    assert.equal(deserializeLayout('{"version":1,"root":{"type":"bogus"}}'), null);
  });
});
