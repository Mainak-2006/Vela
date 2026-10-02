import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { printProgram } from "../src/ast/astPrinter.js";
import type { Program } from "../src/ast/nodes.js";
import { DiagnosticBag, SourceFile } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";

function lexAndParse(text: string): { program: Program; bag: DiagnosticBag } {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  const tokens = tokenize(source, bag);
  const program = parse(tokens, bag);
  return { program, bag };
}

function parseOk(text: string): Program {
  const { program, bag } = lexAndParse(text);
  assert.deepEqual(
    bag.errors().map((d) => d.message),
    [],
    `expected a clean parse of: ${text}`,
  );
  return program;
}

/** The AST as a single-line s-expression, for terse structural assertions. */
function sexp(text: string): string {
  return printProgram(parseOk(text))
    .replace(/\s+/g, " ")
    .replace(/\s+\)/g, ")")
    .trim();
}

function errors(text: string): string[] {
  return lexAndParse(text).bag.errors().map((d) => d.message);
}

describe("parser: declarations", () => {
  it("parses a top-level let declaration", () => {
    assert.equal(sexp("let x: number = 1;"), "(program (letDecl x: number (numberLiteral 1)))");
  });

  it("parses a const declaration as its own kind", () => {
    assert.equal(sexp("const K: number = 1;"), "(program (constDecl K: number (numberLiteral 1)))");
  });

  it("parses a const in a for header", () => {
    // A loop whose counter is never updated can say so, which is the one place a
    // `const` in a for header earns its keep.
    assert.equal(
      sexp("for (const i: number = 0; i < 3; ) { print(i); }"),
      "(program (for (constDecl i: number (numberLiteral 0)) (binary < (variable i) (numberLiteral 3)) (empty) (block (print (variable i)))))",
    );
  });

  it("requires an initialiser on a const, like on a let", () => {
    assert.deepEqual(errors("const K: number;"), [
      "expected '=' followed by an initial value, found ';'",
    ]);
  });

  it("reports a const missing its type", () => {
    assert.deepEqual(errors("const K = 1;"), [
      "expected ':' followed by a type, found '='",
    ]);
  });

  it("parses each primitive type annotation", () => {
    const cases: readonly [string, string][] = [
      ["number", "(numberLiteral 1)"],
      ["string", '(stringLiteral "s")'],
      ["bool", "(booleanLiteral true)"],
    ];
    for (const [type, expected] of cases) {
      const init = type === "number" ? "1" : type === "string" ? '"s"' : "true";
      assert.equal(sexp(`let x: ${type} = ${init};`), `(program (letDecl x: ${type} ${expected}))`);
    }
  });

  it("parses a function declaration with parameters", () => {
    assert.equal(
      sexp("fn add(a: number, b: number): number { return a + b; }"),
      "(program (fnDecl add (a: number, b: number) -> number (block (return (binary + (variable a) (variable b))))))",
    );
  });

  it("parses a parameterless function", () => {
    assert.equal(
      sexp("fn nothing(): void { }"),
      "(program (fnDecl nothing () -> void (block)))",
    );
  });

  it("parses a return with no value", () => {
    assert.equal(sexp("fn f(): void { return; }"), "(program (fnDecl f () -> void (block (return))))");
  });
});

describe("parser: operator precedence", () => {
  it("binds multiplication tighter than addition", () => {
    assert.equal(
      sexp("1 + 2 * 3;"),
      "(program (expressionStmt (binary + (numberLiteral 1) (binary * (numberLiteral 2) (numberLiteral 3)))))",
    );
  });

  it("makes all binary operators left-associative", () => {
    // Parses as ((1 - 2) - 3), not (1 - (2 - 3)).
    assert.equal(
      sexp("1 - 2 - 3;"),
      "(program (expressionStmt (binary - (binary - (numberLiteral 1) (numberLiteral 2)) (numberLiteral 3))))",
    );
  });

  it("groups comparison tighter than equality", () => {
    assert.equal(
      sexp("1 < 2 == 3 < 4;"),
      "(program (expressionStmt (binary == (binary < (numberLiteral 1) (numberLiteral 2)) (binary < (numberLiteral 3) (numberLiteral 4)))))",
    );
  });

  it("binds && tighter than ||", () => {
    assert.equal(
      sexp("a || b && c;"),
      "(program (expressionStmt (logical or (variable a) (logical and (variable b) (variable c)))))",
    );
  });

  it("separates logical && from bitwise-looking arithmetic", () => {
    assert.equal(
      sexp("1 + 2 < 3 && 4 > 5;"),
      "(program (expressionStmt (logical and (binary < (binary + (numberLiteral 1) (numberLiteral 2)) (numberLiteral 3)) (binary > (numberLiteral 4) (numberLiteral 5)))))",
    );
  });

  it("binds unary tighter than binary", () => {
    assert.equal(
      sexp("-1 + 2;"),
      "(program (expressionStmt (binary + (unary - (numberLiteral 1)) (numberLiteral 2))))",
    );
  });

  it("stacks unary operators to the right", () => {
    assert.equal(
      sexp("--1;"),
      "(program (expressionStmt (unary - (unary - (numberLiteral 1)))))",
    );
  });

  it("lets a group override precedence", () => {
    assert.equal(
      sexp("(1 + 2) * 3;"),
      "(program (expressionStmt (binary * (binary + (numberLiteral 1) (numberLiteral 2)) (numberLiteral 3))))",
    );
  });

  it("nests a group without adding a node", () => {
    assert.equal(sexp("(((1)));"), "(program (expressionStmt (numberLiteral 1)))");
  });
});

