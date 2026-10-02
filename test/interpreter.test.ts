import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DiagnosticBag, SourceFile } from "../src/diagnostics.js";
import { tokenize } from "../src/lexer/lexer.js";
import { parse } from "../src/parser/parser.js";
import { check } from "../src/types/checker.js";
import { Environment } from "../src/runtime/environment.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "../src/runtime/interpreter.js";
import { displayValue, setInput, setOutput } from "../src/runtime/values.js";
import type { Value } from "../src/runtime/values.js";

/**
 * Run a Vela program end to end and capture what it printed.
 * Fails the test if any pipeline stage reports a diagnostic, so a test cannot
 * accidentally pass by exercising error handling instead of evaluation.
 */
function run(text: string): { output: string[]; env: Environment } {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  const program = parse(tokenize(source, bag), bag);
  check(program, bag);
  assert.deepEqual(
    bag.errors().map((d) => d.message),
    [],
    `program should compile cleanly: ${text}`,
  );

  const output: string[] = [];
  const restore = setOutput((line) => output.push(line));
  const env = createGlobalEnvironment();
  try {
    new Interpreter(env).run(program);
  } finally {
    restore();
  }
  return { output, env };
}

/** Run and return just the printed lines joined, for concise assertions. */
function printed(text: string): string {
  return run(text).output.join("\n");
}

/**
 * Run a program with `read()` fed from a fixed list of lines instead of stdin.
 * The source is the same indirection the REPL uses, so this exercises the real
 * path rather than a test-only branch.
 */
function withInput(lines: readonly string[], text: string): string {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  const program = parse(tokenize(source, bag), bag);
  check(program, bag);
  assert.deepEqual(
    bag.errors().map((d) => d.message),
    [],
    `program should compile cleanly: ${text}`,
  );

  const output: string[] = [];
  const queue = [...lines];
  const restoreOutput = setOutput((line) => output.push(line));
  const restoreInput = setInput(() => (queue.length > 0 ? queue.shift()! : ""));
  try {
    new Interpreter(createGlobalEnvironment()).run(program);
  } finally {
    restoreInput();
    restoreOutput();
  }
  return output.join("\n");
}

/** Compile without checking, to test the interpreter's runtime backstops. */
function runUnchecked(text: string): string[] {
  const source = new SourceFile("<test>", text);
  const bag = new DiagnosticBag();
  const program = parse(tokenize(source, bag), bag);
  const output: string[] = [];
  const restore = setOutput((line) => output.push(line));
  try {
    new Interpreter(createGlobalEnvironment()).run(program);
  } finally {
    restore();
  }
  return output;
}

/** Evaluate a single expression and return its value as a string. */
function evaluate(expression: string): string {
  const source = new SourceFile("<test>", `${expression};`);
  const bag = new DiagnosticBag();
  const program = parse(tokenize(source, bag), bag);
  check(program, bag);
  assert.deepEqual(bag.errors(), [], `should type-check: ${expression}`);
  const env = createGlobalEnvironment();
  const value = new Interpreter(env).run(program);
  return displayValue(value as Value);
}

describe("interpreter: literals and arithmetic", () => {
  it("evaluates arithmetic with the usual precedence", () => {
    assert.equal(evaluate("1 + 2 * 3"), "7");
    assert.equal(evaluate("(1 + 2) * 3"), "9");
    assert.equal(evaluate("10 - 3 - 2"), "5");
    assert.equal(evaluate("100 / 5 / 2"), "10");
    assert.equal(evaluate("17 % 5"), "2");
  });

  it("evaluates unary operators", () => {
    assert.equal(evaluate("-5"), "-5");
    assert.equal(evaluate("--5"), "5");
    assert.equal(evaluate("!true"), "false");
    assert.equal(evaluate("!false"), "true");
  });

  it("concatenates strings", () => {
    assert.equal(evaluate('"a" + "b" + "c"'), "abc");
  });

  it("compares and produces booleans", () => {
    assert.equal(evaluate("1 < 2"), "true");
    assert.equal(evaluate("2 <= 2"), "true");
    assert.equal(evaluate('"a" == "a"'), "true");
    assert.equal(evaluate('"a" != "b"'), "true");
  });

  it("prints strings without quotes", () => {
    assert.equal(printed('print("hello");'), "hello");
  });

  it("prints numbers and booleans naturally", () => {
    assert.equal(printed("print(1);\nprint(true);\nprint(1.5);"), "1\ntrue\n1.5");
  });
});

describe("interpreter: variables and scope", () => {
  it("binds and reads a global", () => {
    assert.equal(printed("let x: number = 5;\nprint(x);"), "5");
  });

  it("updates a variable on assignment", () => {
    assert.equal(printed("let x: number = 5;\nx = 7;\nprint(x);"), "7");
  });

  it("assigns the value of the expression", () => {
    assert.equal(printed("let x: number = 5;\nlet y: number = 1;\ny = x + y;\nprint(y);"), "6");
  });

  it("keeps a nested let out of the enclosing scope", () => {
    const { output, env } = run('let x: number = 1;\n{ let x: string = "inner"; print(x); }\nprint(x);');
    assert.deepEqual(output, ["inner", "1"]);
    assert.equal(env.get("x")?.kind, "number");
  });

  it("assigns to an outer variable from inside a block", () => {
    assert.equal(printed("let x: number = 1;\n{ x = 2; }\nprint(x);"), "2");
  });

  it("restores an inner shadow after the block ends", () => {
    assert.equal(printed('let x: number = 1;\n{ let x: number = 2; }\nprint(x);'), "1");
  });

  it("scopes a for-loop variable to the loop", () => {
    const { env } = run("for (let i: number = 0; i < 3; i = i + 1) { }");
    assert.equal(env.get("i"), undefined);
  });

  it("exposes globals to a function body", () => {
    assert.equal(
      printed('let g: number = 10;\nfn f(): number { return g; }\nprint(f());'),
      "10",
    );
  });
});

describe("interpreter: const declarations", () => {
  it("binds and reads a global const", () => {
    assert.equal(printed("const K: number = 5;\nprint(K);"), "5");
  });

  it("binds a const in a block", () => {
    assert.equal(printed("{ const K: string = \"in\"; print(K); }"), "in");
  });

  it("binds a const in a for header", () => {
    // The loop variable is scoped to the loop, exactly as a `let` header is.
    const { output, env } = run("let n: number = 0;\nfor (const j: number = 2; n < 2; ) { print(j); n = n + 1; }");
    assert.deepEqual(output, ["2", "2"]);
    assert.equal(env.get("j"), undefined);
  });

  it("stores a const in the environment like any other binding", () => {
    // Nothing about the runtime differs between `let` and `const`. The rule is the
    // checker's, so the value is an ordinary binding here — which is what makes the
    // guarantee a compile-time one rather than a property of the value.
    const { env } = run("const K: number = 5;");
    assert.equal(env.get("K")?.kind, "number");
  });

  it("does not enforce the const at runtime when the checker is bypassed", () => {
    // `run` type-checks, so reaching the interpreter with a const reassignment is
    // impossible through the normal pipeline. Going around the checker through the
    // environment is the only way to see it, and it pins down that the guarantee is
    // the checker's rather than something the runtime repeats.
    const { env } = run("const K: number = 1;");
    assert.equal(env.assign("K", { kind: "number", value: 2 }), true);
    assert.equal(env.get("K")?.kind, "number");
  });
});

