import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DiagnosticBag, SourceFile, type Diagnostic } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";
import { check } from "../src/types/checker.js";
import { isAssignable, typeToString, typesEqual, functionType, numberType, stringType, voidType, errorType } from "../src/types/types.js";

function checkSource(text: string): Diagnostic[] {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  check(parse(tokenize(source, bag), bag), bag);
  return [...bag.errors()];
}

/** Assert a program is rejected, and that the message matches. */
function expectError(text: string, pattern: RegExp): Diagnostic {
  const diagnostics = checkSource(text);
  assert.equal(diagnostics.length, 1, `expected exactly 1 error for: ${text}`);
  const first = diagnostics[0]!;
  assert.match(first.message, pattern);
  return first;
}

/** Assert a program is accepted. */
function expectOk(text: string): void {
  const diagnostics = checkSource(text);
  assert.deepEqual(
    diagnostics.map((d) => d.message),
    [],
    `expected no errors for: ${text}`,
  );
}

describe("type representation", () => {
  it("compares primitives structurally", () => {
    assert.ok(typesEqual(numberType, numberType));
    assert.ok(!typesEqual(numberType, stringType));
  });

  it("compares function types structurally and recursively", () => {
    const a = functionType([numberType], numberType);
    const b = functionType([numberType], numberType);
    const c = functionType([stringType], numberType);
    const d = functionType([numberType], stringType);
    assert.ok(typesEqual(a, b));
    assert.ok(!typesEqual(a, c));
    assert.ok(!typesEqual(a, d));
  });

  it("distinguishes functions by arity", () => {
    assert.ok(!typesEqual(functionType([], numberType), functionType([numberType], numberType)));
  });

  it("absorbs the error type in assignability", () => {
    assert.ok(isAssignable(numberType, errorType));
    assert.ok(isAssignable(errorType, numberType));
    assert.ok(!isAssignable(numberType, stringType));
  });

  it("renders types readably", () => {
    assert.equal(typeToString(numberType), "number");
    assert.equal(typeToString(functionType([numberType, stringType], voidType)), "fn(number, string) -> void");
  });
});

describe("checker: accepted programs", () => {
  it("accepts a simple declaration", () => {
    expectOk("let x: number = 1;");
  });

  it("accepts every primitive type", () => {
    expectOk('let n: number = 1;\nlet s: string = "a";\nlet b: bool = true;');
  });

  it("accepts arithmetic and comparison", () => {
    expectOk("let x: number = 1 + 2 * 3 - 4 / 5 % 6;\nlet b: bool = x > 1;");
  });

  it("accepts string concatenation", () => {
    expectOk('let s: string = "a" + "b";');
  });

  it("accepts short-circuit logic", () => {
    expectOk("let b: bool = true && false || !true;");
  });

  it("accepts a function with a recursive call", () => {
    expectOk(`
      fn fib(n: number): number {
        if (n < 2) { return n; }
        return fib(n - 1) + fib(n - 2);
      }
    `);
  });

  it("accepts a void function that returns nothing", () => {
    expectOk("fn noop(): void { }");
  });

  it("accepts an empty void function with a bare return", () => {
    expectOk("fn noop(): void { return; }");
  });

  it("accepts shadowing in a nested block", () => {
    expectOk("let x: number = 1;\n{ let x: string = \"a\"; }");
  });

  it("accepts assigning to a variable of the right type", () => {
    expectOk("let x: number = 1;\nx = 2;\nx = x + 1;");
  });

  it("accepts a for-loop header variable used only inside the loop", () => {
    expectOk("for (let i: number = 0; i < 3; i = i + 1) { print(i); }");
  });

  it("accepts every built-in print of a non-void value", () => {
    expectOk('print(1);\nprint("a");\nprint(true);');
  });

  it("accepts calling a function declared earlier", () => {
    expectOk("fn f(a: number): number { return a; }\nlet x: number = f(1);");
  });

  it("knows the built-in functions", () => {
    expectOk('let s: string = tostring(1);\nlet n: number = tonumber("2");\nlet t: string = typeOf(true);');
  });

  it("gives the built-ins their declared return types", () => {
    expectError("let n: number = tostring(1);", /cannot initialise 'n' of type 'number' with a value of type 'string'/);
  });

  it("accepts any value for a polymorphic built-in parameter", () => {
    expectOk('print(tostring("a"));\nprint(tostring(1));\nprint(tostring(true));');
  });

  it("still checks built-in arity", () => {
    expectError("tostring();", /expected 1 argument but got 0/);
    expectError("tostring(1, 2);", /expected 1 argument but got 2/);
  });
});