describe("parser: assignment", () => {
  it("parses a simple assignment", () => {
    assert.equal(
      sexp("x = 1;"),
      "(program (expressionStmt (assign x (numberLiteral 1))))",
    );
  });

  it("is right-associative", () => {
    assert.equal(
      sexp("a = b = c;"),
      "(program (expressionStmt (assign a (assign b (variable c)))))",
    );
  });

  it("allows an assignment inside a larger expression", () => {
    assert.equal(
      sexp("y = 1 + 2;"),
      "(program (expressionStmt (assign y (binary + (numberLiteral 1) (numberLiteral 2)))))",
    );
  });

  it("rejects assigning to a non-identifier", () => {
    assert.match(errors("1 = 2;")[0] ?? "", /left-hand side of '=' must be a name/);
    assert.match(errors("(a) = 2;")[0] ?? "", /left-hand side of '=' must be a name/);
  });

  it("applies a call suffix before a unary operator", () => {
    assert.equal(
      sexp("-f(1);"),
      "(program (expressionStmt (unary - (call (variable f) (numberLiteral 1)))))",
    );
  });

  it("chains call suffixes", () => {
    assert.equal(
      sexp("f(1)(2);"),
      "(program (expressionStmt (call (call (variable f) (numberLiteral 1)) (numberLiteral 2))))",
    );
  });
});

describe("parser: compound assignment", () => {
  it("desugars each operator into a plain assignment", () => {
    // Nothing downstream knows these exist, which is why they are cheap: the
    // AST for `x += 1` is exactly the AST for `x = x + 1`.
    for (const [source, op] of [["x += 1;", "+"], ["x -= 1;", "-"], ["x *= 1;", "*"], ["x /= 1;", "/"], ["x %= 1;", "%"]] as const) {
      assert.equal(
        sexp(source),
        `(program (expressionStmt (assign x (binary ${op} (variable x) (numberLiteral 1)))))`,
        source,
      );
    }
  });

  it("parses ++ and -- as statements", () => {
    const expected = "(program (expressionStmt (assign i (binary + (variable i) (numberLiteral 1)))))";
    assert.equal(sexp("i++;"), expected);
    assert.equal(sexp("i--;"), "(program (expressionStmt (assign i (binary - (variable i) (numberLiteral 1)))))");
  });

  it("parses ++ in a for update", () => {
    assert.equal(
      sexp("for (let i: number = 0; i < 3; i++) { }"),
      "(program (for (letDecl i: number (numberLiteral 0)) (binary < (variable i) (numberLiteral 3)) (assign i (binary + (variable i) (numberLiteral 1))) (block)))",
    );
  });

  it("rejects ++ where a value is expected", () => {
    // In a declaration the value slot makes the intent clear: there is no value.
    assert.match(errors("let y: number = i++;")[0] ?? "", /is a statement and has no value/);
    // As a statement of its own, `i++` is complete, so the complaint is that the
    // expression keeps going and the semicolon never arrives.
    assert.match(errors("i++ + 1;")[0] ?? "", /expected ';' at the end of the statement/);
  });

  it("rejects a leading ++ with no variable", () => {
    assert.match(errors("++i;")[0] ?? "", /expected a variable name before the increment/);
  });

  it("keeps a leading -- as a doubled negation", () => {
    // `--1` is 1, not a decrement of something. Only a name in front makes `--`
    // a decrement, which is what keeps both readings available.
    assert.equal(sexp("--1;"), "(program (expressionStmt (unary - (unary - (numberLiteral 1)))))");
    assert.equal(sexp("i--;"), "(program (expressionStmt (assign i (binary - (variable i) (numberLiteral 1)))))");
  });
});

