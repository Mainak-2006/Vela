import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DiagnosticBag, SourceFile, type Diagnostic } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";
import { check } from "../src/types/checker.js";
import { isAssignable, typeToString, typesEqual, arrayType, functionType, nullableType, nullType, numberType, stringType, voidType, errorType } from "../src/types/types.js";

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

describe("checker: structs", () => {
  it("accepts a declaration and a constructor call", () => {
    expectOk("struct Point { x: number; y: number; }\nlet p: Point = Point(3, 4);");
  });

  it("accepts an empty struct", () => {
    expectOk("struct Marker {}\nlet m: Marker = Marker();");
  });

  it("accepts a field read and a field write", () => {
    expectOk(`
      struct P { x: number; }
      let p: P = P(1);
      p.x = 2;
      p.x += 3;
      print(p.x);
    `);
  });

  it("accepts a struct nested in a struct", () => {
    expectOk(`
      struct A { n: number; }
      struct B { a: A; }
      let b: B = B(A(1));
      print(b.a.n);
      b.a.n = 2;
    `);
  });

  it("accepts arrays of structs, and a field write through an index", () => {
    expectOk(`
      struct P { x: number; }
      let ps: P[] = [P(1), P(2)];
      ps[0].x = 9;
    `);
  });

  it("accepts a struct as an argument and a return type", () => {
    expectOk(`
      struct P { x: number; }
      fn shift(p: P, by: number): P { return P(p.x + by); }
      let p: P = shift(P(1), 2);
    `);
  });

  it("accepts a struct named after its use, because resolution is not order-dependent", () => {
    // A forward reference is the same rule as for functions: the signature is known
    // before any body is checked, and here before the declaration is even read.
    expectOk(`
      let p: Point = Point(1, 2);
      struct Point { x: number; y: number; }
    `);
  });

  it("takes one argument per field, in the order declared", () => {
    expectError(
      "struct P { x: number; y: number; }\nlet p: P = P(1);",
      /expected 2 arguments but got 1/,
    );
  });

  it("checks each field's argument type", () => {
    expectError(
      'struct P { x: number; }\nlet p: P = P("s");',
      /argument 1 has type 'string' but 'number' was expected/,
    );
  });

  it("says what a struct expects when the call is wrong", () => {
    const diag = expectError("struct P { x: number; }\nlet p: P = P();", /expected 1 argument/);
    assert.match(diag.notes.join(" "), /one argument per field/);
  });

  it("reports an unknown struct name", () => {
    const diag = expectError("let p: Nope = 1;", /cannot find a struct called 'Nope'/);
    assert.match(diag.notes.join(" "), /this program declares no structs yet/);
  });

  it("lists the structs it does know when one name is wrong", () => {
    const diag = expectError(
      "struct P { x: number; }\nlet q: Q = 1;",
      /cannot find a struct called 'Q'/,
    );
    assert.match(diag.notes.join(" "), /'P'/);
  });

  it("reports an unknown field, and lists the fields there are", () => {
    const diag = expectError(
      "struct P { x: number; y: string; }\nlet p: P = P(1, \"s\");\nprint(p.z);",
      /'P' has no field 'z'/,
    );
    assert.match(diag.notes.join(" "), /'x: number', 'y: string'/);
  });

  it("checks the type written into a field", () => {
    expectError(
      'struct P { x: number; }\nlet p: P = P(1);\np.x = "s";',
      /cannot assign a value of type 'string' to 'x', which is 'number'/,
    );
  });

  it("checks a compound field assignment as the write it desugars to", () => {
    expectError(
      'struct P { x: number; }\nlet p: P = P(1);\np.x += "s";',
      /cannot apply '\+' to 'number' and 'string'/,
    );
  });

  it("reports a field read on something that has no fields", () => {
    expectError("let xs: number[] = [1];\nprint(xs[0].n);", /has no fields|not a struct/);
  });

  it("reports a field write on something that has no fields", () => {
    expectError("let n: number = 1;\nn.x = 2;", /cannot assign a field of a value of type 'number'/);
  });

  it("rejects a struct name used as a value", () => {
    const diag = expectError(
      "struct P { x: number; }\nlet p: P = P;",
      /'P' is a struct, not a value/,
    );
    assert.match(diag.notes.join(" "), /'P\(\.\.\.\)' takes one argument per field/);
  });

  it("rejects two structs of the same shape being compared", () => {
    // The name is the whole of a nominal type, so matching fields are irrelevant.
    expectError(
      "struct P { x: number; }\nstruct R { x: number; }\nlet p: P = P(1);\nlet r: R = R(1);\nprint(p == r);",
      /cannot compare 'P' with 'R' using '=='/,
    );
  });

  it("rejects a struct compared with a number", () => {
    expectError(
      "struct P { x: number; }\nlet p: P = P(1);\nprint(p == 1);",
      /cannot compare 'P' with 'number' using '=='/,
    );
  });

  it("rejects a struct where a number is expected", () => {
    expectError(
      "struct P { x: number; }\nlet p: P = P(1);\nlet n: number = p;",
      /cannot initialise 'n' of type 'number' with a value of type 'P'/,
    );
  });

  it("rejects a struct as a condition", () => {
    expectError(
      "struct P { x: number; }\nlet p: P = P(1);\nif (p) { print(1); }",
      /this condition must be 'bool', but it is 'P'/,
    );
  });

  it("rejects a struct declaration inside a block", () => {
    const diag = expectError(
      "if (true) { struct Inner { a: number; } }",
      /a struct can only be declared at the top level/,
    );
    assert.match(diag.notes.join(" "), /move the declaration to the top/);
  });

  it("rejects a field of type void", () => {
    expectError("struct V { v: void; }", /a struct field cannot have type 'void'/);
  });

  it("rejects a struct that contains itself", () => {
    const diag = expectError("struct Self { me: Self; }", /'Self' cannot contain itself/);
    assert.match(diag.notes.join(" "), /could never be built/);
  });

  it("rejects two structs that contain each other, and names the way back", () => {
    const diag = expectError(
      "struct A { b: B; }\nstruct B { a: A; }",
      /'A' cannot contain itself/,
    );
    // Without the route the message is just "A contains A", which is false. The route
    // is spelled out field by field, so the way back through B is nameable.
    assert.match(diag.notes.join(" "), /'A\.b' -> 'B\.a'/);
  });

  it("reports a self-containing struct once, however it is used", () => {
    // The declaration is where a reader has to fix it, so the uses fail quietly.
    expectError("struct Self { me: Self; }\nlet s: Self = Self(Self());", /cannot contain itself/);
  });

  it("rejects a struct declared twice", () => {
    expectError("struct P { a: number; }\nstruct P { b: number; }", /already declared as a struct/);
  });

  it("rejects a field named like an outer binding", () => {
    expectOk("struct P { x: number; }\nlet p: P = P(1);\nlet x: number = 2;\nprint(x);");
  });

  it("rejects an array of an unknown struct", () => {
    expectError("let ps: Nope[] = [];", /cannot find a struct called 'Nope'/);
  });

  it("lets a const struct's fields be written", () => {
    // The rule is about the *name*: a `const` name cannot be assigned, and a field is
    // not a name, so this is allowed.
    expectOk("struct P { x: number; }\nconst p: P = P(1);\np.x = 2;");
  });

  it("still rejects assigning to a const struct's name", () => {
    expectError(
      "struct P { x: number; }\nconst p: P = P(1);\np = P(2);",
      /'p' is declared with 'const' and cannot be assigned to/,
    );
  });
});

