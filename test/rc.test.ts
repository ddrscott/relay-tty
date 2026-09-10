import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseKeyChord, parseRc, loadRc, DEFAULT_RC } from "../cli/rc.js";

describe("parseKeyChord", () => {
  it("accepts the common spellings", () => {
    assert.deepEqual(parseKeyChord("C-b"), { byte: 2, label: "C-b" });
    assert.deepEqual(parseKeyChord("ctrl-a"), { byte: 1, label: "C-a" });
    assert.deepEqual(parseKeyChord("Ctrl+Z"), { byte: 26, label: "C-z" });
    assert.deepEqual(parseKeyChord("^b"), { byte: 2, label: "C-b" });
    assert.deepEqual(parseKeyChord("^]"), { byte: 0x1d, label: "C-]" });
    assert.deepEqual(parseKeyChord("C-space"), null);
    assert.equal(parseKeyChord("C-@")?.byte, 0);
  });
  it("rejects non-chords", () => {
    assert.equal(parseKeyChord("x"), null);
    assert.equal(parseKeyChord("C-"), null);
    assert.equal(parseKeyChord("C-1"), null);
  });
});

describe("parseRc", () => {
  it("parses keys, ignores comments and blanks, warns on unknowns", () => {
    const warnings: string[] = [];
    const rc = parseRc("# comment\n\nprefix = C-a  # inline\nhost=http://x:1\nbogus = 1\nnoequals\n", (m) => warnings.push(m));
    assert.deepEqual(rc, { prefix: { byte: 1, label: "C-a" }, host: "http://x:1" });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /unknown key "bogus"/);
    assert.match(warnings[1], /expected key = value/);
  });
  it("warns on a bad prefix and keeps the default", () => {
    const warnings: string[] = [];
    const rc = parseRc("prefix = banana", (m) => warnings.push(m));
    assert.equal(rc.prefix, undefined);
    assert.equal(warnings.length, 1);
  });
});

describe("loadRc", () => {
  it("returns defaults when the file is missing", () => {
    assert.deepEqual(loadRc("/nonexistent/relayrc"), DEFAULT_RC);
  });
});
