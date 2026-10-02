/**
 * AST node definitions.
 *
 * Every node carries the `SourceLocation` it came from, so a type error or
 * runtime failure discovered several stages later can still be pointed at exact
 * characters. Nodes are a discriminated union on `kind`, which lets TypeScript
 * narrow on `node.kind` and makes an unhandled node kind a compile error.
 */

import type { SourceLocation } from "../diagnostics.js";

interface NodeBase {
  readonly location: SourceLocation;
}

// ---------------------------------------------------------------------- types

/**
 * A type as it was *written*, as opposed to a `Type` in `types/types.ts`, which is
 * a type as it was resolved.
 *
 * The two are kept apart on purpose. A declaration node has to record what the
 * programmer wrote, with a location precise enough to point a diagnostic at, while
 * the type system only ever wants to deal in resolved types that can be compared
 * structurally. Parsing produces a `TypeNode`; `resolveTypeNode` in
 * `types/types.ts` turns it into a `Type`.
 *
 * Every `TypeNode` carries a location, so a bad annotation can be reported at the
 * annotation rather than at the declaration that holds it.
 *
 * `FunctionTypeNode` is the odd one out among the primitives: it names the
 * *shape* of a value without naming its parameters or return type. It is why a
 * function can be stored in a variable, at the cost of not checking the signature
 * at the call site. A type that *does* name a signature is a different kind.
 */
export type TypeNode =
  | NumberTypeNode
  | StringTypeNode
  | BoolTypeNode
  | VoidTypeNode
  | FunctionTypeNode
  | SignatureTypeNode
  | ArrayTypeNode
  | StructTypeNode
  | NullableTypeNode;

export interface NumberTypeNode extends NodeBase {
  readonly kind: "number";
}

export interface StringTypeNode extends NodeBase {
  readonly kind: "string";
}

export interface BoolTypeNode extends NodeBase {
  readonly kind: "bool";
}

export interface VoidTypeNode extends NodeBase {
  readonly kind: "void";
}

export interface FunctionTypeNode extends NodeBase {
  readonly kind: "function";
}

/**
 * A written function signature, `fn(number, string) -> bool`.
 *
 * Where `function` says only "some function", this names the parameters and the
 * return type, so a call through a variable of this type has its arity, its
 * arguments, and its result all checked. The cost is that a function value fits
 * one exact signature: there is no subtyping, so `fn(number) -> number` is not
 * assignable to `fn(number) -> string`, nor is a one-parameter function
 * assignable to a two-parameter type. That is the same trade every statically
 * typed language makes, and it is why the bare `function` type still exists — see
 * `AnyFunctionType` in `types/types.ts`.
 *
 * Parameter *names* are not part of the type. `fn(number) -> number` and
 * `fn(string) -> number` are the same type as far as assignability is concerned,
 * which is why only the types are kept here.
 */
export interface SignatureTypeNode extends NodeBase {
  readonly kind: "signature";
  readonly params: readonly TypeNode[];
  readonly returnType: TypeNode;
}

/**
 * An array type, written `T[]`.
 *
 * The element type is part of the type, so `number[]` and `string[]` are
 * unrelated and neither satisfies the other. There is no generic array and no
 * `any[]`, because an untyped array is precisely the hole a static type system
 * exists to close — and because Vela has no way to *check* one later.
 *
 * The brackets bind to the element type, not to the whole annotation, so
 * `number[][]` is an array of arrays and needs no parentheses.
 */
export interface ArrayTypeNode extends NodeBase {
  readonly kind: "array";
  readonly element: TypeNode;
}

/**
 * A declared struct used as a type, written by its name: `Point`.
 *
 * A name rather than a shape, because structs are *nominal*. Two declarations with
 * the same field names and the same field types are still two unrelated types, so
 * the name is the whole of it — the fields are looked up from the declaration when
 * the annotation is resolved. That is what makes `struct Point` and a hand-written
 * `Pair` of identical fields impossible to confuse.
 */
export interface StructTypeNode extends NodeBase {
  readonly kind: "structType";
  readonly name: string;
}

/**
 * A type that may be absent, written `T?`.
 *
 * A postfix in the source and a node here, so `number?[]` (an array of nullable
 * numbers) and `number[]?` (a nullable array of numbers) are two different trees
 * rather than one tree the reader has to re-interpret. `null` is a *value*, not a
 * type, so it is `NullLiteral` and not a `TypeNode`: nothing in an annotation can
 * name it.
 */
export interface NullableTypeNode extends NodeBase {
  readonly kind: "nullable";
  readonly inner: TypeNode;
}

// ------------------------------------------------------------------ program

export interface Program extends NodeBase {
  readonly kind: "program";
  readonly declarations: readonly Declaration[];
}