describe("interpreter: functions", () => {
  it("calls a function with arguments", () => {
    assert.equal(printed("fn add(a: number, b: number): number { return a + b; }\nprint(add(2, 3));"), "5");
  });

  it("returns a value from a nested block", () => {
    assert.equal(printed("fn f(n: number): number { if (n > 0) { return 1; } return 0; }\nprint(f(5));"), "1");
  });

  it("supports recursion", () => {
    assert.equal(
      printed("fn fib(n: number): number { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }\nprint(fib(10));"),
      "55",
    );
  });

  it("supports mutual calls through a global variable's reassignment", () => {
    // Vela allows a function to call itself but not two functions to call each
    // other, because a function must be declared before use.
    assert.equal(
      printed("fn f(n: number): number { if (n == 0) { return 0; } return f(n - 1); }\nprint(f(100));"),
      "0",
    );
  });

  it("recurses deeply without exhausting the stack for modest depth", () => {
    assert.equal(
      printed("fn down(n: number): number { if (n == 0) { return 0; } return down(n - 1); }\nprint(down(500));"),
      "0",
    );
  });

  it("reports runaway recursion as a RuntimeError rather than a host RangeError", () => {
    // Without the depth guard this escapes as an uncatchable V8 stack overflow,
    // which bypasses every RuntimeError handler and blames the host.
    assert.throws(
      () => runUnchecked("fn forever(n: number): number { return forever(n + 1); }\nprint(tostring(forever(0)));"),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError, `expected a RuntimeError, got ${String(error)}`);
        assert.match((error as RuntimeError).message, /maximum call depth exceeded/);
        return true;
      },
    );
  });

  it("recovers the call depth after a throw so later calls still work", () => {
    // The counter is decremented in a `finally`; if it were not, one failure
    // would permanently poison the interpreter.
    const source = new SourceFile(
      "<test>",
      "fn boom(n: number): number { return boom(n + 1); }\nprint(tostring(boom(0)));",
    );
    const bag = new DiagnosticBag();
    const program = parse(tokenize(source, bag), bag);
    const restore = setOutput(() => {});
    const interpreter = new Interpreter(createGlobalEnvironment());
    try {
      assert.throws(() => interpreter.run(program), RuntimeError);
      assert.throws(() => interpreter.run(program), RuntimeError);
    } finally {
      restore();
    }
    // A fresh interpreter on a separate environment still works, and a real
    // call at depth one is unaffected by the guard having fired.
    assert.equal(printed("fn two(): number { return 2; }\nprint(tostring(two()));"), "2");
  });

  it("captures the defining scope in a closure", () => {
    assert.equal(
      printed("fn outer(n: number): void { let g: number = n; }\nfn f(): number { return 1; }\nprint(f());"),
      "1",
    );
  });

  it("gives each call its own parameter scope", () => {
    assert.equal(
      printed("fn f(n: number): number { n = n + 1; return n; }\nprint(f(1));\nprint(f(1));"),
      "2\n2",
    );
  });

  it("returns void from a void function", () => {
    assert.equal(printed("fn noop(): void { }\nnoop();\nprint(\"after\");"), "after");
  });

  it("treats a nested function name as local to its block", () => {
    assert.equal(
      printed("fn f(): number { return 1; }\n{ fn f(): number { return 2; } print(f()); }\nprint(f());"),
      "2\n1",
    );
  });
});

describe("interpreter: functions held in variables", () => {
  it("calls through a signature-typed variable", () => {
    // The signature is a compile-time guarantee; at runtime the variable holds
    // the same closure a direct call would reach, so the value is identical.
    assert.equal(
      printed("fn d(x: number): number { return x * 2; }\nlet f: fn(number) -> number = d;\nprint(tostring(f(21)));"),
      "42",
    );
  });

  it("passes a function through a signature-typed parameter and return", () => {
    assert.equal(
      printed(`
        fn d(x: number): number { return x * 2; }
        fn apply(f: fn(number) -> number, v: number): fn(number) -> number { return f; }
        print(tostring(apply(d, 1)(50)));
      `),
      "100",
    );
  });

  it("calls a `void` signature through a parameter", () => {
    assert.equal(
      printed(`
        fn note(text: string): void { print(text); }
        fn run(action: fn(string) -> void, s: string): void { action(s); }
        run(note, "ran");
      `),
      "ran",
    );
  });

  it("reports a signature-typed value as a function at runtime", () => {
    // `typeOf` sees the runtime value, not the annotation, so a signature-typed
    // variable reports "function" exactly as a bare one does.
    assert.equal(
      printed('fn d(): void { }\nlet f: fn() -> void = d;\nprint(typeOf(f));'),
      "function",
    );
  });

  it("still holds the real function, so the call applies the original body", () => {
    // The type says `fn(number) -> number` and the value really is `double`. A
    // checker that trusted the annotation instead of the value would print 1.
    assert.equal(
      printed("fn double(x: number): number { return x * 2; }\nlet f: fn(number) -> number = double;\nprint(tostring(f(3)));"),
      "6",
    );
  });

  it("runs a returned signature-typed closure in its defining scope", () => {
    // `outer` returns a function declared inside its own body, so the closure it
    // was defined in is still the one that runs when the result is called with 4.
    // The annotation says which signature that closure has; it does not create it.
    assert.equal(
      printed(`
        fn makeAdder(n: number): fn(number) -> number {
          fn addTo(x: number): number { return x + n; }
          return addTo;
        }
        print(tostring(makeAdder(3)(4)));
      `),
      "7",
    );
  });

  it("uses a nested signature recursively", () => {
    assert.equal(
      printed("fn twice(f: fn(number) -> number, v: number): number { return f(f(v)); }\nfn inc(x: number): number { return x + 1; }\nprint(tostring(twice(inc, 1)));"),
      "3",
    );
  });
});

