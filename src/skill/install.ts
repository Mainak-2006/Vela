/**
 * Installing the Vela skill into a coding assistant.
 *
 * The problem this exists to solve: `docs/SKILLS.md` is 59 KB, and every
 * mechanism an assistant has for loading instructions has a size limit well
 * below that. Codex caps a project doc at 32 KiB, Devin at 12,000 characters, and
 * the Agent Skills specification asks for a body under 500 lines. So the full
 * reference can never be the thing that gets loaded — it has to sit behind a
 * lean entry point that an agent opens on demand.
 *
 * `docs/vela.SKILL.md` is that entry point: a few hundred lines, and enough of the
 * language to write most programs without opening anything else. This module
 * copies it into wherever a given tool looks for instructions, rewriting the one
 * placeholder that needs a machine-specific answer — the absolute path of the
 * full reference.
 *
 * Two families of target, deliberately treated differently:
 *
 *   - Skill directories (`.claude/skills`, `~/.agents/skills`, …) are loaded
 *     progressively, once an agent decides the skill is relevant, so the stub is
 *     the whole payload.
 *   - Always-on files (`AGENTS.md`, `GEMINI.md`) and path-gated rules
 *     (`*.mdc`, `*.instructions.md`) are read on nearly every message, so they get
 *     the same lean body but with the tool's own frontmatter on top.
 *
 * The full reference is referenced by absolute path, never imported. A relative
 * link is not a lazy load, and a markdown `@import` of a file outside the project
 * raises an approval prompt on every start, so pointing at the path is the only
 * form that works everywhere.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill's name, which must equal the directory it is installed into. */
export const SKILL_NAME = "vela";

/**
 * The token that marks a file as ours. `--uninstall` uses it to decide what it
 * is allowed to delete, which is why it is stateless: there is no manifest to go
 * stale or to lose. It also carries the version, so `--list` can report drift
 * when a user upgrades the compiler and their installed copy does not follow.
 */
const MARKER = "vela-skill-install";

/** Replaced with the absolute path of the full reference in every installed copy. */
const PLACEHOLDER = "{{FULL_REFERENCE}}";

/** The specification asks for a body under this; exceeding it is a bug, so it is tested. */
export const SKILL_LINE_LIMIT = 500;

/** The frontmatter fields we read back out of the source stub. */
interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly license: string | null;
  readonly compatibility: string | null;
}

/** What the installer does with a target's destination. */
export type InstallMode =
  /** Create or replace a file we own. */
  | "write"
  /** Add one `@path` line to a memory file the user also edits. */
  | "import"
  /** Cannot be automated safely; report the step instead. */
  | "hint";

export type Scope = "user" | "project";

export interface Target {
  readonly id: string;
  readonly tool: string;
  readonly scope: Scope;
  readonly mode: InstallMode;
  /** Absolute path of the file this target owns. */
  readonly path: string;
  /**
   * Paths whose existence suggests the tool is installed. A target with no
   * probes is always available, because it writes into the project being worked
   * on rather than into a tool's configuration.
   */
  readonly probes: readonly string[];
  /**
   * Frontmatter to place above the body. Most tools need a different set, and
   * some need none — `AGENTS.md` is plain markdown by design, so adding YAML to
   * it would be wrong.
   */
  readonly frontmatter: readonly string[];
  /** The file an `import` target points at. Must exist, or the import dangles. */
  readonly importSource?: string;
  /** Printed instead of writing, for `hint` targets. */
  readonly note?: string;
}

export type Status = "installed" | "current" | "updated" | "appended" | "skipped" | "conflict" | "uninstalled" | "absent" | "hinted";

export interface Outcome {
  readonly target: Target;
  readonly status: Status;
  /** A human-readable reason, for statuses that need one. */
  readonly detail: string;
}

export interface Options {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly uninstall: boolean;
}

export interface Environment {
  readonly home: string;
  readonly cwd: string;
}

/**
 * `homedir()` does not consistently honour `$HOME`, which would let a test suite
 * write to the developer's real dotfiles. Reading the variable first and falling
 * back keeps `vela install-skill` testable without a container.
 *
 * `VELA_CWD` does the same for the project scope, so `--target agents-project`
 * can be exercised without writing an `AGENTS.md` into whatever directory the
 * tests happen to run from.
 */
