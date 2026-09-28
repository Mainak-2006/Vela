import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DiagnosticBag, SourceFile } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { TOKEN, type Token, type TokenKind } from "../src/lexer/token.js";

function lex(text: string): { tokens: Token[]; bag: DiagnosticBag } {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  const tokens = tokenize(source, bag);
  return { tokens, bag };
}

/** Kind sequence with the trailing EOF removed, for terse assertions. */
function kinds(text: string): TokenKind[] {
  return lex(text).tokens.map((t) => t.kind).filter((k) => k !== TOKEN.EOF);
}

function lexemes(text: string): string[] {
  return lex(text).tokens.map((t) => t.lexeme).filter((l) => l.length > 0);
}

function errors(text: string): string[] {
  return lex(text).bag.errors().map((d) => d.message);
}

describe("lexer: literals", () => {
  it("lexes integers, floats, and exponents", () => {
    assert.deepEqual(lex("1 2.5 1e3 1.5e-3").tokens.slice(0, 4).map((t) => t.numericValue), [
      1, 2.5, 1000, 0.0015,
    ]);
  });

  it("treats underscores as digit separators", () => {
    const [token] = lex("1_000_000").tokens;
    assert.equal(token?.numericValue, 1000000);
    assert.deepEqual(errors("1_000_000"), []);
  });

  it("does not treat a leading underscore as a number", () => {
    assert.deepEqual(kinds("_foo"), [TOKEN.IDENT]);
  });

  it("rejects an underscore trailing a number", () => {
    assert.match(errors("1_")[0] ?? "", /expected a digit after '_'/);
  });

  it("requires a digit after a decimal point", () => {
    assert.match(errors("1.")[0] ?? "", /expected a digit after the decimal point/);
  });

  it("requires a digit in the exponent", () => {
    assert.match(errors("1e")[0] ?? "", /expected a digit in the exponent/);
  });

  it("keeps the token for a malformed number instead of dropping it", () => {
    // These used to return without emitting a number, so `1e+` scanned to
    // nothing at all and `1.foo` lost its `1.`, leaving the parser to blame
    // whatever came next.
    assert.deepEqual(kinds("1e+"), [TOKEN.NUMBER]);
    assert.deepEqual(kinds("1."), [TOKEN.NUMBER]);
    assert.deepEqual(kinds("1.foo"), [TOKEN.NUMBER, TOKEN.IDENT]);
  });

  it("diagnoses a radix prefix rather than splitting the token", () => {
    // `0x10` used to lex as the number 0 followed by the identifier x10, which
    // compiled into the wrong program with no complaint anywhere.
    assert.match(errors("0x10")[0] ?? "", /hexadecimal literals are not supported/);
    assert.match(errors("0b101")[0] ?? "", /binary literals are not supported/);
    assert.deepEqual(kinds("0x10"), [TOKEN.NUMBER]);
  });

  it("still lexes plain decimal numbers after the radix check", () => {
    assert.deepEqual(kinds("0 42 0.5 007"), [TOKEN.NUMBER, TOKEN.NUMBER, TOKEN.NUMBER, TOKEN.NUMBER]);
    assert.deepEqual(errors("0 42 0.5 007"), []);
  });

  it("lexes booleans as keywords", () => {
    assert.deepEqual(kinds("true false"), [TOKEN.TRUE, TOKEN.FALSE]);
  });
});

describe("lexer: strings", () => {
  it("resolves escape sequences into stringValue", () => {
    const [token] = lex('"a\\nb\\tc"').tokens;
    assert.equal(token?.stringValue, "a\nb\tc");
  });

  it("keeps the raw lexeme separate from the resolved value", () => {
    const [token] = lex('"a\\nb"').tokens;
    assert.equal(token?.lexeme, '"a\\nb"');
    assert.equal(token?.stringValue, "a\nb");
  });

  it("allows an escaped quote inside a string", () => {
    const [token] = lex('"say \\"hi\\""').tokens;
    assert.equal(token?.stringValue, 'say "hi"');
  });

  it("allows an empty string", () => {
    const [token] = lex('""').tokens;
    assert.equal(token?.stringValue, "");
  });

  it("reports an unterminated string at end of input", () => {
    assert.match(errors('"abc')[0] ?? "", /unterminated string/);
  });

  it("reports a string that runs off the end of its line", () => {
    assert.match(errors('"abc\ndef"')[0] ?? "", /may not span lines/);
  });

  it("reports an unknown escape but keeps scanning", () => {
    assert.match(errors('"a\\qb"')[0] ?? "", /unknown escape sequence/);
    assert.deepEqual(kinds('"a\\qb" 5'), [TOKEN.STRING, TOKEN.NUMBER]);
  });
});

describe("lexer: operators and maximal munch", () => {
  it("prefers the two-character operator", () => {
    assert.deepEqual(kinds("== != <= >= && ||"), [
      TOKEN.EQUAL_EQUAL,
      TOKEN.BANG_EQUAL,
      TOKEN.LESS_EQUAL,
      TOKEN.GREATER_EQUAL,
      TOKEN.AND_AND,
      TOKEN.OR_OR,
    ]);
  });

  it("does not split `>>` into two greater-than tokens", () => {
    assert.deepEqual(kinds("a >> b"), [TOKEN.IDENT, TOKEN.GREATER, TOKEN.GREATER, TOKEN.IDENT]);
  });

  it("does not split `=>`", () => {
    assert.deepEqual(kinds("=>"), [TOKEN.EQUAL, TOKEN.GREATER]);
  });

  it("keeps `a>b` as three tokens", () => {
    assert.deepEqual(kinds("a>b"), [TOKEN.IDENT, TOKEN.GREATER, TOKEN.IDENT]);
  });

  it("suggests && for a lone ampersand and keeps scanning", () => {
    assert.match(errors("a & b")[0] ?? "", /did you mean '&&'/);
    assert.deepEqual(kinds("a & b"), [TOKEN.IDENT, TOKEN.IDENT]);
  });

  it("suggests || for a lone pipe and keeps scanning", () => {
    assert.match(errors("a | b")[0] ?? "", /did you mean '\|\|'/);
  });
});

