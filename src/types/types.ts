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

import type { TypeNode } from "../ast/nodes.js";
import type { SourceLocation } from "../diagnostics.js";

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
/**
 * A homogeneous array, `T[]`.
 *
 * The element type is part of the type, so `number[]` and `string[]` are
 * unrelated. There is deliberately no `any[]` in source: an untyped array would
 * accept anything and then have no element type to check a later read against,
 * which is exactly the hole a static type system exists to close.
 */
export interface ArrayType {
  readonly kind: "array";
  readonly element: Type;
}

/** One field of a struct, as resolved: a name and a type. */
export interface StructFieldType {
  readonly name: string;
  readonly type: Type;
  /**
   * Whether the constructor may leave this field out.
   *
   * Separate from `type` because the two answer different questions: `type` is what
   * a read of the field yields — `T?` for an optional field — while this is whether
   * an argument has to be written at the call site. A *required* nullable field
   * (`next: Node?`) has the first and not the second, and the pair is what lets the
   * constructor's arity be a range rather than a single number.
   */
  readonly optional: boolean;
  /** Where the field was declared, so a bad use can point back at it. */
  readonly location: SourceLocation;
}

/**
 * A declared struct: nominal, methodless, and fixed in its fields.
 *
 * **Nominal** means identity comes from the declaration rather than from the
 * fields. Two structs with identical field names and types are still unrelated,
 * which is what lets `struct Pair` and a two-field `struct Coord` be told apart
 * later — structurally identical types would be interchangeable by accident and
 * a changed field would silently change every function that took one. So the
 * fields are here for reading and for `Point(1, 2)`, and equality is the name.
 *
 * **Methodless** because a method needs a receiver and a call syntax that knows
 * which type it is on, and both are larger than the type itself is worth. The
 * functions that used to be methods are top-level functions taking the struct,
 * which is checkable already.
 */
/**
 * A type that may be absent, written `T?`.
 *
 * **The one widening in the language.** `T` satisfies `T?` and nothing else does
 * extra work: there is no variance, no `any?`, and no subtyping between unrelated
 * types, so this is the only place a rule is "more than equality" and it is stated
 * here rather than spread across `isAssignable`.
 *
 * The `?` binds to what it is written next to. `number?[]` is an array *of*
 * nullable numbers and `number[]?` is a nullable array *of* numbers, both because
 * that is the only reading each has and because a program should not have to
 * parenthesise a type to say which one it meant.
 *
 * There is no union and no optional field: a nullable type is a value or it is
 * absent, never a choice between several unrelated types, and the only way to ask
 * which it is is `x == null`.
 */
export interface NullableType {
  readonly kind: "nullable";
  readonly inner: Type;
}

export interface StructType {
  readonly kind: "struct";
  readonly name: string;
  readonly fields: readonly StructFieldType[];
}
export interface FunctionType {
  readonly kind: "function";
  readonly params: readonly Type[];
  readonly returnType: Type;
}
/**
 * The type of the `null` literal.
 *
 * A type of its own rather than "no type" or `nullable(any)`, because those two
 * would both let `let n: number = null;` through: `any` is compatible with
 * everything, and treating the literal as having no type at all would make every
 * use of it unchecked. It has no spelling in source — there is no `let x: null` —
 * so it exists only as what the literal has, and the only place it can be stored is
 * somewhere a `T?` is expected.
 */
export interface NullType {
  readonly kind: "null";
}
/** The poison value returned by a failed check. Absorbs further errors. */
export interface ErrorType {
  readonly kind: "error";
}
/**
 * A type that is compatible with every other type. Vela has no `any` in source,
 * because giving programmers one invites exactly the holes a small teaching
 * language should avoid. It exists only in the signatures of the built-in
 * functions, where `tostring` genuinely does accept a number, a string, or a bool
 * and the type system cannot express that union.
 */
export interface AnyType {
  readonly kind: "any";
}

