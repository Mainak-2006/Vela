import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";

import { compile, compileFile } from "../src/pipeline.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "../src/runtime/interpreter.js";
import { setOutput, displayValue, type Value } from "../src/runtime/values.js";
import { isIncomplete, Repl } from "../src/repl/repl.js";

/** Run a source string and capture what it printed, plus the entry's value. */
function evaluate(text: string, known: Parameters<typeof compile>[2] extends { known?: infer K } ? K : never = []) {
  const result = compile("<test>", text, { known });
  assert.equal(result.stage, "ok", `expected clean compile, got: ${result.diagnostics.map((d) => d.message).join("; ")}`);

  const lines: string[] = [];
  const restore = setOutput((line) => lines.push(line));
  let value: Value | undefined;
  try {
    value = new Interpreter(createGlobalEnvironment()).run(result.program!);
  } finally {
    restore();
  }
  return { lines, value, result };
}

/** A WritableStream stand-in that just accumulates what is written to it. */
function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  // A real Writable, not a bare { write }, because readline attaches listeners to
  // the stream it is given.
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

test("compile runs every stage and reports ok", () => {
  const result = compile("ok.vela", 'print("hi");');
  assert.equal(result.stage, "ok");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.program?.declarations.length, 1);
});

test("compile stops after the lexer when lexing fails", () => {
  const result = compile("bad.vela", 'let x: number = 1; let y: string = "unterminated;');
  assert.equal(result.stage, "lex");
  assert.equal(result.program, null);
  assert.ok(result.diagnostics.length > 0);
});

test("compile reports parse errors at the parse stage", () => {
  const result = compile("bad.vela", "let x: number = ;");
  assert.equal(result.stage, "parse");
  assert.ok(result.program, "the parser returns a partial tree rather than throwing");
  assert.equal(result.program!.declarations.length, 0, "the bad declaration is dropped");
});

test("compile reports type errors at the check stage", () => {
  const result = compile("bad.vela", 'let x: number = "not a number";');
  assert.equal(result.stage, "check");
  assert.ok(result.program, "the tree is kept, it just failed checking");
  assert.match(result.diagnostics[0]!.message, /string/);
});

test("a type keyword in expression position is a parse error, not a silent literal", () => {
  // `number` and `string` name both a literal token kind and a type keyword. If
  // those two kinds collide, `parsePrefix` reads the keyword as a literal and
  // the program quietly means 0 or "" instead of failing to compile.
  for (const keyword of ["number", "string"]) {
    const result = compile("bad.vela", `let x: number = ${keyword};`);
    assert.equal(result.stage, "parse", `${keyword} in expression position should not compile`);
    assert.match(result.diagnostics[0]!.message, /expected an expression/);
  }
});

test("a literal in type position is a parse error and never reaches the checker", () => {
  // A numeric literal used to be accepted as a type name, which left the
  // checker dereferencing an undefined type and crashing with a TypeError.
  const result = compile("bad.vela", "let x: 5 = 1;");
  assert.equal(result.stage, "parse", "the parse error stops the pipeline before checking");
  assert.match(result.diagnostics[0]!.message, /expected a type name/);
});

test("lexOnly stops after the lexer", () => {
  const result = compile("t.vela", "this is not valid vela at all ((", { lexOnly: true });
  assert.equal(result.stage, "lex");
  assert.equal(result.program, null);
  assert.ok(result.tokens.length > 0);
});

test("parseOnly stops after the parser, so type errors do not appear", () => {
  const result = compile("t.vela", 'let x: number = "wrong type";', { parseOnly: true });
  assert.equal(result.stage, "parse");
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.program);
});

test("a bad file path is reported as a diagnostic, not a crash", () => {
  const result = compileFile("does/not/exist.vela");
  assert.notEqual(result.stage, "ok");
  assert.match(result.diagnostics[0]!.message, /no such file/);
});

test("known symbols make a name resolvable on a later entry", () => {
  const first = compile("<repl>", "let x: number = 1;");
  assert.equal(first.stage, "ok");
  const declaration = first.program!.declarations[0]!;
  assert.equal(declaration.kind, "letDecl");
  if (declaration.kind !== "letDecl") return;

  const second = compile("<repl>", "x + 1;", {
    known: [{ name: "x", type: { kind: "number" }, kind: "variable", location: declaration.nameLocation }],
  });
  assert.deepEqual(second.diagnostics, [], "x should resolve from the known scope");
});

test("evaluate returns the value of the last expression", () => {
  const { value } = evaluate("1 + 2 * 3;");
  assert.equal(value && displayValue(value), "7");
});

test("evaluate captures printed output", () => {
  const { lines } = evaluate('print("a");\nprint("b");');
  assert.deepEqual(lines, ["a", "b"]);
});

// --- REPL completeness heuristic ---

