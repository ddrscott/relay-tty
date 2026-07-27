import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectFilePaths } from "../app/lib/file-path-detect.js";

/** Convenience: the set of cleaned paths detected in `text`. */
function paths(text: string): string[] {
  return detectFilePaths(text).map((d) => d.path);
}

describe("detectFilePaths: bare filenames (new behavior)", () => {
  it("links a bare filename with a known extension", () => {
    assert.deepEqual(paths("edit package.json now"), ["package.json"]);
  });

  it("links README.md", () => {
    assert.deepEqual(paths("see README.md for details"), ["README.md"]);
  });

  it("parses line/column on a bare filename", () => {
    const [d] = detectFilePaths("error in foo.tsx:12:5 here");
    assert.equal(d.path, "foo.tsx");
    assert.equal(d.line, 12);
    assert.equal(d.column, 5);
  });

  it("parses a line-only suffix on a bare filename", () => {
    const [d] = detectFilePaths("notes.md:42");
    assert.equal(d.path, "notes.md");
    assert.equal(d.line, 42);
    assert.equal(d.column, undefined);
  });

  it("links a bare js file", () => {
    assert.deepEqual(paths("run app.js"), ["app.js"]);
  });
});

describe("detectFilePaths: slash + relative paths still win (regression)", () => {
  it("keeps whole slash path, not just the filename", () => {
    assert.deepEqual(paths("src/components/terminal.tsx:42:10"), ["src/components/terminal.tsx"]);
  });

  it("handles dot-relative paths", () => {
    assert.deepEqual(paths("./app/lib/foo.ts:5"), ["./app/lib/foo.ts"]);
  });

  it("handles parent-relative paths", () => {
    assert.deepEqual(paths("../config.yaml"), ["../config.yaml"]);
  });

  it("handles absolute paths", () => {
    assert.deepEqual(paths("/Users/scott/code/bar.py"), ["/Users/scott/code/bar.py"]);
  });

  it("prefers the full slash path over its bare tail", () => {
    const ds = detectFilePaths("foo/bar.ts");
    assert.equal(ds.length, 1);
    assert.equal(ds[0].path, "foo/bar.ts");
  });
});

describe("detectFilePaths: extension allowlist rejects non-file tokens", () => {
  const rejected = [
    "3.14",
    "obj.method()",
    "array.length",
    "this.state",
    "e.g.",
    "etc.",
    "(.ts)", // no filename before the extension → dot-word only
  ];
  for (const token of rejected) {
    it(`rejects ${JSON.stringify(token)}`, () => {
      // Product names like Node.js DO pass the allowlist (js is a real ext);
      // they are contained by the server existence gate, not here.
      const detected = paths(token);
      assert.ok(
        !detected.some((p) => p === token || p.replace(/[()]/g, "") === token.replace(/[()]/g, "")),
        `expected ${token} not to be linked, got ${JSON.stringify(detected)}`,
      );
    });
  }

  it("does still match word.js product names (existence gate handles these)", () => {
    // Documents intentional behavior: Node.js passes detection because `js` is
    // a valid extension. The false positive is removed downstream by the
    // server-side existence check, not by the regex.
    assert.deepEqual(paths("Node.js"), ["Node.js"]);
  });
});

describe("detectFilePaths: multiple matches in one line", () => {
  it("detects several bare filenames", () => {
    assert.deepEqual(
      paths("touched package.json and README.md and app.ts"),
      ["package.json", "README.md", "app.ts"],
    );
  });
});