describe("parser: calls", () => {
  it("parses a call with no arguments", () => {
    assert.equal(sexp("f();"), "(program (expressionStmt (call (variable f))))");
  });

  it("parses a call with several arguments", () => {
    assert.equal(
      sexp("f(1, \"a\", true);"),
      '(program (expressionStmt (call (variable f) (numberLiteral 1) (stringLiteral "a") (booleanLiteral true))))',
    );
  });

  it("binds a call tighter than any operator", () => {
    assert.equal(
      sexp("f(1) + g(2);"),
      "(program (expressionStmt (binary + (call (variable f) (numberLiteral 1)) (call (variable g) (numberLiteral 2)))))",
    );
  });

  it("parses a call on a parenthesised expression", () => {
    assert.equal(
      sexp("(a + b)(1);"),
      "(program (expressionStmt (call (binary + (variable a) (variable b)) (numberLiteral 1))))",
    );
  });

  it("allows newlines inside an argument list", () => {
    assert.equal(
      sexp("f(\n  1,\n  2\n);"),
      "(program (expressionStmt (call (variable f) (numberLiteral 1) (numberLiteral 2))))",
    );
  });

  it("rejects a missing argument", () => {
    assert.match(errors("f(1,);")[0] ?? "", /expected an expression/);
  });
});

describe("parser: control flow", () => {
  it("parses if without else", () => {
    assert.equal(
      sexp("if (a) { print(1); }"),
      "(program (if (variable a) (block (print (numberLiteral 1)))))",
    );
  });

  it("parses if with else", () => {
    assert.equal(
      sexp("if (a) { } else { }"),
      "(program (if (variable a) (block) (block)))",
    );
  });

  it("keeps `else if` nested rather than chaining it", () => {
    assert.equal(
      sexp("if (a) { } else if (b) { } else { }"),
      "(program (if (variable a) (block) (if (variable b) (block) (block))))",
    );
  });

  it("attaches a dangling else to the nearest if", () => {
    assert.equal(
      sexp("if (a) if (b) { } else { }"),
      "(program (if (variable a) (if (variable b) (block) (block))))",
    );
  });

  it("parses a while loop", () => {
    assert.equal(
      sexp("while (a) { }"),
      "(program (while (variable a) (block)))",
    );
  });

  it("parses a full for loop", () => {
    assert.equal(
      sexp("for (let i: number = 0; i < 10; i = i + 1) { }"),
      "(program (for (letDecl i: number (numberLiteral 0)) (binary < (variable i) (numberLiteral 10)) (assign i (binary + (variable i) (numberLiteral 1))) (block)))",
    );
  });

  it("parses a for loop with omitted condition and update", () => {
    assert.equal(
      sexp("for (;;) { }"),
      "(program (for (empty) (empty) (empty) (block)))",
    );
  });

  it("parses a for loop with an expression initializer", () => {
    assert.equal(
      sexp("for (i = 0; i < 3; i = i + 1) { }"),
      "(program (for (assign i (numberLiteral 0)) (binary < (variable i) (numberLiteral 3)) (assign i (binary + (variable i) (numberLiteral 1))) (block)))",
    );
  });

  it("accepts a single statement as a loop body without braces", () => {
    assert.equal(
      sexp("while (a) print(1);"),
      "(program (while (variable a) (print (numberLiteral 1))))",
    );
  });

  it("parses break and continue", () => {
    assert.equal(
      sexp("while (a) { break; continue; }"),
      "(program (while (variable a) (block (break) (continue))))",
    );
  });
});

describe("parser: scoping and nesting", () => {
  it("nests a block inside a block", () => {
    assert.equal(
      sexp("{ { } }"),
      "(program (block (block)))",
    );
  });

  it("parses declarations in nested blocks", () => {
    assert.equal(
      sexp("{ let a: number = 1; { let b: number = 2; } }"),
      "(program (block (letDecl a: number (numberLiteral 1)) (block (letDecl b: number (numberLiteral 2)))))",
    );
  });

  it("parses a realistic function", () => {
    const { bag } = lexAndParse(`
      fn fib(n: number): number {
        if (n < 2) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
    `);
    assert.deepEqual(bag.errors(), []);
  });
});

