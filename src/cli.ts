#!/usr/bin/env node
/**
 * The Vela command line.
 *
 *   vela run <file>     type-check and execute a program
 *   vela check <file>   type-check only, print nothing on success
 *   vela tokens <file>  print the token stream
 *   vela ast <file>     print the AST as an S-expression
 *   vela repl           start the interactive prompt
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

const USAGE = `Vela — a small statically-typed language

Usage
  vela run <file>       type-check and execute a program
  vela check <file...>  type-check one or more files
  vela tokens <file>    print the token stream from the lexer
  vela ast <file>       print the AST from the parser
  vela repl             start the interactive prompt
  vela --help           show this message

Exit status is 0 on success and 1 if any stage reported an error.`;

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

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
