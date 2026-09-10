import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PrefixMachine, prefixHelp } from "../cli/tui/keys.js";

const B = (s: string) => Buffer.from(s, "latin1");
const P = 0x02;

describe("PrefixMachine", () => {
  it("passes plain input through untouched", () => {
    const m = new PrefixMachine(P);
    const acts = m.feed(B("abc"));
    assert.deepEqual(acts, [{ kind: "pass", bytes: B("abc") }]);
    assert.equal(m.pending, false);
  });

  it("holds the prefix until the command key arrives", () => {
    const m = new PrefixMachine(P);
    assert.deepEqual(m.feed(Buffer.from([P])), []);
    assert.equal(m.pending, true);
    assert.deepEqual(m.feed(B("n")), [{ kind: "next" }]);
    assert.equal(m.pending, false);
  });

  it("handles prefix and command in one chunk, with trailing bytes passing", () => {
    const m = new PrefixMachine(P);
    const acts = m.feed(Buffer.concat([B("ab"), Buffer.from([P]), B("3zz")]));
    assert.deepEqual(acts, [
      { kind: "pass", bytes: B("ab") },
      { kind: "jump", index: 2 },
      { kind: "pass", bytes: B("zz") },
    ]);
  });

  it("sends the prefix literally when pressed twice", () => {
    const m = new PrefixMachine(P);
    assert.deepEqual(m.feed(Buffer.from([P, P])), [{ kind: "literal", bytes: Buffer.from([P]) }]);
  });

  it("maps every bound key", () => {
    const m = new PrefixMachine(P);
    const kinds = ["n", "p", "c", ",", "s", "d", "x", "k", "a", "?"].map((k) => m.feed(Buffer.concat([Buffer.from([P]), B(k)]))[0].kind);
    assert.deepEqual(kinds, ["next", "prev", "new", "rename", "picker", "detach", "kill", "clear", "actions", "help"]);
    assert.deepEqual(m.feed(Buffer.from([P, 0x1b])), [{ kind: "picker" }]);
  });

  it("swallows an escape sequence after the prefix and reports unbound keys", () => {
    const m = new PrefixMachine(P);
    assert.deepEqual(m.feed(Buffer.concat([Buffer.from([P]), B("\x1b[A")])), [{ kind: "unbound", key: "escape-sequence" }]);
    assert.deepEqual(m.feed(Buffer.concat([Buffer.from([P]), B("q")])), [{ kind: "unbound", key: "q" }]);
    assert.equal(m.pending, false);
  });

  it("works with a different prefix byte", () => {
    const m = new PrefixMachine(0x01);
    assert.deepEqual(m.feed(Buffer.from([0x02])), [{ kind: "pass", bytes: Buffer.from([0x02]) }]);
    assert.deepEqual(m.feed(Buffer.from([0x01, 0x6e])), [{ kind: "next" }]);
  });

  it("help mentions the prefix label", () => {
    assert.match(prefixHelp("C-b"), /^C-b then: n next session/);
  });
});
