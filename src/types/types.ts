/**
 * The type representation.
 *
 * Vela has four primitive types plus function types. There is no subtyping, no
 * union, and no inference, so type equality is plain structural recursion.
 *
 * The `error` type is the interesting one. When a check fails, the checker
 * returns `errorType` instead of guessing, and every later rule treats `errorType`
 * as compatible with anything. That way one mistake produces one message rather
 * than a cascade of follow-on complaints about an expression whose type was
 * never really known.
 */

import type { PrimitiveTypeName } from "../ast/nodes.js";

export interface NumberType {
  readonly kind: "number";
}
export interface StringType {
  readonly kind: "string";
}
export interface BoolType {
  readonly kind: "bool";
}
export interface VoidType {
  readonly kind: "void";
}
export interface FunctionType {
  readonly kind: "function";
  readonly params: readonly Type[];
  readonly returnType: Type;
}
/** The poison value returned by a failed check. Absorbs further errors. */
export interface ErrorType {
  readonly kind: "error";
}

export type Type = NumberType | StringType | BoolType | VoidType | FunctionType | ErrorType;

export const numberType: NumberType = { kind: "number" };
export const stringType: StringType = { kind: "string" };
export const boolType: BoolType = { kind: "bool" };
export const voidType: VoidType = { kind: "void" };
export const errorType: ErrorType = { kind: "error" };

export function functionType(params: readonly Type[], returnType: Type): FunctionType {
  return { kind: "function", params, returnType };
}

export function primitiveType(name: PrimitiveTypeName): Type {
  switch (name) {
    case "number":
      return numberType;
    case "string":
      return stringType;
    case "bool":
      return boolType;
    case "void":
      return voidType;
  }
}

export function isError(type: Type): boolean {
  return type.kind === "error";
}

/**
 * Structural type equality. The `error` type equals itself only, so a genuine
 * mismatch involving it is still visible to `typesEqual`; the absorption happens
 * in `isAssignable`, which is what rules consult.
 */
export function typesEqual(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "function" && b.kind === "function") {
    if (a.params.length !== b.params.length) return false;
    if (!typesEqual(a.returnType, b.returnType)) return false;
    return a.params.every((param, i) => typesEqual(param, b.params[i]!));
  }
  return true;
}

/**
 * Assignability, which is equality plus the error-absorption rule. There is no
 * subtyping in Vela, so this is the only place a type relationship is decided.
 */
export function isAssignable(target: Type, value: Type): boolean {
  if (target.kind === "error" || value.kind === "error") return true;
  return typesEqual(target, value);
}

/** How a type is written in a diagnostic. `error` never reaches a message. */
export function typeToString(type: Type): string {
  switch (type.kind) {
    case "function":
      return `fn(${type.params.map(typeToString).join(", ")}) -> ${typeToString(type.returnType)}`;
    case "error":
      return "<error>";
    default:
      return type.kind;
  }
}

/** True for the operators that do arithmetic or ordering, and so need `number` operands. */
export function isArithmeticOperator(operator: string): boolean {
  return operator === "+" || operator === "-" || operator === "*" || operator === "/" || operator === "%";
}

/** True for the operators that compare, and so produce a `bool`. */
export function isComparisonOperator(operator: string): boolean {
  return operator === "==" || operator === "!=" || operator === "<" || operator === ">" || operator === "<=" || operator === ">=";
}

/** True for the operators that work on any pair of matching types. */
export function isEqualityOperator(operator: string): boolean {
  return operator === "==" || operator === "!=";
}
