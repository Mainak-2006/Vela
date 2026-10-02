/**
 * The Lexer — source text to a token stream.
 *
 * A hand-written scanner rather than a pile of regular expressions, so that every
 * character consumed is accounted for and every token knows exactly where it came
 * from. Two rules govern the design:
 *
 *   1. Maximal munch. `>=` is one token, never `>` then `=`. Achieved by peeking
 *      a second character before committing to a single-character operator.
 *   2. Never lose the stream. A malformed character or literal is reported as a
 *      diagnostic and scanning resumes, so a single pass can surface several
 *      errors. Only genuinely unrecoverable states stop the scan.
 */

import {
  DiagnosticBag,
  type SourceFile,
  type SourceLocation,
} from "../diagnostics.js";
import { TOKEN, keywordKind, type Token, type TokenKind } from "./token.js";

/** Tokenize `source`, appending any problems to `bag`. Always ends with an EOF token. */
export function tokenize(source: SourceFile, bag: DiagnosticBag): Token[] {
  return new Lexer(source, bag).scan();
}

class Lexer {
  private readonly text: string;
  private readonly tokens: Token[] = [];
  private start = 0;
  private current = 0;
  private line = 1;
  private column = 1;

  constructor(source: SourceFile, private readonly bag: DiagnosticBag) {
    this.text = source.text;
  }

  scan(): Token[] {
    while (!this.isAtEnd()) {
      this.skipTrivia();
      if (this.isAtEnd()) break;
      this.start = this.current;
      this.scanToken();
    }
    // The EOF token sits at the true end of input. Deriving it from `here` would
    // use `start`, which still points at the last real token once trailing
    // trivia has been skipped, yielding a column that is negative or otherwise
    // meaningless. Every "unexpected end of input" diagnostic points here, so it
    // has to be the position the reader is actually at.
    this.tokens.push({
      kind: TOKEN.EOF,
      lexeme: "",
      location: {
        offset: this.current,
        length: 0,
        line: this.line,
        column: this.column,
      },
    });
    return this.tokens;
  }

  // ---------------------------------------------------------------- characters

  private isAtEnd(): boolean {
    return this.current >= this.text.length;
  }

  private peek(ahead = 0): string {
    return this.text.charAt(this.current + ahead);
  }

