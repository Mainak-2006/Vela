/**
 * Runs every `*.vela` file in `examples/` and reports the outcome.
 *
 * This is the end-to-end test that matters most: each example is type-checked
 * and executed for real, so an example that stops compiling — or a compiler
 * regression that breaks it — fails here rather than in a unit test.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { compileFile } from "../src/pipeline.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "../src/runtime/interpreter.js";
import { setInput, setOutput } from "../src/runtime/values.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(root, "examples");

const files = readdirSync(examplesDir)
  .filter((name) => name.endsWith(".vela"))
  .sort();

/**
 * The lines to feed an example that calls `read()`, read from a sibling `.input`
 * file. An example without one gets an empty script, so a stray `read()` yields
 * the empty string instead of blocking on this process's stdin.
 */
function readInputScript(path: string): string[] {
  const inputPath = path.replace(/\.vela$/, ".input");
  if (!existsSync(inputPath)) return [];
  const text = readFileSync(inputPath, "utf8");
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

if (files.length === 0) {
  console.error("no examples found");
  process.exitCode = 1;
} else {
  let failures = 0;

  for (const file of files) {
    const path = join(examplesDir, file);
    const result = compileFile(path);

    if (result.stage !== "ok" || !result.program) {
      failures++;
      console.error(`FAIL ${relative(root, path)}: ${result.stage} stage reported errors`);
      for (const diagnostic of result.diagnostics) {
        console.error(`  ${diagnostic.severity} at ${diagnostic.location.line}:${diagnostic.location.column}: ${diagnostic.message}`);
      }
      continue;
    }

    try {
      const lines: string[] = [];
      const restore = setOutput((text) => lines.push(text));
      // An example that calls `read()` must not consume this process's stdin, and
      // must not hang when there is nothing to read. Feeding it a fixed script
      // keeps the run hermetic, and the same indirection the REPL uses.
      const script = readInputScript(path);
      const queue = [...script];
      const restoreInput = setInput(() => (queue.length > 0 ? queue.shift()! : ""));
      try {
        new Interpreter(createGlobalEnvironment()).run(result.program);
      } finally {
        restoreInput();
        restore();
      }

      // Semantic check, not just a line count. An example that starts printing the
      // wrong numbers is more broken than one that fails to compile, and a count
      // alone would not notice.
      const expectedPath = path.replace(/\.vela$/, ".expected");
      if (existsSync(expectedPath)) {
        const expected = readFileSync(expectedPath, "utf8").trimEnd().split("\n");
        if (expected.join("\n") !== lines.join("\n")) {
          failures++;
          console.error(`FAIL ${relative(root, path)}: output did not match ${relative(root, expectedPath)}`);
          console.error(`  expected: ${JSON.stringify(expected)}`);
          console.error(`  actual:   ${JSON.stringify(lines)}`);
          continue;
        }
        console.log(
          `ok   ${relative(root, path)} (${result.program.declarations.length} declarations, ${lines.length} lines verified)`,
        );
        continue;
      }

      console.log(
        `ok   ${relative(root, path)} (${result.program.declarations.length} declarations, ${lines.length} lines of output)`,
      );
    } catch (thrown) {
      failures++;
      const message = thrown instanceof RuntimeError ? thrown.message : String(thrown);
      console.error(`FAIL ${relative(root, path)}: ${message}`);
    }
  }

  console.log("");
  console.log(`${files.length - failures}/${files.length} examples ran successfully`);
  if (failures > 0) process.exitCode = 1;
}
