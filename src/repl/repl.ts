/**
 * The REPL — read, evaluate, print, loop.
 *
 * Two things make this more than a `while` around the interpreter:
 *
 *   - **State persists.** Bindings from one entry live in a single global
 *     `Environment` that every later entry shares, and their types are fed back
 *     into the checker as a known scope. Without that second half, `let x: number
 *     = 1;` followed by `x + 1;` would fail to resolve `x`, because each entry is
 *     checked as a fresh program.
 *
 *   - **Multi-line input.** An entry is held in a buffer until it looks complete.
 *     Two signals are used: unbalanced braces or parentheses, and a trailing
 *     operator or comma. This is a heuristic, not a parse of the grammar, and a
 *     construct the heuristic misjudges can still be finished by ending the
 *     entry with a blank line.
 */

import { createInterface, type Interface } from "node:readline/promises";

import type { Declaration } from "../ast/nodes.js";
import { DiagnosticBag, SourceFile, renderDiagnostic, type Diagnostic } from "../diagnostics.js";
import { TOKEN } from "../lexer/token.js";
import { tokenize } from "../lexer/lexer.js";
import type { Symbol } from "../types/checker.js";
import { functionType, primitiveType } from "../types/types.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "../runtime/interpreter.js";
import { displayValue, setInput, setOutput, type Value } from "../runtime/values.js";
import { compile } from "../pipeline.js";

const PROMPT = "vela> ";
const CONTINUATION = "  ... ";

export interface ReplOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /**
   * Data lines to serve to `read()`, drained one per call. The REPL owns the
   * terminal for its own input, so it cannot also read descriptor 0; an embedder
   * that wants `read()` to work passes the lines here. With none, `read()` is
   * immediately at end of input and returns `""`.
   */
  readonly inputLines?: readonly string[];
  /** Called when the user asks to exit. */
  readonly onExit?: () => void;
}

/** Symbols for the top-level declarations of an entry, so later entries can see them. */
function symbolsOf(declarations: readonly Declaration[]): Symbol[] {
  const symbols: Symbol[] = [];
  for (const declaration of declarations) {
    if (declaration.kind === "letDecl") {
      symbols.push({
        name: declaration.name,
        type: primitiveType(declaration.type),
        kind: "variable",
        location: declaration.nameLocation,
      });
    } else if (declaration.kind === "fnDecl") {
      symbols.push({
        name: declaration.name,
        type: functionType(
          declaration.params.map((p) => primitiveType(p.type)),
          primitiveType(declaration.returnType),
        ),
        kind: "function",
        location: declaration.nameLocation,
      });
    }
  }
  return symbols;
}

/**
 * Whether more input is needed. True when brackets are still open, or when the
 * last real token is one that cannot end an expression.
 */
export function isIncomplete(text: string): boolean {
  const bag = new DiagnosticBag();
  const tokens = tokenize(new SourceFile("<repl>", text), bag);
  if (bag.hasErrors()) return false;

  let depth = 0;
  let last: string | null = null;
  for (const token of tokens) {
    switch (token.kind) {
      // `[` belongs here because `s[` is as unfinished as `s(`. Indexing is a
      // suffix, so the same heuristic covers both.
      case TOKEN.LEFT_BRACE:
      case TOKEN.LEFT_PAREN:
      case TOKEN.LEFT_BRACKET:
        depth++;
        break;
      case TOKEN.RIGHT_BRACE:
      case TOKEN.RIGHT_PAREN:
      case TOKEN.RIGHT_BRACKET:
        depth--;
        break;
      case TOKEN.EOF:
        break;
      default:
        last = token.kind;
    }
  }
  if (depth > 0) return true;
  if (last === null) return false;

  // A trailing binary operator, a comma, or an opening bracket means the
  // expression is unfinished. The compound-assignment operators belong here too,
  // so typing `x +=` asks for a right-hand side instead of failing.
  return [
    TOKEN.PLUS, TOKEN.MINUS, TOKEN.STAR, TOKEN.SLASH, TOKEN.PERCENT,
    TOKEN.PLUS_EQUAL, TOKEN.MINUS_EQUAL, TOKEN.STAR_EQUAL,
    TOKEN.SLASH_EQUAL, TOKEN.PERCENT_EQUAL,
    TOKEN.EQUAL, TOKEN.EQUAL_EQUAL, TOKEN.BANG_EQUAL,
    TOKEN.LESS, TOKEN.LESS_EQUAL, TOKEN.GREATER, TOKEN.GREATER_EQUAL,
    TOKEN.AND_AND, TOKEN.OR_OR, TOKEN.COMMA, TOKEN.COLON,
  ].includes(last as never);
}

export class Repl {
  private readonly globals = createGlobalEnvironment();
  private readonly interpreter = new Interpreter(this.globals);
  private readonly known: Symbol[] = [];
  private buffer = "";
  private restoreOutput: (() => void) | null = null;
  private restoreInput: (() => void) | null = null;