export type Declaration =
  | LetDeclaration
  | ConstDeclaration
  | FunctionDeclaration
  | StructDeclaration
  | Statement;

// --------------------------------------------------------------- declarations

export interface LetDeclaration extends NodeBase {
  readonly kind: "letDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: TypeNode;
  readonly initializer: Expression;
}

/**
 * A binding that must not be assigned to after it is created.
 *
 * `const` binds and types exactly like `let`, and the only difference is that the
 * checker rejects every later assignment to the name. It is not a runtime
 * guarantee: nothing about the interpreter differs, so this is a compile-time rule
 * about a name rather than a value that has been made immutable.
 */
export interface ConstDeclaration extends NodeBase {
  readonly kind: "constDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: TypeNode;
  readonly initializer: Expression;
}

export interface Parameter {
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: TypeNode;
}

export interface FunctionDeclaration extends NodeBase {
  readonly kind: "fnDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly params: readonly Parameter[];
  readonly returnType: TypeNode;
  readonly body: Block;
}

/**
 * A record type: `struct Point { x: number; y: number; }`
 *
 * The three things Vela does *not* have are here by omission rather than by
 * omission elsewhere: no methods, no inheritance, and no default field values. A
 * struct is a set of named, typed fields and nothing else, and the only way to
 * build one is the declaration's own name called as a function, `Point(1, 2)`,
 * which checks its arguments against the fields in the order written. One
 * construction form, checked once, is worth more here than four that each need
 * their own rules.
 *
 * Structs are top-level declarations. A `struct` inside a block would give two
 * blocks the freedom to declare the same name and neither be wrong, which is the
 * whole reason a nominal type is nominal.
 */
export interface StructDeclaration extends NodeBase {
  readonly kind: "structDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly fields: readonly StructField[];
}

/**
 * One field of a `struct` declaration.
 *
 * `optional` is the `?` written after the name in `next?: Node`, kept apart from
 * the type on purpose. It is a property of the *declaration* — "the constructor may
 * leave this one out" — and not a property of the type, so it stays here rather than
 * being folded into the annotation as a `nullable` node. `type` is therefore written
 * exactly as it appears, and the checker turns an optional field into `T?` when it
 * resolves the fields, which is the only place that has to agree on it.
 *
 * The two are still the same feature seen from two ends: an omitted argument has to
 * be *stored* somewhere, and `null` is where it goes.
 */
export interface StructField extends NodeBase {
  readonly kind: "structField";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: TypeNode;
  readonly optional: boolean;
}

// ---------------------------------------------------------------- statements

export type Statement =
  | Block
  | IfStatement
  | WhileStatement
  | ForStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | PrintStatement
  | ExpressionStatement;

export interface Block extends NodeBase {
  readonly kind: "block";
  readonly declarations: readonly Declaration[];
}

export interface IfStatement extends NodeBase {
  readonly kind: "if";
  readonly condition: Expression;
  readonly thenBranch: Statement;
  /** An `else` that itself is an `if` is not chained, so this is a plain Statement. */
  readonly elseBranch: Statement | null;
}

export interface WhileStatement extends NodeBase {
  readonly kind: "while";
  readonly condition: Expression;
  readonly body: Statement;
}

/**
 * What a `for` header may put before its first `;`.
 *
 * A `let` or `const` declares a variable scoped to the loop; anything else is an
 * expression evaluated once. `const` is accepted so a loop whose counter is not
 * updated — `for (const i: number = 0; i < 3; )` — can say so.
 */
export type ForInitializer = LetDeclaration | ConstDeclaration | Expression | null;

export interface ForStatement extends NodeBase {
  readonly kind: "for";
  readonly initializer: ForInitializer;
  readonly condition: Expression | null;
  readonly update: Expression | null;
  readonly body: Statement;
}

export interface ReturnStatement extends NodeBase {
  readonly kind: "return";
  readonly value: Expression | null;
}

export interface BreakStatement extends NodeBase {
  readonly kind: "break";
}

export interface ContinueStatement extends NodeBase {
  readonly kind: "continue";
}

export interface PrintStatement extends NodeBase {
  readonly kind: "print";
  readonly value: Expression;
}

export interface ExpressionStatement extends NodeBase {
  readonly kind: "expressionStmt";
  readonly expression: Expression;
}

// --------------------------------------------------------------- expressions

export type Expression =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | NullLiteral
  | Variable
  | UnaryExpression
  | BinaryExpression
  | LogicalExpression
  | AssignmentExpression
  | CallExpression
  | IndexExpression
  | ArrayLiteral
  | IndexAssignmentExpression
  | FieldAccessExpression
  | FieldAssignmentExpression;