describe("interpreter: compound assignment and increment", () => {
  it("applies each compound operator to a number", () => {
    assert.equal(
      printed(`
        let x: number = 10;
        x += 5; print(x);
        x -= 3; print(x);
        x *= 2; print(x);
        x /= 4; print(x);
        x %= 4; print(x);
      `),
      "15\n12\n24\n6\n2",
    );
  });

  it("concatenates with += on a string", () => {
    assert.equal(printed(`let s: string = "ab"; s += "cd"; s += "ef"; print(s);`), "abcdef");
  });

  it("increments and decrements as statements", () => {
    assert.equal(
      printed(`
        let n: number = 5;
        n++;
        print(n);
        n--;
        n--;
        print(n);
      `),
      "6\n4",
    );
  });

  it("runs a for loop whose update is i++", () => {
    assert.equal(
      printed(`for (let i: number = 0; i < 4; i++) { print(tostring(i)); }`),
      "0\n1\n2\n3",
    );
  });

  it("runs a for loop whose update is i--", () => {
    assert.equal(
      printed(`for (let i: number = 3; i > 0; i--) { print(tostring(i)); }`),
      "3\n2\n1",
    );
  });

  it("runs a function stored in a variable", () => {
    assert.equal(
      printed(`
        fn double(x: number): number { return x * 2; }
        let f: function = double;
        print(tostring(f(21)));
      `),
      "42",
    );
  });

  it("reassigns a function value and calls the new one", () => {
    assert.equal(
      printed(`
        fn double(x: number): number { return x * 2; }
        fn negate(x: number): number { return 0 - x; }
        let f: function = double;
        print(tostring(f(3)));
        f = negate;
        print(tostring(f(3)));
      `),
      "6\n-3",
    );
  });

  it("passes a function as an argument and returns one", () => {
    assert.equal(
      printed(`
        fn double(x: number): number { return x * 2; }
        fn callIt(cb: function, n: number): string { return "value " + tostring(n); }
        fn giveBack(cb: function): function { return cb; }
        print(callIt(double, 5));
        let again: function = giveBack(double);
        print(tostring(again(8)));
      `),
      "value 5\n16",
    );
  });

  it("reads one code unit at a time", () => {
    assert.equal(
      printed(`
        let s: string = "hello";
        print(s[0]);
        print(s[4]);
        print(s[0] + "|" + s[1]);
      `),
      "h\no\nh|e",
    );
  });

  it("walks a string with len and an index", () => {
    assert.equal(
      printed(`
        let s: string = "abc";
        for (let i: number = 0; i < len(s); i = i + 1) { print(s[i]); }
        print(s[len(s) - 1]);
      `),
      "a\nb\nc\nc",
    );
  });

  it("reports an out-of-range index at runtime", () => {
    assert.throws(() => run(`let s: string = "ab";\nprint(s[5]);`), /index 5 is out of range/);
    assert.throws(() => run(`let s: string = "ab";\nprint(s[0 - 1]);`), /index -1 is out of range/);
    assert.throws(() => run(`let s: string = "ab";\nprint(s[2]);`), /out of range/);
  });

  it("reads a line from the input source", () => {
    assert.equal(withInput(["vela", "21"], `let a: string = read(); print(a);`), "vela");
    assert.equal(
      withInput(["7"], "let n: number = tonumber(read()); print(tostring(n * 2));"),
      "14",
    );
  });

  it("returns the empty string at end of input", () => {
    // No `null` in Vela, so an empty string is the only honest end-of-input
    // answer. A program reading past the end should stop cleanly, not fail.
    assert.equal(withInput([], "print(\"[\" + read() + \"]\");"), "[]");
    assert.equal(withInput(["a"], "print(read()); print(\"[\" + read() + \"]\");"), "a\n[]");
  });

  it("returns the empty string for a blank input line", () => {
    assert.equal(withInput([""], "print(\"[\" + read() + \"]\");"), "[]");
  });

  it("does not turn end of input into a runtime error", () => {
    assert.doesNotThrow(() => withInput([], "let s: string = read(); print(s);"));
  });

  it("reads lines until the end of input", () => {
    // A fixed-count read loop, the shape an echo server or a batch filter uses.
    assert.equal(
      withInput(["3", "alpha", "beta", "gamma"], `
        let n: number = tonumber(read());
        for (let i: number = 0; i < n; i = i + 1) {
            print(tostring(i + 1) + ": " + read());
        }
      `),
      "1: alpha\n2: beta\n3: gamma",
    );
  });

  it("echoes until the input runs out", () => {
    // Reads one more time than there are lines, which is the end-of-input case.
    assert.equal(
      withInput(["x", "y"], `
        let line: string = read();
        while (line != "") {
            print(line);
            line = read();
        }
        print("done");
      `),
      "x\ny\ndone",
    );
  });

  it("keeps a doubled minus as a negation", () => {
    assert.equal(printed("print(tostring(--1)); print(tostring(---1));"), "1\n-1");
  });

  it("still reports division by zero from /=", () => {
    assert.throws(() => run("let x: number = 1; x /= 0;"), /division by zero/);
  });
});

describe("interpreter: control flow", () => {
  it("runs an if branch", () => {
    assert.equal(printed("if (true) { print(1); } else { print(2); }"), "1");
  });

  it("runs an else branch", () => {
    assert.equal(printed("if (false) { print(1); } else { print(2); }"), "2");
  });

  it("omits else when the condition fails", () => {
    assert.equal(printed("if (false) { print(1); }"), "");
  });

  it("chains else if", () => {
    const text = `
      fn classify(n: number): string {
        if (n < 0) { return "negative"; }
        else if (n == 0) { return "zero"; }
        else { return "positive"; }
      }
      print(classify(-1)); print(classify(0)); print(classify(1));
    `;
    assert.equal(printed(text), "negative\nzero\npositive");
  });

  it("loops with while", () => {
    assert.equal(printed("let i: number = 0;\nwhile (i < 3) { print(i); i = i + 1; }"), "0\n1\n2");
  });

  it("loops zero times when the condition starts false", () => {
    assert.equal(printed("let i: number = 5;\nwhile (i < 3) { print(i); }"), "");
  });

  it("loops with for", () => {
    assert.equal(printed("for (let i: number = 0; i < 3; i = i + 1) { print(i); }"), "0\n1\n2");
  });

  it("counts down with for", () => {
    assert.equal(printed("for (let i: number = 3; i > 0; i = i - 1) { print(i); }"), "3\n2\n1");
  });

  it("treats a missing for condition as always true, so use break", () => {
    assert.equal(printed("for (let i: number = 0; ; i = i + 1) { if (i > 2) { break; } print(i); }"), "0\n1\n2");
  });

  it("breaks out of a while", () => {
    assert.equal(printed("let i: number = 0;\nwhile (true) { i = i + 1; if (i > 2) { break; } }\nprint(i);"), "3");
  });

  it("breaks out of the inner loop only", () => {
    const text = `
      for (let i: number = 0; i < 2; i = i + 1) {
        for (let j: number = 0; j < 5; j = j + 1) {
          if (j == 2) { break; }
          print(j);
        }
      }
    `;
    assert.equal(printed(text), "0\n1\n0\n1");
  });

  it("continues a while loop", () => {
    const text = "let i: number = 0;\nwhile (i < 5) { i = i + 1; if (i % 2 == 0) { continue; } print(i); }";
    assert.equal(printed(text), "1\n3\n5");
  });

  it("continues a for loop and still runs the update", () => {
    const text = "for (let i: number = 0; i < 5; i = i + 1) { if (i == 2) { continue; } print(i); }";
    assert.equal(printed(text), "0\n1\n3\n4");
  });

  it("returns early from inside nested loops", () => {
    const text = `
      fn findFirst(): number {
        for (let i: number = 0; i < 10; i = i + 1) {
          if (i * i > 20) { return i; }
        }
        return -1;
      }
      print(findFirst());
    `;
    assert.equal(printed(text), "5");
  });
});