describe("parser: function signature types", () => {
  it("parses a written signature as a type", () => {
    assert.equal(
      sexp("let f: fn(number) -> string = g;"),
      "(program (letDecl f: fn(number) -> string (variable g)))",
    );
  });

  it("parses a signature with no parameters", () => {
    assert.equal(sexp("let f: fn() -> void = g;"), "(program (letDecl f: fn() -> void (variable g)))");
  });

  it("parses several parameters", () => {
    assert.equal(
      sexp("let f: fn(number, string, bool) -> number = g;"),
      "(program (letDecl f: fn(number, string, bool) -> number (variable g)))",
    );
  });

  it("accepts parameter names and drops them from the type", () => {
    // A name is not part of a type: `fn(n: number) -> number` and
    // `fn(number) -> number` are the same type. Accepting both keeps a written
    // signature parallel to a `fn` declaration, which is what a reader expects.
    assert.equal(
      sexp("let f: fn(n: number, s: string) -> number = g;"),
      sexp("let f: fn(number, string) -> number = g;"),
    );
  });

  it("parses a signature nested inside another signature", () => {
    assert.equal(
      sexp("let f: fn(fn(number) -> number, bool) -> string = g;"),
      "(program (letDecl f: fn(fn(number) -> number, bool) -> string (variable g)))",
    );
  });

  it("accepts a signature as a parameter type and a return type", () => {
    assert.deepEqual(errors("fn apply(f: fn(number) -> number): fn(number) -> number { return f; }"), []);
  });

  it("accepts a signature in every annotation position", () => {
    assert.deepEqual(errors("const C: fn(number) -> number = g;"), []);
    assert.deepEqual(errors("let g: fn(number) -> number = h;"), []);
    assert.deepEqual(errors("fn f(p: fn() -> void): void { }"), []);
  });

  it("treats a bare `fn` with no parameter list as a syntax error", () => {
    // `fn` alone is the declaration keyword, not a type. Only a full signature
    // names one, so this cannot be quietly accepted as the bare `function`.
    assert.match(errors("let f: fn = g;")[0] ?? "", /expected '\('/);
  });

  it("reports a missing arrow once", () => {
    assert.deepEqual(errors("let f: fn(number) number = g;").length, 1);
    assert.match(errors("let f: fn(number) number = g;")[0] ?? "", /expected '->'/);
  });

  it("reports a missing return type once", () => {
    assert.match(errors("let f: fn(number) -> = g;")[0] ?? "", /expected a type name/);
    assert.deepEqual(errors("let f: fn(number) -> = g;").length, 1);
  });

  it("reports a trailing comma in the parameter list", () => {
    assert.deepEqual(errors("let f: fn(number,) -> number = g;").length, 1);
    assert.match(errors("let f: fn(number,) -> number = g;")[0] ?? "", /expected a type name/);
  });

  it("does not cascade after a broken signature", () => {
    // A signature is long, so a mistake inside it can leave the parser several
    // tokens out of position. Bailing out keeps one mistake to one message rather
    // than also complaining that the `=` it swallowed was missing.
    for (const bad of [
      "let f: fn(number = 5;",
      "let f: fn(number) = g;",
      "let f: fn -> number = g;",
      "let f: fn(number) ->;",
    ]) {
      assert.deepEqual(errors(bad).length, 1, `expected one error for: ${bad}`);
    }
  });

  it("never loops forever on a malformed signature", () => {
    for (const nasty of ["fn(", "fn()", "fn(", "fn ->", "fn(number) ->", "fn(,)"]) {
      lexAndParse(`let f: ${nasty} = g;`);
    }
  });
});

