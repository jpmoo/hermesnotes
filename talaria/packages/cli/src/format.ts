/** Colour, only when someone is looking — never when the output is a pipe. */
const ESC = "\u001b";
export const dim = (s: string) => (process.stdout.isTTY ? `${ESC}[2m${s}${ESC}[0m` : s);
export const warn = (s: string) => (process.stdout.isTTY ? `${ESC}[33m${s}${ESC}[0m` : s);