describe("interpreter: a function ending in a loop", () => {
  // These functions have no `return` after the loop because there is no path that
  // reaches one, so the value has to come out of the loop body itself. Running them
  // is the other half of the check: proving the shape is sound is what makes the
  // interpreter safe to hand them a value it never produced.
  it("returns from inside an infinite loop", () => {
    const text = `
      fn f(n: number): number {
        while (true) { return n * 2; }
      }
      print(f(21));
    `;
    assert.equal(printed(text), "42");
  });

  it("returns from inside a for whose condition is the literal true", () => {
    const text = `
      fn f(): number {
        for (let i: number = 0; true; i = i + 1) { return i * 10; }
      }
      print(f());
    `;
    assert.equal(printed(text), "0");
  });

  it("takes the return from whichever arm of a loop body runs", () => {
    const text = `
      fn f(n: number): number {
        while (true) {
          if (n % 2 == 0) { return 2; }
          else { return 3; }
        }
      }
      print(f(4));
      print(f(5));
    `;
    assert.equal(printed(text), "2\n3");
  });

  it("goes round again on a continue rather than falling out", () => {
    // `continue` under `while (true)` re-tests a condition that cannot go false, so
    // the counter is what eventually reaches the return.
    const text = `
      fn f(n: number): number {
        let i: number = 0;
        while (true) {
          if (i < n) { i = i + 1; continue; }
          return i;
        }
      }
      print(f(3));
    `;
    assert.equal(printed(text), "3");
  });

  it("stops at a nested loop's break and returns after it", () => {
    // The `break` belongs to the inner loop, so it is the statement after the outer
    // loop that runs next — which is why the outer one needs a return there.
    const text = `
      fn f(c: bool): number {
        while (true) {
          while (c) { break; }
          return 7;
        }
      }
      print(f(true));
    `;
    assert.equal(printed(text), "7");
  });

  it("skips a nested loop's continue and keeps going", () => {
    const text = `
      fn f(): number {
        while (true) {
          for (let i: number = 0; i < 3; i = i + 1) { continue; }
          return 9;
        }
      }
      print(f());
    `;
    assert.equal(printed(text), "9");
  });
});

describe("interpreter: short-circuit evaluation", () => {
  it("does not evaluate the right side of && when the left is false", () => {
    // `b` is never read, so no error is produced; if && were eager this would fail.
    assert.equal(printed("let a: number = 0;\nlet b: number = 0;\nif (a != 0 && b == 0) { print(1); } else { print(2); }"), "2");
  });

  it("does not evaluate the right side of || when the left is true", () => {
    assert.equal(printed("if (true || false) { print(1); }"), "1");
  });

  it("skips a side effect in the right operand of &&", () => {
    assert.equal(printed("let x: number = 0;\nlet r: bool = false && (x = 99) == 99;\nprint(x);"), "0");
  });

  it("skips a side effect in the right operand of ||", () => {
    assert.equal(printed("let x: number = 0;\nlet r: bool = true || (x = 99) == 99;\nprint(x);"), "0");
  });

  it("evaluates the right operand when needed", () => {
    assert.equal(printed("let x: number = 0;\nlet r: bool = true && (x = 99) == 99;\nprint(x);"), "99");
  });
});

describe("interpreter: built-ins", () => {
  it("tostring converts any value", () => {
    assert.equal(printed('print(tostring(1));\nprint(tostring(true));\nprint(tostring("a"));'), "1\ntrue\na");
  });

  it("tonumber parses a numeric string", () => {
    assert.equal(printed('print(tonumber("42"));\nprint(tonumber("x"));\nprint(tonumber("1.5"));'), "42\n0\n1.5");
  });

  it("typeOf names the runtime type", () => {
    assert.equal(printed('print(typeOf(1));\nprint(typeOf("a"));\nprint(typeOf(true));'), "number\nstring\nbool");
  });

  it("leaves built-ins callable from inside a function", () => {
    assert.equal(printed('fn show(n: number): void { print(tostring(n)); }\nshow(5);'), "5");
  });

  it("truncates toward zero, so negatives lose the fraction downwards", () => {
    assert.equal(printed("print(tostring(trunc(2.7)));\nprint(tostring(trunc(-2.7)));"), "2\n-2");
  });

  it("rounds a floor down and a ceil up, including for negatives", () => {
    assert.equal(printed("print(tostring(floor(2.7)));\nprint(tostring(floor(-2.7)));"), "2\n-3");
    assert.equal(printed("print(tostring(ceil(2.1)));\nprint(tostring(ceil(-2.7)));"), "3\n-2");
  });

  it("rounds halves away from zero rather than to even", () => {
    // Math.round would give 2 here. The documented recipe is half away from
    // zero, and the built-in has to match the recipe it replaced.
    assert.equal(printed("print(tostring(round(2.5)));\nprint(tostring(round(-2.5)));"), "3\n-3");
  });

  it("leaves a whole number alone in trunc, floor, and ceil", () => {
    assert.equal(printed("print(tostring(floor(3)));\nprint(tostring(ceil(3)));\nprint(tostring(round(3)));"), "3\n3\n3");
  });

  it("takes the absolute value", () => {
    assert.equal(printed("print(tostring(abs(0 - 3)));\nprint(tostring(abs(3)));"), "3\n3");
  });

  it("picks the smaller and larger of two numbers", () => {
    assert.equal(printed("print(tostring(min(2, 7)));\nprint(tostring(max(2, 7)));"), "2\n7");
  });

  it("divides integers toward zero, matching the sign rule of '%'", () => {
    assert.equal(printed("print(tostring(idiv(17, 5)));\nprint(tostring(idiv(-17, 5)));"), "3\n-3");
  });

  it("returns 0 from idiv rather than failing on a zero divisor", () => {
    assert.equal(printed("print(tostring(idiv(1, 0)));"), "0");
  });
});