describe("parser: structs", () => {
  it("reads a declaration with its fields in order", () => {
    assert.equal(
      sexp("struct Point { x: number; y: number; }"),
      "(program (structDecl Point (field x: number) (field y: number)))",
    );
  });

  it("reads a declaration spread over several lines the same way", () => {
    // Every field ends with `;` like every other statement, so the braces are what
    // close the list and the line breaks are nothing at all.
    const oneLine = sexp("struct P { a: number; b: string; }");
    const manyLines = sexp("struct P {\n  a: number;\n  b: string;\n}");
    assert.equal(manyLines, oneLine);
  });

  it("accepts an empty field list", () => {
    assert.equal(sexp("struct Marker {}"), "(program (structDecl Marker))");
    assert.deepEqual(errors("struct Marker { }"), []);
  });

  it("reads a field of any written type", () => {
    assert.equal(
      sexp("struct S { xs: number[]; f: fn(number) -> string; p: Point; }"),
      "(program (structDecl S (field xs: number[]) (field f: fn(number) -> string) (field p: Point)))",
    );
  });

  it("rejects a field without a type", () => {
    assert.match(errors("struct P { x; }")[0] ?? "", /expected ':'/);
  });

  it("rejects a field without a semicolon", () => {
    assert.match(errors("struct P { x: number }")[0] ?? "", /expected ';'/);
  });

  it("rejects a duplicate field name", () => {
    assert.match(errors("struct P { x: number; x: string; }")[0] ?? "", /declared twice/);
  });

  it("names the field at the first duplicate", () => {
    // The second one, which is the one being read when the clash is noticed.
    const diag = lexAndParse("struct P { x: number; x: string; }").bag.errors()[0];
    assert.equal(diag?.location.column, 23);
  });

  it("requires a name after `struct`", () => {
    assert.match(errors("struct { x: number; }")[0] ?? "", /a struct name/);
  });

  it("reports a missing closing brace", () => {
    assert.match(errors("struct P { x: number;")[0] ?? "", /'\}' to close the field list/);
  });

  it("keeps the fields that parsed after one that did not", () => {
    // Recovery is not the interesting part on its own: what matters is that a typo
    // in the last field still leaves a declaration worth reporting.
    const { program, bag } = lexAndParse("struct P { a: number; b; c: string; }");
    assert.equal(bag.errors().length, 1);
    const [declaration] = program.declarations;
    assert.deepEqual(
      declaration?.kind === "structDecl" ? declaration.fields.map((f) => f.name) : [],
      ["a", "c"],
    );
  });

  it("reads a struct name as a type", () => {
    assert.equal(sexp("let p: Point = f();"), "(program (letDecl p: Point (call (variable f))))");
    assert.equal(sexp("let ps: Point[] = [];"), "(program (letDecl ps: Point[] (arrayLiteral)))");
    assert.equal(
      sexp("let g: fn(Point) -> Point = f;"),
      "(program (letDecl g: fn(Point) -> Point (variable f)))",
    );
  });

  it("reads a field access as a postfix on any expression", () => {
    assert.equal(
      sexp("print(p.x);"),
      "(program (print (fieldAccess (variable p) x)))",
    );
    assert.equal(
      sexp("print(xs[0].at.y);"),
      "(program (print (fieldAccess (fieldAccess (index (variable xs) (numberLiteral 0)) at) y)))",
    );
  });

  it("marks a field optional when a `?` follows its name", () => {
    // The `?` is read after the name and kept off the type, because "the constructor
    // may leave this out" is a fact about the declaration rather than about `T`.
    assert.equal(
      sexp("struct C { retries: number; label?: string; }"),
      "(program (structDecl C (field retries: number) (field label?: string)))",
    );
    const [declaration] = parseOk("struct C { retries: number; label?: string; }").declarations;
    assert.deepEqual(
      declaration?.kind === "structDecl"
        ? declaration.fields.map((field) => [field.name, field.optional])
        : [],
      [
        ["retries", false],
        ["label", true],
      ],
    );
  });

  it("reads `?` before the type and not after it", () => {
    // The two are different declarations: `next?: Node` may be left out, `next: Node?`
    // must be given a value and may hold null.
    assert.equal(
      sexp("struct N { next?: Node; }"),
      "(program (structDecl N (field next?: Node)))",
    );
    assert.equal(
      sexp("struct N { next: Node?; }"),
      "(program (structDecl N (field next: Node?)))",
    );
  });

  it("reads an optional field of any written type", () => {
    assert.equal(
      sexp("struct S { xs?: number[]; f?: fn(number) -> string; p?: Point; }"),
      "(program (structDecl S (field xs?: number[]) (field f?: fn(number) -> string) (field p?: Point)))",
    );
    // A nested one is a diagnostic rather than a tree, so it is never printed.
    assert.match(errors("struct S { p?: Point?; }")[0] ?? "", /already nullable/);
  });

  it("rejects a required field after an optional one", () => {
    assert.match(
      errors("struct D { label?: string; retries: number; }")[0] ?? "",
      /required field 'retries' cannot follow an optional one/,
    );
  });

  it("reports the wrong field order once, with the fix in a note", () => {
    // Two required fields after one optional is one mistake, so it is one message —
    // at the first field that breaks the order, not at every later one.
    const bag = lexAndParse("struct D { label?: string; retries: number; extra: number; }").bag;
    assert.deepEqual(bag.errors().map((d) => d.message), [
      "required field 'retries' cannot follow an optional one",
    ]);
    assert.deepEqual(
      bag.errors()[0]?.notes,
      [
        "a constructor takes one argument per field, in order, so leaving one out leaves out everything after it",
        "move the optional fields to the end of the list",
      ],
    );
  });

  it("rejects `?` on a field that is already nullable", () => {
    const diag = lexAndParse("struct E { x?: number?; }").bag.errors()[0];
    assert.match(diag?.message ?? "", /field 'x' is already nullable/);
    assert.deepEqual(
      diag?.notes,
      ["write either 'next?: Node' or 'next: Node?', not both", "the first may be left out of the constructor; the second must be given one"],
    );
  });

  it("rejects an optional field of type `void`", () => {
    assert.match(
      errors("struct F { y?: void; }")[0] ?? "",
      /cannot be optional and have type 'void'/,
    );
  });

  it("keeps the fields after one whose order was refused", () => {
    // The list still exists, so a program with the fields in the wrong order still
    // has a struct to check the uses of.
    const { program, bag } = lexAndParse("struct D { a?: number; b: string; }");
    assert.equal(bag.errors().length, 1);
    const [declaration] = program.declarations;
    assert.deepEqual(
      declaration?.kind === "structDecl" ? declaration.fields.map((f) => f.name) : [],
      ["a", "b"],
    );
  });

  it("reads a field assignment, with a name or any chain for the target", () => {
    assert.equal(
      sexp("p.x = 1;"),
      "(program (expressionStmt (fieldAssign (variable p) x (numberLiteral 1))))",
    );
    assert.equal(
      sexp("p.at.y = 1;"),
      "(program (expressionStmt (fieldAssign (fieldAccess (variable p) at) y (numberLiteral 1))))",
    );
  });

  it("desugars a compound field assignment into the same node", () => {
    // `p.x += 1` is `p.x = p.x + 1`, spelled out here, so nothing downstream has to
    // know that `+=` exists.
    assert.equal(
      sexp("p.x += 1;"),
      "(program (expressionStmt (fieldAssign (variable p) x (binary + (fieldAccess (variable p) x) (numberLiteral 1)))))",
    );
  });

  it("requires a name after a dot", () => {
    assert.match(errors("print(p.);")[0] ?? "", /a field name after/);
  });

  it("does not let a field access swallow a call", () => {
    // `p.f(1)` is a call on a field, not a field of a call, because postfix
    // suffixes bind left to right.
    assert.equal(
      sexp("p.f(1);"),
      "(program (expressionStmt (call (fieldAccess (variable p) f) (numberLiteral 1))))",
    );
  });
});

