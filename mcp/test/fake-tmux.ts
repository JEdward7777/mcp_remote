// In-memory stand-in for the tmux driver (tests only).
import type { PaneInfo, SpawnSpec, TmuxDriver } from "../src/tmux";

export class FakeTmux implements TmuxDriver {
  sessions = new Map<string, { spec: SpawnSpec; pid: number; dead: boolean; status: number | null; screen: string; history: string }>();
  nextPid = 1000;
  spawns: SpawnSpec[] = [];
  keys: { name: string; keys: string[] }[] = [];
  /** Called after send-keys, to emulate the dialog going away. */
  onKeys: (name: string, keys: string[]) => void = () => {};
  version = async () => "tmux 3.4";
  async spawn(spec: SpawnSpec) {
    if (this.sessions.has(spec.name)) throw Object.assign(new Error("duplicate session"), { stderr: `duplicate session: ${spec.name}` });
    this.spawns.push(spec);
    this.sessions.set(spec.name, { spec, pid: this.nextPid++, dead: false, status: null, screen: "", history: "" });
  }
  async list(): Promise<PaneInfo[]> {
    return [...this.sessions.entries()].map(([name, s]) => ({ name, pid: s.pid, dead: s.dead, status: s.status }));
  }
  async capture(name: string, history?: number) {
    const s = this.sessions.get(name);
    if (!s) return "";
    return history ? s.history + "\n" + s.screen : s.screen;
  }
  async sendKeys(name: string, keys: string[]) {
    this.keys.push({ name, keys });
    this.onKeys(name, keys);
  }
  async kill(name: string) {
    this.sessions.delete(name);
  }
  async showEnv(name: string) {
    return this.sessions.get(name)?.spec.env ?? {};
  }
  die(name: string, status: number | null, output = "") {
    const s = this.sessions.get(name)!;
    s.dead = true;
    s.status = status;
    s.history = output;
    s.screen = `Pane is dead (status ${status})`;
  }
}

