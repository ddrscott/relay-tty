// ANSI escape helpers for server startup output — no dependencies
const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const dim = esc("2");
export const bold = esc("1");
export const cyan = esc("36");
export const green = esc("32");
export const boldGreen = esc("1;32");