test("isIncomplete asks for more input after an open brace", () => {
  assert.equal(isIncomplete("fn f() {"), true);
  assert.equal(isIncomplete("if (x) {"), true);
  assert.equal(isIncomplete("for (let i: number = 0; i < 3; i = i + 1) {"), true);
});

test("isIncomplete asks for more input after an open paren", () => {
  assert.equal(isIncomplete("print("), true);
  assert.equal(isIncomplete("print(1 +"), true);
});

test("isIncomplete asks for more input after an open bracket", () => {
  assert.equal(isIncomplete("print(\"ab\"["), true);
  assert.equal(isIncomplete("print(\"ab\"[0] +"), true);
});

test("isIncomplete asks for more input after a trailing operator", () => {
  assert.equal(isIncomplete("1 +"), true);
  assert.equal(isIncomplete("a &&"), true);
  assert.equal(isIncomplete("x :"), true);
  assert.equal(isIncomplete("print(1, 2,"), true);
});

test("isIncomplete is false once the entry is balanced and terminated", () => {
  assert.equal(isIncomplete("1 + 2;"), false);
  assert.equal(isIncomplete("let x: number = 1;"), false);
  assert.equal(isIncomplete("fn f(): number { return 1; }"), false);
  assert.equal(isIncomplete("print(\"done\");"), false);
  assert.equal(isIncomplete("print(\"ab\"[0]);"), false);
});

test("isIncomplete is false for empty and comment-only input", () => {
  assert.equal(isIncomplete(""), false);
  assert.equal(isIncomplete("   "), false);
  assert.equal(isIncomplete("// just a comment"), false);
});

test("isIncomplete does not loop forever on a stray closing brace", () => {
  assert.equal(isIncomplete("}"), false);
});

// --- REPL behaviour, driven through submit() ---

test("Repl.submit echoes an expression's value", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit("40 + 2;");
  assert.equal(out.text(), "42\n");
});

test("Repl.submit writes program output but adds no echo for a void entry", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit('print("side effect");');
  assert.equal(out.text(), "side effect\n");
});

test("Repl routes print output and echoes through the same stream", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit('print("printed");');
  repl.submit("40 + 2;");
  assert.equal(out.text(), "printed\n42\n", "nothing is written to process.stdout instead");
  repl.dispose();
});

test("Repl.dispose restores the default output", async () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.dispose();
  const { lines } = evaluate('print("back on stdout");');
  assert.deepEqual(lines, ["back on stdout"]);
});

test("Repl.submit keeps bindings between entries", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit("let x: number = 7;");
  repl.submit("x * 3;");
  assert.equal(out.text(), "21\n");
});

test("Repl.submit keeps functions between entries, including recursion", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit("fn double(n: number): number { return n * 2; }");
  repl.submit("double(21);");
  repl.submit("fn fact(n: number): number { if (n < 2) { return 1; } return n * fact(n - 1); }");
  repl.submit("fact(5);");
  assert.equal(out.text(), "42\n120\n");
});

test("a REPL entry may shadow an earlier binding inside a block", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit('let s: string = "outer";');
  repl.submit('{ let s: string = "inner"; print(s); }');
  repl.submit("print(s);");
  assert.equal(out.text(), "inner\nouter\n", "the block binding is scoped to its block");
});

test("redeclaring the same name in a REPL entry is a static error", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit('let s: string = "first";');
  repl.submit('let s: string = "second";');
  repl.submit("s;");
  assert.match(out.text(), /already declared/);
  assert.match(out.text(), /first\n$/, "the original binding is unchanged");
});

test("Repl.submit resets the environment", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit("let x: number = 1;");
  repl.reset();
  repl.submit("x;");
  assert.match(out.text(), /cannot find 'x'/, "x should no longer resolve after reset");
});

test("Repl.reset keeps the built-ins bound", () => {
  // The checker re-seeds its own view of the built-ins on every entry, so a
  // cleared runtime scope still type-checks and only fails when it runs. That
  // made the bug invisible to a test that only checked a user binding.
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.reset();
  repl.submit('print(tostring(1) + " " + tostring(len("ab")) + " " + typeOf(1) + " " + tostring(tonumber("7")));');
  assert.doesNotMatch(out.text(), /cannot find/, "built-ins must survive reset");
  assert.match(out.text(), /1 2 number 7/);
});

test("Repl.submit reports a type error without running the entry", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit('let bad: number = "nope";');
  repl.submit("bad;");
  assert.match(out.text(), /error/);
  assert.match(out.text(), /cannot find 'bad'/, "a rejected entry adds nothing to the session");
});

