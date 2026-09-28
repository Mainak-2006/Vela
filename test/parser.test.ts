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
    assert.match(errors("1 = 2;")[0] ?? "", /left-hand side of '=' must be a variable/);
    assert.match(errors("(a) = 2;")[0] ?? "", /left-hand side of '=' must be a variable/);
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

describe("parser: errors and recovery", () => {
  it("reports a missing semicolon", () => {
    assert.match(errors("let x: number = 1")[0] ?? "", /expected ';'/);
  });

  it("reports a missing type annotation", () => {
    assert.match(errors("let x = 1;")[0] ?? "", /expected ':'/);
  });

  it("rejects an unknown type name", () => {
    assert.match(errors("let x: integer = 1;")[0] ?? "", /expected a type name/);
  });

  it("mentions that annotations are required", () => {
    const diag = lexAndParse("let x: integer = 1;").bag.errors()[0];
    assert.match(diag?.notes.join(" ") ?? "", /explicit type/);
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
    const { bag } = lexAndParse("for (let i: nope = 0; i < 1; i = i + 1) { }");
    // `for (let i: nope = 0; ...)` — `nope` begins at column 13.
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