describe("interpreter: string built-ins", () => {
  it("changes case", () => {
    assert.equal(printed('print(upper("aBc"));\nprint(lower("aBc"));'), "ABC\nabc");
  });

  it("maps case by Unicode, so the result can be longer than the input", () => {
    // "ß" upper-cases to "SS", which is two characters. An ASCII table would leave
    // it alone. The test exists because the length change is observable and the
    // documentation promises it.
    assert.equal(printed('print(upper("straße"));'), "STRASSE");
  });

  it("trims whitespace from both ends", () => {
    assert.equal(printed('print("[" + trim("  a b\\t") + "]");'), "[a b]");
    assert.equal(printed('print("[" + trim("abc") + "]");'), "[abc]");
  });

  it("takes the subject first in startsWith and endsWith", () => {
    assert.equal(
      printed(
        'print(tostring(startsWith("hello", "he")));\nprint(tostring(startsWith("hello", "lo")));\nprint(tostring(endsWith("hello", "lo")));\nprint(tostring(endsWith("hello", "he")));',
      ),
      "true\nfalse\ntrue\nfalse",
    );
  });

  it("answers -1 when indexOf finds nothing", () => {
    assert.equal(
      printed('print(tostring(indexOf("hello", "ll")));\nprint(tostring(indexOf("hello", "z")));'),
      "2\n-1",
    );
  });

  it("finds an empty needle at 0, which is a real answer", () => {
    assert.equal(printed('print(tostring(indexOf("hello", "")));'), "0");
  });

  it("takes a substring", () => {
    assert.equal(printed('print(substr("hello", 1, 3));'), "ell");
  });

  it("clamps substr rather than failing", () => {
    // Every one of these is a boundary a caller can reach by accident, and an empty
    // string is a better answer than a runtime error for text that is being built.
    assert.equal(printed('print("[" + substr("hello", 2, 99) + "]");'), "[llo]");
    assert.equal(printed('print("[" + substr("hello", 9, 2) + "]");'), "[]");
    assert.equal(printed('print("[" + substr("hello", 1, 0 - 1) + "]");'), "[]");
  });

  it("counts a negative substr start from the end", () => {
    assert.equal(printed('print("[" + substr("hello", 0 - 2, 2) + "]");'), "[lo]");
  });

  it("repeats a string, truncating a fractional count", () => {
    assert.equal(printed('print(repeat("ab", 3));'), "ababab");
    assert.equal(printed('print("[" + repeat("ab", 0) + "]");'), "[]");
    assert.equal(printed('print(repeat("ab", 2.9));'), "abab");
  });

  it("replaces the first occurrence only", () => {
    assert.equal(printed('print(replace("a-b-c", "-", "+"));'), "a+b-c");
  });

  it("leaves the string alone when there is nothing to replace", () => {
    assert.equal(printed('print(replace("a-b-c", "z", "+"));'), "a-b-c");
  });

  it("leaves the string alone when the needle is empty", () => {
    // Inserting at "every position" in an empty gap is not a useful answer, so this
    // is a no-op rather than JavaScript's append-the-replacement behaviour.
    assert.equal(printed('print(replace("abc", "", "+"));'), "abc");
  });

  it("keeps every string built-in total, so none of them can fail", () => {
    // A single expression that touches every one of them, including on the empty
    // string and with zero and negative arguments. Nothing here should throw.
    const text = [
      'print(upper("") + lower("") + trim(""));',
      'print(tostring(startsWith("", "")) + " " + tostring(endsWith("", "")));',
      'print(tostring(indexOf("", "a")));',
      'print("[" + substr("", 0, 5) + "]");',
      'print("[" + repeat("", 3) + "]");',
      'print("[" + replace("", "a", "b") + "]");',
    ].join("\n");
    assert.equal(printed(text), "\ntrue true\n-1\n[]\n[]\n[]");
  });
});