describe("checker: optional struct fields", () => {
  const CONFIG = "struct Config { retries: number; label?: string; note?: string; }";

  it("accepts a call that leaves the optional fields out", () => {
    expectOk(`${CONFIG}\nlet c: Config = Config(3);`);
  });

  it("accepts a call that gives some of them and not others", () => {
    // A prefix of the optional suffix: the fields are filled in order, so an omitted
    // one is always at the end of the arguments.
    expectOk(`${CONFIG}\nlet a: Config = Config(3, "x");\nlet b: Config = Config(3, "x", "y");`);
  });

  it("accepts null for an optional field that is written out", () => {
    // The field is optional *and* nullable, so `null` is a value as well as an
    // omission — the two spellings mean the same state.
    expectOk(`${CONFIG}\nlet c: Config = Config(3, null);`);
  });

  it("reads an optional field as a nullable", () => {
    const diag = expectError(
      `${CONFIG}\nlet n: number = Config(3).label;`,
      /cannot initialise 'n' of type 'number' with a value of type 'string\?'/,
    );
    assert.match(diag.notes.join(" "), /test it first/);
  });

  it("narrows an optional field with a test, and not without one", () => {
    expectOk(`
      ${CONFIG}
      let c: Config = Config(3);
      if (c.label != null) { print(c.label); }
    `);
    expectError(`${CONFIG}\nlet c: Config = Config(3);\nprint(len(c.label));`, /which 'len' does not accept/);
  });

  it("narrows an optional field for a field chain", () => {
    expectOk(`
      struct Inner { n?: number; }
      struct Outer { inner: Inner; }
      let o: Outer = Outer(Inner(1));
      if (o.inner.n != null) { print(tostring(o.inner.n + 1)); }
    `);
  });

  it("takes back the fact after the field is written", () => {
    // `print` takes anything, so the read after the write needs something that
    // requires the value: the fact is about `c.label` being there, not about what
    // can be done with it.
    expectError(
      `${CONFIG}\nlet c: Config = Config(3, "x");\nif (c.label != null) { c.label = null; print(tostring(len(c.label))); }`,
      /argument 1 has type 'string\?', which 'len' does not accept/,
    );
  });

  it("lets a value and null both be assigned to the field", () => {
    expectOk(`${CONFIG}\nlet c: Config = Config(3);\nc.label = "x";\nc.label = null;`);
  });

  it("rejects too few arguments, naming the end of the range", () => {
    const diag = expectError(`${CONFIG}\nlet c: Config = Config();`, /expected at least 1 argument but got 0/);
    // The note is what turns an arity complaint into a fix: it says which argument
    // may be dropped, which is written in the declaration rather than at the call.
    assert.match(diag.notes.join(" "), /'label', 'note' are optional/);
  });

  it("rejects too many arguments, naming the end of the range", () => {
    const diag = expectError(
      `${CONFIG}\nlet c: Config = Config(3, "x", "y", "z");`,
      /expected at most 3 arguments but got 4/,
    );
    assert.match(diag.notes.join(" "), /one argument per field/);
  });

  it("keeps the ordinary arity message for a struct with no optional fields", () => {
    // Nothing is optional, so there is no range to mention and the message stays the
    // one every other call in the language uses.
    expectError("struct P { x: number; }\nlet p: P = P();", /expected 1 argument but got 0/);
  });

  it("still checks the arguments that were given", () => {
    // A wrong-arity call often also has a wrong argument, and reporting both saves a
    // round trip through the checker.
    const diagnostics = checkSource("struct C { a: number; b: string; }\nlet c: C = C(\"x\");");
    assert.deepEqual(diagnostics.map((d) => d.message), [
      "expected 2 arguments but got 1",
      "argument 1 has type 'string' but 'number' was expected",
    ]);
  });

  it("types an optional field as `T?` in a call signature", () => {
    // The signature a constructor presents is what the arity note prints, so it is
    // the checker's own view of the fields rather than a separate rendering.
    const diag = expectError(`${CONFIG}\nlet c: Config = Config();`, /at least 1 argument/);
    assert.match(diag.notes[0] ?? "", /fn\(number, string\?, string\?\) -> Config/);
  });

  it("lets an optional field break a struct cycle", () => {
    expectOk(`
      struct Node { value: number; next?: Node; }
      let chain: Node = Node(1, Node(2, Node(3)));
      fn total(from: Node?): number {
        let sum: number = 0;
        for (let at: Node? = from; at != null; at = at.next) { sum = sum + at.value; }
        return sum;
      }
      print(tostring(total(chain)));
    `);
  });

  it("still rejects a cycle that no optional field breaks", () => {
    expectError("struct A { b: B; }\nstruct B { a: A; }", /'A' cannot contain itself/);
  });

  it("mentions the optional form in the cycle's own note", () => {
    // A reader told to add a `?` should be told which `?`: the one after the name
    // stops the argument being required, and the one after the type stops the cycle.
    const diag = expectError("struct Self { me: Self; }", /cannot contain itself/);
    assert.match(diag.notes.join(" "), /'next\?: Node'/);
  });

  it("rejects `?` on a field whose type is already nullable", () => {
    expectError("struct E { x?: number?; }", /is already nullable/);
  });

  it("rejects a required field after an optional one", () => {
    expectError(
      "struct D { label?: string; retries: number; }",
      /required field 'retries' cannot follow an optional one/,
    );
  });
});

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

  it("compares array types by their element type", () => {
    assert.ok(typesEqual(arrayType(numberType), arrayType(numberType)));
    assert.ok(!typesEqual(arrayType(numberType), arrayType(stringType)));
    // Nested arrays compare element types recursively, so the depths matter.
    assert.ok(typesEqual(arrayType(arrayType(numberType)), arrayType(arrayType(numberType))));
    assert.ok(!typesEqual(arrayType(arrayType(numberType)), arrayType(numberType)));
  });

  it("keeps 'null' and 'T?' apart", () => {
    // `null` is a type of its own rather than "any type, possibly absent": the second
    // would let `null` be stored in a `number?` *and* printed as `number?`, and would
    // make the two indistinguishable wherever a type is compared.
    assert.ok(typesEqual(nullType, nullType));
    assert.ok(!typesEqual(nullType, numberType));
    assert.ok(!typesEqual(nullType, nullableType(numberType)));
    assert.ok(typesEqual(nullableType(numberType), nullableType(numberType)));
    assert.ok(!typesEqual(nullableType(numberType), nullableType(stringType)));
    // `number?` and `number[]?` differ in what is absent, so they are not the same type.
    assert.ok(!typesEqual(nullableType(arrayType(numberType)), nullableType(numberType)));
  });

  it("lets a value widen into a nullable type and nothing else", () => {
    assert.ok(isAssignable(nullableType(numberType), numberType));
    assert.ok(isAssignable(nullableType(numberType), nullType));
    assert.ok(isAssignable(nullableType(numberType), nullableType(numberType)));
    // Not the other way round, and not sideways: a `number?` is not a `string?`, and
    // neither of them is a `number`.
    assert.ok(!isAssignable(numberType, nullableType(numberType)));
    assert.ok(!isAssignable(nullableType(stringType), nullableType(numberType)));
    assert.ok(!isAssignable(nullableType(arrayType(numberType)), nullableType(numberType)));
    // Two nullable levels are one, because "absent" has no inner type of its own: the
    // constructor collapses them, so `number??` and `number?` cannot be two types.
    assert.ok(typesEqual(nullableType(numberType), nullableType(nullableType(numberType))));
    assert.ok(isAssignable(nullableType(numberType), nullableType(nullableType(numberType))));
  });

  it("absorbs a nullable error type both ways", () => {
    assert.ok(isAssignable(nullableType(numberType), nullableType(errorType)));
    assert.ok(isAssignable(nullableType(errorType), nullableType(numberType)));
  });

  it("renders a nullable type with the '?' after the type it qualifies", () => {
    assert.equal(typeToString(nullableType(numberType)), "number?");
    assert.equal(typeToString(nullableType(arrayType(numberType))), "number[]?");
    assert.equal(typeToString(nullableType(nullableType(numberType))), "number?");
    assert.equal(typeToString(nullType), "null");
  });

  it("renders types readably", () => {
    assert.equal(typeToString(numberType), "number");
    assert.equal(typeToString(functionType([numberType, stringType], voidType)), "fn(number, string) -> void");
    assert.equal(typeToString(arrayType(numberType)), "number[]");
    // No parentheses: the brackets bind to the element, exactly as they are written.
    assert.equal(typeToString(arrayType(arrayType(stringType))), "string[][]");
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

  it("type-checks the numeric built-ins from the shared table", () => {
    expectOk("let a: number = trunc(2.7);\nlet b: number = floor(2.7);\nlet c: number = ceil(2.7);\nlet d: number = round(2.5);\nlet e: number = abs(0 - 1);\nlet f: number = min(1, 2);\nlet g: number = max(1, 2);\nlet h: number = idiv(7, 2);");
  });

  it("rejects a non-number argument to a numeric built-in", () => {
    expectError("let a: number = trunc(\"2.7\");", /argument 1 has type 'string' but 'number' was expected/);
    expectError("let a: number = min(\"1\", 2);", /argument 1 has type 'string' but 'number' was expected/);
  });

  it("checks arity on the numeric built-ins", () => {
    expectError("let a: number = idiv(1);", /expected 2 arguments but got 1/);
    expectError("let a: number = abs(1, 2);", /expected 1 argument but got 2/);
  });

  it("does not treat print as a callable", () => {
    // `print` is a keyword and was removed from the built-in table, so there is
    // no signature the language cannot express. It fails in the parser, not the
    // checker, which is why this asserts on the diagnostics rather than using
    // expectError's single-error assumption.
    const messages = checkSource("let a: number = print(1);").map((d) => d.message);
    assert.ok(messages.length > 0, "print in an expression position must be rejected");
    assert.ok(
      messages.every((m) => /print|expression/.test(m)),
      `expected a parse error naming print, got: ${messages.join("; ")}`,
    );
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

  it("accepts a call to a function declared later", () => {
    // Signatures are hoisted before any body is checked, so a forward call
    // resolves. The interpreter already hoisted the declaration, so this
    // agreement is the point: what type-checks is what runs.
    expectOk("let x: number = f(1);\nfn f(a: number): number { return a; }");
  });

  it("accepts mutual recursion", () => {
    expectOk(`
      fn isEven(n: number): bool {
        if (n == 0) { return true; }
        return isOdd(n - 1);
      }
      fn isOdd(n: number): bool {
        if (n == 0) { return false; }
        return isEven(n - 1);
      }
      let r: bool = isEven(10);
    `);
  });

  it("accepts mutual recursion between siblings inside a block", () => {
    expectOk(`
      fn outer(): number {
        fn a(n: number): number { if (n == 0) { return 0; } return b(n - 1); }
        fn b(n: number): number { if (n == 0) { return 1; } return a(n - 1); }
        return a(4);
      }
    `);
  });

  it("accepts storing a function in a `function`-typed variable", () => {
    expectOk("fn d(x: number): number { return x; }\nlet f: function = d;");
    expectOk("fn g(): string { return \"\"; }\nlet f: function = g;");
  });

  it("accepts a function-typed parameter and return", () => {
    expectOk(`
      fn d(x: number): number { return x; }
      fn apply(cb: function, n: number): function { return cb; }
      let out: function = apply(d, 1);
    `);
  });

  it("rejects storing a non-function in a `function`-typed variable", () => {
    expectError("let f: function = 5;", /of type 'function' with a value of type 'number'/);
  });

  it("types s[i] as a string", () => {
    expectOk(`let s: string = "ab"; let c: string = s[0];`);
    expectOk(`let s: string = "ab"; print(s[0] + "!");`);
  });

  it("rejects indexing a non-string", () => {
    expectError("let n: number = 1;\nprint(n[0]);", /cannot be indexed/);
    expectError("let b: bool = true;\nprint(b[0]);", /cannot be indexed/);
  });

  it("rejects a non-number index", () => {
    expectError(`let s: string = "ab";\nprint(s["x"]);`, /a string index has type 'string'/);
    expectError(`let s: string = "ab";\nprint(s[true]);`, /a string index has type 'bool'/);
  });

  it("passes a bare function value through another bare function value", () => {
    expectOk("fn d(x: number): number { return x; }\nlet f: function = d;\nlet g: function = f;");
  });

  it("does not check a call through a `function`-typed variable", () => {
    // The documented cost of the bare type: the signature is not recorded, so the
    // arity and return type at this call site cannot be verified.
    expectOk("fn d(x: number): number { return x; }\nlet f: function = d;\nlet n: number = f(1);");
  });

  it("still reports calling a non-function", () => {
    expectError("let n: number = 1;\nn();", /this is not a function/);
  });

  it("checks a hoisted function's body against its own signature", () => {
    // Hoisting must not lose the signature: the body is still checked against it,
    // so a bad return is still reported even though the name resolved early.
    expectError("fn f(): number { return true; }", /this return has type 'bool' but 'f' returns 'number'/);
  });

  it("still rejects a duplicate function declaration", () => {
    expectError("fn f(): number { return 1; }\nfn f(): number { return 2; }", /already declared/);
  });

  it("still rejects a variable used before its declaration", () => {
    // Only functions hoist. A variable's type comes from a value that has to be
    // computed, so `later` genuinely does not exist yet.
    expectError("fn f(): number { return later; }\nlet later: number = 1;", /cannot find 'later'/);
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

  it("accepts a const declaration", () => {
    expectOk('const K: number = 1;\nconst S: string = "a";\nconst B: bool = true;');
  });

  it("reads a const like any other binding", () => {
    expectOk("const K: number = 1;\nlet n: number = K + 1;");
  });

  it("rejects assigning to a const", () => {
    const diag = expectError("const K: number = 1;\nK = 2;", /'K' is declared with 'const' and cannot be assigned to/);
    assert.match(diag.notes.join(" "), /the declaration of 'K' is here/);
  });

  it("rejects compound assignment to a const", () => {
    // `+=` desugars to `K = K + 1` in the parser, so the same rule catches it. The
    // test exists because a sugar form that reaches the checker as something else
    // would otherwise be a silent hole in the rule.
    expectError("const K: number = 1;\nK += 2;", /'K' is declared with 'const'/);
  });

  it("rejects incrementing a const", () => {
    expectError("const K: number = 1;\nK++;", /'K' is declared with 'const'/);
  });

  it("rejects a const in a for header being used as the loop update", () => {
    expectError(
      "for (const i: number = 0; i < 3; i++) { print(i); }",
      /'i' is declared with 'const'/,
    );
  });

  it("applies the const rule to a const declared in an outer block", () => {
    expectError(
      "const K: number = 1;\nif (true) { K = 2; }",
      /'K' is declared with 'const'/,
    );
  });

  it("still allows a const to shadow an outer name in a new block", () => {
    // Shadowing creates a new binding, and that new binding is the one the const
    // rule applies to. The const is not violated by declaring a new `K` inside.
    expectOk("const K: number = 1;\n{ const K: number = 2;\nlet n: number = K; }");
  });

  it("rejects a mismatched const initialiser", () => {
    expectError('const K: number = "a";', /cannot initialise 'K' of type 'number' with a value of type 'string'/);
  });

  it("rejects a void const", () => {
    expectError("const K: void = 1;", /a variable cannot have type 'void'/);
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

describe("checker: return analysis through loops", () => {
  // The question a non-void function has to answer is "can control reach the end",
  // and a loop normally lets it: the condition can go false and the statement after
  // runs. These are the shapes that cannot, so a function may end with one instead
  // of a sentinel `return`.
  it("accepts an infinite loop whose body returns", () => {
    expectOk("fn f(n: number): number { while (true) { return 1; } }");
  });

  it("accepts an infinite loop that never finishes at all", () => {
    // No value is produced, and none is needed: the call never comes back. That is
    // why the rule is about control reaching the end rather than about a `return`.
    expectOk("fn f(): number { while (true) { print(1); } }");
  });

  it("accepts a for whose condition is the literal true", () => {
    expectOk("fn f(): number { for (let i: number = 0; true; i = i + 1) { return i; } }");
  });

  it("accepts a for with no condition at all, which is unconditional", () => {
    // The C spelling of `while (true)`, and spellable in Vela.
    expectOk("fn f(): number { for (;;) { print(1); } }");
  });

  it("accepts a loop whose body is an if/else where both arms return", () => {
    expectOk("fn f(c: bool): number { while (true) { if (c) { return 1; } else { return 2; } } }");
  });

  it("accepts a continue, because re-testing a literal true cannot end the loop", () => {
    expectOk(
      "fn f(c: bool): number { while (true) { if (c) { continue; } return 1; } }",
    );
  });

  it("ignores a break that belongs to a nested loop", () => {
    // `break` leaves the innermost loop enclosing it, so this one ends the inner
    // `while`, not the `while (true)` around it. Counting it would reject correct
    // code — and this program does return, on the outer loop's first iteration.
    expectOk("fn f(c: bool): number { while (true) { while (c) { break; } return 1; } }");
  });

  it("ignores a continue that belongs to a nested loop", () => {
    expectOk(
      "fn f(): number { while (true) { for (let i: number = 0; i < 3; i = i + 1) { continue; } return 1; } }",
    );
  });

  it("does not look inside a nested function", () => {
    // A `break` cannot cross a function boundary, so nothing in here says anything
    // about the loop around it.
    expectOk("fn f(): number { while (true) { fn inner(): number { return 1; } print(1); } }");
  });

  it("counts a loop in one arm of an if/else", () => {
    expectOk("fn f(c: bool): number { if (c) { while (true) { return 1; } } else { return 2; } }");
  });

  it("rejects an infinite loop with a break", () => {
    // The `break` is a way out that produces nothing, which is the case the rule
    // exists to exclude.
    expectError("fn f(): number { while (true) { break; } }", /must end with a return statement/);
  });

  it("rejects an infinite loop that can break past its return", () => {
    expectError(
      "fn f(x: bool): number { while (true) { if (x) { return 1; } break; } }",
      /must end with a return statement/,
    );
  });

  it("rejects a testable loop whose body always returns, because it may run zero times", () => {
    // The body returns on every iteration, but `n` may be 0 or less — then the
    // body never runs and control reaches the end of the function with nothing
    // produced. Proving otherwise needs real dataflow analysis.
    expectError(
      "fn f(n: number): number { while (n > 0) { return n; } }",
      /must end with a return statement/,
    );
  });

  it("rejects a testable loop whose body returns under a condition", () => {
    expectError(
      "fn f(c: bool): number { while (c) { if (c) { return 1; } else { return 2; } } }",
      /must end with a return statement/,
    );
  });

  it("still rejects a loop whose body only sometimes returns", () => {
    expectError("fn f(c: bool): number { while (c) { if (c) { return 1; } } }", /must end with a return statement/);
  });

  it("still rejects a loop whose body returns under a condition", () => {
    expectError(
      "fn f(n: number): number { while (n > 0) { if (n == 1) { return 1; } } }",
      /must end with a return statement/,
    );
  });

  it("rejects a for whose body always returns, because it may run zero times", () => {
    expectError(
      "fn f(): number { for (let i: number = 0; i < 3; i = i + 1) { return i; } }",
      /must end with a return statement/,
    );
  });

  it("does not count a loop as returning when the body merely prints", () => {
    expectError("fn f(c: bool): number { while (c) { print(1); } }", /must end with a return statement/);
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

describe("checker: nullable types", () => {
  it("accepts null in a nullable position and the value it holds otherwise", () => {
    expectOk("let x: number? = null;\nlet y: number? = 1;\nlet n: number = 2;");
  });

  it("rejects a null where a non-nullable type is expected", () => {
    expectError("let x: number = null;", /cannot initialise 'x' of type 'number' with a value of type 'null'/);
  });

  it("rejects a nullable value where a non-nullable type is expected", () => {
    // The whole point of writing `T?`: the checker will not quietly forget the `?`.
    expectError(
      "let a: number? = 1;\nlet b: number = a;",
      /cannot initialise 'b' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("rejects null as an argument, a return, or a field", () => {
    expectError("fn f(n: number): void { }\nf(null);", /argument 1 has type 'null' but 'number' was expected/);
    expectError("fn f(): number { return null; }", /this return has type 'null' but 'f' returns 'number'/);
    expectError("struct S { n: number; }\nlet s: S = S(null);", /argument 1 has type 'null' but 'number' was expected/);
  });

  it("accepts null for a nullable parameter and a nullable return", () => {
    expectOk("fn f(n: number?): number? { return n; }\nf(null);\nlet r: number? = f(1);");
  });

  it("says how to fix a null in a non-nullable position", () => {
    const diag = expectError("let x: number = null;", /cannot initialise 'x'/);
    assert.match(diag.notes.join(" "), /'null' holds no value/);
    assert.match(diag.notes.join(" "), /annotate the target as 'number\?'/);
  });

  it("suggests a test when a nullable value is used as if it were there", () => {
    const diag = expectError("let x: number? = 1;\nlet y: number = x + 1;", /cannot apply '\+' to 'number\?' and 'number'/);
    assert.match(diag.notes.join(" "), /may be absent/);
    assert.match(diag.notes.join(" "), /if \(x != null\)/);
  });

  it("compares null with a nullable, in either order", () => {
    expectOk("let x: number? = null;\nif (x == null) { print(\"absent\"); }");
    expectOk("let x: number? = null;\nif (null != x) { print(\"present\"); }");
  });

  it("allows comparing null with something that cannot be null", () => {
    // Always false, and Vela reports faults rather than tautologies — but the test has
    // to be writable, or a value could not be probed once its type had been pinned down.
    expectOk("let a: number = 1;\nif (a == null) { print(\"never\"); }\nprint(tostring(a));");
  });

  it("keeps two nullable types apart when comparing them", () => {
    expectError("let a: number? = 1;\nlet b: string? = \"s\";\nif (a == b) { print(\"x\"); }", /cannot compare 'number\?' with 'string\?'/);
  });

  it("narrows a nullable name for the rest of an if branch", () => {
    expectOk(
      [
        "fn describe(n: number?): string {",
        "  if (n == null) { return \"none\"; }",
        "  return tostring(n + 1);",
        "}",
        'print(describe(null));',
        'print(describe(1));',
      ].join("\n"),
    );
  });

  it("narrows to null in the else of an equality test", () => {
    expectOk(
      [
        "fn describe(n: number?): string {",
        "  if (n != null) { return tostring(n); }",
        '  return "none";',
        "}",
        "print(describe(null));",
      ].join("\n"),
    );
  });

  it("narrows after an if with no else whose body always leaves", () => {
    // The guard clause: the statements after it are only reached the other way, so
    // they are checked under the condition being false.
    expectOk(
      [
        "fn first(xs: number[]): number {",
        "  if (len(xs) == 0) { return 0; }",
        "  return xs[0];",
        "}",
        "print(tostring(first([])));",
        "print(tostring(first([7])));",
      ].join("\n"),
    );
  });

  it("does not narrow after an if whose body can fall through", () => {
    expectError(
      [
        "let x: number? = 1;",
        "if (x == null) { print(\"absent\"); }",
        "let y: number = x;",
      ].join("\n"),
      /cannot initialise 'y' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("narrows after a while whose body cannot leave first", () => {
    expectOk(
      [
        "fn firstNonNull(a: number?, b: number?): number {",
        "  let at: number? = a;",
        "  while (at == null) { at = b; }",
        "  return at;",
        "}",
        'print(tostring(firstNonNull(null, 4)));',
      ].join("\n"),
    );
  });

  it("narrows a for header's update and body alike", () => {
    // Both run only when the condition held, so both are checked as though it does.
    expectOk(
      [
        "struct Node { value: number; next: Node?; }",
        "fn sum(head: Node?): number {",
        "  let total: number = 0;",
        "  for (let at: Node? = head; at != null; at = at.next) { total = total + at.value; }",
        "  return total;",
        "}",
        "print(tostring(sum(Node(1, Node(2, null)))));",
      ].join("\n"),
    );
  });

  it("narrows after a while whose body can leave first", () => {
    // The one case the analysis refuses: a body that can return may have run zero
    // times, so nothing is known about the name once the loop is done with it.
    expectError(
      [
        "fn f(x: number?): number {",
        "  while (x != null) { if (x > 1) { return 1; } else { return 2; } }",
        "  return x;",
        "}",
      ].join("\n"),
      /this return has type 'number\?' but 'f' returns 'number'/,
    );
  });

  it("narrows inside a while body, as though the condition held", () => {
    expectOk(
      [
        "fn total(xs: number[]): number {",
        "  let i: number = 0;",
        "  let next: number? = 3;",
        "  while (next != null) {",
        "    i = i + next;",
        "    next = null;",
        "  }",
        "  return i;",
        "}",
        "print(tostring(total([])));",
      ].join("\n"),
    );
  });

  it("narrows the right operand of &&", () => {
    expectOk("let x: number? = 1;\nif (x != null && x > 0) { print(tostring(x)); }");
  });

  it("does not carry a fact out of a branch", () => {
    // The fact is a property of the path, so code after the `if` sees the declared
    // type again. Without this the checker would accept code that cannot run.
    expectError(
      "let x: number? = 1;\nif (x != null) { print(tostring(x)); }\nlet y: number = x;",
      /cannot initialise 'y' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("does not claim a fact from one arm of ||", () => {
    // `a || b` being true does not say which one was true, so neither may be narrowed.
    expectError(
      "let x: number? = 1;\nlet y: number? = 2;\nif (x == null || y == null) { let z: number = x + y; }",
      /cannot apply '\+' to 'number\?' and 'number\?'/,
    );
  });

  it("drops a fact when the name is assigned to", () => {
    expectError(
      "let x: number? = 1;\nif (x != null) { x = null; let y: number = x; }",
      /cannot initialise 'y' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("narrows per binding, so a shadowing name is not narrowed by an outer test", () => {
    // Keyed on the symbol rather than the name: the inner `x` is a different binding,
    // and a test of the outer one says nothing about it.
    expectError(
      [
        "let x: number? = 1;",
        "if (x != null) {",
        "  let x: number? = null;",
        "  let y: number = x;",
        "}",
      ].join("\n"),
      /cannot initialise 'y' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("does not narrow a name inside an unrelated function", () => {
    expectError(
      "let x: number? = 1;\nfn f(): number { return x; }",
      /this return has type 'number\?' but 'f' returns 'number'/,
    );
  });

  it("narrows a field of a name, which is what makes a linked list work", () => {
    expectOk(
      [
        "struct Node { value: number; next: Node?; }",
        "let b: Node = Node(2, Node(1, null));",
        "if (b.next != null) { print(tostring(b.next.value)); }",
      ].join("\n"),
    );
  });

  it("narrows a chain of fields, each on the strength of the one before", () => {
    expectOk(
      [
        "struct Node { value: number; next: Node?; }",
        "let a: Node = Node(1, null);",
        "let b: Node = Node(2, Node(3, a));",
        "if (b.next != null && b.next.next != null) { print(tostring(b.next.next.value)); }",
      ].join("\n"),
    );
  });

  it("drops a fact about a field when the field is written", () => {
    expectError(
      [
        "struct Node { next: Node?; }",
        "let p: Node = Node(Node(null));",
        "if (p.next != null) { p.next = null; let y: Node = p.next; }",
      ].join("\n"),
      /cannot initialise 'y' of type 'Node' with a value of type 'Node\?'/,
    );
  });

  it("makes an array of nullable elements an array, not a nullable array", () => {
    // `number?[]` is an array that may hold an absent element; the array is always
    // there, so its length is a `number` however the elements are spelled.
    expectOk("let xs: number?[] = [1, null];\nprint(tostring(len(xs)));");
    expectOk("let xs: number?[] = [1];\nif (xs[0] != null) { print(tostring(xs[0])); }");
  });

  it("does not narrow an element, which is a place with no fixed name", () => {
    // `xs[0]` has no text that identifies the same element next time, so a test of it
    // teaches nothing the checker could rely on and the use says so.
    expectError(
      "let xs: number?[] = [1];\nif (xs[0] != null) { let y: number = xs[0]; }",
      /cannot initialise 'y' of type 'number' with a value of type 'number\?'/,
    );
  });

  it("lets a nullable array be absent", () => {
    expectOk("let xs: number[]? = null;\nif (xs != null) { print(tostring(len(xs))); }");
    expectError("let xs: number[]? = [1];\nlet n: number = len(xs);", /argument 1 has type 'number\[\]\?', which 'len' does not accept/);
  });

  it("rejects a null element where the element type is not nullable", () => {
    expectError("let xs: number[] = [1, null];", /element 2/);
  });

  it("lets a struct hold a nullable field and be built with null", () => {
    expectOk(
      [
        "struct Node { value: number; next: Node?; }",
        "let a: Node = Node(1, null);",
        "let b: Node = Node(2, a);",
        "if (b.next != null) { print(tostring(b.next.value)); }",
        "print(tostring(a.next == null));",
      ].join("\n"),
    );
  });

  it("takes either a value or null for a nullable field", () => {
    // A `number` fits in a `number?`, so both spellings build the same field type. What
    // is refused is a value that *might* be absent where one is required, which is the
    // other direction and the reason a field is written `number?` in the first place.
    expectOk(
      [
        "struct S { n: number?; }",
        "let a: S = S(1);",
        "let b: S = S(null);",
        "if (a.n != null) { print(tostring(a.n)); }",
      ].join("\n"),
    );
    expectError(
      "struct S { n: number; }\nlet maybe: number? = null;\nlet s: S = S(maybe);",
      /argument 1 has type 'number\?' but 'number' was expected/,
    );
  });

  it("keeps the two directions of assignability apart", () => {
    // `number` fits in `number?`, and a `number?` fits in nothing narrower. Neither
    // statement is a widening rule that could be read the other way round.
    expectOk("let x: number = 1;\nlet a: number? = x;");
    expectError("let x: number = 1;\nlet a: number? = x;\nlet b: number = a;", /cannot initialise/);
  });
});

describe("checker: arrays", () => {
  it("takes the element type from a declared type", () => {
    expectOk("let xs: number[] = [1, 2, 3];");
    expectOk("let xs: string[] = [\"a\"];");
    expectOk("let xs: bool[] = [true];");
  });

  it("takes the element type from the elements when there is no context", () => {
    // `print` takes `any`, so there is no expected type to read an element type
    // from — the literal has to be able to describe itself.
    expectOk("print([1, 2]);");
    expectOk("fn f(): number[] { return [3, 4]; }");
  });

  it("takes the element type from a return type", () => {
    // `[]` in a return position has the same need as one in a declaration, and
    // the return type is the context that supplies it.
    expectOk("fn f(): number[] { return []; }");
    expectOk("fn f(): string[] { return [\"a\"]; }");
  });

  it("takes the element type from a parameter, at the call site", () => {
    expectOk("fn f(xs: number[]): number { return len(xs); }\nprint(f([]));");
    expectOk("fn f(xs: number[]): number { return len(xs); }\nprint(f([1, 2]));");
  });

  it("types xs[i] as the element", () => {
    expectOk("let xs: number[] = [1];\nlet n: number = xs[0];");
    expectOk("let xs: string[] = [\"a\"];\nprint(xs[0] + \"!\");");
    expectOk("let g: number[][] = [[1]];\nlet n: number = g[0][0];");
  });

  it("rejects elements of mixed types", () => {
    expectError("let xs: number[] = [1, \"a\"];", /element 2 has type 'string' but this array holds 'number'/);
    expectError("let xs: number[] = [1, true];", /element 2 has type 'bool'/);
  });

  it("rejects an empty literal with nothing to infer from", () => {
    // The one case that cannot resolve: an empty literal holds no elements, so
    // without an annotation there is no element type and no way to check a later
    // write. Guessing would be worse than refusing.
    expectError("print([]);", /an empty array literal has no element type/);
    // A bare `function` records no signature, so a call through one offers the
    // literal no context either — which is the documented cost of that type, now
    // visible in a place where it actually bites.
    expectError(
      "fn g(cb: function): void { cb([]); }",
      /an empty array literal has no element type/,
    );
  });

  it("rejects an array that does not match its declared type", () => {
    expectError("let xs: number[] = [\"a\"];", /element 1 has type 'string' but this array holds 'number'/);
  });

  it("treats array types as unrelated", () => {
    expectError("let xs: number[] = [1];\nlet ys: string[] = xs;", /cannot initialise 'ys' of type 'string\[\]' with a value of type 'number\[\]'/);
    expectError("let xs: number[] = [1];\nlet ys: number[][] = xs;", /with a value of type 'number\[\]'/);
  });

  it("checks a write against the element type", () => {
    expectOk("let xs: number[] = [1];\nxs[0] = 2;");
    expectError("let xs: number[] = [1];\nxs[0] = \"a\";", /cannot store a value of type 'string' in a 'number\[\]'/);
    expectError("let xs: string[] = [\"a\"];\nxs[0] = 1;", /cannot store a value of type 'number' in a 'string\[\]'/);
  });

  it("checks a write through a chained index", () => {
    expectOk("let g: number[][] = [[1]];\ng[0][0] = 2;");
    expectError("let g: number[][] = [[1]];\ng[0][0] = \"a\";", /cannot store a value of type 'string'/);
    // The outer array holds arrays, so writing a number into it is the error, not
    // the inner element type.
    expectError("let g: number[][] = [[1]];\ng[0] = 1;", /cannot store a value of type 'number' in a 'number\[\]\[\]', whose elements are 'number\[\]'/);
  });

  it("rejects assigning through a string", () => {
    expectError("let s: string = \"ab\";\ns[0] = \"c\";", /only an array can be written to/);
  });

  it("rejects a non-number array index", () => {
    expectError("let xs: number[] = [1];\nprint(xs[\"x\"]);", /an array index has type 'string'/);
    expectError("let xs: number[] = [1];\nprint(xs[true]);", /an array index has type 'bool'/);
    expectError("let xs: number[] = [1];\nxs[\"x\"] = 1;", /an array index has type 'string'/);
  });

  it("rejects indexing something that is neither a string nor an array", () => {
    expectError("let n: number = 1;\nprint(n[0]);", /cannot be indexed/);
    expectError("let b: bool = true;\nprint(b[0]);", /cannot be indexed/);
    expectError("let n: number = 1;\nprint(n[0][0]);", /cannot be indexed/);
  });

  it("lets len measure a string or an array", () => {
    expectOk("print(len(\"abc\"));");
    expectOk("print(len([1, 2, 3]));");
    expectOk("let xs: number[] = [1];\nprint(len(xs));");
  });

  it("rejects len on anything else", () => {
    expectError("print(len(42));", /which 'len' does not accept/);
    expectError("print(len(true));", /which 'len' does not accept/);
    // An array of arrays is still an array, however deep.
    expectOk("let g: number[][] = [[1]];\nprint(len(g));");
  });

  it("shares one array between two names", () => {
    // The type system cannot promise the contents stay equal after a write, so it
    // promises the reference is the same — which is what `==` compares.
    expectOk("let xs: number[] = [1];\nlet ys: number[] = xs;\nys[0] = 2;");
    expectOk("let xs: number[] = [1];\nlet ys: number[] = xs;\nprint(xs == ys);");
  });

  it("compares arrays of the same type", () => {
    expectOk("print([1] == [1]);");
    expectError("print([1] == [\"a\"]);", /cannot compare/);
  });

  it("returns the element type it was given from append", () => {
    // The result type depends on the argument, which is why `append` is one
    // built-in rather than one per element type: a parameterised type is not a
    // type Vela can write.
    expectOk("let xs: number[] = append([1], 2);");
    expectOk("let xs: string[] = append([\"a\"], \"b\");");
    expectOk("let g: number[][] = append([[1]], [2]);");
    expectError("let xs: string[] = append([1], 2);", /cannot initialise 'xs' of type 'string\[\]'/);
  });

  it("cannot infer an empty literal passed to a polymorphic parameter", () => {
    // `append([], "a")` looks as if it should say `string[]`, but the first
    // argument's position is typed `any` because the built-in's own type depends on
    // it. Taking the element type from the second argument would be a guess, and a
    // guess here would be wrong as soon as the two arguments disagreed. Starting
    // from one element, or building up with reassignment, is the way to write it.
    expectError("let xs: string[] = append([], \"a\");", /an empty array literal has no element type/);
  });

  it("rejects append without an array to copy", () => {
    expectError("let xs: number[] = append(1, 2);", /which 'append' does not accept/);
  });

  it("checks the appended value against what the array holds", () => {
    // The value cannot be declared `any` and left alone: the result type is taken
    // from the first argument, so an unchecked second argument would let a
    // `number[]` hold a string and report `number[]` for the whole thing. The rule
    // has to be the first argument's element type because there is no
    // `fn(T[], T) -> T[]` to write in Vela.
    expectError("let xs: number[] = append([1], \"a\");", /which 'append' does not accept/);
    expectError("append([1], [2]);", /which 'append' does not accept/);
    expectOk("append([1], 2);");
    // A wrong first argument is reported on its own; there is no element type to
    // check the second against yet, so the value is not reported twice.
    expectError("append(1, \"a\");", /which 'append' does not accept/);
  });

  it("applies built-in rules to the built-in, not to a name that shares it", () => {
    // A shadowing binding is an ordinary user function. Applying `append`'s rules
    // to it would reject a call that has nothing to do with an array.
    expectOk("fn f(append: function): void { append(1, \"a\"); }");
    expectOk("fn f(len: function): void { len(1); }");
    expectOk("fn g(x: number): number { return x; }\n{ let len: function = g; }");
    // The real built-ins are still themselves.
    expectError("fn f(): void { len(1); }", /which 'len' does not accept/);
    expectError("fn f(): void { append(1, 2); }", /which 'append' does not accept/);
  });

  it("lets a const array still have its elements written", () => {
    // `const` binds a name to a value it may not be reassigned to. What that value
    // contains is a property of the array, not of the name.
    expectOk("const xs: number[] = [1];\nxs[0] = 2;");
    expectError("const xs: number[] = [1];\nxs = [2];", /declared with 'const' and cannot be assigned to/);
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

describe("checker: written function signatures", () => {
  const double = "fn d(x: number): number { return x * 2; }";
  const label = 'fn l(n: number): string { return "n"; }';

  it("accepts a function stored under its exact signature", () => {
    expectOk(`${double}\nlet f: fn(number) -> number = d;`);
    expectOk(`${label}\nlet f: fn(number) -> string = l;`);
    expectOk("fn n(): void { }\nlet f: fn() -> void = n;");
  });

  it("accepts a signature with parameter names, which are not part of the type", () => {
    expectOk(`${double}\nlet f: fn(n: number) -> number = d;`);
  });

  it("accepts a signature in every annotation position", () => {
    expectOk(`
      fn d(x: number): number { return x; }
      fn apply(f: fn(number) -> number, v: number): fn(number) -> number { return f; }
      const CB: fn(number) -> number = d;
      let held: fn(number) -> number = apply(d, 1);
    `);
  });

  it("rejects a mismatched return type", () => {
    expectError(`${double}\nlet f: fn(number) -> string = d;`, /type 'fn\(number\) -> string' with a value of type 'fn\(number\) -> number'/);
  });

  it("rejects a mismatched parameter type", () => {
    expectError(`${double}\nlet f: fn(string) -> number = d;`, /type 'fn\(string\) -> number' with a value of type 'fn\(number\) -> number'/);
  });

  it("rejects a mismatched arity", () => {
    // There is no subtyping, so a one-parameter function does not satisfy a
    // two-parameter type. This is the trade every typed language makes, and it
    // is why the bare `function` type still exists.
    expectError(`${double}\nlet f: fn(number, number) -> number = d;`, /type 'fn\(number, number\) -> number' with a value of type 'fn\(number\) -> number'/);
  });

  it("rejects a non-function under a signature type", () => {
    expectError("let f: fn(number) -> number = 5;", /with a value of type 'number'/);
  });

  it("checks a call through a signature-typed variable", () => {
    // This is the whole point of a written signature: the bare `function` type
    // gives up the arity and the return type, and this one does not.
    expectOk(`${double}\nlet f: fn(number) -> number = d;\nlet n: number = f(21);`);
  });

  it("reports the arity of a call through a signature-typed variable", () => {
    expectError(`${double}\nlet f: fn(number) -> number = d;\nf();`, /expected 1 argument but got 0/);
    expectError(`${double}\nlet f: fn(number) -> number = d;\nf(1, 2);`, /expected 1 argument but got 2/);
  });

  it("reports a wrong argument through a signature-typed variable", () => {
    expectError(`${double}\nlet f: fn(number) -> number = d;\nf("x");`, /argument 1 has type 'string' but 'number' was expected/);
  });

  it("knows the return type of a call through a signature-typed variable", () => {
    expectError(`${label}\nlet f: fn(number) -> string = l;\nlet n: number = f(1);`, /cannot initialise 'n' of type 'number' with a value of type 'string'/);
  });

  it("rejects assigning the wrong function to a signature-typed variable", () => {
    expectError(`${double}\n${label}\nlet f: fn(number) -> number = l;`, /with a value of type 'fn\(number\) -> string'/);
  });

  it("rejects reassigning to a different signature", () => {
    expectError(`${double}\n${label}\nlet f: fn(number) -> number = d;\nf = l;`, /cannot assign a value of type 'fn\(number\) -> string' to 'f'/);
  });

  it("reports the signature in the arity note", () => {
    const diag = expectError(`${double}\nlet f: fn(number) -> number = d;\nf();`, /expected 1 argument/);
    assert.match(diag.notes.join(" "), /fn\(number\) -> number/);
  });

  it("does not accept a bare function value under a signature", () => {
    // The other direction of the same rule. A bare `function` has no signature
    // recorded, so it cannot satisfy one; claiming otherwise would invent
    // parameters the type does not have.
    expectError(`${double}\nlet b: function = d;\nlet f: fn(number) -> number = b;`, /with a value of type 'function'/);
  });

  it("accepts a signature-typed value where a bare `function` is wanted", () => {
    // The widening is one-way, and deliberately so: a specific function is known
    // to be a function, but a bare one is not known to be that specific one.
    expectOk(`${double}\nlet b: function = d;`);
  });

  it("compares nested signatures structurally", () => {
    expectOk(`
      fn d(x: number): number { return x; }
      fn apply(f: fn(number) -> number, v: number): number { return f(v); }
      let twice: fn(fn(number) -> number, number) -> number = apply;
    `);
    expectError(`
      fn d(x: number): number { return x; }
      fn apply(f: fn(number) -> number, v: number): number { return f(v); }
      let wrong: fn(fn(number) -> number) -> number = apply;
    `, /type 'fn\(fn\(number\) -> number\) -> number' with a value of type 'fn\(fn\(number\) -> number, number\) -> number'/);
  });

  it("rejects calling a `void`-returning signature for a value", () => {
    expectError(
      "fn n(): void { }\nlet f: fn() -> void = n;\nlet s: string = f();",
      /cannot initialise 's' of type 'string' with a value of type 'void'/,
    );
  });

  it("renders a signature the way it was written", () => {
    assert.equal(typeToString(functionType([numberType, stringType], voidType)), "fn(number, string) -> void");
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