  constructor(private readonly options: ReplOptions = {}) {
    // Route the interpreter's own output through our stream too. Without this,
    // `print` inside an entry would go straight to process.stdout and vanish
    // from a piped or captured session, while the REPL's echoes and diagnostics
    // went to the caller's stream. That split makes the stream useless.
    if (options.output) {
      const stream = options.output;
      this.restoreOutput = setOutput((text) => {
        stream.write(`${text}\n`);
      });
    }
  }

  /** Restore process-wide state. Only needed when a custom output was given. */
  dispose(): void {
    this.restoreOutput?.();
    this.restoreOutput = null;
    this.restoreInput?.();
    this.restoreInput = null;
  }

  async start(): Promise<void> {
    const input = this.options.input ?? process.stdin;
    const output = this.options.output ?? process.stdout;
    const rl = createInterface({ input, output, prompt: PROMPT, terminal: true }) as Interface;

    // The interpreter reads stdin synchronously, but readline has already buffered
    // the whole stream, so descriptor 0 is empty by the time an entry runs, and
    // re-reading it would race the next thing the user types. So `read()` is served
    // from a queue the embedder filled, and that queue is empty unless it says
    // otherwise -- which means `read()` reports end of input rather than handing
    // back the line that was just typed, which would be a source of Vela code
    // answering a question about the outside world.
    const data = [...(this.options.inputLines ?? [])];
    this.restoreInput = setInput(() => (data.length > 0 ? data.shift()! : ""));

    this.banner();
    output.write(PROMPT);

    for await (const line of rl) {
      const trimmed = line.trim();

      // Dot commands are recognised even while an entry is pending. Nothing in
      // Vela can begin with '.', so this is unambiguous, and it means `.reset`
      // and `.exit` can rescue a buffer that the completeness heuristic has
      // wrongly decided is unfinished.
      if (trimmed.startsWith(".")) {
        const abandoned = this.buffer !== "";
        this.buffer = "";
        const keepGoing = this.handleDotCommand(trimmed);
        if (abandoned) this.write("entry discarded\n");
        if (!keepGoing) break;
        output.write(PROMPT);
        continue;
      }

      this.buffer = this.buffer === "" ? line : `${this.buffer}\n${line}`;

      // A blank line always ends the entry, which is the escape hatch when the
      // completeness heuristic is wrong.
      if (isIncomplete(this.buffer) && trimmed !== "") {
        output.write(CONTINUATION);
        continue;
      }

      this.submit(this.buffer);
      this.buffer = "";
      output.write(PROMPT);
    }

    rl.close();
    output.write("goodbye\n");
    this.dispose();
    this.options.onExit?.();
  }

  /** Compile and run one complete entry. Exposed so tests can drive it directly. */
  submit(text: string): { output: string; value?: Value } {
    const result = compile("<repl>", text, { known: this.known });
    if (result.stage !== "ok" || !result.program) {
      this.reportDiagnostics(result.source.text, result.diagnostics);
      return { output: "" };
    }

    try {
      const value = this.interpreter.run(result.program);
      for (const declaration of result.program.declarations) {
        this.known.push(...symbolsOf([declaration]));
      }
      if (value.kind !== "void") {
        this.write(`${displayValue(value)}\n`);
        return { output: displayValue(value), value };
      }
      return { output: "" };
    } catch (thrown) {
      if (thrown instanceof RuntimeError) {
        this.reportDiagnostics(text, [
          {
            severity: "error",
            message: thrown.message,
            location: thrown.location,
            notes: [],
            brief: false,
          },
        ]);
        return { output: "" };
      }
      throw thrown;
    }
  }

  /** Reset the accumulated state, discarding all bindings. */
  reset(): void {
    this.globals.clear();
    this.known.length = 0;
    this.buffer = "";
  }

  private handleDotCommand(line: string): boolean {
    const [command] = line.split(/\s+/);
    switch (command) {
      case ".exit":
      case ".quit":
        return false;
      case ".reset":
        this.reset();
        this.write("state cleared\n");
        return true;
      case ".help":
        this.write(HELP);
        return true;
      default:
        this.write(`unknown command '${line}'\ntype .help for a list\n`);
        return true;
    }
  }

  private reportDiagnostics(text: string, diagnostics: readonly Diagnostic[]): void {
    if (diagnostics.length === 0) return;
    const source = new SourceFile("<repl>", text);
    this.write(`${renderDiagnostic(source, diagnostics[0]!)}\n`);
    if (diagnostics.length > 1) {
      this.write(`(and ${diagnostics.length - 1} more error${diagnostics.length === 2 ? "" : "s"})\n`);
    }
  }

  private write(text: string): void {
    const output = this.options.output ?? process.stdout;
    output.write(text);
  }

  private banner(): void {
    this.write(
      [
        "Vela — a small statically-typed language",
        "Type .help for commands, .exit to quit.",
        "",
      ].join("\n"),
    );
  }
}

const HELP = `
Commands
  .help    show this message
  .reset   clear all bindings and start over
  .exit    quit

Everything else is Vela source. Statements ending in ';' run immediately;
an expression's value is echoed. Declarations persist between lines.
`;

/** Entry point used by the CLI. */
export async function startRepl(options?: ReplOptions): Promise<void> {
  await new Repl(options).start();
}