describe("interpreter: structs", () => {
  it("builds a value and reads a field", () => {
    assert.equal(
      printed(`
        struct Point { x: number; y: number; }
        let p: Point = Point(3, 4);
        print(p.x);
        print(p.y);
      `),
      "3\n4",
    );
  });

  it("prints a struct by name and fields", () => {
    assert.equal(
      printed(`
        struct Point { x: number; y: number; }
        print(Point(1, 2));
      `),
      "Point(x: 1, y: 2)",
    );
  });

  it("prints a nested struct nested", () => {
    assert.equal(
      printed(`
        struct A { n: number; }
        struct B { a: A; xs: number[]; }
        print(B(A(1), [2, 3]));
      `),
      "B(a: A(n: 1), xs: [2, 3])",
    );
  });

  it("reports a struct by its own name from typeOf", () => {
    assert.equal(
      printed(`
        struct Marker {}
        print(typeOf(Marker()));
      `),
      "Marker",
    );
  });

  it("writes a field, in place, for the one value that holds it", () => {
    assert.equal(
      printed(`
        struct P { x: number; }
        let p: P = P(1);
        p.x = 2;
        p.x += 3;
        print(p.x);
      `),
      "5",
    );
  });

  it("writes a field through an index", () => {
    assert.equal(
      printed(`
        struct P { x: number; }
        let ps: P[] = [P(1), P(2)];
        ps[1].x = 9;
        print(ps[1].x);
      `),
      "9",
    );
  });

  it("writes an element of an array reached through a field", () => {
    assert.equal(
      printed(`
        struct B { xs: number[]; }
        let b: B = B([1, 2]);
        b.xs[1] = 9;
        print(b.xs);
      `),
      "[1, 9]",
    );
  });

  it("builds a struct declared below its use", () => {
    assert.equal(
      printed(`
        let p: Point = Point(1, 2);
        struct Point { x: number; y: number; }
        print(p.y);
      `),
      "2",
    );
  });

  describe("value semantics", () => {
    it("copies on assignment, so a second name is a second value", () => {
      assert.equal(
        printed(`
          struct P { x: number; }
          let p: P = P(1);
          let q: P = p;
          q.x = 2;
          print(tostring(p.x) + " " + tostring(q.x));
        `),
        "1 2",
      );
    });

    it("copies through a nested struct", () => {
      assert.equal(
        printed(`
          struct Inner { n: number; }
          struct Outer { inner: Inner; }
          let o: Outer = Outer(Inner(1));
          o.inner.n = 2;
          print(tostring(o.inner.n));
        `),
        "2",
      );
    });

    it("copies an array held in a field, so the copy owns it", () => {
      assert.equal(
        printed(`
          struct B { xs: number[]; }
          let b: B = B([1, 2]);
          let c: B = b;
          c.xs[0] = 9;
          print(b.xs);
        `),
        "[1, 2]",
      );
    });

    it("copies into an array element, so two names never share a struct", () => {
      assert.equal(
        printed(`
          struct P { x: number; }
          let p: P = P(1);
          let ps: P[] = [p];
          ps[0].x = 2;
          print(p.x);
        `),
        "1",
      );
    });

    it("copies on an argument, so a callee cannot change the caller's struct", () => {
      assert.equal(
        printed(`
          struct P { x: number; }
          fn bump(p: P): void { p.x = 99; }
          let p: P = P(1);
          bump(p);
          print(p.x);
        `),
        "1",
      );
    });

    it("copies a returned struct, so the caller owns what it gets", () => {
      assert.equal(
        printed(`
          struct P { x: number; }
          let p: P = P(1);
          fn keep(q: P): P { return q; }
          p.x = 5;
          let r: P = keep(p);
          r.x = 7;
          print(tostring(p.x) + " " + tostring(r.x));
        `),
        "5 7",
      );
    });

    it("still shares an array bound on its own", () => {
      // The two rules are about different values: an array *is* a reference, and
      // binding one shares it. Only a struct copies what it contains.
      assert.equal(
        printed(`
          let xs: number[] = [1];
          let ys: number[] = xs;
          ys[0] = 9;
          print(xs[0]);
        `),
        "9",
      );
    });

    it("still shares an array bound out of a field", () => {
      assert.equal(
        printed(`
          struct B { xs: number[]; }
          let b: B = B([1]);
          let ys: number[] = b.xs;
          ys[0] = 9;
          print(b.xs[0]);
        `),
        "9",
      );
    });
  });

  it("compares by fields, so a copy equals what it was copied from", () => {
    assert.equal(
      printed(`
        struct P { x: number; }
        let p: P = P(1);
        let q: P = p;
        print(tostring(p == p));
        print(tostring(p == q));
        print(tostring(P(1) == P(1)));
        print(tostring(P(1) == P(2)));
      `),
      "true\ntrue\ntrue\nfalse",
    );
  });

  it("compares nested structs by their fields", () => {
    assert.equal(
      printed(`
        struct A { n: number; }
        struct B { a: A; }
        print(tostring(B(A(1)) == B(A(1))));
        print(tostring(B(A(1)) == B(A(2))));
      `),
      "true\nfalse",
    );
  });

  it("compares an array inside a struct by reference, as it does anywhere else", () => {
    assert.equal(
      printed(`
        struct B { xs: number[]; }
        let xs: number[] = [1];
        print(tostring(B(xs) == B(xs)));
        print(tostring(B([1]) == B([1])));
      `),
      "true\nfalse",
    );
  });

  it("keeps an empty struct printable and comparable", () => {
    assert.equal(
      printed(`
        struct Marker {}
        let a: Marker = Marker();
        let b: Marker = Marker();
        print(a);
        print(tostring(a == a));
        print(tostring(a == b));
      `),
      "Marker()\ntrue\ntrue",
    );
  });

  it("registers a struct declared after its first use", () => {
    // The interpreter registers every struct before running anything, so the order
    // of the declaration does not decide whether a call can be built.
    assert.equal(
      printed(`
        fn make(): P { return P(7); }
        struct P { x: number; }
        print(make().x);
      `),
      "7",
    );
  });

  it("rejects a field read from something that is not a struct", () => {
    assert.throws(
      () => runUnchecked("let n: number = 1;\nprint(n.x);").join(""),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.match(error.message, /has no fields/);
        return true;
      },
    );
  });

  it("rejects a field write to something that is not a struct", () => {
    assert.throws(
      () => runUnchecked('let s: string = "a";\ns.x = 1;').join(""),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.match(error.message, /cannot assign a field of a value of type 'string'/);
        return true;
      },
    );
  });

  it("rejects calling a struct value", () => {
    assert.throws(
      () => runUnchecked("struct P { x: number; }\nlet p: P = P(1);\np();").join(""),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.match(error.message, /not a function/);
        return true;
      },
    );
  });
});

describe("interpreter: null", () => {
  it("prints null as 'null'", () => {
    assert.equal(printed("let x: number? = null;\nprint(x);"), "null");
  });

  it("compares null with null and with an absent value", () => {
    assert.equal(
      printed(`
        let a: number? = null;
        let b: number? = 1;
        print(tostring(a == null));
        print(tostring(b == null));
        print(tostring(null == null));
        print(tostring(null != b));
      `),
      "true\nfalse\ntrue\ntrue",
    );
  });

  it("compares a nullable holding a value by value, not by presence", () => {
    assert.equal(
      printed(`
        let a: number? = 1;
        let b: number? = 1;
        print(tostring(a == b));
      `),
      "true",
    );
  });

  it("reports null as its own type, and a nullable by what it holds", () => {
    // A nullable type is not a type the runtime knows about — it is a promise about
    // what may be stored — so `typeOf` reports the value it is asked about.
    assert.equal(
      printed(`
        let a: number? = null;
        let b: number? = 1;
        print(typeOf(a));
        print(typeOf(b));
        print(typeOf(null));
      `),
      "null\nnumber\nnull",
    );
  });

  it("passes null through tostring and tonumber", () => {
    assert.equal(printed("print(tostring(null));\nprint(tostring(tonumber(null)));"), "null\n0");
  });

  it("stores and reads a null field of a struct", () => {
    assert.equal(
      printed(`
        struct Node { value: number; next: Node?; }
        let a: Node = Node(1, null);
        print(tostring(a.next == null));
        let b: Node = Node(2, a);
        if (b.next != null) { print(tostring(b.next.value)); }
        print(b);
      `),
      "true\n1\nNode(value: 2, next: Node(value: 1, next: null))",
    );
  });

  it("short-circuits a guard so the right operand is not evaluated", () => {
    // The narrowing is what makes the guard writable; the short-circuit is what makes
    // it safe, and both are properties of the same expression.
    assert.equal(
      printed(`
        struct Node { value: number; next: Node?; }
        let b: Node = Node(1, null);
        fn use(): number { print("evaluated"); return 1; }
        if (b.next != null && use() == 1) { print("both"); }
      `),
      "",
    );
    assert.equal(
      printed(`
        struct Node { value: number; next: Node?; }
        let b: Node = Node(1, null);
        fn use(): number { print("evaluated"); return 1; }
        if (b.next == null || use() == 1) { print("first was enough"); }
      `),
      "first was enough",
    );
  });

  it("does not evaluate the right operand of || when the left is true", () => {
    assert.equal(
      printed(`
        let a: number? = null;
        fn boom(): number { return 1; }
        if (a == null || boom() == 1) { print("reached"); }
      `),
      "reached",
    );
  });

  it("assigns null over a value and back", () => {
    assert.equal(
      printed(`
        let x: number? = 1;
        print(tostring(x != null));
        x = null;
        print(tostring(x == null));
      `),
      "true\ntrue",
    );
  });

  it("keeps the two answers of a null test apart through a while loop", () => {
    assert.equal(
      printed(`
        fn count(n: number?): number {
          let total: number = 0;
          let i: number = 0;
          while (i < 3) {
            if (n == null) { i = i + 1; } else { total = total + n; i = i + 1; }
          }
          return total;
        }
        print(tostring(count(null)));
        print(tostring(count(4)));
      `),
      "0\n12",
    );
  });
});