test("Repl.submit reports a runtime error and keeps state", () => {
  const out = captureStream();
  const repl = new Repl({ output: out.stream });
  repl.submit("let n: number = 0;");
  repl.submit("1 / n;");
  repl.submit("n + 5;");
  assert.match(out.text(), /division by zero/);
  assert.match(out.text(), /5\n$/, "the session survives a runtime error");
});

test("wrong argument count is caught statically, not at runtime", () => {
  const result = compile("t.vela", "fn f(a: number, b: number): number { return a + b; }\nprint(f(1));");
  assert.equal(result.stage, "check");
  assert.match(result.diagnostics[0]!.message, /expected 2 arguments but got 1/);
});

// --- new built-in ---

test("len returns the character count of a string", () => {
  const { value } = evaluate('len("hello");');
  assert.equal(value && displayValue(value), "5");
});

test("len of the empty string is zero", () => {
  const { value } = evaluate('len("");');
  assert.equal(value && displayValue(value), "0");
});

test("len rejects a number at the type level", () => {
  const result = compile("bad.vela", "len(1);");
  assert.equal(result.stage, "check");
});

test("RuntimeError carries a source location for rendering", () => {
  const result = compile("e.vela", "let n: number = 0;\n1 / n;");
  assert.equal(result.stage, "ok");
  let thrown: unknown;
  try {
    new Interpreter(createGlobalEnvironment()).run(result.program!);
  } catch (thrown_) {
    thrown = thrown_;
  }
  assert.ok(thrown instanceof RuntimeError);
  assert.equal(thrown.location.line, 2);
});

// --- start(), driven with a piped input stream ---

/** A ReadableStream stand-in that emits `lines` and then ends. */
function inputOf(lines: readonly string[]): NodeJS.ReadableStream {
  return Readable.from([`${lines.join("\n")}\n`]);
}

test("Repl.start evaluates a piped session in order", async () => {
  const out = captureStream();
  const repl = new Repl({ input: inputOf(["let x: number = 3;", "x + 1;"]), output: out.stream });
  await repl.start();
  assert.equal(out.text().endsWith("goodbye\n"), true);
  assert.match(out.text(), /4\n/, "the second entry echoes the value");
  assert.match(out.text(), /Vela — a small statically-typed language/);
});

test("Repl.start carries multi-line entries through the continuation prompt", async () => {
  const out = captureStream();
  const repl = new Repl({
    input: inputOf(["fn double(n: number): number {", "  return n * 2;", "}", "double(21);"]),
    output: out.stream,
  });
  await repl.start();
  assert.match(out.text(), /42\n/);
});

test("Repl.start lets a dot command rescue an unfinished entry", async () => {
  const out = captureStream();
  // The brace never closes, so the entry stays pending until `.reset` clears it.
  const repl = new Repl({ input: inputOf(["fn f() {", ".reset", "let y: number = 1;", "y;"]), output: out.stream });
  await repl.start();
  const text = out.text();
  assert.match(text, /entry discarded/, "the stuck buffer is dropped, not run");
  assert.doesNotMatch(text, /error/, "the abandoned entry is never compiled");
  assert.match(text, /1\n/, "the session carries on");
});

test("Repl.start treats a blank line as end-of-entry", async () => {
  const out = captureStream();
  // An unclosed brace would normally hold the buffer open; a blank line forces
  // it to be submitted, which reports the error and clears the buffer.
  const repl = new Repl({ input: inputOf(["fn f() {", "", "1 + 1;"]), output: out.stream });
  await repl.start();
  const text = out.text();
  assert.match(text, /error/, "the incomplete entry is reported");
  assert.match(text, /2\n/, "and the next entry still runs");
});

test("Repl.start reports an unknown command without touching state", async () => {
  const out = captureStream();
  const repl = new Repl({ input: inputOf(["let x: number = 5;", ".nope", "x;"]), output: out.stream });
  await repl.start();
  const text = out.text();
  assert.match(text, /unknown command '\.nope'/);
  assert.match(text, /5\n/, "x survived the bad command");
});

test("Repl.start serves read() from the lines the embedder supplied", async () => {
  const out = captureStream();
  const repl = new Repl({
    input: inputOf(['print("[" + read() + "]");', 'print("[" + read() + "]");']),
    output: out.stream,
    inputLines: ["first", "second"],
  });
  await repl.start();
  const text = out.text();
  assert.match(text, /\[first\]/);
  assert.match(text, /\[second\]/);
});

test("Repl.start reports end of input rather than the line that was just typed", async () => {
  const out = captureStream();
  // readline owns the terminal, so descriptor 0 is already drained by the time an
  // entry runs. Handing `read()` the source line would make Vela code answer a
  // question about the outside world with its own text.
  const repl = new Repl({ input: inputOf(['print("[" + read() + "]");']), output: out.stream });
  await repl.start();
  assert.match(out.text(), /\[\]/, "an empty line is the end-of-input answer");
});