describe("parser: nullable types", () => {
  it("reads a '?' as making the type it follows nullable", () => {
    assert.equal(
      sexp("let x: number? = null;"),
      "(program (letDecl x: number? (nullLiteral)))",
    );
  });

  it("reads 'null' as a literal of its own", () => {
    assert.equal(
      sexp("let x: number? = null;"),
      "(program (letDecl x: number? (nullLiteral)))",
    );
    assert.equal(
      sexp("print(null == null);"),
      "(program (print (binary == (nullLiteral) (nullLiteral))))",
    );
  });

  it("lets '?' and '[]' be written in either order", () => {
    // Both spellings are the same type, and neither had to win: a suffix loop that
    // accepts both keeps the writer from having to remember which binds tighter.
    assert.equal(
      sexp("let a: number?[] = [1];"),
      "(program (letDecl a: number?[] (arrayLiteral (numberLiteral 1))))",
    );
    assert.equal(
      sexp("let b: number[]? = [1];"),
      "(program (letDecl b: number[]? (arrayLiteral (numberLiteral 1))))",
    );
    // Which also makes a third spelling legal rather than a special case: a nullable
    // array of nullable numbers is a type, and it is a *different* one from both.
    assert.deepEqual(errors("let c: number?[]? = [1];"), []);
  });

  it("nests a nullable inside an array of arrays", () => {
    assert.equal(
      sexp("let g: number[][]? = [[1]];"),
      "(program (letDecl g: number[][]? (arrayLiteral (arrayLiteral (numberLiteral 1)))))",
    );
  });

  it("rejects '?' after 'void', which has nothing to be absent", () => {
    assert.match(errors("let x: void? = null;")[0] ?? "", /a type cannot be a nullable 'void'/);
  });

  it("rejects a second '?', which would change nothing", () => {
    // `number??` is not a stranger spelling of `number?`; saying so keeps a type that
    // has been written twice from looking like a feature it is not. A '?' after an
    // *array* of nullable elements is a different type, and stays legal.
    assert.match(errors("let x: number?? = null;")[0] ?? "", /already nullable/);
    assert.match(errors("let x: number?[]?? = [];")[0] ?? "", /already nullable/);
  });

  it("rejects '?' on a type that cannot hold a value", () => {
    assert.match(errors("fn f(): void? { }")[0] ?? "", /a type cannot be a nullable 'void'/);
  });

  it("prints '?' after the type it makes nullable", () => {
    // The printed type follows source order, so `number?[]` reads back as an array of
    // nullable numbers rather than as a nullable array — the two are different types.
    assert.equal(
      printProgram(parseOk("let x: number?[] = [];")),
      "(program\n  (letDecl x: number?[]\n    (arrayLiteral\n    )\n  )\n)",
    );
    assert.match(printProgram(parseOk("let y: number? = null;")), /x: number\?|y: number\?/);
  });
});

