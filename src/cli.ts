#!/usr/bin/env node
/**
 * The Vela command line.
 *
 *   vela run <file>     type-check and execute a program
 *   vela check <file>   type-check only, print nothing on success
 *   vela tokens <file>  print the token stream
 *   vela ast <file>     print the AST as an S-expression
 *   vela repl           start the interactive prompt
 *   vela install-skill  add the Vela skill to a coding assistant
 *   vela --help         show usage
 *
 * `tokens` and `ast` exist so each front-end stage can be inspected on its own.
 * When a stage is misbehaving, seeing what the previous stage handed it is the
 * fastest way to find out which one is wrong.
 */

import { resolve } from "node:path";

import { renderDiagnostic, renderDiagnostics } from "./diagnostics.js";
import { compileFile, formatAst, formatTokens } from "./pipeline.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "./runtime/interpreter.js";
import { startRepl } from "./repl/repl.js";
import {
  applyTarget,
  buildTargets,
  detectEnvironment,
  drift,
  formatReport,
  isAvailable,
  readSource,
  warningsFor,
  type Outcome,
  type Target,
} from "./skill/install.js";

const USAGE = `Vela — a small statically-typed language

Usage
  vela run <file>       type-check and execute a program
  vela check <file...>  type-check one or more files
  vela tokens <file>    print the token stream from the lexer
  vela ast <file>       print the AST from the parser
  vela repl             start the interactive prompt
  vela --help           show this message

Also
  vela install-skill [options]   add the Vela skill to a coding assistant
    --target <id>    repeatable; default is every target that is detected
    --scope <s>      user | project | both        (default: both)
    --list           show each target, and whether it is installed
    --dry-run        report what would change, and change nothing
    --force          overwrite a file that vela did not write
    --uninstall      remove what a previous install wrote

Exit status is 0 on success and 1 if any stage reported an error.`;

/** Usage for `install-skill` itself, listing the target ids it accepts. */
function skillUsage(targets: readonly Target[]): string {
  const lines = targets.map((t) => `  ${t.id.padEnd(15)} ${t.tool}  [${t.scope}]`);
  return `Install the Vela skill into a coding assistant.

Targets
${lines.join("\n")}

Options
  --target <id>    repeatable; default is every target that is detected
  --scope <s>      user | project | both        (default: both)
  --list           show each target, and whether it is installed
  --dry-run        report what would change, and change nothing
  --force          overwrite a file that vela did not write
  --uninstall      remove what a previous install wrote`;
}

/**
 * A reader that goes away — `vela run fizzbuzz.vela | head -5` — leaves us
 * writing to a closed pipe, and Node reports that as an `error` event on stdout.
 * Unhandled, it becomes a stack trace, which is a crash for something that is
 * really just a program that printed more than anyone wanted to read. Exiting
 * quietly is what every other filter in a pipeline does.
 */
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case "run":
      return runCommand(rest);
    case "check":
      return checkCommand(rest);
    case "tokens":
      return tokensCommand(rest);
    case "ast":
      return astCommand(rest);
    case "repl":
      await startRepl();
      return 0;
    case "install-skill":
      return installSkillCommand(rest);
    default:
      console.error(`unknown command '${command}'\n`);
      console.error(USAGE);
      return 1;
  }
}

function requireFile(args: readonly string[], command: string): string | null {
  const target = args[0];
  if (!target) {
    console.error(`vela ${command}: expected a file path\n`);
    return null;
  }
  return resolve(target);
}

function runCommand(args: readonly string[]): number {
  const path = requireFile(args, "run");
  if (!path) return 1;

  const result = compileFile(path);
  if (result.stage !== "ok" || !result.program) {
    console.error(renderDiagnostics(result.source, result.diagnostics));
    return 1;
  }

  try {
    new Interpreter(createGlobalEnvironment()).run(result.program);
    return 0;
  } catch (thrown) {
    if (thrown instanceof RuntimeError) {
      console.error(renderDiagnostic(result.source, {
        severity: "error",
        message: thrown.message,
        location: thrown.location,
        notes: [],
        brief: false,
      }));
      return 1;
    }
    throw thrown;
  }
}

function checkCommand(args: readonly string[]): number {
  if (args.length === 0) {
    console.error("vela check: expected at least one file path\n");
    return 1;
  }
  let failed = 0;
  for (const target of args) {
    const path = resolve(target);
    const result = compileFile(path);
    if (result.stage === "ok") {
      // Report the declaration count, so silence is never ambiguous.
      const count = result.program?.declarations.length ?? 0;
      console.log(
        `${target}: ok (${count} top-level ${count === 1 ? "declaration" : "declarations"})`,
      );
      continue;
    }
    failed++;
    console.error(renderDiagnostics(result.source, result.diagnostics));
  }
  return failed > 0 ? 1 : 0;
}

