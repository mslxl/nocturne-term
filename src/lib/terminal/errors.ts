const TERMINAL_SESSION_INACTIVE_PATTERN =
  /terminal session [^\s]+ (?:not found|is no longer active)/i;

export function isTerminalSessionInactiveMessage(message: string): boolean {
  return TERMINAL_SESSION_INACTIVE_PATTERN.test(message);
}
