// All diagnostics go to stderr. In the shim, stdout carries MCP protocol only.
let prefix = "mcp-remote";

export function setLogPrefix(p: string): void {
  prefix = p;
}

export function log(...args: unknown[]): void {
  const parts = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)));
  process.stderr.write(`${new Date().toISOString()} [${prefix}] ${parts.join(" ")}\n`);
}