describe("parser: arrays", () => {
  it("parses an array type annotation", () => {
    assert.equal(sexp("let xs: number[] = g;"), "(program (letDecl xs: number[] (variable g)))");
  });

  it("binds the brackets to the element, not to the annotation", () => {
    // `number[][]` needs no parentheses because `[]` attaches to what precedes it.
    assert.equal(sexp("let g: number[][] = h;"), "(program (letDecl g: number[][] (variable h)))");
  });

  it("accepts an array of every element type", () => {
    for (const element of ["number", "string", "bool", "function", "fn(number) -> bool", "number[]"]) {
      assert.deepEqual(errors(`let xs: ${element}[] = g;`), [], element);
    }
  });

  it("rejects an array of void elements", () => {
    assert.match(errors("let xs: void[] = g;")[0] ?? "", /an array cannot hold 'void' elements/);
    assert.match(errors("let xs: void[][] = g;")[0] ?? "", /an array cannot hold 'void' elements/);
  });

  it("reports an unclosed array type once", () => {
    assert.deepEqual(errors("let xs: number[ = g;").length, 1);
    assert.match(errors("let xs: number[ = g;")[0] ?? "", /expected '\]' to close an array type/);
  });

  it("parses an array literal", () => {
    assert.equal(
      sexp("let xs: number[] = [1, 2, 3];"),
      "(program (letDecl xs: number[] (arrayLiteral (numberLiteral 1) (numberLiteral 2) (numberLiteral 3))))",
    );
  });

  it("parses an empty literal and nested literals", () => {
    assert.equal(sexp("let xs: number[] = [];"), "(program (letDecl xs: number[] (arrayLiteral)))");
    assert.equal(
      sexp("let g: number[][] = [[1], [2, 3]];"),
      "(program (letDecl g: number[][] (arrayLiteral (arrayLiteral (numberLiteral 1)) (arrayLiteral (numberLiteral 2) (numberLiteral 3)))))",
    );
  });

  it("evaluates elements left to right", () => {
    // Each element is an ordinary expression, so a literal is a value like any
    // other and the order the calls happen in is observable.
    assert.equal(
      sexp("let xs: number[] = [f(), g()];"),
      "(program (letDecl xs: number[] (arrayLiteral (call (variable f)) (call (variable g)))))",
    );
  });

  it("rejects a trailing comma in a literal", () => {
    assert.match(errors("let xs: number[] = [1, 2,];").at(-1) ?? "", /trailing comma in an array literal/);
  });

  it("parses an index assignment as its own node", () => {
    assert.equal(
      sexp("xs[0] = 1;"),
      "(program (expressionStmt (indexAssign (variable xs) (numberLiteral 0) (numberLiteral 1))))",
    );
  });

  it("is right-associative in the assigned value", () => {
    assert.equal(
      sexp("xs[0] = ys[1] = 2;"),
      "(program (expressionStmt (indexAssign (variable xs) (numberLiteral 0) (indexAssign (variable ys) (numberLiteral 1) (numberLiteral 2)))))",
    );
  });

  it("desugars a compound index assignment into a plain one", () => {
    assert.equal(
      sexp("xs[i] += 1;"),
      sexp("xs[i] = xs[i] + 1;"),
    );
    assert.equal(
      sexp("xs[0] *= n;"),
      sexp("xs[0] = xs[0] * n;"),
    );
  });

  it("parses an index target whose index is itself an expression", () => {
    assert.equal(
      sexp("xs[i + 1] = xs[j];"),
      "(program (expressionStmt (indexAssign (variable xs) (binary + (variable i) (numberLiteral 1)) (index (variable xs) (variable j)))))",
    );
  });

  it("assigns through a chained index", () => {
    // `g[0][1] = 9` writes into the inner array, so the final index is the
    // assignment target and the earlier ones are just how it is reached.
    assert.equal(
      sexp("g[0][1] = 9;"),
      "(program (expressionStmt (indexAssign (index (variable g) (numberLiteral 0)) (numberLiteral 1) (numberLiteral 9))))",
    );
  });

  it("reads an index as an ordinary expression", () => {
    // The interesting part: recognising a possible assignment target must not
    // change how a plain read parses. `xs[0] + 1` still sees its `+ 1`, and
    // `xs[0][1]` still chains.
    assert.equal(
      sexp("print(xs[0] + 1);"),
      "(program (print (binary + (index (variable xs) (numberLiteral 0)) (numberLiteral 1))))",
    );
    assert.equal(
      sexp("print(xs[0][1]);"),
      "(program (print (index (index (variable xs) (numberLiteral 0)) (numberLiteral 1))))",
    );
  });

  it("rejects assigning through something that is not a name or index", () => {
    assert.match(errors("f()[0] = 1;")[0] ?? "", /left-hand side of '=' must be a name/);
    assert.match(errors("1 = 2;")[0] ?? "", /left-hand side of '=' must be a name/);
    assert.match(errors("p.f() = 2;")[0] ?? "", /left-hand side of '=' must be a name/);
  });

  it("assigns through any chain that starts with a name", () => {
    // The chain has to start with a name, because that is the only thing that
    // gives an assignment something to write back into.
    assert.equal(sexp("pts[0].x = 1;"), "(program (expressionStmt (fieldAssign (index (variable pts) (numberLiteral 0)) x (numberLiteral 1))))");
    assert.equal(
      sexp('p.tags[1] = "z";'),
      '(program (expressionStmt (indexAssign (fieldAccess (variable p) tags) (numberLiteral 1) (stringLiteral "z"))))',
    );
    assert.equal(sexp("p.at.y = 1;"), "(program (expressionStmt (fieldAssign (fieldAccess (variable p) at) y (numberLiteral 1))))");
  });

  it("reports a bad assignment target once", () => {
    // The generic "expected ';'" used to follow the specific complaint, blaming
    // the semicolon for a mistake the first diagnostic had already located.
    for (const bad of ["1 = 2;", "(a) = 2;", "f()[0] = 1;"]) {
      assert.deepEqual(errors(bad).length, 1, `expected one error for: ${bad}`);
    }
  });

  it("never loops forever on a malformed literal", () => {
    for (const nasty of ["[", "[,]", "[1", "[1,", "[[", "[]["]) {
      lexAndParse(`let xs: number[] = ${nasty};`);
    }
  });
});

