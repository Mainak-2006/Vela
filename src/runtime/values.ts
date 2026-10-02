/**
 * Runtime values.
 *
 * The interpreter passes these around directly. A tagged union is enough here
 * because Vela's types are small and closed, so there is nothing to gain from a
 * boxed object with a vtable.
 *
 * `void` is represented by its own singleton rather than by `null`. `null` is
 * deliberately *not* a value a Vela program can create, write, or compare: since
 * there is no `null` keyword yet, the type checker can promise that a `string`
 * always holds a string.
 */

import fs from "node:fs";
import type { FunctionDeclaration } from "../ast/nodes.js";
import {
  anyType,
  arrayType,
  boolType,
  errorType,
  isAssignable,
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

/** The `null` value, a sentinel for "no value". */
export interface NullValue {
  readonly kind: "null";
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

/**
 * A homogeneous array.
 *
 * `value` is mutable rather than `readonly` on purpose. Vela arrays are fixed in
 * *length* — nothing grows them, and an out-of-range write is a runtime error —
 * but an element can be replaced, so `xs[0] = 1` has to be able to reach in. A
 * readonly array of mutable cells would not be a distinction any caller could
 * observe here.
 *
 * The reference is shared rather than copied. `let ys: number[] = xs;` binds a
 * second name to the *same* array, so a write through either is visible through
 * both. That is what makes an array a value with identity rather than a
 * description of one, and it is why `==` compares the reference instead of the
 * contents.
 */
export interface ArrayValue {
  readonly kind: "array";
  readonly value: readonly Value[];
}

/**
 * A struct value: a box of fields, and the name of the struct it is one of.
 *
 * A box rather than the fields themselves, which is what makes a copy observable:
 * a struct is copied when it is stored, so `let q: Point = p;` gives `q` its own
 * fields, and writing `q.x` afterwards leaves `p` alone. Arrays behave the other
 * way round — they are shared — so the two kinds have to be told apart at runtime
 * for `==` to be the identity check both of them are.
 *
 * Fields are positional and match the declaration's order, so the type's field list
 * is the index: field `i` of a value is field `i` of the type.
 */
export interface StructValue {
  readonly kind: "struct";
  readonly name: string;
  readonly value: readonly Value[];
}

export type Value =
  | NumberValue
  | StringValue
  | BooleanValue
  | VoidValue
  | ClosureValue
  | NativeValue
  | NullValue
  | ArrayValue
  | StructValue;

export const VOID: VoidValue = { kind: "void" };
export const NULL: NullValue = { kind: "null" };

export function number(value: number): NumberValue {
  return { kind: "number", value };
}

export function string(value: string): StringValue {
  return { kind: "string", value };
}

export function bool(value: boolean): BooleanValue {
  return { kind: "bool", value };
}

export function array(value: readonly Value[]): ArrayValue {
  return { kind: "array", value };
}

/**
 * A struct value from its field values, stored positionally in declaration order.
 *
 * The arguments are copied on the way in for the same reason `store` copies them:
 * a struct never shares anything with the value it was built from.
 */
export function struct(name: string, fields: readonly Value[]): StructValue {
  return { kind: "struct", name, value: fields.map(store) };
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

export function isNull(value: Value): value is NullValue {
  return value.kind === "null";
}

export function isArray(value: Value): value is ArrayValue {
  return value.kind === "array";
}

export function isStruct(value: Value): value is StructValue {
  return value.kind === "struct";
}

/**
 * Copy a value on its way into a binding, an argument, an element or a field.
 *
 * An array stored on its own is *not* copied — it is the one shared value in Vela,
 * so `let ys: number[] = xs;` has to keep sharing — but a struct is copied whole,
 * and everything reachable through it with it, arrays included. Otherwise the copy
 * would not be one: `let q: Box = b; q.tags[0] = "z";` would still be visible
 * through `b`, and a struct would quietly be a reference after all.
 *
 * So the two rules are not in tension, they are about different values. An array
 * *is* a reference, and binding one shares it. A struct *contains* references, and
 * copying one copies what it contains rather than pointing at it.
 *
 * This is the whole of a struct's value semantics, and applying it at every store is
 * why no later stage has to know about it: by the time anything reads a struct, the
 * copy has already been made.
 */
export function store(value: Value): Value {
  return value.kind === "struct" ? copyContents(value.value, value.name) : value;
}

/**
 * The contents of a copy: every field, and everything inside it, so that two copies
 * of one struct share nothing. `name` is passed along so a nested struct keeps its
 * own — a copy of a `Point` is still a `Point`.
 */
function copyContents(fields: readonly Value[], name: string): StructValue {
  return {
    kind: "struct",
    name,
    value: fields.map((field) =>
      field.kind === "struct"
        ? copyContents(field.value, field.name)
        : field.kind === "array"
          ? { ...field, value: field.value.map(copyElement) }
          : field,
    ),
  };
}

/** One element of a copied array: a struct is copied, a primitive is itself. */
function copyElement(value: Value): Value {
  return value.kind === "struct"
    ? copyContents(value.value, value.name)
    : value.kind === "array"
      ? { ...value, value: value.value.map(copyElement) }
      : value;
}

export function isCallable(value: Value): value is ClosureValue | NativeValue {
  return value.kind === "function" || value.kind === "native";
}

/**
 * The name a value has in a diagnostic, matching the type names so that
 * "expected a 'number'" and a stack trace that says `number` agree.
 */
export function typeNameOf(value: Value): string {
  // A struct is shown by its declared name, so a diagnostic and `typeOf` agree with
  // what the annotation in the source said rather than with the runtime tag.
  if (value.kind === "null") return "null";
  return value.kind === "struct" ? value.name : value.kind;
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
    case "null":
      return "null";
    case "void":
      return "void";
    case "function":
      return `<fn ${value.declaration.name}>`;
    case "native":
      return `<built-in ${value.name}>`;
    // Brackets, so an array is never mistaken for a string when printed. Nested
    // arrays print nested, and a string element prints bare like any other string.
    case "array":
      return `[${value.value.map(displayValue).join(", ")}]`;
    // `Point(x: 3, y: 4)` — the name, then every field by name and value, so a
    // printed struct says what it is as well as what it holds. The field names are
    // not carried on the value, so this reads its shape from the declaration.
    case "struct":
      return `${value.name}(${fieldNamesOf(value.name)
        .map((field, i) => `${field}: ${displayValue(value.value[i] ?? VOID)}`)
        .join(", ")})`;
  }
}

/**
 * The field names of a struct, for printing.
 *
 * The runtime keeps a struct's fields positionally and has no need for their names
 * — the checker is the stage that resolves a field name to a position — so the names
 * are registered once, by `registerStruct`, and read back here. A struct value whose
 * declaration the runtime never saw (a REPL entry with no declaration in scope)
 * prints without names rather than throwing.
 */
function fieldNamesOf(name: string): readonly string[] {
  return STRUCT_FIELDS.get(name) ?? [];
}

const STRUCT_FIELDS = new Map<string, readonly string[]>();

/** Record a struct declaration's field names, in order, for printing. */
export function registerStruct(name: string, fieldNames: readonly string[]): void {
  STRUCT_FIELDS.set(name, fieldNames);
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
  /**
   * An optional check on an argument type, for a built-in that accepts one of
   * several types, or a type that depends on which argument it is.
   *
   * A predicate is deliberately not a second signature: Vela has no source syntax
   * for an overload, so the honest declaration is a check rather than a fiction.
   * `paramTypes` still lists the argument positions so the seed scope has one
   * signature per built-in, and this refines the positions where they differ.
   *
   * Every argument type is passed along, because one argument's type can be the
   * rule for another's: `append` cannot say `fn(T[], T) -> T[]` in Vela, so the
   * value is checked against the *first* argument's element type here. Checking it
   * as "any" would let `append(xs, "a")` return a `number[]` holding a string.
   */
  readonly accepts?: (type: Type, position: number, argTypes: readonly Type[]) => boolean;
  /** What to say when `accepts` rejects an argument. Goes with it or not at all. */
  readonly acceptsHint?: string;
  readonly returnType: Type;
  /**
   * An optional result type computed from the argument types, for a built-in whose
   * return type is not fixed — `append` returns the same element type it was given.
   *
   * This is the same idea as `accepts` on the way out, and it is why `append` can be
   * one built-in rather than one per element type. A written signature
   * `fn(T[]) -> T[]` cannot be written in Vela for the same reason there is no
   * `any[]`: a parameterised type is not one of the types the language has.
   */
  readonly returns?: (argTypes: readonly Type[]) => Type;
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
    // The one built-in whose answer is not a fixed word: a struct reports its own
    // declared name, so `typeOf(p)` is `"Point"` rather than a tag nobody wrote in
    // an annotation. Everything else answers from the runtime tag.
    name: "typeOf",
    arity: 1,
    paramTypes: [anyType],
    returnType: stringType,
    call: (args) => {
      const target = args[0];
      return string(target ? typeNameOf(target) : "void");
    },
  },
  {
    // `len` is the one built-in whose parameter type is not a single type. It
    // measures a string's code units or an array's length, and `accepts` below
    // states that as a predicate instead of overloading the name.
    name: "len",
    arity: 1,
    paramTypes: [anyType],
    accepts: (type) => type.kind === "string" || type.kind === "array",
    acceptsHint: "'len(s)' counts the code units of a 'string', and 'len(xs)' counts the elements of an array",
    returnType: numberType,
    call: (args) => {
      const target = args[0];
      if (!target) return number(0);
      return number(target.kind === "string" ? target.value.length : target.kind === "array" ? target.value.length : 0);
    },
  },

  // --------------------------------------------------------------- arrays

  {
    // The one way to build an array of a length that is only known while running.
    // It returns a *new* array rather than growing the one it was given, which is
    // what keeps the promise that an array's length never changes: `append(xs, 1)`
    // leaves `xs` exactly as it was, and the result has one more element. So a
    // loop that appends reassigns —
    //
    //     for (...) { out = append(out, value); }
    //
    // — and pays a copy per step. That is the honest trade for a language with no
    // grow-on-index write: a write past the end cannot silently become an append,
    // because that would hide the bug that wrote the wrong index.
    name: "append",
    arity: 2,
    paramTypes: [anyType, anyType],
    accepts: (type, position, argTypes) => {
      const source = argTypes[0];
      if (position === 0) return type.kind === "array";
      // The element type is the first argument's, and only when the first argument
      // is an array at all — otherwise the first argument is reported on its own
      // and there is no element type to check against yet.
      if (position === 1 && source && source.kind === "array") {
        return isAssignable(source.element, type);
      }
      return true;
    },
    acceptsHint:
      "the first argument is the array to copy, and the second must match what it holds: 'append(xs, value)'",
    returnType: anyType,
    returns: (argTypes) => {
      const target = argTypes[0];
      return target && target.kind === "array" ? arrayType(target.element) : errorType;
    },
    call: (args) => {
      const target = args[0];
      if (!target || target.kind !== "array") return array([]);
      const value = args[1];
      return array(value ? [...target.value, value] : [...target.value]);
    },
  },

  // -------------------------------------------------------------- strings
  //
  // Everything here is *total*: it never fails and never raises a runtime error.
  // `substr` clamps rather than checking, `indexOf` answers with a sentinel, and
  // `repeat` with a negative count produces an empty string. That is a deliberate
  // contrast with `s[i]`, which reports an out-of-range index, because a substring
  // operation that ran off the end has an obvious empty answer while an element
  // that is not there does not. The index expression stays strict so a typo is
  // still caught; these are for building text, where clamping is what you want.

  {
    name: "upper",
    arity: 1,
    paramTypes: [stringType],
    returnType: stringType,
    // Unicode case mapping, not an ASCII table. That means the result is not always
    // the same length as the input — "ß" upper-cases to "SS" — so a program that
    // indexes into the result cannot assume one index is one letter.
    call: (args) => string(text(args[0]).toUpperCase()),
  },
  {
    name: "lower",
    arity: 1,
    paramTypes: [stringType],
    returnType: stringType,
    call: (args) => string(text(args[0]).toLowerCase()),
  },
  {
    name: "trim",
    arity: 1,
    paramTypes: [stringType],
    returnType: stringType,
    // Both ends, and all of JavaScript's notion of whitespace, which includes more
    // than spaces and tabs.
    call: (args) => string(text(args[0]).trim()),
  },
  {
    name: "startsWith",
    arity: 2,
    paramTypes: [stringType, stringType],
    returnType: boolType,
    // Subject first, then the prefix: it reads as "does this string start with
    // that". This is the reverse of the `startsWith(pre, s)` recipe that used to
    // live in the reference documentation.
    call: (args) => bool(text(args[0]).startsWith(text(args[1]))),
  },
  {
    name: "endsWith",
    arity: 2,
    paramTypes: [stringType, stringType],
    returnType: boolType,
    call: (args) => bool(text(args[0]).endsWith(text(args[1]))),
  },
  {
    name: "indexOf",
    arity: 2,
    paramTypes: [stringType, stringType],
    returnType: numberType,
    // -1 when absent, which is the sentinel the language has always used instead
    // of `null` for "no answer". `0` is a real result, so a check has to be
    // `!= -1` rather than a truthiness test.
    call: (args) => number(text(args[0]).indexOf(text(args[1]))),
  },
  {
    name: "substr",
    arity: 3,
    paramTypes: [stringType, numberType, numberType],
    returnType: stringType,
    // Clamped rather than checked: a start past the end yields "", a negative start
    // counts from the end as though the string were a sequence, and a count that
    // runs off the end simply stops. A negative count takes nothing.
    call: (args) => {
      const source = text(args[0]);
      let start = Math.trunc(numeric(args[1]));
      if (start < 0) start = Math.max(0, source.length + start);
      start = Math.min(start, source.length);
      const count = Math.max(0, Math.trunc(numeric(args[2])));
      return string(source.slice(start, start + count));
    },
  },
  {
    name: "repeat",
    arity: 2,
    paramTypes: [stringType, numberType],
    returnType: stringType,
    // A count of zero or less gives "". The count is truncated, so `repeat("ab", 2.9)`
    // is `repeat("ab", 2)` rather than an error about the fraction.
    call: (args) => {
      const times = Math.trunc(numeric(args[1]));
      return times <= 0 ? string("") : string(text(args[0]).repeat(times));
    },
  },
  {
    name: "replace",
    arity: 3,
    paramTypes: [stringType, stringType, stringType],
    returnType: stringType,
    // The *first* occurrence only, which is what a single call can honestly promise
    // without a repeat count. Replacing every occurrence is the sort of thing that
    // wants a `replaceAll`, and inventing an "all" default here would make the
    // obvious reading of `replace` wrong.
    //
    // An empty `from` leaves the string alone, because there is no sensible place to
    // insert, and String.replace's own behaviour of appending is surprising.
    call: (args) => {
      const from = text(args[1]);
      if (from === "") return string(text(args[0]));
      return string(text(args[0]).replace(from, text(args[2])));
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

/** The text of a built-in argument, or "" if it is not a string. */
function text(value: Value | undefined): string {
  return value && value.kind === "string" ? value.value : "";
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
