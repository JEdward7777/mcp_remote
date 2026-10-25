// Newline-delimited JSON framing over a local stream socket (shim <-> daemon).
import type { Socket } from "node:net";
import type { z } from "zod";
import { MAX_FRAME_BYTES, parseFrame } from "@mcp-remote/shared";

export class LineConn<In> {
  private buf = "";
  private closed = false;

  constructor(
    readonly sock: Socket,
    schema: z.ZodType<In>,
    onFrame: (f: In) => void,
    onBad: (error: string) => void,
  ) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const r = parseFrame(schema, line);
        if (r.ok) onFrame(r.value);
        else onBad(r.error);
      }
      if (this.buf.length > MAX_FRAME_BYTES) {
        onBad("frame too large");
        this.buf = "";
        sock.destroy();
      }
    });
    sock.on("close", () => (this.closed = true));
  }

  send(frame: unknown): boolean {
    if (this.closed || this.sock.destroyed) return false;
    this.sock.write(JSON.stringify(frame) + "\n");
    return true;
  }

  close(): void {
    this.closed = true;
    this.sock.end();
  }
}
