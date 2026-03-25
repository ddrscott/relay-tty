/**
 * Fix colon-separated SGR RGB color sequences missing the colorspace field.
 *
 * NeoVim 0.10+ emits `\e[38:2:R:G:Bm` (ITU T.416 colons, no colorspace).
 * xterm.js v5 expects `\e[38:2:<cs>:R:G:Bm` (colorspace slot always present,
 * even if empty as `38:2::R:G:B`).  Without it xterm.js treats R as colorspace,
 * shifts G→R, B→G, and defaults B=0 — zeroing the blue channel.
 *
 * Fix: rewrite the 3-value colon form to semicolons (`38;2;R;G;B`) which
 * xterm.js parses unambiguously.  Only touches SGR sequences (final byte `m`).
 */

// Byte constants for the fast-path scan: "8:2:" = 0x38 0x3a 0x32 0x3a
const B_8 = 0x38;
const B_COLON = 0x3a;
const B_2 = 0x32;

/**
 * Regex applied inside the params of a CSI SGR sequence.
 * Matches `38:2:R:G:B`, `48:2:R:G:B`, or `58:2:R:G:B` where exactly three
 * decimal values follow `:2:` (negative lookahead rejects 4+ values, which
 * means a colorspace IS present and xterm.js handles it fine).
 */
const COLON_RGB_RE = /([345]8):2:(\d+):(\d+):(\d+)(?!:\d)/g;

/** Match a complete CSI SGR sequence: ESC [ <params> m */
const CSI_SGR_RE = /\x1b\[([0-9;:]*)m/g;

let _decoder: TextDecoder | undefined;
let _encoder: TextEncoder | undefined;

export function normalizeSgrColors(data: Uint8Array): Uint8Array {
  // Fast path: scan for the byte pattern "8:2:" which appears in 38:2: / 48:2: / 58:2:
  let found = false;
  for (let i = 0, len = data.length - 3; i < len; i++) {
    if (data[i] === B_8 && data[i + 1] === B_COLON && data[i + 2] === B_2 && data[i + 3] === B_COLON) {
      found = true;
      break;
    }
  }
  if (!found) return data;

  // Decode, fix, re-encode
  _decoder ??= new TextDecoder();
  _encoder ??= new TextEncoder();

  const text = _decoder.decode(data);
  const fixed = text.replace(CSI_SGR_RE, (_match, params: string) => {
    const fixedParams = params.replace(COLON_RGB_RE, "$1;2;$2;$3;$4");
    return fixedParams !== params ? `\x1b[${fixedParams}m` : _match;
  });

  return fixed !== text ? _encoder.encode(fixed) : data;
}