export function detectEnvironment(): Environment {
  const fromEnv = process.env.VELA_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  const project = process.env.VELA_CWD;
  return { home: resolve(fromEnv ?? homedir()), cwd: resolve(project ?? process.cwd()) };
}

/**
 * `docs/` sits beside `src/` in a checkout and beside `dist/` in an installed
 * package, so two levels up from this file lands on the package root either way.
 */
function docsDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
}

/**
 * Pull the fields we need out of the stub's YAML frontmatter.
 *
 * This is a purpose-built reader, not a YAML parser: it walks the block once and
 * keeps the top-level scalars plus the single nested `metadata.version`. Adding a
 * YAML dependency for four fields would be a poor trade in a package whose whole
 * point is having no dependencies, and a full parser would invite silently
 * dropping fields the specification actually requires.
 */
function readMeta(head: string): SkillMeta {
  const top = new Map<string, string>();
  let inMetadata = false;

  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      inMetadata = line.startsWith("metadata:");
      if (inMetadata) continue;
      const at = line.indexOf(":");
      if (at === -1) continue;
      top.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
      continue;
    }
    if (!inMetadata) continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    top.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const required = (key: string): string => {
    const value = top.get(key);
    if (value === undefined || value === "") {
      throw new Error(`docs/vela.SKILL.md: frontmatter is missing '${key}'`);
    }
    return value;
  };

  return {
    name: required("name"),
    description: required("description"),
    license: top.get("license") ?? null,
    compatibility: top.get("compatibility") ?? null,
  };
}

export interface Source {
  readonly meta: SkillMeta;
  /** The stub's body, with the placeholder still in place. */
  readonly body: string;
  /** The absolute path of the full reference. */
  readonly reference: string;
  /**
   * The package version, read from `package.json` rather than the stub's
   * frontmatter.
   *
   * This is the version stamped into every installed file and the one `--list`
   * compares against, so it has to be the real release version. Keeping a second
   * copy in the stub's frontmatter would mean a release that bumps one and not
   * the other reports every user's install as outdated forever — a bug that is
   * invisible until the first upgrade and then hits every user at once.
   */
  readonly version: string;
  readonly lineCount: number;
}

