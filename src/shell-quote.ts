/** Quote one argv token for a POSIX shell command typed into the REPL shell. */
export function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_/:.,=+@%~-]+$/.test(value) && value.length > 0) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function shellQuoteCommand(args: readonly string[]): string {
  return args.map(shellQuoteArg).join(" ");
}
