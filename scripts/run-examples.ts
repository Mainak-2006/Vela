/**
 * Runs every `*.vela` file in `examples/` and reports the outcome.
 *
 * This is the end-to-end test that matters most: each example is type-checked
 * and executed for real, so an example that stops compiling — or a compiler
 * regression that breaks it — fails here rather than in a unit test.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import { compileFile } from "../src/pipeline.js";
import { Interpreter, RuntimeError, createGlobalEnvironment } from "../src/runtime/interpreter.js";
import { setOutput } from "../src/runtime/values.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(root, "examples");

const files = readdirSync(examplesDir)
  .filter((name) => name.endsWith(".vela"))
  .sort();

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
      try {
        new Interpreter(createGlobalEnvironment()).run(result.program);
      } finally {
        restore();
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
