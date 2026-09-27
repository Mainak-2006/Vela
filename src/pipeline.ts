/**
 * The pipeline driver.
 *
 * Every front-end entry point — the CLI, the REPL, the tests — runs source text
 * through exactly this sequence, so they cannot disagree about what "compiling"
 * means:
 *
 *     text → SourceFile → tokens → AST → checked AST
 *
 * Each stage appends to one shared `DiagnosticBag` and the driver stops after
 * the first stage that produced errors, because there is no point type-checking
 * a tree the parser did not fully understand. The result object always carries a
 * `SourceFile`, so a caller can render diagnostics with the right context.
 */

import { readFileSync } from "node:fs";

import { printProgram, type PrintOptions } from "./ast/astPrinter.js";
import type { Program } from "./ast/nodes.js";
import { DiagnosticBag, SourceFile, type Diagnostic } from "./diagnostics.js";
import { formatToken, tokenize } from "./lexer/lexer.js";
import type { Token } from "./lexer/token.js";
import { parse } from "./parser/parser.js";
import { check, type Symbol } from "./types/checker.js";

export type Stage = "lex" | "parse" | "check" | "ok";

export interface CompileResult {
  readonly source: SourceFile;
  /** The stage reached. `"ok"` means the program is fully checked. */
  readonly stage: Stage;
  /** Tokens from the lexer. Empty if lexing was not reached. */
  readonly tokens: readonly Token[];
  /** The parsed tree, if the parser ran. Never checked if `stage` is not `"ok"`. */
  readonly program: Program | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CompileOptions {
  /** Names already in scope, for REPL entries. */
  readonly known?: readonly Symbol[];
  /** Stop after the lexer, for `vela tokens`. */
  readonly lexOnly?: boolean;
  /** Stop after the parser, for `vela ast`. */
  readonly parseOnly?: boolean;
}

/** Run the front end over source text that is already in memory. */
export function compile(path: string, text: string, options: CompileOptions = {}): CompileResult {
  const source = new SourceFile(path, text);
  const bag = new DiagnosticBag();

  const tokens = tokenize(source, bag);
  if (options.lexOnly || bag.hasErrors()) {
    return { source, stage: "lex", tokens, program: null, diagnostics: bag.all() };
  }

  const program = parse(tokens, bag);
  if (options.parseOnly || bag.hasErrors()) {
    return {
      source,
      stage: bag.hasErrors() ? "parse" : "parse",
      tokens,
      program,
      diagnostics: bag.all(),
    };
  }

  check(program, bag, options.known ?? []);
  const stage: Stage = bag.hasErrors() ? "check" : "ok";
  return { source, stage, tokens, program, diagnostics: bag.all() };
}

/** Run the front end over a file on disk. */
export function compileFile(path: string, options: CompileOptions = {}): CompileResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const source = new SourceFile(path, "");
    const bag = new DiagnosticBag();
    bag.add(
      cause instanceof Error && "code" in cause && cause.code === "ENOENT"
        ? "no such file"
        : `cannot read file: ${cause instanceof Error ? cause.message : String(cause)}`,
      { offset: 0, length: 0, line: 1, column: 1 },
    );
    return { source, stage: "lex", tokens: [], program: null, diagnostics: bag.all() };
  }
  return compile(path, text, options);
}

/** Render a token stream one token per line. Used by `vela tokens`. */
export function formatTokens(tokens: readonly Token[]): string {
  return tokens.map(formatToken).join("\n");
}

/** Render a program's AST. Used by `vela ast`. */
export function formatAst(program: Program, options?: PrintOptions): string {
  return printProgram(program, options);
}
