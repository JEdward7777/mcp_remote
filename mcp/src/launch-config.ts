// Launch settings (Phase 2, D6/D18): which project folders the phone may start Claude Code in, and how.
// Stored in <config dir>/launch.json (0600), separate from config.json so re-pairing never touches it.
// Only the daemon reads paths from here; the Hub and the phone only ever see opaque ids + folder names.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { MAX_LAUNCHES_PER_MACHINE, MAX_PROJECTS_PER_MACHINE, type ProjectInfo } from "@mcp-remote/shared";
import { configDir, ensureConfigDir } from "./config";

/**
 * Values `claude --permission-mode` accepts (verified against `claude --help`, Claude Code 2.1.310, and
 * https://code.claude.com/docs/en/cli-reference). `manual` is an alias for `default`.
 */
export const PERMISSION_MODES = ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
export const PermissionMode = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const PERMISSION_MODE_HELP: Record<PermissionMode, string> = {
  default: "asks before edits and commands (UI: Manual). A phone user cannot answer prompts yet (D18), so the session stalls",
  manual: "alias for default",
  acceptEdits: "file edits and common filesystem commands run without asking; other commands still prompt",
  plan: "read-only planning",
  auto: "runs everything, with Claude Code's background safety classifier blocking risky actions (needs a supported model)",
  dontAsk: "anything that would prompt is denied instead",
  bypassPermissions: "no permission checks at all; isolated machines only. Refused when running as root",
};

/** Conversation-selection flags the launcher sets itself; extra args may not override them. */
export const RESERVED_ARGS = ["--continue", "--resume", "--session-id", "--fork-session", "--from-pr"];

/** The managed flag an argument would set, if any: long forms (also `--x=value`) and any short-flag
 * cluster containing c or r (`-c`, `-r`, `-rabc`, `-cr`, `-dc`). */
export function reservedFlag(a: string): string | null {
  const long = RESERVED_ARGS.find((r) => a === r || a.startsWith(`${r}=`));
  if (long) return long;
  if (/^-[A-Za-z]/.test(a) && !a.startsWith("--")) {
    const letters = a.slice(1).split("=")[0]!;
    const m = letters.match(/[cr]/);
    if (m) return letters.length === 1 ? a : `-${m[0]} (in ${a})`;
  }
  return null;
}

/** One extra CLI argument. Validated so it can never be read as a tmux command separator. */
const ExtraArg = z
  .string()
  .min(1)
  .max(512)
  .refine((a) => !a.endsWith(";"), "an argument may not end with ';' (tmux would read it as a command separator)")
  .refine((a) => !/[\0\n\r]/.test(a), "no control characters")
  .superRefine((a, ctx) => {
    const hit = reservedFlag(a);
    if (hit) {
      ctx.addIssue({
        code: "custom",
        message:
          `${hit} is managed by mcp-remote (it picks --session-id / --resume / --continue per launch from the ` +
          "phone's resume option); remove it from extra-args",
      });
    }
  });

export const ProjectEntry = z.object({ path: z.string().min(1).max(1024), name: z.string().min(1).max(128).optional() });

export const LaunchConfig = z.object({
  /** Explicit project folders. */
  projects: z.array(ProjectEntry).max(MAX_PROJECTS_PER_MACHINE).default([]),
  /** Folders whose direct sub-folders (one level, not hidden) are launchable. */
  roots: z.array(z.string().min(1).max(1024)).max(32).default([]),
  /** Passed as --permission-mode; null = don't pass the flag (Claude Code's own default applies). */
  permission_mode: PermissionMode.nullable().default(null),
  /** Absolute path to the claude binary; null = look up `claude` on PATH when launching. */
  claude_path: z.string().min(1).max(1024).nullable().default(null),
  extra_args: z.array(ExtraArg).max(32).default([]),
  /** Concurrent phone-launched sessions (starting/running/needs_attention). */
  max_sessions: z.number().int().min(1).max(MAX_LAUNCHES_PER_MACHINE).default(4),
  /** Default for the phone's auto-restart toggle. */
  auto_restart: z.boolean().default(false),
  tmux_path: z.string().min(1).max(1024).nullable().default(null),
  /** Dedicated tmux server socket name (tmux -L); keeps launched sessions apart from your own tmux. */
  tmux_socket: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("mcp-remote"),
  /** Name of the shim in Claude Code's MCP config (server:<name> in the channels flag). */
  server_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("mcp-remote"),
  /** Seconds to wait for Claude Code to start the shim before reporting needs_attention. */
  startup_timeout_s: z.number().int().min(10).max(600).default(90),
});
export type LaunchConfig = z.infer<typeof LaunchConfig>;

