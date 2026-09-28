/**
 * Runtime values.
 *
 * The interpreter passes these around directly. A tagged union is enough here
 * because Vela has four primitive types and no user-defined types, so there is
 * nothing to gain from a boxed object with a vtable.
 *
 * `void` is represented by the `null` singleton rather than its own variant.
 * `null` is deliberately *not* a value a Vela program can create, write, or
 * compare: since there is no `null` keyword, the type checker can promise that a
 * `string` always holds a string.
 */

import fs from "node:fs";
import type { FunctionDeclaration } from "../ast/nodes.js";
import {
  anyType,
  numberType,
  stringType,
  type Type,
} from "../types/types.js";
import type { Environment } from "./environment.js";

export interface NumberValue {
  readonly kind: "number";
  readonly value: number;
}

export interface StringValue {
  readonly kind: "string";
  readonly value: string;
}

export interface BooleanValue {
  readonly kind: "bool";
  readonly value: boolean;
}

/** The absence of a value, produced by a `void` function or a bare `return`. */
export interface VoidValue {
  readonly kind: "void";
}

/** A function together with the scope it was declared in. */
export interface ClosureValue {
  readonly kind: "function";
  readonly declaration: FunctionDeclaration;
  readonly closure: Environment;
}

/** A function provided by the runtime rather than written in Vela. */
export interface NativeValue {
  readonly kind: "native";
  readonly name: string;
  readonly arity: number;
  readonly call: (args: readonly Value[]) => Value;
}

export type Value = NumberValue | StringValue | BooleanValue | VoidValue | ClosureValue | NativeValue;

export const VOID: VoidValue = { kind: "void" };

export function number(value: number): NumberValue {
  return { kind: "number", value };
}

export function string(value: string): StringValue {
  return { kind: "string", value };
}

export function bool(value: boolean): BooleanValue {
  return { kind: "bool", value };
}

export function closure(declaration: FunctionDeclaration, captured: Environment): ClosureValue {
  return { kind: "function", declaration, closure: captured };
}

export function native(
  name: string,
  arity: number,
  call: (args: readonly Value[]) => Value,
): NativeValue {
  return { kind: "native", name, arity, call };
}

export function isNumber(value: Value): value is NumberValue {
  return value.kind === "number";
}

export function isString(value: Value): value is StringValue {
  return value.kind === "string";
}

export function isBool(value: Value): value is BooleanValue {
  return value.kind === "bool";
}

export function isVoid(value: Value): value is VoidValue {
  return value.kind === "void";
}

export function isCallable(value: Value): value is ClosureValue | NativeValue {
  return value.kind === "function" || value.kind === "native";
}

/**
 * The name a value has in a diagnostic, matching the type names so that
 * "expected a 'number'" and a stack trace that says `number` agree.
 */
export function typeNameOf(value: Value): string {
  return value.kind;
}

/** How a value is shown by `print` and by the REPL. Strings print bare. */
export function displayValue(value: Value): string {
  switch (value.kind) {
    case "number":
      return formatNumber(value.value);
    case "string":
      return value.value;
    case "bool":
      return value.value ? "true" : "false";
    case "void":
      return "void";
    case "function":
      return `<fn ${value.declaration.name}>`;
    case "native":
      return `<built-in ${value.name}>`;
  }
}

/** How a value is shown when its type is what matters, e.g. in error messages. */
export function inspectValue(value: Value): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return formatNumber(value.value);
    default:
      return displayValue(value);
  }
}

/** Render a number without a trailing `.0`, and without exponent noise for integers. */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

/**
 * The built-in functions, declared once.
 *
 * The spec table below is the single source of truth for a built-in's name, arity,
 * types, and behaviour. The runtime builds `NativeValue`s from it, and the type
 * checker seeds its root scope with the same signatures, so the two can never
 * drift apart. Adding a built-in means adding one entry here and nothing else.
 */
export interface BuiltinSpec {
  readonly name: string;
  readonly arity: number;
  /** Declared parameter types. `anyType` where the built-in is genuinely polymorphic. */
  readonly paramTypes: readonly Type[];
  readonly returnType: Type;
  readonly call: (args: readonly Value[]) => Value;
}

/**
 * The callables the runtime provides, in one place. The checker seeds its root
 * scope from this same table, which is what stops the two from drifting apart.
 *
 * `print` is deliberately absent. It is a keyword, so it can never appear in an
 * expression position, and a signature the language cannot express is a lie in
 * the table that everything else is derived from.
 */
