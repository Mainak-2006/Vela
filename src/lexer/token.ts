/**
 * Tokens — the lexer's output vocabulary.
 *
 * Token kinds are plain lowercase strings rather than a numeric enum so that
 * dumping a token stream is readable (`vela tokens`) and so that kind names in
 * parser error messages read the same way as in this file.
 */

import type { SourceLocation } from "../diagnostics.js";

export const TOKEN = {
  // Literals
  IDENT: "ident",
  NUMBER: "number",
  STRING: "string",

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

  // Punctuation
  LEFT_PAREN: "(",
  RIGHT_PAREN: ")",
  LEFT_BRACE: "{",
  RIGHT_BRACE: "}",
  COMMA: ",",
  SEMICOLON: ";",
  COLON: ":",

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
    case TOKEN.COMMA:
      return "','";
    case TOKEN.COLON:
      return "':'";
    case TOKEN.EQUAL:
      return "'='";
    default:
      return `'${kind}'`;
  }
}