/** The package version, which is the only place it is recorded. */
function readPackageVersion(): string {
  const path = join(docsDirectory(), "..", "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (thrown) {
    throw new Error(`cannot read the version from ${path}: ${(thrown as Error).message}`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${path} has no 'version' string`);
  }
  return version;
}

/** Read the stub and the full reference, and check the stub against the spec's limits. */
export function readSource(): Source {
  const docs = docsDirectory();
  const stubPath = join(docs, "vela.SKILL.md");
  const referencePath = join(docs, "SKILLS.md");

  let text: string;
  try {
    text = readFileSync(stubPath, "utf8");
  } catch {
    throw new Error(
      `cannot read ${stubPath}\nThe skill stub ships with the vela-lang package; this copy looks incomplete.`,
    );
  }

  if (!text.startsWith("---\n")) throw new Error("docs/vela.SKILL.md: missing opening '---'");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new Error("docs/vela.SKILL.md: unterminated frontmatter");
  const meta = readMeta(text.slice(4, end));
  const body = text.slice(end + 5);

  if (meta.name !== SKILL_NAME) {
    throw new Error(`docs/vela.SKILL.md: frontmatter name is '${meta.name}', expected '${SKILL_NAME}'`);
  }
  const lineCount = text.split("\n").length;
  if (lineCount > SKILL_LINE_LIMIT) {
    throw new Error(
      `docs/vela.SKILL.md is ${lineCount} lines; the Agent Skills specification asks for under ${SKILL_LINE_LIMIT}.\n` +
        "Move detail into docs/SKILLS.md and point at it, rather than letting every tool truncate or reject this file.",
    );
  }

  return { meta, body, reference: referencePath, version: readPackageVersion(), lineCount };
}

/** A YAML double-quoted scalar, so a description containing `: ` or `#` still parses. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The frontmatter every skill-directory target shares. */
function skillFrontmatter(meta: SkillMeta, version: string): string[] {
  const lines = [`name: ${meta.name}`, `description: ${quoted(meta.description)}`];
  if (meta.license !== null) lines.push(`license: ${meta.license}`);
  if (meta.compatibility !== null) lines.push(`compatibility: ${meta.compatibility}`);
  lines.push("metadata:", `  ${MARKER}: ${quoted(version)}`);
  return lines;
}

/** The marker for a file that has no frontmatter of its own. */
function commentMarker(version: string): string {
  return `<!-- ${MARKER}: ${version} -->`;
}

function render(source: Source, target: Target): string {
  const body = source.body.replaceAll(PLACEHOLDER, source.reference);
  if (target.frontmatter.length === 0) {
    return `${commentMarker(source.version)}\n\n${body.replace(/^\n+/, "")}`;
  }
  return `---\n${target.frontmatter.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/**
 * Every destination we know how to write, in the order they are worth reporting:
 * skills first, because they are the mechanism that scales, then the rules that
 * only some tools read, then the one target we cannot automate.
 */
export function buildTargets(env: Environment, source: Source): Target[] {
  const { home, cwd } = env;
  const skill = skillFrontmatter(source.meta, source.version);
  const userSkill = (dir: readonly string[]): string => join(home, ...dir, SKILL_NAME, "SKILL.md");

  return [
    {
      id: "agents",
      tool: "Zed, Roo Code, Kilo Code, opencode (shared skill dir)",
      scope: "user",
      mode: "write",
      path: userSkill([".agents", "skills"]),
      probes: [join(home, ".agents"), join(home, ".zed"), join(home, ".config", "opencode")],
      frontmatter: skill,
    },
    {
      id: "claude",
      tool: "Claude Code (skill)",
      scope: "user",
      mode: "write",
      path: userSkill([".claude", "skills"]),
      probes: [join(home, ".claude")],
      frontmatter: skill,
    },
    {
      id: "opencode",
      tool: "opencode (skill)",
      scope: "user",
      mode: "write",
      path: userSkill([".config", "opencode", "skills"]),
      probes: [join(home, ".config", "opencode")],
      frontmatter: skill,
    },
    {
      id: "claude-md",
      tool: "Claude Code (user memory, for projects without the skill)",
      scope: "user",
      mode: "import",
      path: join(home, ".claude", "CLAUDE.md"),
      probes: [join(home, ".claude")],
      frontmatter: [],
      importSource: userSkill([".claude", "skills"]),
    },
    {
      id: "cursor",
      tool: "Cursor (path rule)",
      scope: "project",
      mode: "write",
      path: join(cwd, ".cursor", "rules", "vela.mdc"),
      probes: [join(cwd, ".cursor"), join(cwd, ".cursorrules")],
      frontmatter: [
        `description: ${quoted(source.meta.description)}`,
        'globs: "**/*.vela"',
        "alwaysApply: false",
        "metadata:",
        `  ${MARKER}: ${quoted(source.version)}`,
      ],
    },
    {
      id: "copilot",
      tool: "GitHub Copilot (instructions file)",
      scope: "project",
      mode: "write",
      path: join(cwd, ".github", "instructions", "vela.instructions.md"),
      probes: [join(cwd, ".github")],
      frontmatter: [`applyTo: "**/*.vela"`, "metadata:", `  ${MARKER}: ${quoted(source.version)}`],
    },
    {
      id: "claude-rules",
      tool: "Claude Code (path rule)",
      scope: "project",
      mode: "write",
      path: join(cwd, ".claude", "rules", "vela.md"),
      probes: [join(cwd, ".claude")],
      frontmatter: ['paths: ["**/*.vela"]', "metadata:", `  ${MARKER}: ${quoted(source.version)}`],
    },
    {
      id: "agents-project",
      tool: "AGENTS.md (every agent, project scope)",
      scope: "project",
      mode: "write",
      path: join(cwd, "AGENTS.md"),
      probes: [],
      frontmatter: [],
    },
    {
      id: "gemini",
      tool: "Gemini CLI (GEMINI.md)",
      scope: "project",
      mode: "write",
      path: join(cwd, "GEMINI.md"),
      probes: [join(cwd, ".gemini")],
      frontmatter: [],
    },
    {
      id: "aider",
      tool: "Aider",
      scope: "project",
      mode: "hint",
      path: join(cwd, ".aider.conf.yml"),
      probes: [join(cwd, ".aider.conf.yml"), join(home, ".aider.conf.yml")],
      frontmatter: [],
      note:
        "Aider has no auto-discovery, and rewriting a user's YAML risks corrupting it.\n" +
        `  Add this to .aider.conf.yml yourself:\n\n    read:\n      - ${join(cwd, "AGENTS.md")}\n` +
        "  (install the 'agents-project' target first, then read: AGENTS.md is enough)",
    },
  ];
}

/** The version stamped into an installed file, or null if it was not written by us. */
export function installedVersion(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!text.includes(MARKER)) return null;
  const match = new RegExp(`${MARKER}:?\\s*"?(\\d+\\.\\d+\\.\\d+)`).exec(text);
  return match?.[1] ?? "";
}

/** True when the tool looks installed, i.e. at least one probe path exists. */
export function isAvailable(target: Target): boolean {
  return target.probes.length === 0 || target.probes.some((probe) => existsSync(probe));
}

/**
 * Remove directories left empty by an uninstall, stopping at `stopAt`.
 *
 * `rmdir` on a shared parent like `~/.claude` would be a surprise if the user
 * keeps other config there, so the walk is bounded and never crosses `stopAt`.
 * `rmdirSync` rather than `rmSync`: the former only ever removes an empty
 * directory, so a concurrent write into one we are about to prune makes the call
 * fail instead of deleting something.
 */
function pruneEmptyParents(path: string, stopAt: string): void {
  const boundary = resolve(stopAt);
  let dir = dirname(path);
  for (let i = 0; i < 8; i += 1) {
    const current = resolve(dir);
    if (current === boundary || !current.startsWith(boundary + sep)) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      rmdirSync(current);
    } catch {
      return;
    }
    dir = dirname(current);
  }
}

function apply(target: Target, source: Source, options: Options): Outcome {
  if (target.mode === "hint") {
    return { target, status: "hinted", detail: target.note ?? "" };
  }

  if (options.uninstall) {
    return uninstall(target, options);
  }

  if (target.mode === "import") {
    const sourcePath = target.importSource;
    if (sourcePath === undefined || !existsSync(sourcePath)) {
      return {
        target,
        status: "skipped",
        detail: `nothing to import yet; install the 'claude' target first (${sourcePath ?? "unknown path"})`,
      };
    }
    const line = `@${sourcePath}`;
    // Both branches add the same three lines so that a later `--list` can tell
    // the file is ours even when we appended to a file the user already had.
    const block = [commentMarker(source.version), `<!-- see the Vela skill for ${sourcePath} -->`, line];
    let text = "";
    if (existsSync(target.path)) {
      try {
        text = readFileSync(target.path, "utf8");
      } catch {
        return { target, status: "conflict", detail: `cannot read ${target.path}` };
      }
      if (text.split("\n").some((l) => l.trim() === line)) {
        return { target, status: "current", detail: `already imports ${sourcePath}` };
      }
    }
    if (options.dryRun) {
      const verb = text === "" ? "create with" : "append";
      return { target, status: "appended", detail: `${target.path} (${verb} ${line})` };
    }
    const joined = text === "" ? "" : text.endsWith("\n") ? text : `${text}\n`;
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, `${joined}${block.join("\n")}\n`);
    return { target, status: "appended", detail: target.path };
  }

  const existing = installedVersion(target.path);
  const untouched = existsSync(target.path) && existing === null;

  if (untouched && !options.force) {
    return {
      target,
      status: "conflict",
      detail: `${target.path} already exists and was not written by vela; pass --force to overwrite`,
    };
  }
  if (existing === source.version) {
    return { target, status: "current", detail: target.path };
  }
  if (options.dryRun) {
    return {
      target,
      status: existing === null ? "installed" : "updated",
      detail: `${target.path} (write ${source.lineCount} lines)`,
    };
  }

  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, render(source, target));
  return {
    target,
    status: existing === null ? "installed" : "updated",
    detail: target.path,
  };
}

