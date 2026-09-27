import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyTarget,
  buildTargets,
  detectEnvironment,
  drift,
  isAvailable,
  readSource,
  SKILL_LINE_LIMIT,
  SKILL_NAME,
  type Options,
  type Target,
} from "../src/skill/install.js";
import { compile } from "../src/pipeline.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "src", "cli.ts");

const sandboxes: string[] = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

interface Sandbox {
  readonly home: string;
  readonly project: string;
  readonly env: ReturnType<typeof detectEnvironment>;
  readonly source: ReturnType<typeof readSource>;
  readonly targets: readonly Target[];
}

/**
 * A throwaway HOME and project directory.
 *
 * The installer writes outside the repository by design, so every test gets its
 * own tree rather than sharing one — otherwise a case that leaves a file behind
 * would make the next one lie about its starting state.
 */
function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "vela-skill-"));
  sandboxes.push(base);
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env = { home, cwd: project };
  const source = readSource();
  return { home, project, env, source, targets: buildTargets(env, source) };
}

const quiet: Options = { dryRun: false, force: false, uninstall: false };
const dryRun: Options = { dryRun: true, force: false, uninstall: false };
const force: Options = { dryRun: false, force: true, uninstall: false };
const removing: Options = { dryRun: false, force: false, uninstall: true };

function find(targets: readonly Target[], id: string): Target {
  const target = targets.find((t) => t.id === id);
  assert.ok(target, `no target '${id}'`);
  return target;
}