export type Type =
  | NumberType
  | StringType
  | BoolType
  | VoidType
  | FunctionType
  | AnyFunctionType
  | ArrayType
  | NullableType
  | StructType
  | NullType
  | ErrorType
  | AnyType;

export const numberType: NumberType = { kind: "number" };
export const stringType: StringType = { kind: "string" };
export const boolType: BoolType = { kind: "bool" };
export const voidType: VoidType = { kind: "void" };
export const nullType: NullType = { kind: "null" };
export const errorType: ErrorType = { kind: "error" };
export const anyType: AnyType = { kind: "any" };

export function functionType(params: readonly Type[], returnType: Type): FunctionType {
  return { kind: "function", params, returnType };
}

export function arrayType(element: Type): ArrayType {
  return { kind: "array", element };
}

/**
 * The type that is `inner` or absent.
 *
 * **One level only.** `nullableType(nullableType(t))` is `nullableType(t)`, because
 * "absent" has no inner type to qualify — a second `?` would ask the same question
 * twice. The parser rejects `number??` for the same reason, and collapsing here means
 * the invariant holds for types built in code as well as for ones written by hand: no
 * type ever renders as `number??`, and `T?` and `T??` cannot compare unequal while
 * being the same thing.
 */
export function nullableType(inner: Type): NullableType {
  return inner.kind === "nullable" ? inner : { kind: "nullable", inner };
}

export function structType(name: string, fields: readonly StructFieldType[]): StructType {
  return { kind: "struct", name, fields };
}

/** The declared type of one field, or undefined when the struct has no such field. */
export function fieldTypeOf(type: StructType, name: string): StructFieldType | undefined {
  return type.fields.find((field) => field.name === name);
}

/**
 * The bare `function` type, for a variable that holds a function of any
 * signature.
 *
 * This is deliberately weaker than a `FunctionType`. Naming the parameters and
 * the return type would check the call site, but it would also mean a function
 * value can only be stored in a variable of exactly one signature, which is the
 * friction that makes people reach for a language with proper generics. The
 * tradeoff is stated plainly in the diagnostic below: storing a function is
 * checked, calling it through a `function`-typed variable is not.
 */
export interface AnyFunctionType {
  readonly kind: "anyFunction";
}

export const anyFunctionType: AnyFunctionType = { kind: "anyFunction" };

/**
 * Turn a type as written into a resolved type.
 *
 * The parser produces a `TypeNode`; everything downstream wants a `Type`. The
 * mapping is one-to-one and total, so a `TypeNode` never fails to resolve — the
 * errors a type annotation can have (an unknown type name, a type in the wrong
 * place) are all reported by the parser, which is the only thing that can name
 * what it expected.
 *
 * A struct name is the one case that is *not* total: `Point` means nothing until
 * the declaration is found. So `resolveTypeNode` takes the table of declared
 * structs, and an annotation naming one that does not exist resolves to
 * `errorType` — the parser has already reported the unknown name, and the poison
 * value stops a second, downstream complaint.
 */
export function resolveTypeNode(node: TypeNode, structs: ReadonlyMap<string, StructType> = new Map()): Type {
  switch (node.kind) {
    case "number":
      return numberType;
    case "string":
      return stringType;
    case "bool":
      return boolType;
    case "void":
      return voidType;
    case "function":
      return anyFunctionType;
    case "signature":
      // Recursive rather than a shallow mapping: a signature can mention another
      // signature, as in `fn(fn(number) -> number) -> number`, so resolving an
      // annotation means resolving the annotations inside it. The types were
      // already checked by the parser, so the recursion cannot fail — a bad inner
      // type has already been reported and never reaches this function.
      return functionType(
        node.params.map((param) => resolveTypeNode(param, structs)),
        resolveTypeNode(node.returnType, structs),
      );
    case "array":
      // Same reasoning, and the element nests the same way: `number[][]` is an
      // array whose elements are arrays, with no parentheses needed anywhere.
      return arrayType(resolveTypeNode(node.element, structs));
    case "nullable":
      return nullableType(resolveTypeNode(node.inner, structs));
    case "structType": {
      const declared = structs.get(node.name);
      return declared ?? errorType;
    }
  }
}