export const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  {
    name: "tostring",
    arity: 1,
    paramTypes: [anyType],
    returnType: stringType,
    call: (args) => {
      const target = args[0];
      return string(target ? displayValue(target) : "");
    },
  },
  {
    name: "tonumber",
    arity: 1,
    paramTypes: [anyType],
    returnType: numberType,
    call: (args) => {
      const target = args[0];
      if (!target || target.kind !== "string") return number(0);
      const parsed = Number(target.value);
      return number(Number.isNaN(parsed) ? 0 : parsed);
    },
  },
  {
    name: "typeOf",
    arity: 1,
    paramTypes: [anyType],
    returnType: stringType,
    call: (args) => {
      const target = args[0];
      return string(target ? target.kind : "void");
    },
  },
  {
    name: "len",
    arity: 1,
    paramTypes: [stringType],
    returnType: numberType,
    call: (args) => {
      const target = args[0];
      return number(target && target.kind === "string" ? target.value.length : 0);
    },
  },

  // ------------------------------------------------------------- numbers
  //
  // These were recipes in the reference documentation until a function per
  // concept was a line of source rather than a paragraph. The definitions match
  // the recipes exactly, so a program written against either behaves the same.

  {
    name: "trunc",
    arity: 1,
    paramTypes: [numberType],
    returnType: numberType,
    call: (args) => number(trunc(numeric(args[0]))),
  },
  {
    name: "floor",
    arity: 1,
    paramTypes: [numberType],
    returnType: numberType,
    call: (args) => {
      const x = numeric(args[0]);
      const t = trunc(x);
      // Math.floor already rounds toward negative infinity, so there is no
      // reason to reimplement it in terms of trunc. The recipe exists only
      // because Vela has no Math object.
      return number(t === x ? t : x < 0 ? t - 1 : t);
    },
  },
  {
    name: "ceil",
    arity: 1,
    paramTypes: [numberType],
    returnType: numberType,
    call: (args) => {
      const x = numeric(args[0]);
      const t = trunc(x);
      return number(t === x ? t : x > 0 ? t + 1 : t);
    },
  },
  {
    name: "round",
    arity: 1,
    paramTypes: [numberType],
    returnType: numberType,
    // Half away from zero, matching the documented recipe rather than the
    // banker's rounding that Math.round does.
    call: (args) => {
      const x = numeric(args[0]);
      return number(trunc(x >= 0 ? x + 0.5 : x - 0.5));
    },
  },
  {
    name: "abs",
    arity: 1,
    paramTypes: [numberType],
    returnType: numberType,
    call: (args) => {
      const x = numeric(args[0]);
      return number(x < 0 ? 0 - x : x);
    },
  },
  {
    name: "min",
    arity: 2,
    paramTypes: [numberType, numberType],
    returnType: numberType,
    call: (args) => number(Math.min(numeric(args[0]), numeric(args[1]))),
  },
  {
    name: "max",
    arity: 2,
    paramTypes: [numberType, numberType],
    returnType: numberType,
    call: (args) => number(Math.max(numeric(args[0]), numeric(args[1]))),
  },
  {
    name: "idiv",
    arity: 2,
    paramTypes: [numberType, numberType],
    returnType: numberType,
    // Truncating rather than flooring, so the result obeys the same
    // toward-zero rule as `%` does. Dividing by zero yields 0 rather than
    // raising: a built-in has nowhere to point for a source location, and
    // Infinity is not a value this language can hold meaningfully.
    call: (args) => {
      const b = numeric(args[1]);
      if (b === 0) return number(0);
      return number(trunc(numeric(args[0]) / b));
    },
  },
  {
    name: "read",
    arity: 0,
    paramTypes: [],
    returnType: stringType,
    // No prompt and no arguments: a prompt would need to know about output, and
    // arguments would need types to check against. One line in, one line out.
    //
    // End of input is the empty string rather than an error. A program reading a
    // fixed number of lines should stop cleanly, and there is no `null` in Vela
    // to signal it, so an empty line is the only honest answer available.
    call: () => {
      const line = source();
      return line === null ? string("") : string(stripCarriageReturn(line));
    },
  },
];

/** Drop a trailing `\r` so a CRLF file does not leave it on every line. */
function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The numeric value of a built-in argument, or 0 if it is not a number. */
function numeric(value: Value | undefined): number {
  return value && value.kind === "number" ? value.value : 0;
}

/** Round toward zero. `x % 1` is the fractional part with the sign of x. */
function trunc(x: number): number {
  return x >= 0 ? x - (x % 1) : x + ((0 - x) % 1);
}

/** The `NativeValue`s installed in a fresh global scope. */
export function createBuiltins(): readonly Value[] {
  return BUILTIN_SPECS.map((spec) => native(spec.name, spec.arity, spec.call));
}

/**
 * Input source for `read()`, indirected for the same reason the output sink is:
 * swapping this is the only difference between a program that reads stdin and a
 * test that reads a fixed list of lines.
 *
 * The default reads one line at a time from file descriptor 0. It is line-based
 * rather than character-based because `read()` returns a whole line, and it strips
 * the trailing newline so a program does not have to. `\r\n` is handled too,
 * since a file written on Windows should not leave a stray `\r` on every line.
 */
let source: () => string | null = readLineFromStdin;

export function setInput(next: () => string | null): () => void {
  const previous = source;
  source = next;
  return () => {
    source = previous;
  };
}

/** Read one line from stdin, or return null at end of input. */
function readLineFromStdin(): string | null {
  // Bytes are accumulated and decoded once at the end. Decoding each byte on its own
  // would replace every character outside ASCII with U+FFFD, since a multi-byte
  // character is several reads and a lone byte is not a character.
  const bytes: number[] = [];
  for (;;) {
    // One byte at a time is the only way to stop exactly at the newline without
    // consuming the first byte of the next line, and the line boundary is the
    // whole contract of `read()`.
    const buffer = Buffer.alloc(1);
    let read: number;
    try {
      read = fs.readSync(0, buffer, 0, 1, null);
    } catch (error) {
      // A non-blocking descriptor, or a closed stream, is end of input as far as a
      // Vela program is concerned. Rethrowing would surface a host errno in the
      // middle of an otherwise valid run.
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        return bytes.length === 0 ? null : Buffer.from(bytes).toString("utf8");
      }
      return null;
    }
    if (read === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString("utf8");
    if (buffer[0] === 0x0a) return Buffer.from(bytes).toString("utf8");
    bytes.push(buffer[0]!);
  }
}

/**
 * Output sink, indirected so tests can capture it. Swapping this is the only
 * difference between running a program and testing it.
 */
let sink: (text: string) => void = (text) => process.stdout.write(text + "\n");

export function write(value: Value): void {
  sink(displayValue(value));
}

export function writeLine(text: string): void {
  sink(text);
}

/** Replace the output sink. Returns a function that restores the previous one. */
export function setOutput(next: (text: string) => void): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}
