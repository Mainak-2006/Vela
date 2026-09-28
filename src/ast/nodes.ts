/**
 * AST node definitions.
 *
 * Every node carries the `SourceLocation` it came from, so a type error or
 * runtime failure discovered several stages later can still be pointed at exact
 * characters. Nodes are a discriminated union on `kind`, which lets TypeScript
 * narrow on `node.kind` and makes an unhandled node kind a compile error.
 */

import type { SourceLocation } from "../diagnostics.js";

/**
 * The type names usable in annotations.
 *
 * `function` is the odd one out: the other four are primitives, and this one names
 * the *shape* of a value without naming its parameters or return type. It is why a
 * function can be stored in a variable, at the cost of not checking the signature
 * at the call site.
 */
export type PrimitiveTypeName = "number" | "string" | "bool" | "void" | "function";

export const PRIMITIVE_TYPE_NAMES: readonly PrimitiveTypeName[] = [
  "number",
  "string",
  "bool",
  "void",
  "function",
];

interface NodeBase {
  readonly location: SourceLocation;
}

// ------------------------------------------------------------------ program

export interface Program extends NodeBase {
  readonly kind: "program";
  readonly declarations: readonly Declaration[];
}

export type Declaration = LetDeclaration | FunctionDeclaration | Statement;

// --------------------------------------------------------------- declarations

export interface LetDeclaration extends NodeBase {
  readonly kind: "letDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: PrimitiveTypeName;
  readonly typeLocation: SourceLocation;
  readonly initializer: Expression;
}

export interface Parameter {
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly type: PrimitiveTypeName;
  readonly typeLocation: SourceLocation;
}

export interface FunctionDeclaration extends NodeBase {
  readonly kind: "fnDecl";
  readonly name: string;
  readonly nameLocation: SourceLocation;
  readonly params: readonly Parameter[];
  readonly returnType: PrimitiveTypeName;
  readonly returnTypeLocation: SourceLocation;
  readonly body: Block;
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

export type ForInitializer = LetDeclaration | Expression | null;

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
  | Variable
  | UnaryExpression
  | BinaryExpression
  | LogicalExpression
  | AssignmentExpression
  | CallExpression
  | IndexExpression;

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

export interface CallExpression extends NodeBase {
  readonly kind: "call";
  readonly callee: Expression;
  readonly args: readonly Expression[];
}

/**
 * Reading one code unit out of a string: `s[i]`.
 *
 * Vela has no collections, so a string is the only thing that can be indexed. The
 * result is a one-code-unit string rather than a `number`, which keeps every
 * indexed result a `string` and means the usual `+` and `len` rules still apply.
 */
export interface IndexExpression extends NodeBase {
  readonly kind: "index";
  readonly target: Expression;
  readonly index: Expression;
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
