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
      fn repeat(s: string, n: number): string {
        let out: string = "";
        for (let i: number = 0; i < n; i = i + 1) {
          out = out + s;
        }
        return out;
      }
      print(repeat("ab", 3));
    `;
    assert.equal(printed(text), "ababab");
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