export function isError(type: Type): boolean {
  return type.kind === "error";
}

/**
 * Structural type equality. `any` and `error` are distinct from everything,
 * including each other, so a genuine mismatch involving them stays visible here;
 * the absorption happens in `isAssignable`, which is what rules consult.
 */
export function typesEqual(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "function" && b.kind === "function") {
    if (a.params.length !== b.params.length) return false;
    if (!typesEqual(a.returnType, b.returnType)) return false;
    return a.params.every((param, i) => typesEqual(param, b.params[i]!));
  }
  // An array's element type is part of the type, so `number[]` and `string[]`
  // are unrelated, and the comparison recurses for `number[][]`.
  if (a.kind === "array" && b.kind === "array") return typesEqual(a.element, b.element);
  // Nominal: the name decides, and the fields are not consulted. Two declarations
  // cannot share a name in one program, so comparing names cannot say two
  // different structs are the same type.
  if (a.kind === "struct" && b.kind === "struct") return a.name === b.name;
  // Two nullables are the same type when their inner types are, so `number?` and
  // `string?` are unrelated exactly as `number` and `string` are. `null` is its own
  // type, which the default handles: same kind, no structure.
  if (a.kind === "nullable" && b.kind === "nullable") return typesEqual(a.inner, b.inner);
  return true;
}

/**
 * Assignability: equality, plus three absorptions and one widening.
 *
 * `error` absorbs so one mistake yields one message, `any` absorbs because a
 * built-in such as `tostring` really does accept any value, and `null` absorbs
 * into a nullable type because that is what `T?` is *for*. The widening is `T`
 * satisfying `T?`, and it is the only one: there is no subtyping otherwise, so
 * `number` is not a `string?` and a `Point` is not a `Point?` in any sense a
 * program could rely on beyond "it may also be absent".
 */
export function isAssignable(target: Type, value: Type): boolean {
  if (target.kind === "error" || value.kind === "error") return true;
  if (target.kind === "any" || value.kind === "any") return true;
  // A specific function satisfies the bare `function` type, and a bare function
  // value satisfies the bare type too. What the bare type never satisfies is a
  // concrete signature: doing that would claim knowledge of parameters and a
  // return type that were deliberately thrown away.
  if (target.kind === "anyFunction") return value.kind === "function" || value.kind === "anyFunction";
  if (value.kind === "anyFunction") return false;
  // Nullable cases. `null` goes into a `T?` and nowhere else; a `T?` goes into a
  // `U?` exactly when its inner type would have gone into `U`, so the null-ness is
  // not allowed to smuggle a value across a mismatch; and a plain `T` widens into a
  // `T?` — the one place this language has subtyping.
  if (target.kind === "nullable") {
    if (value.kind === "null") return true;
    if (value.kind === "nullable") return isAssignable(target.inner, value.inner);
    return isAssignable(target.inner, value);
  }
  // Nothing else absorbs a nullable value. In particular `number?` does not satisfy
  // `number`: a value that might be absent is not a number, and pretending
  // otherwise is what would make `x + 1` on a missing value a runtime surprise.
  if (value.kind === "nullable" || value.kind === "null") return false;
  return typesEqual(target, value);
}

/** How a type is written in a diagnostic. */
export function typeToString(type: Type): string {
  switch (type.kind) {
    case "function":
      return `fn(${type.params.map(typeToString).join(", ")}) -> ${typeToString(type.returnType)}`;
    case "anyFunction":
      return "function";
    // The brackets go on the element type without parentheses, which is how it is
    // written and how it parses back: `number[][]` rather than `(number[])[]`.
    case "nullable":
      return typeToString(type.inner) + "?";
    case "array":
      return `${typeToString(type.element)}[]`;
    // A struct prints as its own name, because that is what it is written as and
    // what a diagnostic about it should say. The fields are one lookup away when
    // they are the point.
    case "struct":
      return type.name;
    case "any":
      return "any";
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
