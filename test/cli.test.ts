import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cli = join(root, "src", "cli.ts");

const workspace = mkdtempSync(join(tmpdir(), "vela-cli-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

/** Write a .vela file and return its path. */
function source(name: string, text: string): string {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Invoke the CLI in a child process so exit codes are real. */
function vela(...args: string[]): Run {
  try {
    const stdout = execFileSync("npx", ["tsx", cli, ...args], {
      encoding: "utf8",
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (thrown) {
    const failure = thrown as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("vela --help exits 0 and lists every command", () => {
  const { status, stdout } = vela("--help");
  assert.equal(status, 0);
  for (const command of ["run", "check", "tokens", "ast", "repl", "install-skill"]) {
    assert.match(stdout, new RegExp(`vela ${command}`), `help should mention '${command}'`);
  }
});

test("vela with no arguments prints usage and exits 0", () => {
  const { status, stdout } = vela();
  assert.equal(status, 0);
  assert.match(stdout, /Usage/);
});

test("an unknown command exits 1", () => {
  const { status, stderr } = vela("frobnicate");
  assert.equal(status, 1);
  assert.match(stderr, /unknown command 'frobnicate'/);
});

test("vela run executes a program and exits 0", () => {
  const path = source("run-ok.vela", 'print("from the cli");\n');
  const { status, stdout } = vela("run", path);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "from the cli");
});

test("vela run reports a type error and exits 1", () => {
  const path = source("run-bad-type.vela", 'let x: number = "no";\n');
  const { status, stderr } = vela("run", path);
  assert.equal(status, 1);
  assert.match(stderr, /error/);
  assert.match(stderr, /string/);
});

test("a failing program does not run its statements", () => {
  const path = source("no-side-effects.vela", 'let x: number = "no";\nprint("must not appear");\n');
  const { status, stdout } = vela("run", path);
  assert.equal(status, 1);
  assert.doesNotMatch(stdout, /must not appear/);
});

test("vela run reports a syntax error with a line number and exits 1", () => {
  const path = source("syntax.vela", "let x: number = ;\n");
  const { status, stderr } = vela("run", path);
  assert.equal(status, 1);
  assert.match(stderr, /error: expected an expression, found ';'/, "the message names the offending token");
  assert.match(stderr, /1 \| let x: number = ;/, "the offending line is quoted back");
  assert.match(stderr, /\^/, "a caret points at the error");
});

test("vela run on a missing file exits 1 without a stack trace", () => {
  const { status, stderr } = vela("run", join(workspace, "absent.vela"));
  assert.equal(status, 1);
  assert.match(stderr, /no such file/);
  assert.doesNotMatch(stderr, /at Object|node:internal/);
});

test("vela check succeeds quietly and exits 0", () => {
  const path = source("check-ok.vela", "let x: number = 1;\n");
  const { status, stdout } = vela("check", path);
  assert.equal(status, 0);
  assert.match(stdout, /ok \(1 top-level declaration\)/);
});

test("vela check accepts several files and fails if any is bad", () => {
  const good = source("check-good.vela", "let a: number = 1;\n");
  const bad = source("check-bad.vela", 'let b: number = "no";\n');
  const both = vela("check", good, bad);
  assert.equal(both.status, 1);
  assert.match(both.stdout, /check-good\.vela: ok/);

  const allGood = vela("check", good, source("check-good2.vela", "let c: bool = true;\n"));
  assert.equal(allGood.status, 0);
});

test("vela check with no file exits 1", () => {
  const { status, stderr } = vela("check");
  assert.equal(status, 1);
  assert.match(stderr, /expected at least one file/);
});

test("vela tokens prints one token per line as position, kind, lexeme", () => {
  const path = source("tokens.vela", 'print("x");\n');
  const { status, stdout } = vela("tokens", path);
  assert.equal(status, 0);
  assert.deepEqual(stdout.trim().split("\n").map((line) => line.replace(/\s+$/, "")), [
    "1:1  print    print",
    "1:6  (        (",
    '1:7  string   "x"',
    "1:10  )        )",
    "1:11  ;        ;",
    // The eof token sits at the real end of input. This used to read 2:-1,
    // because the location was derived from the last real token rather than the
    // current position, which corrupted every "unexpected end of input" caret.
    "2:1  eof",
  ]);
});

test("vela tokens works even when the program is not valid", () => {
  const path = source("tokens-bad.vela", 'let x: number = "unterminated;\n');
  const { status, stdout, stderr } = vela("tokens", path);
  assert.equal(status, 1, "lex errors still fail the command");
  assert.match(stderr, /unterminated|unclosed/i, "the lex error is reported");
  assert.match(stdout, /1:5 {2}ident {4}x/, "tokens scanned before the error are still shown");
  assert.match(stdout, /eof/, "the stream is terminated even after a failed scan");
});

test("vela ast prints an indented S-expression", () => {
  const path = source("ast.vela", "let x: number = 1;\n");
  const { status, stdout } = vela("ast", path);
  assert.equal(status, 0);
  assert.equal(stdout, "(program\n  (letDecl x: number\n    (numberLiteral 1)\n  )\n)\n");
});

test("vela ast reports a syntax error and still shows the partial tree", () => {
  const path = source("ast-bad.vela", "let x: number = ;\n");
  const { status, stdout, stderr } = vela("ast", path);
  assert.equal(status, 1);
  assert.match(stderr, /error: expected an expression/, "a silent failure would be useless here");
  assert.equal(stdout, "(program\n)\n", "the partial tree is still shown");
});

test("an unknown flag is not silently treated as a file", () => {
  const { status } = vela("run", "--nonsense");
  assert.equal(status, 1);
});

test("read() takes a line from a real pipe, one byte at a time", async () => {
  // This is the only test that exercises the actual stdin reader rather than an
  // injected source, and it is the only place a byte-at-a-time reader shows up:
  // `café` and `→` are more than one byte each, so decoding per byte would
  // replace every one of them with U+FFFD.
  const path = source(
    "read-stdin.vela",
    [
      'let a: string = read();',
      'let b: string = read();',
      'print(len(a));',
      'print(a);',
      'print(b);',
      "",
    ].join("\n"),
  );

  const child = spawn("npx", ["tsx", cli, "run", path], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += String(chunk);
  });
  child.stdin.write("café\n→\n");
  child.stdin.end();

  const status = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(status, 0);
  assert.equal(stdout, "4\ncafé\n→\n");
});

test("a reader that hangs up ends the run quietly", async () => {
  // Enough output that the child cannot finish before the pipe closes, so this
  // reliably reaches the write that fails.
  const path = source(
    "epipe.vela",
    "for (let i: number = 0; i < 20000; i = i + 1) { print(i); }\n",
  );

  const child = spawn("npx", ["tsx", cli, "run", path], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  // Hang up the way `head` does: take one line, then close.
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdout.destroy();

  const status = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  assert.equal(stderr, "", "a closed pipe is not a crash, so nothing is reported");
  assert.equal(status, 0, "the program ends the way a filter ends, not with a failure");
});