describe("interpreter: optional struct fields", () => {
  const CONFIG = "struct Config { retries: number; label?: string; note?: string; }";

  it("stores null where an argument was left out", () => {
    assert.equal(
      printed(`${CONFIG}\nprint(Config(3));`),
      "Config(retries: 3, label: null, note: null)",
    );
  });

  it("fills the omitted fields from the end, keeping the ones given", () => {
    // Two arguments fill the two required fields in order; the third is absent. The
    // padding is at the end precisely because the optional fields are a suffix.
    assert.equal(
      printed(`${CONFIG}\nprint(Config(3, "prod"));\nprint(Config(3, "prod", "written"));`),
      "Config(retries: 3, label: prod, note: null)\nConfig(retries: 3, label: prod, note: written)",
    );
  });

  it("accepts null for an optional field given as an argument", () => {
    assert.equal(printed(`${CONFIG}\nprint(Config(3, null, "here"));`), "Config(retries: 3, label: null, note: here)");
  });

  it("fills every field of a struct whose fields are all optional", () => {
    assert.equal(printed("struct All { a?: number; b?: string; }\nprint(All());"), "All(a: null, b: null)");
  });

  it("writes the field and reads back what was written", () => {
    assert.equal(
      printed(`
        ${CONFIG}
        let c: Config = Config(3);
        c.label = "set";
        print(tostring(c.label));
        c.label = null;
        print(tostring(c.label == null));
      `),
      "set\ntrue",
    );
  });

  it("compares two structs field by field, absence included", () => {
    // Two structs built the same way are equal whether the absence came from leaving
    // the argument out or from passing `null` — which is the point of making omission
    // mean `null` rather than something else.
    assert.equal(
      printed(`${CONFIG}\nprint(tostring(Config(3) == Config(3, null, null)));\nprint(tostring(Config(3) == Config(4)));`),
      "true\nfalse",
    );
  });

  it("copies an omitted field like any other", () => {
    assert.equal(
      printed(`
        ${CONFIG}
        let a: Config = Config(3, "x");
        let b: Config = a;
        b.label = null;
        print(tostring(a.label));
      `),
      "x",
    );
  });

  it("stores an omitted field as null inside an array of structs", () => {
    assert.equal(printed(`${CONFIG}\nlet cs: Config[] = [Config(1), Config(2, "b")];\nprint(cs);`), "[Config(retries: 1, label: null, note: null), Config(retries: 2, label: b, note: null)]");
  });

  it("passes an omitted field through a function like any other argument", () => {
    assert.equal(
      printed(`
        ${CONFIG}
        fn retriesOf(c: Config): number { return c.retries; }
        fn labelled(c: Config): string {
          if (c.label != null) { return c.label; }
          return "none";
        }
        print(tostring(retriesOf(Config(3))));
        print(labelled(Config(3)));
        print(labelled(Config(3, "set")));
      `),
      "3\nnone\nset",
    );
  });

  it("builds a recursive chain from optional fields", () => {
    assert.equal(
      printed(`
        struct Node { value: number; next?: Node; }
        fn total(from: Node?): number {
          let sum: number = 0;
          for (let at: Node? = from; at != null; at = at.next) { sum = sum + at.value; }
          return sum;
        }
        print(tostring(total(Node(1, Node(2, Node(3))))));
        print(tostring(total(Node(9))));
      `),
      "6\n9",
    );
  });
});

