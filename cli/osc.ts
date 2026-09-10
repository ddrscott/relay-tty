/**
 * Re-encode side-channel frames as the terminal escapes they came from.
 *
 * pty-host lifts OSC 52 (clipboard), OSC 9 (notification) and OSC 1337
 * (inline image) out of the output stream into CLIPBOARD, NOTIFICATION and
 * IMAGE frames, which the browser handles natively. A terminal client has to
 * write them back out, or copying from vim or Claude Code never reaches the
 * clipboard and the terminal never shows the app's notifications or images.
 */

/** Drop control characters so a payload cannot terminate the OSC early or inject escapes. */
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

/** OSC 52: set the system clipboard ("c" selection). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf-8").toString("base64")}\x07`;
}

/** OSC 9: desktop notification (iTerm2, Ghostty, WezTerm, kitty). */
export function osc9(text: string): string {
  return `\x1b]9;${clean(text)}\x07`;
}

/** OSC 1337 File: iTerm2 inline image protocol (also WezTerm, Konsole). */
export function osc1337Image(image: { id: string; mime: string; bytes: Uint8Array }): string {
  const name = Buffer.from(image.id, "utf-8").toString("base64");
  const data = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString("base64");
  return `\x1b]1337;File=name=${name};size=${image.bytes.byteLength};inline=1:${data}\x07`;
}