/**
 * An array literal: `[1, 2, 3]`, or `[]` for an empty one.
 *
 * The element type is not written here; it comes from the context. A literal is
 * checked against the type it is being initialised or compared to, and the
 * elements have to agree with that type. `[]` on its own therefore has no element
 * type and cannot be used without one — which is the same rule as `void` needing
 * a context to be meaningful, and it is why `let xs: number[] = [];` needs its
 * annotation and `let xs = [];` does not compile.
 */
export interface ArrayLiteral extends NodeBase {
  readonly kind: "arrayLiteral";
  readonly elements: readonly Expression[];
}

export interface NumberLiteral extends NodeBase {
  readonly kind: "numberLiteral";
  readonly value: number;
}

export interface StringLiteral extends NodeBase {
  readonly kind: "stringLiteral";
  readonly value: string;
}

export interface BooleanLiteral extends NodeBase {
  readonly kind: "booleanLiteral";
  readonly value: boolean;
}

/**
 * The `null` literal: a value that is absent.
 *
 * Its own node rather than a string or a number, because it is neither: it is the
 * only value with no operations on it except `==`/`!=` against something nullable,
 * and giving it a type of its own is what lets the checker say where it may be
 * stored instead of treating every expression as possibly-null.
 */
export interface NullLiteral extends NodeBase {
  readonly kind: "nullLiteral";
}

export interface Variable extends NodeBase {
  readonly kind: "variable";
  readonly name: string;
}

export type UnaryOperator = "!" | "-";

export interface UnaryExpression extends NodeBase {
  readonly kind: "unary";
  readonly operator: UnaryOperator;
  readonly operand: Expression;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">=";

export interface BinaryExpression extends NodeBase {
  readonly kind: "binary";
  readonly operator: BinaryOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export type LogicalOperator = "and" | "or";

export interface LogicalExpression extends NodeBase {
  readonly kind: "logical";
  readonly operator: LogicalOperator;
  readonly left: Expression;
  readonly right: Expression;
}

export interface AssignmentExpression extends NodeBase {
  readonly kind: "assignment";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly value: Expression;
}

/**
 * Assignment through an index: `xs[0] = 1`.
 *
 * A separate node rather than a field on `AssignmentExpression`, because the two
 * differ in what has to be checked. A name assignment resolves a symbol and asks
 * whether that symbol may be written; an index assignment has to do that *and*
 * read the element type out of the target to check the value against. Folding it
 * into the existing node would mean either an optional name or an optional index,
 * and one of the two would always be wrong.
 *
 * `xs[0] += 1` is desugared by the parser into this node with the value written
 * out as `xs[0] + 1`, exactly as `x += 1` becomes `x = x + 1`.
 */
export interface IndexAssignmentExpression extends NodeBase {
  readonly kind: "indexAssign";
  readonly target: Expression;
  readonly index: Expression;
  readonly value: Expression;
}

export interface CallExpression extends NodeBase {
  readonly kind: "call";
  readonly callee: Expression;
  readonly args: readonly Expression[];
}

/**
 * Reading one element out of a string or an array: `s[i]`, `xs[i]`.
 *
 * The result is whatever the target's element type says: a one-code-unit `string`
 * for a string, and `T` for a `T[]`. Keeping that in one node rather than two is
 * right because the syntax and the runtime bounds check are identical; only the
 * element type differs, and that comes from the target.
 */
export interface IndexExpression extends NodeBase {
  readonly kind: "index";
  readonly target: Expression;
  readonly index: Expression;
}

/**
 * Reading one field: `p.x`.
 *
 * The field is a name in the tree rather than an expression, because there is
 * nothing to evaluate and nothing to check about it beyond "does this struct have
 * that field" — the checker answers that from the target's type, and a dynamic
 * lookup string would only move the check to runtime.
 */
export interface FieldAccessExpression extends NodeBase {
  readonly kind: "fieldAccess";
  readonly target: Expression;
  readonly field: string;
}

/**
 * Writing one field: `p.x = 1`, and `p.x += 1` desugared into it.
 *
 * A separate node for the same reason `indexAssign` is one: assigning a *name*
 * asks whether that symbol may be written, while assigning a *field* has to do
 * that and then read the field's declared type out of the target to check the
 * value against. Folding the two together would leave one of them unchecked.
 *
 * The field is not the name being assigned, so a `const` struct's fields stay
 * writable — the same rule that lets a `const` array's elements be written.
 */
export interface FieldAssignmentExpression extends NodeBase {
  readonly kind: "fieldAssign";
  readonly target: Expression;
  readonly field: string;
  readonly value: Expression;
}

// ------------------------------------------------------------------- helpers

export type AnyNode = Program | Declaration | Expression;

/** The location a node should be reported against, for diagnostics. */
export function nodeLocation(node: AnyNode): SourceLocation {
  return node.location;
}

/** Short label used in AST dumps and error messages, e.g. `letDecl`. */
export function nodeLabel(node: AnyNode): string {
  return node.kind;
}
