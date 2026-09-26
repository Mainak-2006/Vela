/**
 * Diagnostics — positions, errors, and human-readable rendering.
 *
 * Every token and every AST node in Vela carries a `SourceLocation` so that any
 * error discovered in any stage of the pipeline can be pointed back at the exact
 * characters in the original file. This module is the single place that knows
 * how to turn a location plus a message into something a human wants to read.
 */

/** A half-open span of source text, with a 1-based line and column. */
export interface SourceLocation {
  /** 0-based character offset into the source text. */
  readonly offset: number;
  /** Length of the span in characters. */
  readonly length: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number, counted in characters. */
  readonly column: number;
}

export function loc(
  offset: number,
  length: number,
  line: number,
  column: number,
): SourceLocation {
  return { offset, length, line, column };
}

/** A location spanning from the start of `start` to the end of `end`. */
export function span(start: SourceLocation, end: SourceLocation): SourceLocation {
  return {
    offset: start.offset,
    length: Math.max(0, end.offset + end.length - start.offset),
    line: start.line,
    column: start.column,
  };
}

/** The location covering the whole program. */
export function wholeFile(source: SourceFile): SourceLocation {
  return { offset: 0, length: source.text.length, line: 1, column: 1 };
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly severity: Severity;
  readonly message: string;
  readonly location: SourceLocation;
  /** Optional extra lines printed under the caret line. */
  readonly notes: readonly string[];
  /** When true, only the first line of the message is reported. Used to collapse
   *  the follow-on "expected X, found EOF" chain that error recovery produces. */
  readonly brief: boolean;
}

export function error(message: string, location: SourceLocation, notes: string[] = []): Diagnostic {
  return { severity: "error", message, location, notes, brief: false };
}

export function warning(message: string, location: SourceLocation, notes: string[] = []): Diagnostic {
  return { severity: "warning", message, location, notes, brief: false };
}

/** A concise error, used by the parser's "I wanted one of these" failures. */
export function briefError(
  message: string,
  location: SourceLocation,
  notes: string[] = [],
): Diagnostic {
  return { severity: "error", message, location, notes, brief: true };
}

/**
 * Thrown to unwind out of a stage that cannot continue. Catch it at the stage
 * boundary, flush the bag it was carrying, and move on.
 */
export class CompileAbort extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "CompileAbort";
    this.diagnostic = diagnostic;
  }
}

/** Accumulates diagnostics so a single pass can report many errors. */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  report(diagnostic: Diagnostic): void {
    this.items.push(diagnostic);
  }

  add(message: string, location: SourceLocation, notes: string[] = []): void {
    this.report(error(message, location, notes));
  }

  /** Report a diagnostic and immediately unwind. */
  addFatal(message: string, location: SourceLocation, notes: string[] = []): never {
    const diagnostic = error(message, location, notes);
    this.report(diagnostic);
    throw new CompileAbort(diagnostic);
  }

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }

  at(i: number): Diagnostic | undefined {
    return this.items[i];
  }

  all(): readonly Diagnostic[] {
    return this.items;
  }

  errors(): readonly Diagnostic[] {
    return this.items.filter((d) => d.severity === "error");
  }

  drain(): Diagnostic[] {
    return this.items.splice(0, this.items.length);
  }

  /** Merge another bag's contents into this one, then clear the other. */
  absorb(other: DiagnosticBag): void {
    for (const d of other.drain()) this.report(d);
  }
}

/** A source file plus the line index needed to resolve offsets to line/column. */
export class SourceFile {
  readonly path: string;
  readonly text: string;
  /** Offset of the first character of each line. */
  private readonly lineStarts: readonly number[];

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
    this.lineStarts = computeLineStarts(text);
  }

  /** 0-based line index containing `offset`. */
  lineIndexAt(offset: number): number {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  locationAt(offset: number, length = 1): SourceLocation {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    const index = this.lineIndexAt(clamped);
    return {
      offset: clamped,
      length,
      line: index + 1,
      column: clamped - this.lineStarts[index]! + 1,
    };
  }

  /** The text of a 0-based line, without its trailing newline. */
  lineText(index: number): string {
    const start = this.lineStarts[index];
    if (start === undefined) return "";
    const end =
      index + 1 < this.lineStarts.length
        ? this.lineStarts[index + 1]!
        : this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, "");
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 0-based line index of a 1-based line number, clamped to the file. */
  clampLine(line: number): number {
    return Math.max(0, Math.min(line - 1, this.lineCount - 1));
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

const CARET = "^";

/**
 * Render one diagnostic with the offending source line and a caret underline.
 *
 *     error: cannot apply operator '+' to a 'number' and a 'string'
 *         |
 *       4 | let x: number = 1 + "a";
 *         |              ^^^^^
 *         |
 */
export function renderDiagnostic(source: SourceFile, diagnostic: Diagnostic): string {
  const { location, severity } = diagnostic;
  const lineIndex = source.clampLine(location.line);
  const lineText = source.lineText(lineIndex);
  const gutterWidth = String(location.line).length;

  // Column is 1-based; the caret run length is clamped to the end of the line so
  // a span that runs past a newline does not draw underscores forever.
  const caretStart = Math.max(0, location.column - 1);
  const lineLength = lineText.length;
  const caretEnd = Math.min(
    lineLength,
    Math.max(caretStart + Math.max(1, location.length), caretStart + 1),
  );

  const pad = " ".repeat(gutterWidth);
  const lines: string[] = [];
  lines.push(`${severity}: ${firstLine(diagnostic.message)}`);
  lines.push(`${pad} |`);
  lines.push(`${padLine(gutterWidth, location.line)} | ${lineText}`);
  lines.push(`${pad} | ${" ".repeat(caretStart)}${CARET.repeat(caretEnd - caretStart)}`);
  for (const note of diagnostic.notes) {
    lines.push(`${pad} | note: ${note}`);
  }
  lines.push(`${pad} |`);
  return lines.join("\n");
}

function firstLine(message: string): string {
  const i = message.indexOf("\n");
  return i === -1 ? message : message.slice(0, i);
}

function padLine(gutterWidth: number, line: number): string {
  return line.toString().padStart(gutterWidth, " ");
}

/** Render a whole bag, prefixed by the file path. Returns "" when there is nothing to say. */
export function renderDiagnostics(
  source: SourceFile,
  diagnostics: readonly Diagnostic[],
): string {
  if (diagnostics.length === 0) return "";
  const blocks = diagnostics.map((d) => renderDiagnostic(source, d));
  return `${source.path}\n${blocks.join("\n\n")}`;
}
