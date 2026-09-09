import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellQuote, shellQuotePaths } from "../app/lib/shell-quote.js";

describe("shellQuote", () => {
  it("leaves plain absolute paths alone", () => {
    assert.equal(shellQuote("/Users/scott/code/relay-tty/README.md"), "/Users/scott/code/relay-tty/README.md");
  });

  it("leaves paths with dots, dashes, plus, at, percent, colon and comma alone", () => {
    assert.equal(shellQuote("/tmp/a-b_c.d+e@f%g:h,i"), "/tmp/a-b_c.d+e@f%g:h,i");
  });

  it("single-quotes a path containing spaces", () => {
    assert.equal(shellQuote("/Users/scott/My Documents/notes.txt"), "'/Users/scott/My Documents/notes.txt'");
  });

  it("escapes an embedded single quote", () => {
    assert.equal(shellQuote("/tmp/it's here.txt"), `'/tmp/it'\\''s here.txt'`);
  });

  it("quotes shell metacharacters", () => {
    for (const ch of ["$", "&", ";", "|", "(", ")", "*", "?", "[", "]", "{", "}", "<", ">", "`", '"', "\\", "!", "#", "~", "="]) {
      const p = `/tmp/a${ch}b`;
      assert.equal(shellQuote(p), `'${p}'`, `should quote ${ch}`);
    }
  });

  it("quotes non-ASCII paths", () => {
    assert.equal(shellQuote("/tmp/résumé.pdf"), "'/tmp/résumé.pdf'");
  });

  it("quotes leading tilde so the shell does not expand it", () => {
    assert.equal(shellQuote("~/foo"), "'~/foo'");
  });

  it("returns an empty quoted string for empty input", () => {
    assert.equal(shellQuote(""), "''");
  });
});

describe("shellQuotePaths", () => {
  it("joins quoted paths with single spaces", () => {
    assert.equal(
      shellQuotePaths(["/tmp/a.txt", "/tmp/b c.txt"]),
      "/tmp/a.txt '/tmp/b c.txt'",
    );
  });

  it("returns an empty string for no paths", () => {
    assert.equal(shellQuotePaths([]), "");
  });
});