function uninstall(target: Target, options: Options): Outcome {
  if (!existsSync(target.path)) {
    return { target, status: "absent", detail: "nothing installed" };
  }
  if (target.mode === "import") {
    const text = readFileSync(target.path, "utf8");
    const before = text.split("\n");
    // Drop exactly the two lines we added — the import and its comment — and
    // nothing else. The user owns this file, so anything we cannot positively
    // identify as ours has to survive.
    const kept = before.filter((l) => {
      if (l.startsWith(`@${target.importSource ?? ""}`)) return false;
      if (l.startsWith("<!-- see the Vela skill for")) return false;
      if (l.trim() === `<!-- ${MARKER}: ${installedVersion(target.path)} -->`) return false;
      return true;
    });
    if (kept.length === before.length) {
      return { target, status: "absent", detail: "no vela import found" };
    }
    if (options.dryRun) return { target, status: "uninstalled", detail: `${target.path} (remove import line)` };
    const rendered = kept.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
    if (rendered.trim() === "") {
      // Nothing of the user's is left, so the file exists only to hold our
      // import. Removing it is the honest outcome.
      rmSync(target.path, { force: true });
    } else {
      writeFileSync(target.path, rendered);
    }
    return { target, status: "uninstalled", detail: target.path };
  }

  if (installedVersion(target.path) === null) {
    return { target, status: "absent", detail: "not written by vela; left alone" };
  }
  if (options.dryRun) return { target, status: "uninstalled", detail: `${target.path} (remove)` };

  rmSync(target.path, { force: true });
  const env = detectEnvironment();
  pruneEmptyParents(target.path, target.scope === "user" ? env.home : env.cwd);
  return { target, status: "uninstalled", detail: target.path };
}