export function launchConfigPath(): string {
  return join(configDir(), "launch.json");
}

export function defaultLaunchConfig(): LaunchConfig {
  return LaunchConfig.parse({});
}

export function loadLaunchConfig(): LaunchConfig {
  const path = launchConfigPath();
  if (!existsSync(path)) return defaultLaunchConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const r = LaunchConfig.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${path}: ${i?.path.join(".") || "(root)"}: ${i?.message ?? "invalid"}`);
  }
  return r.data;
}

export function saveLaunchConfig(cfg: LaunchConfig): string {
  ensureConfigDir();
  const path = launchConfigPath();
  const r = LaunchConfig.safeParse(cfg);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`${i?.path.join(".") || "launch settings"}: ${i?.message ?? "invalid"}`);
  }
  const valid = r.data;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/** Stable opaque id for a folder: a hash of its real path, so the Hub never learns the path. */
export function projectIdFor(realPath: string): string {
  return "p" + createHash("sha256").update(realPath).digest("hex").slice(0, 15);
}

export interface ResolvedProject extends ProjectInfo {
  path: string;
  source: "explicit" | "root";
}

function realDir(p: string): string | null {
  try {
    const r = realpathSync(p);
    return statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

/** Absolute, normalized form of a user-typed folder (relative paths resolve against cwd). */
export function normalizeDir(input: string): string {
  const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const real = realDir(abs);
  if (!real) throw new Error(`${input} is not an existing directory`);
  return real;
}

/**
 * The allowlist: explicit projects plus one level of non-hidden sub-folders of each root.
 * Missing folders are skipped. Duplicates (same real path) appear once; clashing names get a suffix.
 */
export function resolveProjects(cfg: LaunchConfig): ResolvedProject[] {
  const out: ResolvedProject[] = [];
  const seen = new Set<string>();
  const names = new Map<string, number>();
  const add = (path: string, name: string, source: ResolvedProject["source"]) => {
    if (seen.has(path) || out.length >= MAX_PROJECTS_PER_MACHINE) return;
    seen.add(path);
    let n = name.slice(0, 120) || path;
    const k = names.get(n) ?? 0;
    names.set(n, k + 1);
    if (k > 0) n = `${n}-${k + 1}`;
    out.push({ id: projectIdFor(path), name: n, path, source });
  };
  for (const p of cfg.projects) {
    const real = realDir(p.path);
    if (real) add(real, p.name ?? basename(real), "explicit");
  }
  for (const root of cfg.roots) {
    const realRoot = realDir(root);
    if (!realRoot) continue;
    let entries: string[];
    try {
      entries = readdirSync(realRoot).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const real = realDir(join(realRoot, e));
      if (real) add(real, e, "root");
    }
  }
  return out;
}

/** Find an allowlisted project by its opaque id. The only way a launch request maps to a folder. */
export function findProject(cfg: LaunchConfig, id: string): ResolvedProject | undefined {
  return resolveProjects(cfg).find((p) => p.id === id);
}

/**
 * Best-effort read of Claude Code's own state (~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json) to warn
 * about folders where Claude Code will still show its workspace-trust dialog. Never written by us.
 */
export function claudeTrustedDirs(): Set<string> | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const dir = process.env.CLAUDE_CONFIG_DIR || home;
  try {
    const j = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    return new Set(Object.entries(j.projects ?? {}).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => k));
  } catch {
    return null;
  }
}

/** True if Claude Code recorded trust for this folder or one of its parents. */
export function isTrusted(trusted: Set<string>, path: string): boolean {
  let p = path;
  for (;;) {
    if (trusted.has(p)) return true;
    const parent = resolve(p, "..");
    if (parent === p) return false;
    p = parent;
  }
}
