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

import type { FunctionDeclaration } from "../ast/nodes.js";
import {
  anyType,
  numberType,
  stringType,
  voidType,
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

export const BUILTIN_SPECS: readonly BuiltinSpec[] = [
  {
    name: "print",
    arity: 1,
    paramTypes: [anyType],
    returnType: voidType,
    call: (args) => {
      const target = args[0];
      if (target) write(target);
      return VOID;
    },
  },
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
];

/** The `NativeValue`s installed in a fresh global scope. */
export function createBuiltins(): readonly Value[] {
  return BUILTIN_SPECS.map((spec) => native(spec.name, spec.arity, spec.call));
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