describe("checker: name resolution", () => {
  it("rejects an unknown name", () => {
    expectError("let x: number = y;", /cannot find 'y' in this scope/);
  });

  it("suggests a near-miss name", () => {
    const diag = expectError("let count: number = 1;\nlet x: number = cont;", /cannot find 'cont'/);
    assert.match(diag.notes.join(" "), /did you mean 'count'/);
  });

  it("rejects a redeclaration in the same scope", () => {
    expectError("let x: number = 1;\nlet x: number = 2;", /already declared in this scope/);
  });

  it("allows shadowing in a nested block", () => {
    expectOk("let x: number = 1;\n{ let x: number = 2; }");
  });

  it("rejects reading a for-loop variable after the loop", () => {
    expectError("for (let i: number = 0; i < 3; i = i + 1) { }\nprint(i);", /cannot find 'i'/);
  });

  it("rejects reading a parameter outside its function", () => {
    expectError("fn f(a: number): void { }\nprint(a);", /cannot find 'a'/);
  });

  it("rejects duplicate parameter names", () => {
    expectError("fn f(a: number, a: number): void { }", /duplicate parameter 'a'/);
  });

  it("rejects calling a function before it is declared", () => {
    expectError("let x: number = f(1);\nfn f(a: number): number { return a; }", /cannot find 'f'/);
  });

  it("rejects assigning to a function name", () => {
    expectError("fn f(): void { }\nf = 1;", /is a function and cannot be assigned to/);
  });
});

describe("checker: declarations", () => {
  it("rejects a mismatched initialiser", () => {
    expectError('let x: number = "a";', /cannot initialise 'x' of type 'number' with a value of type 'string'/);
  });

  it("rejects a bool where a number is expected", () => {
    expectError("let x: number = true;", /cannot initialise 'x' of type 'number' with a value of type 'bool'/);
  });

  it("rejects a void variable", () => {
    expectError("let x: void = 1;", /a variable cannot have type 'void'/);
  });

  it("requires a non-void function to end with return", () => {
    const diag = expectError("fn f(): number { print(1); }", /must end with a return statement/);
    assert.match(diag.notes.join(" "), /can finish without producing a 'number'/);
  });

  it("accepts a non-void function that ends with return", () => {
    expectOk("fn f(): number { print(1);\nreturn 0; }");
  });

  it("accepts an if/else where both arms return", () => {
    expectOk("fn f(n: number): number { if (n < 0) { return 0 - n; } else { return n; } }");
  });

  it("accepts an if/else-if chain where every arm returns", () => {
    expectOk(`
      fn classify(n: number): string {
        if (n < 0) { return "negative"; }
        else if (n == 0) { return "zero"; }
        else { return "positive"; }
      }
    `);
  });

  it("rejects an if with no else, even when the body returns", () => {
    expectError("fn f(n: number): number { if (n > 0) { return 1; } }", /must end with a return statement/);
  });

  it("rejects an if/else where only one arm returns", () => {
    expectError(
      "fn f(n: number): number { if (n > 0) { return 1; } else { print(0); } }",
      /must end with a return statement/,
    );
  });

  it("does not count a loop as returning, even an infinite one", () => {
    expectError("fn f(n: number): number { while (true) { return 1; } }", /must end with a return statement/);
  });

  it("does not count a conditional return inside a loop as returning", () => {
    expectError(
      "fn f(n: number): number { for (let i: number = 0; i < n; i = i + 1) { if (i == 2) { return i; } } }",
      /must end with a return statement/,
    );
  });

  it("rejects a return value of the wrong type", () => {
    expectError('fn f(): number { return "a"; }', /this return has type 'string' but 'f' returns 'number'/);
  });

  it("rejects a bare return in a non-void function", () => {
    expectError("fn f(): number { return; }", /this function must return a 'number'/);
  });

  it("rejects a return value in a void function", () => {
    expectError("fn f(): void { return 1; }", /a function returning 'void' cannot return a value/);
  });
});

describe("checker: operators", () => {
  it("rejects arithmetic on strings", () => {
    expectError('let x: number = "a" - 1;', /cannot apply '-' to 'string' and 'number'/);
  });

  it("rejects mixed-type concatenation", () => {
    expectError('let s: string = "a" + 1;', /cannot apply '\+' to 'string' and 'number'/);
  });

  it("accepts number + number", () => {
    expectOk("let x: number = 1 + 2;");
  });

  it("accepts string + string", () => {
    expectOk('let x: string = "a" + "b";');
  });

  it("rejects comparing a string with a number", () => {
    expectError('let b: bool = "a" < 1;', /cannot apply '<' to 'string' and 'number'/);
  });

  it("rejects ordering strings", () => {
    expectError('let b: bool = "a" < "b";', /cannot apply '<' to 'string' and 'string'/);
  });

  it("rejects equality across different types", () => {
    expectError('let b: bool = 1 == "a";', /cannot compare 'number' with 'string' using '=='/);
  });

  it("accepts equality within one type", () => {
    expectOk('let b: bool = 1 == 2;\nlet c: bool = "a" == "b";\nlet d: bool = true == false;');
  });

  it("rejects a non-bool operand to !", () => {
    expectError("let b: bool = !1;", /operator '!' requires a 'bool' operand, but this is 'number'/);
  });

  it("rejects a non-number operand to unary -", () => {
    expectError('let n: number = -"a";', /operator '-' requires a 'number' operand, but this is 'string'/);
  });

  it("rejects a non-bool operand to &&", () => {
    expectError("let b: bool = true && 1;", /operator '&&' requires 'bool' operands/);
  });

  it("rejects a non-bool operand to ||", () => {
    expectError("let b: bool = 1 || true;", /operator '\|\|' requires 'bool' operands/);
  });

  it("checks both operands of a binary operator", () => {
    const diagnostics = checkSource('let x: number = "a" + true;');
    assert.equal(diagnostics.length, 1);
  });
});

