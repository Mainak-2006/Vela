/**
 * Tokens — the lexer's output vocabulary.
 *
 * Token kinds are plain lowercase strings rather than a numeric enum so that
 * dumping a token stream is readable (`vela tokens`) and so that kind names in
 * parser error messages read the same way as in this file.
 */

import type { SourceLocation } from "../diagnostics.js";

export const TOKEN = {
  // Literals. `NUMBER`/`STRING` are suffixed so they stay distinct from the
  // `TYPE_NUMBER`/`TYPE_STRING` type keywords below, which share their lexemes.
  // A token's `kind` has to tell a literal apart from a type name, or the
  // parser accepts one where the other belongs.
  IDENT: "ident",
  NUMBER: "number-literal",
  STRING: "string-literal",

  // Keywords
  LET: "let",
  FN: "fn",
  RETURN: "return",
  IF: "if",
  ELSE: "else",
  WHILE: "while",
  FOR: "for",
  BREAK: "break",
  CONTINUE: "continue",
  PRINT: "print",

  // Type keywords
  TYPE_NUMBER: "number",
  TYPE_STRING: "string",
  TYPE_BOOL: "bool",
  TYPE_VOID: "void",
  /** The bare function type, usable where a signature would be too much. */
  TYPE_FUNCTION: "function",

  // Boolean literals
  TRUE: "true",
  FALSE: "false",

  // Operators
  PLUS: "+",
  MINUS: "-",
  STAR: "*",
  SLASH: "/",
  PERCENT: "%",
  BANG: "!",
  EQUAL: "=",
  EQUAL_EQUAL: "==",
  BANG_EQUAL: "!=",
  LESS: "<",
  LESS_EQUAL: "<=",
  GREATER: ">",
  GREATER_EQUAL: ">=",
  AND_AND: "&&",
  OR_OR: "||",

  // Compound assignment. These are sugar: each one means `x = x <op> y`, and
  // the parser desugars them rather than the checker or interpreter knowing
  // anything about them.
  PLUS_EQUAL: "+=",
  MINUS_EQUAL: "-=",
  STAR_EQUAL: "*=",
  SLASH_EQUAL: "/=",
  PERCENT_EQUAL: "%=",

  // Standalone increment and decrement. These are statements, not expressions:
  // there is no post-increment value, so `let y: number = i++;` is a parse error.
  PLUS_PLUS: "++",
  MINUS_MINUS: "--",

  // Punctuation
  LEFT_PAREN: "(",
  RIGHT_PAREN: ")",
  LEFT_BRACE: "{",
  RIGHT_BRACE: "}",
  COMMA: ",",
  SEMICOLON: ";",
  COLON: ":",
  LEFT_BRACKET: "[",
  RIGHT_BRACKET: "]",

  // Sentinel
  EOF: "eof",
} as const;

export type TokenKind = (typeof TOKEN)[keyof typeof TOKEN];

const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ["let", TOKEN.LET],
  ["fn", TOKEN.FN],
  ["return", TOKEN.RETURN],
  ["if", TOKEN.IF],
  ["else", TOKEN.ELSE],
  ["while", TOKEN.WHILE],
  ["for", TOKEN.FOR],
  ["break", TOKEN.BREAK],
  ["continue", TOKEN.CONTINUE],
  ["print", TOKEN.PRINT],
  ["number", TOKEN.TYPE_NUMBER],
  ["string", TOKEN.TYPE_STRING],
  ["bool", TOKEN.TYPE_BOOL],
  ["void", TOKEN.TYPE_VOID],
  ["function", TOKEN.TYPE_FUNCTION],
  ["true", TOKEN.TRUE],
  ["false", TOKEN.FALSE],
]);

/** Look up a keyword by its spelling. Returns undefined for ordinary identifiers. */
export function keywordKind(text: string): TokenKind | undefined {
  return KEYWORDS.get(text);
}

export const KEYWORD_SPELLINGS: readonly string[] = [...KEYWORDS.keys()];

/** A single lexical token. `lexeme` is the exact source text it was cut from. */
export interface Token {
  readonly kind: TokenKind;
  readonly lexeme: string;
  readonly location: SourceLocation;
  /** Set for NUMBER tokens. */
  readonly numericValue?: number;
  /** Set for STRING tokens: the contents with escapes already resolved. */
  readonly stringValue?: string;
}

export function isTokenKind(kind: TokenKind): (token: Token) => boolean {
  return (token) => token.kind === kind;
}

/** Human-facing name for a kind, used inside parser error messages. */
export function describeKind(kind: TokenKind): string {
  switch (kind) {
    case TOKEN.EOF:
      return "end of input";
    case TOKEN.IDENT:
      return "an identifier";
    case TOKEN.NUMBER:
      return "a number";
    case TOKEN.STRING:
      return "a string";
    case TOKEN.SEMICOLON:
      return "';'";
    case TOKEN.LEFT_PAREN:
      return "'('";
    case TOKEN.RIGHT_PAREN:
      return "')'";
    case TOKEN.LEFT_BRACE:
      return "'{'";
    case TOKEN.RIGHT_BRACE:
      return "'}'";
    case TOKEN.LEFT_BRACKET:
      return "'['";
    case TOKEN.RIGHT_BRACKET:
      return "']'";
    case TOKEN.COMMA:
      return "','";
    case TOKEN.COLON:
      return "':'";
    case TOKEN.EQUAL:
      return "'='";
    case TOKEN.PLUS_EQUAL:
      return "'+='";
    case TOKEN.MINUS_EQUAL:
      return "'-='";
    case TOKEN.STAR_EQUAL:
      return "'*='";
    case TOKEN.SLASH_EQUAL:
      return "'/='";
    case TOKEN.PERCENT_EQUAL:
      return "'%='";
    case TOKEN.PLUS_PLUS:
      return "'++'";
    case TOKEN.MINUS_MINUS:
      return "'--'";
    default:
      return `'${kind}'`;
  }
}