describe("lexer: identifiers and keywords", () => {
  it("lexes identifiers with letters, digits, and underscores", () => {
    assert.deepEqual(lexemes("_a1 B2_c d"), ["_a1", "B2_c", "d"]);
  });

  it("keeps literal and type-keyword kinds distinct", () => {
    // The two pairs share a lexeme, so only the kind string separates them. If
    // they ever collide again the parser cannot tell a literal from a type name.
    assert.notEqual(TOKEN.NUMBER, TOKEN.TYPE_NUMBER);
    assert.notEqual(TOKEN.STRING, TOKEN.TYPE_STRING);
    assert.deepEqual(kinds("5 \"s\""), [TOKEN.NUMBER, TOKEN.STRING]);
    assert.deepEqual(kinds("number string"), [TOKEN.TYPE_NUMBER, TOKEN.TYPE_STRING]);
  });

  it("recognises every keyword", () => {
    const kindsOfKeywords = kinds("let fn return if else while for break continue print number string bool void true false");
    assert.deepEqual(kindsOfKeywords, [
      TOKEN.LET,
      TOKEN.FN,
      TOKEN.RETURN,
      TOKEN.IF,
      TOKEN.ELSE,
      TOKEN.WHILE,
      TOKEN.FOR,
      TOKEN.BREAK,
      TOKEN.CONTINUE,
      TOKEN.PRINT,
      TOKEN.TYPE_NUMBER,
      TOKEN.TYPE_STRING,
      TOKEN.TYPE_BOOL,
      TOKEN.TYPE_VOID,
      TOKEN.TRUE,
      TOKEN.FALSE,
    ]);
  });

  it("does not treat a keyword prefix as a keyword", () => {
    assert.deepEqual(kinds("letter ifs forx"), [TOKEN.IDENT, TOKEN.IDENT, TOKEN.IDENT]);
  });
});

describe("lexer: trivia", () => {
  it("skips line and block comments", () => {
    assert.deepEqual(kinds("1 // one\n2 /* two\nthree */ 3"), [TOKEN.NUMBER, TOKEN.NUMBER, TOKEN.NUMBER]);
  });

  it("treats a division as division, not a comment", () => {
    assert.deepEqual(kinds("a / b"), [TOKEN.IDENT, TOKEN.SLASH, TOKEN.IDENT]);
  });

  it("reports an unterminated block comment", () => {
    assert.match(errors("1 /* nope")[0] ?? "", /unterminated block comment/);
  });

  it("keeps tokens either side of a comment", () => {
    assert.deepEqual(lexemes("a /* x */ b"), ["a", "b"]);
  });
});

describe("lexer: positions", () => {
  it("records line and column per token", () => {
    const { tokens } = lex("let x\n  = 1");
    const [letTok, xTok, eqTok, oneTok] = tokens;
    assert.deepEqual(
      [letTok, xTok, eqTok, oneTok].map((t) => [t?.location.line, t?.location.column]),
      [[1, 1], [1, 5], [2, 3], [2, 5]],
    );
  });

  it("returns to column 1 after a newline inside a block comment", () => {
    const { tokens } = lex("/*\n\n*/ x");
    const xTok = tokens.find((t) => t.lexeme === "x");
    assert.deepEqual([xTok?.location.line, xTok?.location.column], [3, 4]);
  });

  it("points a diagnostic at the offending character", () => {
    // The '#' sits at column 17: `let y: number = ` is sixteen characters.
    const { bag } = lex("let x: number = 1;\nlet y: number = #;");
    const diag = bag.errors()[0];
    assert.equal(diag?.location.line, 2);
    assert.equal(diag?.location.column, 17);
  });

  it("places the EOF token at the real end of input", () => {
    // This used to be derived from the last real token, so trailing trivia left
    // it at a negative column, which is what every "unexpected end of input"
    // caret was drawn from.
    const eof = lex('print("x");\n').tokens.at(-1);
    assert.deepEqual(
      [eof?.location.line, eof?.location.column, eof?.location.length],
      [2, 1, 0],
    );
  });

  it("places EOF after trailing whitespace on the final line", () => {
    const eof = lex("let x: number = 1;   ").tokens.at(-1);
    // The source is twenty-one characters, so EOF sits at column 22.
    assert.deepEqual([eof?.location.line, eof?.location.column], [1, 22]);
  });
});

describe("lexer: error recovery", () => {
  it("reports several bad characters in one pass", () => {
    assert.equal(errors("& | @ #").length, 4);
  });

  it("always ends the stream with exactly one EOF token", () => {
    const { tokens } = lex("1 2 3");
    assert.equal(tokens[tokens.length - 1]?.kind, TOKEN.EOF);
    assert.equal(tokens.filter((t) => t.kind === TOKEN.EOF).length, 1);
  });

  it("still returns an EOF token for an empty file", () => {
    const { tokens, bag } = lex("");
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]?.kind, TOKEN.EOF);
    assert.equal(bag.length, 0);
  });
});