describe("parser: errors and recovery", () => {
  it("reports a missing semicolon", () => {
    assert.match(errors("let x: number = 1")[0] ?? "", /expected ';'/);
  });

  it("reports a missing type annotation", () => {
    assert.match(errors("let x = 1;")[0] ?? "", /expected ':'/);
  });

  it("rejects a token that cannot be a type name", () => {
    assert.match(errors("let x: 1 = 1;")[0] ?? "", /expected a type name/);
  });

  it("mentions that annotations are required", () => {
    const diag = lexAndParse("let x: 1 = 1;").bag.errors()[0];
    assert.match(diag?.notes.join(" ") ?? "", /explicit type/);
  });

  // An unknown *name* is a different question from an unknown *type*. A struct is
  // written by name, and only the checker has the declarations, so the parser
  // accepts `Nope` here and the checker reports it as an unknown struct.
  it("accepts an unknown name in a type position", () => {
    assert.deepEqual(errors("let x: integer = 1;"), []);
  });

  it("reports a missing closing paren", () => {
    assert.match(errors("if (a { }")[0] ?? "", /expected '\)'/);
  });

  it("reports an unclosed block", () => {
    assert.match(errors("{ print(1); ")[0] ?? "", /expected '\}'/);
  });

  it("reports an unclosed string before parsing", () => {
    assert.match(errors('let x: string = "abc;')[0] ?? "", /unterminated string/);
  });

  it("rejects `break` outside a loop", () => {
    assert.match(errors("break;")[0] ?? "", /only allowed inside a loop/);
  });

  it("rejects `continue` outside a loop", () => {
    assert.match(errors("continue;")[0] ?? "", /only allowed inside a loop/);
  });

  it("rejects `return` outside a function", () => {
    assert.match(errors("return 1;")[0] ?? "", /only allowed inside a function/);
  });

  it("accepts break and continue inside nested loops", () => {
    assert.deepEqual(errors("while (a) { while (b) { break; continue; } }"), []);
  });

  it("reports several syntax errors in one pass", () => {
    assert.ok(errors("let = ;\nlet = ;\nlet = ;").length >= 3);
  });

  it("never loops forever on hostile input", () => {
    for (const nasty of ["{", ")", "= = =", "let", "fn", "1 +", "if", "/*", '"']) {
      lexAndParse(nasty);
    }
  });

  it("parses an empty program", () => {
    assert.equal(sexp(""), "(program)");
    assert.equal(sexp("// just a comment\n/* and another */"), "(program)");
  });
});

describe("parser: locations", () => {
  it("gives each node a span covering its own text", () => {
    const program = parseOk("let x: number = 42;");
    const decl = program.declarations[0];
    assert.ok(decl?.kind === "letDecl");
    const initializer = decl.initializer;
    assert.ok(initializer.kind === "numberLiteral");
    // `let x: number = 42;` — the `42` begins at column 17.
    assert.deepEqual(
      [initializer.location.line, initializer.location.column, initializer.location.length],
      [1, 17, 2],
    );
  });

  it("spans a whole function from `fn` to its closing brace", () => {
    const program = parseOk("fn f(): void {\n  print(1);\n}");
    const decl = program.declarations[0];
    assert.ok(decl?.kind === "fnDecl");
    assert.equal(decl.location.line, 1);
    assert.equal(decl.location.column, 1);
  });

  it("points at the offending token for a type error in a header", () => {
    const { bag } = lexAndParse("for (let i: 1 = 0; i < 1; i = i + 1) { }");
    // `for (let i: 1 = 0; ...)` — the `1` begins at column 13.
    const diag = bag.errors()[0];
    assert.equal(diag?.location.line, 1);
    assert.equal(diag?.location.column, 13);
  });
});

describe("parser: printer", () => {
  it("can annotate nodes with line and column", () => {
    const program = parseOk("let x: number = 1;");
    const printed = printProgram(program, { locations: true });
    assert.match(printed, /@1:1/);
  });

  it("honours a custom indent", () => {
    // indent 4: (program) at 0, (if) at 4, and (if)'s children at 8.
    const printed = printProgram(parseOk("if (a) { }"), { indent: "    " });
    assert.match(printed, /\n {4}\(if\n/);
    assert.match(printed, /\n {8}\(block/);
  });
});