  private advance(): string {
    const ch = this.text.charAt(this.current);
    this.current++;
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private match(expected: string): boolean {
    if (this.peek() !== expected) return false;
    this.advance();
    return true;
  }

  // ------------------------------------------------------------------ emission

  /** A location of `length` characters ending at the current scan position. */
  private here(length: number): SourceLocation {
    return {
      offset: this.start,
      length,
      line: this.line,
      column: this.column - (this.current - this.start),
    };
  }

  private token(kind: TokenKind, lexeme: string): Token {
    return { kind, lexeme, location: this.here(lexeme.length) };
  }

  private emit(kind: TokenKind): void {
    this.tokens.push(this.token(kind, this.text.slice(this.start, this.current)));
  }

  private fail(message: string): void {
    this.bag.add(message, this.here(this.current - this.start));
  }

  // -------------------------------------------------------------------- trivia

  private skipTrivia(): void {
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        this.skipLineComment();
      } else if (ch === "/" && this.peek(1) === "*") {
        this.skipBlockComment();
      } else {
        return;
      }
    }
  }

  private skipLineComment(): void {
    while (!this.isAtEnd() && this.peek() !== "\n") this.advance();
  }

  private skipBlockComment(): void {
    const commentStart = this.current;
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // '/'
    this.advance(); // '*'
    while (true) {
      if (this.isAtEnd()) {
        this.bag.add("unterminated block comment: expected a matching '*/'", {
          offset: commentStart,
          length: this.current - commentStart,
          line: startLine,
          column: startColumn,
        });
        return;
      }
      if (this.peek() === "*" && this.peek(1) === "/") {
        this.advance();
        this.advance();
        return;
      }
      this.advance();
    }
  }

  // ------------------------------------------------------------------ scanning

  private scanToken(): void {
    const ch = this.advance();
    switch (ch) {
      case "(":
        return this.emit(TOKEN.LEFT_PAREN);
      case ")":
        return this.emit(TOKEN.RIGHT_PAREN);
      case "{":
        return this.emit(TOKEN.LEFT_BRACE);
      case "}":
        return this.emit(TOKEN.RIGHT_BRACE);
      case "[":
        return this.emit(TOKEN.LEFT_BRACKET);
      case "]":
        return this.emit(TOKEN.RIGHT_BRACKET);
      case ".":
        return this.emit(TOKEN.DOT);
      case ",":
        return this.emit(TOKEN.COMMA);
      case ";":
        return this.emit(TOKEN.SEMICOLON);
      case ":":
        return this.emit(TOKEN.COLON);
      case "+":
        // Order matters: the two-character forms are tried first, so `+=` and
        // `++` are never scanned as a `+` followed by something else.
        if (this.match("=")) return this.emit(TOKEN.PLUS_EQUAL);
        if (this.match("+")) return this.emit(TOKEN.PLUS_PLUS);
        return this.emit(TOKEN.PLUS);
      case "-":
        if (this.match("=")) return this.emit(TOKEN.MINUS_EQUAL);
        if (this.match("-")) return this.emit(TOKEN.MINUS_MINUS);
        if (this.match(">")) return this.emit(TOKEN.ARROW);
        return this.emit(TOKEN.MINUS);
      case "*":
        if (this.match("=")) return this.emit(TOKEN.STAR_EQUAL);
        return this.emit(TOKEN.STAR);
      case "/":
        if (this.match("=")) return this.emit(TOKEN.SLASH_EQUAL);
        return this.emit(TOKEN.SLASH);
      case "%":
        if (this.match("=")) return this.emit(TOKEN.PERCENT_EQUAL);
        return this.emit(TOKEN.PERCENT);
      case "?":
        return this.emit(TOKEN.QUESTION);
      case "?":
        return this.emit(TOKEN.QUESTION);

      // Peek for the second character before falling back to a one-character operator.
      case "=":
        return this.emit(this.match("=") ? TOKEN.EQUAL_EQUAL : TOKEN.EQUAL);
      case "!":
        return this.emit(this.match("=") ? TOKEN.BANG_EQUAL : TOKEN.BANG);
      case "<":
        return this.emit(this.match("=") ? TOKEN.LESS_EQUAL : TOKEN.LESS);
      case ">":
        return this.emit(this.match("=") ? TOKEN.GREATER_EQUAL : TOKEN.GREATER);
      case "&":
        if (this.match("&")) return this.emit(TOKEN.AND_AND);
        return this.fail("unexpected character '&' (did you mean '&&'?)");
      case "|":
        if (this.match("|")) return this.emit(TOKEN.OR_OR);
        return this.fail("unexpected character '|' (did you mean '||'?)");

      case '"':
        return this.scanString();

      default:
        if (isDigit(ch)) return this.scanNumber();
        if (isIdentifierStart(ch)) return this.scanIdentifier();
        return this.fail(`unexpected character '${describeChar(ch)}'`);
    }
  }

  private scanIdentifier(): void {
    while (isIdentifierPart(this.peek())) this.advance();
    const lexeme = this.text.slice(this.start, this.current);
    const kind = keywordKind(lexeme) ?? TOKEN.IDENT;
    this.tokens.push(this.token(kind, lexeme));
  }

  /**
   * Numbers: `123`, `1_000_000`, `3.14`, `1.5e-3`. Underscores are permitted only
   * between digits, so a trailing `1_` is a diagnostic rather than a silent 1.
   *
   * A malformed literal is still emitted as a token. Dropping it would silently
   * shorten the stream, so `1e+` would look like empty input and `1.foo` would
   * lose its `1.`, leaving the parser to complain about whatever came next
   * instead of about the number the author actually wrote.
   */
  private scanNumber(): void {
    // A radix prefix is the one case where a number silently means something
    // else: `0x10` would otherwise scan as the number 0 followed by the
    // identifier x10, and the program would compile into the wrong thing with no
    // complaint at all. Diagnose it instead.
    //
    // `scanToken` has already consumed the leading character, so the `0` sits at
    // `start` and the prefix letter is the character after the current position.
    const prefix = this.peek();
    if (prefix === "x" || prefix === "X") {
      this.advance();
      this.fail("hexadecimal literals are not supported (write the number in decimal)");
      return;
    }
    if (prefix === "b" || prefix === "B") {
      this.advance();
      this.fail("binary literals are not supported (write the number in decimal)");
      return;
    }
    this.scanDigits();
    if (this.peek() === ".") {
      if (!isDigit(this.peek(1))) {
        this.advance();
        this.emitMalformedNumber("expected a digit after the decimal point");
        return;
      }
      this.advance();
      this.scanDigits();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      const exponentStart = this.current;
      this.advance();
      if (this.peek() === "+" || this.peek() === "-") this.advance();
      if (!isDigit(this.peek())) {
        this.bag.add("expected a digit in the exponent", {
          offset: exponentStart,
          length: this.current - exponentStart,
          line: this.line,
          column: this.column - (this.current - exponentStart),
        });
        this.emitMalformedNumber();
        return;
      }
      this.scanDigits();
    }
    const lexeme = this.text.slice(this.start, this.current);
    if (this.text.charAt(this.current - 1) === "_") {
      this.fail("expected a digit after '_'");
    }
    const value = Number(lexeme.replace(/_/g, ""));
    if (Number.isNaN(value)) {
      this.fail(`'${lexeme}' is not a valid number`);
      this.tokens.push(this.token(TOKEN.NUMBER, lexeme));
      return;
    }
    this.tokens.push({
      kind: TOKEN.NUMBER,
      lexeme,
      location: this.here(lexeme.length),
      numericValue: value,
    });
  }

  /**
   * Emit a number token for text that could not be scanned into a value, pairing
   * it with `message` when one is given. The value is whatever the digits scanned
   * so far are worth, so the token carries a number rather than nothing.
   */
  private emitMalformedNumber(message?: string): void {
    if (message) this.fail(message);
    const lexeme = this.text.slice(this.start, this.current);
    this.tokens.push({
      kind: TOKEN.NUMBER,
      lexeme,
      location: this.here(lexeme.length),
      numericValue: 0,
    });
  }

  /** Consume digits, allowing single underscores between them. */
  private scanDigits(): void {
    while (isDigit(this.peek()) || this.peek() === "_") this.advance();
  }

  private scanString(): void {
    let value = "";
    while (true) {
      if (this.isAtEnd()) {
        this.fail("unterminated string: expected a closing '\"'");
        this.tokens.push({
          kind: TOKEN.STRING,
          lexeme: this.text.slice(this.start, this.current),
          location: this.here(this.current - this.start),
          stringValue: value,
        });
        return;
      }
      const ch = this.peek();
      if (ch === '"') {
        this.advance();
        break;
      }
      if (ch === "\n") {
        this.fail("unterminated string: strings may not span lines");
        this.tokens.push({
          kind: TOKEN.STRING,
          lexeme: this.text.slice(this.start, this.current),
          location: this.here(this.current - this.start),
          stringValue: value,
        });
        return;
      }
      if (ch === "\\") {
        this.advance();
        value += this.scanEscape();
        continue;
      }
      this.advance();
      value += ch;
    }
    this.tokens.push({
      kind: TOKEN.STRING,
      lexeme: this.text.slice(this.start, this.current),
      location: this.here(this.current - this.start),
      stringValue: value,
    });
  }

  /** The backslash has been consumed; read and resolve the escape body. */
  private scanEscape(): string {
    if (this.isAtEnd()) {
      this.fail("unterminated escape sequence at end of input");
      return "";
    }
    const ch = this.advance();
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      default:
        this.bag.add(`unknown escape sequence '\\${ch}'`, {
          offset: this.current - 2,
          length: 2,
          line: this.line,
          column: this.column - 2,
        });
        return ch;
    }
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch);
}

/** Make control characters visible in error messages. */
function describeChar(ch: string): string {
  if (ch === "\t") return "\\t";
  if (ch === "\r") return "\\r";
  if (ch === "\0") return "\\0";
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return `\\u{${code}}`;
  return ch;
}

/** One-line human summary of a token, used by `vela tokens`. */
export function formatToken(token: Token): string {
  const at = `${token.location.line}:${token.location.column}`;
  if (token.kind === TOKEN.STRING) return `${at}  string   ${JSON.stringify(token.stringValue ?? "")}`;
  if (token.kind === TOKEN.NUMBER) return `${at}  number   ${token.numericValue ?? 0}`;
  return `${at}  ${pad(token.kind, 8)} ${token.lexeme}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