function tokensCommand(args: readonly string[]): number {
  const path = requireFile(args, "tokens");
  if (!path) return 1;

  const result = compileFile(path, { lexOnly: true });
  if (result.diagnostics.length > 0) {
    console.error(renderDiagnostics(result.source, result.diagnostics));
  }
  console.log(formatTokens(result.tokens));
  return result.diagnostics.length > 0 ? 1 : 0;
}

function astCommand(args: readonly string[]): number {
  const path = requireFile(args, "ast");
  if (!path) return 1;

  const showLocations = args.includes("--locations");
  const result = compileFile(path, { parseOnly: true });

  // The parser returns a partial tree even when it reports errors, so the tree
  // being present does not mean the parse succeeded. Report the diagnostics
  // first, then the partial tree if there is one, and fail either way.
  if (result.diagnostics.length > 0) {
    console.error(renderDiagnostics(result.source, result.diagnostics));
  }
  if (result.program) {
    console.log(formatAst(result.program, { locations: showLocations }));
  }
  return result.diagnostics.length > 0 ? 1 : 0;
}

function installSkillCommand(args: readonly string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    let source;
    try {
      source = readSource();
    } catch (thrown) {
      console.error(`${(thrown as Error).message}\n`);
      return 1;
    }
    console.log(skillUsage(buildTargets(detectEnvironment(), source)));
    return 0;
  }

  const flags = new Set(["--list", "--dry-run", "--force", "--uninstall"]);
  const wanted: string[] = [];
  let scope: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (flags.has(arg)) continue;
    if (arg === "--target" || arg === "--scope") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error(`vela install-skill: ${arg} needs a value\n`);
        return 1;
      }
      i += 1;
      if (arg === "--target") wanted.push(value);
      else scope = value;
      continue;
    }
    console.error(`vela install-skill: unknown option '${arg}'\n`);
    return 1;
  }

  const SCOPES = new Set(["user", "project", "both"]);
  if (scope !== null && !SCOPES.has(scope)) {
    console.error(`vela install-skill: --scope must be user, project, or both\n`);
    return 1;
  }

  let source;
  try {
    source = readSource();
  } catch (thrown) {
    console.error(`${(thrown as Error).message}\n`);
    return 1;
  }

  const all = buildTargets(detectEnvironment(), source);
  const known = new Map(all.map((t) => [t.id, t]));

  for (const id of wanted) {
    if (!known.has(id)) {
      console.error(`vela install-skill: unknown target '${id}'\n`);
      console.error(`Valid targets: ${[...known.keys()].join(", ")}\n`);
      return 1;
    }
  }

  // An explicit --target is honoured even when the tool was not detected, because
  // the user may be installing ahead of running the tool for the first time.
  const selected = wanted.length > 0
    ? wanted.map((id) => known.get(id) as Target)
    : all.filter((t) => isAvailable(t));

  const targets = scope === null || scope === "both"
    ? selected
    : selected.filter((t) => t.scope === scope);

  if (targets.length === 0) {
    console.log("No matching targets.\n");
    console.log("Nothing was detected. Name one explicitly:\n");
    console.log(skillUsage(all));
    return 1;
  }

  if (args.includes("--list")) {
    console.log(skillUsage(all));
    console.log("");
    for (const target of all) {
      const state = drift(target, source.meta.version);
      const detected = isAvailable(target) ? "detected" : "-";
      console.log(
        `  ${target.id.padEnd(15)} ${target.scope.padEnd(8)} ${detected.padEnd(9)} ${state.padEnd(9)} ${target.path}`,
      );
    }
    return 0;
  }

  const options = {
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    uninstall: args.includes("--uninstall"),
  };

  const outcomes: Outcome[] = targets.map((t) => applyTarget(t, source, options));
  const warnings = warningsFor(targets, detectEnvironment());

  const verb = options.uninstall ? "Uninstalling" : options.dryRun ? "Would install" : "Installing";
  console.log(`${verb} the vela skill (v${source.meta.version}, ${source.lineCount} lines)\n`);
  console.log(formatReport(outcomes, warnings));

  const notes = outcomes.filter((o) => o.status === "hinted" || o.status === "skipped");
  for (const note of notes) {
    if (note.detail === "") continue;
    console.log(`\n  ${note.target.id}:`);
    console.log(note.detail.split("\n").map((l) => `  ${l}`).join("\n"));
  }

  if (!options.dryRun && outcomes.some((o) => o.status === "installed" || o.status === "appended")) {
    console.log("\n  Restart the tool for it to pick the skill up. opencode re-reads skills at startup.");
  }

  // A conflict means the user asked for something and did not get it, which is
  // a failure worth a non-zero exit; a target merely not being detected is not.
  return outcomes.some((o) => o.status === "conflict") ? 1 : 0;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
