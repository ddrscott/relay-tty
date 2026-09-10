import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TERMINAL_RESET } from "../shared/client/terminal-reset.js";
import { osc52, osc9, osc1337Image } from "../cli/osc.js";

describe("TERMINAL_RESET", () => {
  // Every mode pty-host restores (crates/pty-host/src/term_modes.rs) must be
  // turned off here, or a switch leaves it on for the next session.
  const restoredByPtyHost = [1, 7, 25, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004];
  const defaultsOn = new Set([7, 25]);

  it("returns every restored DEC mode to its default", () => {
    for (const mode of restoredByPtyHost) {
      const want = `\x1b[?${mode}${defaultsOn.has(mode) ? "h" : "l"}`;
      assert.ok(TERMINAL_RESET.includes(want), `missing ${JSON.stringify(want)}`);
    }
  });

  it("resets keypad, cursor shape, keyboard protocols, margins and SGR", () => {
    for (const seq of ["\x1b>", "\x1b[0 q", "\x1b[=0;1u", "\x1b[>4;0m", "\x1b7\x1b[r\x1b8", "\x1b[0m"]) {
      assert.ok(TERMINAL_RESET.includes(seq), `missing ${JSON.stringify(seq)}`);
    }
  });

  it("leaves the alternate screen without the cursor-restoring 1049", () => {
    assert.ok(TERMINAL_RESET.startsWith("\x1b[?1047l\x1b[?47l"));
    assert.ok(!TERMINAL_RESET.includes("?1049"));
  });
});

describe("OSC re-encoding", () => {
  it("osc52 base64-encodes UTF-8 for the clipboard", () => {
    assert.equal(osc52("héllo"), `\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
  });
  it("osc9 strips control characters so the payload cannot break out", () => {
    assert.equal(osc9("agent\x07needs\x1b[31myou"), "\x1b]9;agent needs [31myou\x07");
  });
  it("osc1337 carries name, size and base64 data", () => {
    const seq = osc1337Image({ id: "img1", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    assert.equal(seq, `\x1b]1337;File=name=${Buffer.from("img1").toString("base64")};size=3;inline=1:AQID\x07`);
  });
});