describe("checker: conditions", () => {
  it("rejects a number in an if condition", () => {
    const diag = expectError("if (1) { }", /this condition must be 'bool', but it is 'number'/);
    assert.match(diag.notes.join(" "), /no truthiness/);
  });

  it("rejects a string in a while condition", () => {
    expectError('while ("a") { }', /this condition must be 'bool', but it is 'string'/);
  });

  it("rejects a number in a for condition", () => {
    expectError("for (; 1; ) { }", /this condition must be 'bool', but it is 'number'/);
  });

  it("accepts a comparison as a condition", () => {
    expectOk("if (1 == 1) { }");
  });

  it("rejects printing a void value", () => {
    expectError("fn f(): void { }\nprint(f());", /cannot print a value of type 'void'/);
  });
});

describe("checker: assignment", () => {
  it("rejects assigning the wrong type", () => {
    expectError("let x: number = 1;\nx = \"a\";", /cannot assign a value of type 'string' to 'x', which is 'number'/);
  });

  it("accepts assigning a matching type", () => {
    expectOk("let x: number = 1;\nx = 2;");
  });
});

describe("checker: calls", () => {
  it("rejects calling a non-function", () => {
    expectError("let x: number = 1;\nx();", /this is not a function \(it has type 'number'\)/);
  });

  it("rejects too few arguments", () => {
    expectError("fn f(a: number, b: number): number { return a; }\nf(1);", /expected 2 arguments but got 1/);
  });

  it("rejects too many arguments", () => {
    expectError("fn f(a: number): number { return a; }\nf(1, 2);", /expected 1 argument but got 2/);
  });

  it("uses the singular for one argument", () => {
    expectError("fn f(a: number): number { return a; }\nf();", /expected 1 argument but got 0/);
  });

  it("rejects a wrong argument type", () => {
    expectError(
      'fn f(a: number): number { return a; }\nf("x");',
      /argument 1 has type 'string' but 'number' was expected/,
    );
  });

  it("reports the arity error and the argument error together", () => {
    // Argument 1 is genuinely mistyped, and argument 2 has no slot to be checked
    // against, so both the arity and the type of argument 1 are worth reporting.
    const diagnostics = checkSource('fn f(a: number): number { return a; }\nf("x", 1);');
    assert.equal(diagnostics.length, 2);
    assert.match(diagnostics[0]!.message, /expected 1 argument but got 2/);
    assert.match(diagnostics[1]!.message, /argument 1 has type 'string'/);
  });

  it("does not invent a type error for arguments past the end of the signature", () => {
    const diagnostics = checkSource('fn f(a: number): number { return a; }\nf(1, "x");');
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!.message, /expected 1 argument but got 2/);
  });

  it("points the arity error at the call", () => {
    const diag = expectError("fn f(a: number): number { return a; }\nf();", /expected 1 argument/);
    assert.equal(diag.location.line, 2);
  });
});

describe("checker: error recovery", () => {
  it("does not cascade after an unknown name", () => {
    // `count` is unknown, so the binary rule has nothing real to say about
    // `unknown + 1`; exactly one message, not three.
    const diagnostics = checkSource("let x: number = unknown + 1;");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!.message, /cannot find 'unknown'/);
  });

  it("reports each distinct unknown name once", () => {
    const diagnostics = checkSource("let x: number = unknown + unknown;");
    assert.equal(diagnostics.length, 2);
  });

  it("does not report a type error for a value it could not resolve", () => {
    // `f` is unknown, so its argument types are unknown too; one message is right.
    const diagnostics = checkSource("let x: number = nope(1, 2, 3);");
    assert.equal(diagnostics.length, 1);
  });

  it("reports several independent errors in one pass", () => {
    const diagnostics = checkSource("let a: number = 1;\nlet b: number = \"x\";\nlet c: number = true;");
    assert.equal(diagnostics.length, 2);
  });

  it("keeps checking after a function with an error", () => {
    const diagnostics = checkSource('fn f(): number { return "a"; }\nlet x: number = "b";');
    assert.equal(diagnostics.length, 2);
  });

  it("does not loop forever on deeply nested blocks", () => {
    const text = "{".repeat(50) + "}".repeat(50);
    checkSource(text);
  });
});