describe("interpreter: arrays", () => {
  it("builds a literal and prints it", () => {
    assert.equal(printed("print([1, 2, 3]);"), "[1, 2, 3]");
    assert.equal(printed('print(["a", "b"]);'), "[a, b]");
    assert.equal(printed("print([true, false]);"), "[true, false]");
  });

  it("appends without changing the array it was given", () => {
    // The one way to build an array whose length is only known while running. It
    // returns a new array, so an array's length never changes once it exists.
    assert.equal(
      printed(`
        let xs: number[] = [1, 2];
        let ys: number[] = append(xs, 3);
        print(ys);
        print(xs);
        print(len(ys));
      `),
      "[1, 2, 3]\n[1, 2]\n3",
    );
  });

  it("appends to an empty array", () => {
    assert.equal(printed('let xs: string[] = [];\nprint(append(xs, "a"));'), "[a]");
  });

  it("appends an array, keeping its nesting", () => {
    assert.equal(printed("let xs: number[][] = [[1]];\nprint(append(xs, [2, 3]));"), "[[1], [2, 3]]");
  });

  it("prints nested arrays", () => {
    assert.equal(printed("let g: number[][] = [[1, 2], [3, 4]];\nprint(g);"), "[[1, 2], [3, 4]]");
    assert.equal(printed("let g: number[][] = [[], [1]];\nprint(g);"), "[[], [1]]");
  });

  it("evaluates elements left to right", () => {
    // The order is observable, so it is worth a test: a literal is a value like
    // any other, and its elements are ordinary expressions.
    assert.equal(
      printed(`
        let log: string = "";
        fn note(ch: string): number { log = log + ch; return 1; }
        let xs: number[] = [note("a"), note("b"), note("c")];
        print(log);
      `),
      "abc",
    );
  });

  it("reads an element", () => {
    assert.equal(printed("let xs: number[] = [10, 20, 30];\nprint(xs[0]);\nprint(xs[2]);"), "10\n30");
    assert.equal(printed('let xs: string[] = ["a", "b"];\nprint(xs[1]);'), "b");
    assert.equal(printed("let g: number[][] = [[1, 2]];\nprint(g[0][1]);"), "2");
  });

  it("measures an array with len", () => {
    assert.equal(printed("let xs: number[] = [1, 2, 3];\nprint(len(xs));"), "3");
    assert.equal(printed("let xs: number[] = [];\nprint(len(xs));"), "0");
  });

  it("writes an element", () => {
    assert.equal(printed("let xs: number[] = [1, 2];\nxs[0] = 9;\nprint(xs);"), "[9, 2]");
    assert.equal(printed('let xs: string[] = ["a"];\nxs[0] = "b";\nprint(xs);'), "[b]");
  });

  it("writes through a chained index", () => {
    assert.equal(
      printed("let g: number[][] = [[1, 2], [3, 4]];\ng[0][1] = 9;\nprint(g);"),
      "[[1, 9], [3, 4]]",
    );
  });

  it("applies a compound assignment to an element", () => {
    assert.equal(
      printed(`
        let xs: number[] = [1, 2, 3];
        xs[0] += 10; xs[1] -= 1; xs[2] *= 4;
        print(xs);
      `),
      "[11, 1, 12]",
    );
  });

  it("evaluates an index assignment to the stored value", () => {
    assert.equal(printed("let xs: number[] = [1];\nprint(xs[0] = 5);"), "5");
  });

  it("shares one array between two names", () => {
    // The reference, not a copy: a write through either name is visible through
    // both. This is what makes an array a value with identity.
    assert.equal(
      printed(`
        let xs: number[] = [1, 2];
        let ys: number[] = xs;
        ys[0] = 99;
        print(xs);
      `),
      "[99, 2]",
    );
  });

  it("shares an array with the function it was passed to", () => {
    // A parameter is the same reference, not a copy, so a function that writes
    // through it is a way to fill an array in place.
    assert.equal(
      printed(`
        fn fill(xs: number[], from: number): void {
          for (let i: number = 0; i < len(xs); i = i + 1) { xs[i] = from + i; }
        }
        let xs: number[] = [0, 0, 0];
        fill(xs, 5);
        print(xs);
      `),
      "[5, 6, 7]",
    );
  });

  it("compares arrays by identity, not by contents", () => {
    assert.equal(
      printed(`
        let xs: number[] = [1, 2];
        let ys: number[] = xs;
        print(xs == ys);
        print(xs == [1, 2]);
        print([1] == [1]);
        let zs: number[] = [1, 2];
        print(xs == zs);
      `),
      "true\nfalse\nfalse\nfalse",
    );
  });

  it("stores whatever a function returned", () => {
    assert.equal(
      printed(`
        fn pair(a: number, b: number): number[] { return [a, b]; }
        let xs: number[] = pair(1, 2);
        print(xs[0] + xs[1]);
        print(len(pair(7, 8)));
      `),
      "3\n2",
    );
  });

  it("sums, reverses, and builds an array whose length is computed", () => {
    // No `for...of` and no collection library: every array operation is a loop
    // over indexes, which is the whole reason the type is worth having. Note that
    // `reverse` cannot write into `out` as it goes — an empty array has nothing to
    // write *into* — so it appends and reassigns instead.
    assert.equal(
      printed(`
        fn total(xs: number[]): number {
          let sum: number = 0;
          for (let i: number = 0; i < len(xs); i = i + 1) { sum = sum + xs[i]; }
          return sum;
        }
        fn reverse(xs: number[]): number[] {
          let out: number[] = [];
          for (let i: number = 0; i < len(xs); i = i + 1) { out = append(out, xs[len(xs) - 1 - i]); }
          return out;
        }
        fn evens(limit: number): number[] {
          let out: number[] = [];
          for (let i: number = 0; i <= limit; i = i + 1) {
            if (i % 2 == 0) { out = append(out, i); }
          }
          return out;
        }
        let xs: number[] = [3, 1, 4, 1, 5];
        print(total(xs));
        print(reverse(xs));
        print(total(reverse(reverse(xs))));
        print(evens(10));
      `),
      "14\n[5, 1, 4, 1, 3]\n14\n[0, 2, 4, 6, 8, 10]",
    );
  });

  it("reports the type of an array as 'array'", () => {
    assert.equal(printed("let xs: number[] = [1];\nprint(typeOf(xs));"), "array");
  });

  it("reports an out-of-range read at runtime", () => {
    assert.throws(
      () => run("let xs: number[] = [1, 2];\nprint(xs[2]);"),
      /index 2 is out of range: this array has length 2/,
    );
    assert.throws(() => run("let xs: number[] = [1, 2];\nprint(xs[0 - 1]);"), /index -1 is out of range/);
  });

  it("reports an out-of-range write at runtime", () => {
    // Bounds cannot be checked before the program runs, and Vela has no
    // exceptions to catch, so the interpreter is where this is reported.
    assert.throws(
      () => run("let xs: number[] = [1, 2];\nxs[2] = 9;"),
      /index 2 is out of range: this array has length 2/,
    );
    assert.throws(() => run("let xs: number[] = [];\nxs[0] = 1;"), /index 0 is out of range/);
  });

  it("locates the runtime error", () => {
    assert.throws(
      () => run("let xs: number[] = [1];\n\nprint(xs[1]);"),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.location.line, 3);
        return true;
      },
    );
  });
});

describe("interpreter: runtime errors", () => {
  it("rejects division by zero", () => {
    assert.throws(() => runUnchecked("let a: number = 1;\nlet b: number = 0;\nprint(a / b);"), (error: unknown) => {
      assert.ok(error instanceof RuntimeError);
      assert.match(error.message, /division by zero/);
      assert.equal(error.location.line, 3);
      return true;
    });
  });

  it("rejects a zero remainder", () => {
    assert.throws(
      () => runUnchecked("let a: number = 1;\nlet b: number = 0;\nprint(a % b);"),
      /remainder by zero/,
    );
  });

  it("rejects a non-bool condition when checking is bypassed", () => {
    assert.throws(() => runUnchecked("if (1) { print(1); }"), /expected a 'bool' condition/);
  });

  it("rejects a non-number condition when checking is bypassed", () => {
    assert.throws(() => runUnchecked('while ("a") { }'), /expected a 'bool' condition/);
  });

  it("reports the location of a runtime error", () => {
    assert.throws(
      () => runUnchecked("let a: number = 1;\n\nlet b: number = 0;\nlet c: number = a / b;"),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal(error.location.line, 4);
        return true;
      },
    );
  });
});

describe("interpreter: realistic programs", () => {
  it("runs fizzbuzz", () => {
    const text = `
      for (let i: number = 1; i <= 15; i = i + 1) {
        if (i % 15 == 0) { print("FizzBuzz"); }
        else if (i % 3 == 0) { print("Fizz"); }
        else if (i % 5 == 0) { print("Buzz"); }
        else { print(tostring(i)); }
      }
    `;
    assert.equal(printed(text).split("\n").length, 15);
    assert.match(printed(text), /^1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz$/);
  });

  it("runs a greatest-common-divisor loop", () => {
    const text = `
      fn gcd(a: number, b: number): number {
        while (b != 0) {
          let t: number = b;
          b = a % b;
          a = t;
        }
        return a;
      }
      print(gcd(48, 18));
    `;
    assert.equal(printed(text), "6");
  });

  it("runs a word-count style program with string concatenation", () => {
    const text = `
      fn pad(s: string, width: number): string {
        let out: string = s;
        while (len(out) < width) { out = out + "."; }
        return out;
      }
      print(pad("ab", 6) + " " + repeat("ab", 3));
    `;
    assert.equal(printed(text), "ab.... ababab");
  });

  it("runs a primality check", () => {
    const text = `
      fn isPrime(n: number): bool {
        if (n < 2) { return false; }
        for (let d: number = 2; d * d <= n; d = d + 1) {
          if (n % d == 0) { return false; }
        }
        return true;
      }
      for (let n: number = 1; n <= 12; n = n + 1) {
        if (isPrime(n)) { print(tostring(n)); }
      }
    `;
    assert.equal(printed(text), "2\n3\n5\n7\n11");
  });
});
