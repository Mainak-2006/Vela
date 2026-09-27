/**
 * Vela's public API.
 *
 * A program embedding Vela imports from here. The four stages are all exported
 * separately so a host can stop early — the `tokens` and `ast` CLI commands are
 * just thin wrappers over `tokenize`, `parse`, and `printProgram`.
 *
 * The usual entry point is `compile`, which runs every stage and is what the CLI
 * and the REPL both go through.
 */

// Stages
export { tokenize, formatToken } from "./lexer/lexer.js";
export { parse } from "./parser/parser.js";
export { check, Scope, type Symbol } from "./types/checker.js";
export { Interpreter, RuntimeError, createGlobalEnvironment } from "./runtime/interpreter.js";

// Pipeline
export {
  compile,
  compileFile,
  formatAst,
  formatTokens,
  type CompileOptions,
  type CompileResult,
  type Stage,
} from "./pipeline.js";

// AST
export type * from "./ast/nodes.js";
export { visit, type NodeVisitor } from "./ast/visitor.js";
export { printProgram, type PrintOptions } from "./ast/astPrinter.js";

// Tokens
export { TOKEN, type TokenKind, type Token } from "./lexer/token.js";

// Diagnostics
export {
  DiagnosticBag,
  SourceFile,
  renderDiagnostic,
  renderDiagnostics,
  loc,
  span,
  wholeFile,
  error,
  warning,
  briefError,
  type Diagnostic,
  type SourceLocation,
  type Severity,
} from "./diagnostics.js";

// Types
export {
  anyType,
  boolType,
  errorType,
  functionType,
  isError,
  numberType,
  primitiveType,
  stringType,
  voidType,
  typesEqual,
  isAssignable,
  typeToString,
  type Type,
} from "./types/types.js";

// Runtime
export { Environment } from "./runtime/environment.js";
export {
  bool,
  closure,
  createBuiltins,
  displayValue,
  inspectValue,
  native,
  number,
  setOutput,
  string,
  typeNameOf,
  VOID,
  write,
  writeLine,
  type BuiltinSpec,
  type Value,
} from "./runtime/values.js";