/** Every file under a directory, relative to it, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

/** Drive the real CLI so exit codes and argument parsing are exercised too. */
function vela(home: string, project: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env, VELA_HOME: home, VELA_CWD: project };
  try {
    const stdout = execFileSync("npx", ["tsx", cli, ...args], {
      encoding: "utf8",
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (thrown) {
    const failure = thrown as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

// --- the stub itself -------------------------------------------------------

test("the skill stub is within the line limit the specification asks for", () => {
  const source = readSource();
  assert.ok(
    source.lineCount <= SKILL_LINE_LIMIT,
    `docs/vela.SKILL.md is ${source.lineCount} lines, over the ${SKILL_LINE_LIMIT} limit`,
  );
});

test("the stub's frontmatter is what the Agent Skills specification requires", () => {
  const { meta } = readSource();
  assert.equal(meta.name, SKILL_NAME);
  // The spec requires the name to match the directory it lives in, and allows
  // only lowercase alphanumerics and single hyphens.
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(meta.description.length > 0, "description is required, and is the only thing a loader sees up front");
  assert.ok(meta.description.length <= 1024, "the specification caps description at 1024 characters");
  assert.ok(meta.version.length > 0);
});

test("every target that installs a skill names it after the skill", () => {
  for (const target of buildTargets({ home: "/tmp/h", cwd: "/tmp/p" }, readSource())) {
    if (target.mode !== "write" || target.frontmatter.length === 0) continue;
    if (target.path.endsWith(".mdc") || target.path.endsWith(".instructions.md")) continue;
    if (target.frontmatter[0]?.startsWith("name:") !== true) continue;
    assert.ok(
      target.path.includes(`${sep}${SKILL_NAME}${sep}`),
      `${target.id} should install into a directory named '${SKILL_NAME}', got ${target.path}`,
    );
  }
});

// --- the examples in the stub ---------------------------------------------

test("the stub's examples still compile, and the deliberate errors still fail", () => {
  const text = readFileSync(join(root, "docs", "vela.SKILL.md"), "utf8");
  const blocks = [...text.matchAll(/```vela\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  assert.ok(blocks.length >= 8, `expected the stub to keep its examples, found ${blocks.length}`);

  // A block is meant to be rejected when it is annotated as an error; anything
  // else has to type-check, which is what catches an edit that breaks an example.
  const rejected = blocks.filter((b) => b.includes("// error"));
  const accepted = blocks.filter((b) => !b.includes("// error"));

  for (const block of rejected) {
    const result = compile("<stub>", block);
    assert.notEqual(result.stage, "ok", `this block is annotated as an error but compiled:\n${block}`);
  }

  // The recipes chain — trunc feeds floor, ceil, round and idiv, which feed
  // oneDecimal — so they are checked the way the document tells a reader to use
  // them: in sequence, not one block at a time.
  const chain = accepted.join("\n");
  const result = compile("<stub>", chain);
  assert.equal(
    result.stage,
    "ok",
    `the stub's examples no longer compile: ${result.diagnostics.map((d) => d.message).join("; ")}`,
  );
});

// --- scope containment -----------------------------------------------------

test("no target writes outside the scope it claims", () => {
  const { env, targets } = sandbox();
  for (const target of targets) {
    const boundary = resolve(target.scope === "user" ? env.home : env.cwd);
    const path = resolve(target.path);
    assert.ok(
      path === boundary || path.startsWith(boundary + sep),
      `${target.id} (${target.scope}) escapes its root: ${path} is not under ${boundary}`,
    );
  }
});

test("a target id is a plain identifier, so it cannot walk out of its directory", () => {
  for (const target of buildTargets({ home: "/tmp/h", cwd: "/tmp/p" }, readSource())) {
    assert.match(target.id, /^[a-z][a-z-]*$/, `target id '${target.id}' should be a bare slug`);
  }
});

// --- install and uninstall -------------------------------------------------

test("--dry-run reports changes without writing anything", () => {
  const { env, targets, source } = sandbox();
  for (const target of targets) {
    if (target.scope !== "user") continue;
    applyTarget(target, source, dryRun);
  }
  assert.deepEqual(tree(env.home), []);
});

test("a write target produces frontmatter, a marker, and no leftover placeholder", () => {
  const { targets, source } = sandbox();
  const target = find(targets, "agents");
  const outcome = applyTarget(target, source, quiet);
  assert.equal(outcome.status, "installed");

  const text = readFileSync(target.path, "utf8");
  assert.ok(text.startsWith("---\n"), "a skill file must open with frontmatter");
  assert.match(text, /^name: vela$/m);
  assert.match(text, /vela-skill-install/, "the marker is what makes uninstall safe");
  assert.ok(!text.includes("{{FULL_REFERENCE}}"), "the placeholder should have been resolved");
  assert.ok(text.includes(source.reference), "the full reference should be named by absolute path");
});

test("the full reference is named by absolute path, never imported", () => {
  const source = readSource();
  assert.ok(source.reference.startsWith(sep), `the reference path should be absolute, got ${source.reference}`);
  assert.ok(existsSync(source.reference), `the referenced file should exist: ${source.reference}`);
});

test("a path-gated target gets its own frontmatter and not the skill's name", () => {
  const { targets } = sandbox();
  for (const id of ["cursor", "copilot", "claude-rules"]) {
    const target = find(targets, id);
    assert.ok(target.frontmatter.length > 0, `${id} needs frontmatter or the tool will ignore the file`);
  }
  const cursor = find(targets, "cursor");
  assert.ok(cursor.frontmatter.includes('globs: "**/*.vela"'), "Cursor only applies a rule when the file matches");
  assert.ok(cursor.frontmatter.includes("alwaysApply: false"), "an always-apply rule would be read on every prompt");
  assert.ok(cursor.path.endsWith(".mdc"), "Cursor ignores plain .md in .cursor/rules");
});

test("AGENTS.md is installed as plain markdown, because that is its format", () => {
  const { targets } = sandbox();
  const target = find(targets, "agents-project");
  assert.deepEqual([...target.frontmatter], [], "YAML frontmatter in AGENTS.md is not a thing tools read");
  assert.equal(target.path.endsWith("AGENTS.md"), true);
});

test("re-installing is a no-op once the version matches", () => {
  const { targets, source } = sandbox();
  const target = find(targets, "agents");
  assert.equal(applyTarget(target, source, quiet).status, "installed");
  const first = readFileSync(target.path, "utf8");
  assert.equal(applyTarget(target, source, quiet).status, "current");
  assert.equal(readFileSync(target.path, "utf8"), first, "a second run must not rewrite identical content");
});

test("an outdated copy is reported as such and repaired on the next install", () => {
  const { targets, source } = sandbox();
  const target = find(targets, "agents");
  applyTarget(target, source, quiet);
  writeFileSync(target.path, readFileSync(target.path, "utf8").replace(source.meta.version, "0.0.1"));

  assert.equal(drift(target, source.meta.version), "outdated");
  assert.equal(applyTarget(target, source, quiet).status, "updated");
  assert.equal(drift(target, source.meta.version), "current");
});

test("a file vela did not write is a conflict, and --force is required", () => {
  const { targets, source } = sandbox();
  const target = find(targets, "agents-project");
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, "# My project\n");

  const blocked = applyTarget(target, source, quiet);
  assert.equal(blocked.status, "conflict");
  assert.equal(readFileSync(target.path, "utf8"), "# My project\n", "a rejected install must not have touched it");

  assert.equal(applyTarget(target, source, force).status, "installed");
  assert.match(readFileSync(target.path, "utf8"), /# Vela/);
});

test("uninstall removes what was installed and prunes the directories it created", () => {
  const { env, targets, source } = sandbox();
  const target = find(targets, "claude");
  applyTarget(target, source, quiet);
  assert.deepEqual(tree(env.home), [`.claude/skills/${SKILL_NAME}/SKILL.md`]);

  assert.equal(applyTarget(target, source, removing).status, "uninstalled");
  assert.deepEqual(tree(env.home), [], "the directories we created should not be left behind");
});

test("uninstall never prunes past the scope root, so other config survives", () => {
  const { env, targets, source } = sandbox();
  const other = join(env.home, ".claude", "settings.json");
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, "{}\n");

  const target = find(targets, "claude");
  applyTarget(target, source, quiet);
  applyTarget(target, source, removing);

  assert.deepEqual(tree(env.home), [".claude/settings.json"]);
  assert.equal(existsSync(env.home), true);
});

test("uninstall leaves a file it does not own alone", () => {
  const { targets, source } = sandbox();
  const target = find(targets, "agents-project");
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, "someone else's file\n");

  assert.equal(applyTarget(target, source, removing).status, "absent");
  assert.equal(readFileSync(target.path, "utf8"), "someone else's file\n");
});

test("--uninstall --dry-run removes nothing", () => {
  const { env, targets, source } = sandbox();
  const target = find(targets, "claude");
  applyTarget(target, source, quiet);
  const before = tree(env.home);
  applyTarget(target, source, { dryRun: true, force: false, uninstall: true });
  assert.deepEqual(tree(env.home), before);
});

test("a dry run on an uninstall reports what it would remove", () => {
  const { env, targets, source } = sandbox();
  const target = find(targets, "claude");
  applyTarget(target, source, quiet);
  const outcome = applyTarget(target, source, { dryRun: true, force: false, uninstall: true });
  assert.equal(outcome.status, "uninstalled");
  assert.equal(existsSync(target.path), true);
});

// --- the import target -----------------------------------------------------

test("the claude-md import waits for the skill it points at", () => {
  const { targets, source } = sandbox();
  const importTarget = find(targets, "claude-md");

  const tooEarly = applyTarget(importTarget, source, quiet);
  assert.equal(tooEarly.status, "skipped", "a dangling import would prompt for approval on every start");
  assert.equal(existsSync(importTarget.path), false);
});

test("the import target preserves the user's own memory file", () => {
  const { env, targets, source } = sandbox();
  mkdirSync(join(env.home, ".claude"), { recursive: true });
  writeFileSync(join(env.home, ".claude", "CLAUDE.md"), "# Mine\n\nPrefer tabs.\n");

  const skill = find(targets, "claude");
  const claudeMd = find(targets, "claude-md");

  assert.equal(applyTarget(skill, source, quiet).status, "installed");
  assert.equal(applyTarget(claudeMd, source, quiet).status, "appended");

  const afterInstall = readFileSync(join(env.home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(afterInstall, /Prefer tabs\./, "the user's own instructions must survive");
  assert.ok(afterInstall.includes(skill.path), "and the import must be there");

  assert.equal(applyTarget(claudeMd, source, removing).status, "uninstalled");
  const afterRemove = readFileSync(join(env.home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(afterRemove, /Prefer tabs\./);
  assert.ok(!afterRemove.includes("vela-skill-install"), "our marker should be gone too");
  assert.ok(!afterRemove.includes(skill.path));
});

test("re-adding the import is not duplicated", () => {
  const { env, targets, source } = sandbox();
  const skill = find(targets, "claude");
  const claudeMd = find(targets, "claude-md");

  applyTarget(skill, source, quiet);
  applyTarget(claudeMd, source, quiet);
  assert.equal(applyTarget(claudeMd, source, quiet).status, "current");
  const text = readFileSync(claudeMd.path, "utf8");
  assert.equal(text.split(`@${skill.path}`).length - 1, 1, "the import line should appear exactly once");
});

// --- detection -------------------------------------------------------------

test("detection follows the tool's own configuration directory", () => {
  const { env, targets } = sandbox();
  assert.equal(isAvailable(find(targets, "claude")), false, "no ~/.claude yet");

  mkdirSync(join(env.home, ".claude"), { recursive: true });
  assert.equal(isAvailable(find(targets, "claude")), true);
});

test("a project-scope target needs no detection, because it writes into the project", () => {
  const { targets } = sandbox();
  assert.deepEqual([...find(targets, "agents-project").probes], []);
});

test("the aider target reports its manual step instead of rewriting the user's YAML", () => {
  const { targets } = sandbox();
  const target = find(targets, "aider");
  assert.equal(target.mode, "hint");
  assert.ok((target.note ?? "").includes("read:"), "the note should give the exact key to add");
});

test("targets are named so the tool they serve is obvious", () => {
  for (const target of buildTargets({ home: "/tmp/h", cwd: "/tmp/p" }, readSource())) {
    assert.ok(target.tool.length > 0, `${target.id} should name its tool`);
    assert.ok(target.scope === "user" || target.scope === "project");
  }
});

// --- the command line ------------------------------------------------------

test("vela install-skill --help lists every target and exits 0", () => {
  const { home, project, targets } = sandbox();
  const { status, stdout } = vela(home, project, "install-skill", "--help");
  assert.equal(status, 0);
  for (const target of targets) {
    assert.match(stdout, new RegExp(`\\b${target.id}\\b`), `help should list the '${target.id}' target`);
  }
});

test("vela --help mentions install-skill", () => {
  const { status, stdout } = vela(sandbox().home, sandbox().project, "--help");
  assert.equal(status, 0);
  assert.match(stdout, /vela install-skill/);
});

test("vela install-skill --list exits 0 and reports each target's state", () => {
  const { home, project, targets } = sandbox();
  const { status, stdout } = vela(home, project, "install-skill", "--list");
  assert.equal(status, 0);
  for (const target of targets) {
    assert.match(stdout, new RegExp(`\\b${target.id}\\b`), `list should show '${target.id}'`);
  }
  assert.match(stdout, /missing/, "an uninstalled target should read as missing");
});

test("an unknown --target exits 1 and names the valid ones", () => {
  const { home, project } = sandbox();
  const { status, stderr } = vela(home, project, "install-skill", "--target", "emacs");
  assert.equal(status, 1);
  assert.match(stderr, /unknown target 'emacs'/);
  assert.match(stderr, /agents-project/, "the error should list what is available");
});

test("an unknown option exits 1", () => {
  const { home, project } = sandbox();
  const { status, stderr } = vela(home, project, "install-skill", "--wat");
  assert.equal(status, 1);
  assert.match(stderr, /unknown option '--wat'/);
});

test("--scope with a bad value exits 1", () => {
  const { home, project } = sandbox();
  const { status, stderr } = vela(home, project, "install-skill", "--scope", "everywhere");
  assert.equal(status, 1);
  assert.match(stderr, /--scope must be user, project, or both/);
});

test("--target with no value exits 1", () => {
  const { home, project } = sandbox();
  const { status, stderr } = vela(home, project, "install-skill", "--target");
  assert.equal(status, 1);
  assert.match(stderr, /--target needs a value/);
});

test("--scope user keeps the install out of the project", () => {
  const { home, project } = sandbox();
  const { status } = vela(home, project, "install-skill", "--scope", "user", "--target", "agents");
  assert.equal(status, 0);
  assert.equal(existsSync(join(home, ".agents", "skills", SKILL_NAME, "SKILL.md")), true);
  assert.deepEqual(tree(project), [], "the project should be untouched");
});

test("--scope project writes into the working directory", () => {
  const { home, project } = sandbox();
  const { status } = vela(home, project, "install-skill", "--scope", "project", "--target", "agents-project");
  assert.equal(status, 0);
  assert.equal(existsSync(join(project, "AGENTS.md")), true);
  assert.deepEqual(tree(home), []);
});

test("the command's dry run writes nothing anywhere", () => {
  const { home, project } = sandbox();
  const { status } = vela(home, project, "install-skill", "--dry-run", "--target", "agents", "--target", "agents-project");
  assert.equal(status, 0);
  assert.deepEqual(tree(home), []);
  assert.deepEqual(tree(project), []);
});

test("a conflict makes the command exit non-zero", () => {
  const { home, project } = sandbox();
  writeFileSync(join(project, "AGENTS.md"), "# Mine\n");
  const { status, stdout } = vela(home, project, "install-skill", "--target", "agents-project");
  assert.equal(status, 1, "the user asked for an install and did not get one");
  assert.match(stdout, /conflict/);
});

test("the environment override is what keeps a test run out of the real home", () => {
  const { env, project } = sandbox();
  assert.equal(env.home, resolve(env.home));
  assert.ok(!env.home.startsWith(process.env.HOME ?? ""), "the sandbox home must not be the real one");
  assert.equal(env.cwd, project);
});

test("detectEnvironment falls back to the process cwd when VELA_CWD is unset", () => {
  const previous = process.env.VELA_CWD;
  delete process.env.VELA_CWD;
  try {
    assert.equal(detectEnvironment().cwd, resolve(process.cwd()));
  } finally {
    if (previous !== undefined) process.env.VELA_CWD = previous;
  }
});