/** Run one target. Kept separate so the tests can drive a single case. */
export function applyTarget(target: Target, source: Source, options: Options): Outcome {
  return apply(target, source, options);
}

/** The version a target currently holds, for drift reporting. */
export function drift(target: Target, current: string): "missing" | "current" | "outdated" | "foreign" {
  const version = installedVersion(target.path);
  if (version === null) return existsSync(target.path) ? "foreign" : "missing";
  return version === current ? "current" : "outdated";
}

export interface Warning {
  readonly target: Target | null;
  readonly message: string;
}

/**
 * Problems that do not stop the install but will make it do nothing useful, so
 * they are worth saying out loud. Each one corresponds to a real tool behaviour
 * that silently discards an instruction file.
 */
export function warningsFor(targets: readonly Target[], env: Environment): Warning[] {
  const warnings: Warning[] = [];
  const has = (id: string): Target | null => targets.find((t) => t.id === id) ?? null;

  const claudeMd = join(env.home, ".claude", "CLAUDE.md");
  if (existsSync(claudeMd)) {
    warnings.push({
      target: has("claude-md"),
      message:
        `${claudeMd} exists, so Claude Code will ignore AGENTS.md in a project (its default is\n` +
        "claude-md-or-agents-md). Use the 'claude-md' target, or a .claude/rules/vela.md path rule.",
    });
  }

  for (const legacy of [".rules", ".cursorrules", ".windsurfrules"]) {
    const found = join(env.cwd, legacy);
    if (!existsSync(found)) continue;
    warnings.push({
      target: has("agents-project"),
      message:
        `${found} exists. Zed takes the first matching instructions file and stops, so it will\n` +
        "never reach AGENTS.md. Merge the vela rules into it, or delete it.",
    });
  }

  const copilotWide = join(env.cwd, ".github", "copilot-instructions.md");
  if (existsSync(copilotWide)) {
    warnings.push({
      target: has("copilot"),
      message:
        `${copilotWide} exists; it applies to every file, so it is read even when no\n` +
        ".vela file is open. The path-scoped vela.instructions.md is the one that waits.",
    });
  }

  return warnings;
}

/** Render the human-readable report. */
export function formatReport(outcomes: readonly Outcome[], warnings: readonly Warning[]): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    const tag = outcome.status.padEnd(11);
    lines.push(`  ${tag} ${outcome.target.id.padEnd(15)} ${outcome.detail}`);
  }
  for (const warning of warnings) {
    lines.push("");
    // A warning is a sentence that has been hard-wrapped, so its continuation
    // lines need to line up under the first or it reads as a separate message.
    const [first = "", ...rest] = warning.message.split("\n");
    lines.push(`  warning: ${first}`);
    for (const line of rest) lines.push(`           ${line}`);
  }
  return lines.join("\n");
}
