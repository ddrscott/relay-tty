import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseKeyChord, parseRc, loadRc, ensureRcFile, DEFAULT_RC, DEFAULT_RC_TEXT } from "../cli/rc.js";

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

describe("default relayrc", () => {
  it("parses back to the defaults with no warnings", () => {
    const warnings: string[] = [];
    assert.deepEqual({ ...DEFAULT_RC, ...parseRc(DEFAULT_RC_TEXT, (m) => warnings.push(m)) }, DEFAULT_RC);
    assert.deepEqual(warnings, []);
  });
});

describe("loadRc", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-rc-"));

  it("creates the default file when it is missing, including the directory", () => {
    const file = path.join(tmp(), "relay-tty", "relayrc");
    assert.deepEqual(loadRc(file), DEFAULT_RC);
    assert.equal(fs.readFileSync(file, "utf-8"), DEFAULT_RC_TEXT);
  });

  it("never overwrites an existing file", () => {
    const file = path.join(tmp(), "relayrc");
    fs.writeFileSync(file, "prefix = C-a\n");
    assert.equal(ensureRcFile(file), false);
    assert.equal(loadRc(file).prefix.label, "C-a");
    assert.equal(fs.readFileSync(file, "utf-8"), "prefix = C-a\n");
  });

  it("returns defaults when the file cannot be created", () => {
    assert.deepEqual(loadRc("/nonexistent-root-dir/relay-tty/relayrc"), DEFAULT_RC);
  });
});
