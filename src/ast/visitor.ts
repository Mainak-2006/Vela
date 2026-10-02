/**
 * AST traversal.
 *
 * `visit` dispatches on `node.kind` into a visitor object. Because every handler
 * is a required member of `NodeVisitor`, adding a node kind to the union forces
 * every traversal (the type checker, the interpreter, the printer) to handle it.
 * That is the whole point: an unhandled case is a compile error, not a silent
 * fallthrough at runtime.
 */

import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  Block,
  Declaration,
  BooleanLiteral,
  NullLiteral,
  BreakStatement,
  CallExpression,
  IndexExpression,
  ConstDeclaration,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  FieldAccessExpression,
  FieldAssignmentExpression,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  IndexAssignmentExpression,
  LetDeclaration,
  LogicalExpression,
  NumberLiteral,
  PrintStatement,
  Program,
  ReturnStatement,
  Statement,
  StringLiteral,
  StructDeclaration,
  UnaryExpression,
  Variable,
  WhileStatement,
} from "./nodes.js";

/** One method per node kind, each returning the traversal's result type. */
export interface NodeVisitor<T> {
  program(node: Program): T;
  letDecl(node: LetDeclaration): T;
  constDecl(node: ConstDeclaration): T;
  fnDecl(node: FunctionDeclaration): T;
  structDecl(node: StructDeclaration): T;
  block(node: Block): T;
  ifStmt(node: IfStatement): T;
  whileStmt(node: WhileStatement): T;
  forStmt(node: ForStatement): T;
  returnStmt(node: ReturnStatement): T;
  breakStmt(node: BreakStatement): T;
  continueStmt(node: ContinueStatement): T;
  printStmt(node: PrintStatement): T;
  expressionStmt(node: ExpressionStatement): T;
  numberLiteral(node: NumberLiteral): T;
  stringLiteral(node: StringLiteral): T;
  booleanLiteral(node: BooleanLiteral): T;
  nullLiteral(node: NullLiteral): T;
  variable(node: Variable): T;
  unary(node: UnaryExpression): T;
  binary(node: BinaryExpression): T;
  logical(node: LogicalExpression): T;
  assignment(node: AssignmentExpression): T;
  call(node: CallExpression): T;
  index(node: IndexExpression): T;
  indexAssign(node: IndexAssignmentExpression): T;
  fieldAccess(node: FieldAccessExpression): T;
  fieldAssign(node: FieldAssignmentExpression): T;
  arrayLiteral(node: ArrayLiteral): T;
}

export function visit<T>(node: Program, visitor: NodeVisitor<T>): T;
export function visit<T>(node: LetDeclaration, visitor: NodeVisitor<T>): T;
export function visit<T>(node: FunctionDeclaration, visitor: NodeVisitor<T>): T;
export function visit<T>(node: Declaration, visitor: NodeVisitor<T>): T;
export function visit<T>(node: Statement, visitor: NodeVisitor<T>): T;
export function visit<T>(node: Expression, visitor: NodeVisitor<T>): T;
/** Catch-all for callers holding a node whose exact kind is not statically known. */
export function visit<T>(
  node: Program | Declaration | Statement | Expression,
  visitor: NodeVisitor<T>,
): T;
export function visit<T>(
  node: Program | Declaration | Statement | Expression,
  visitor: NodeVisitor<T>,
): T {
  switch (node.kind) {
    case "program":
      return visitor.program(node);
    case "letDecl":
      return visitor.letDecl(node);
    case "constDecl":
      return visitor.constDecl(node);
    case "fnDecl":
      return visitor.fnDecl(node);
    case "structDecl":
      return visitor.structDecl(node);
    case "block":
      return visitor.block(node);
    case "if":
      return visitor.ifStmt(node);
    case "while":
      return visitor.whileStmt(node);
    case "for":
      return visitor.forStmt(node);
    case "return":
      return visitor.returnStmt(node);
    case "break":
      return visitor.breakStmt(node);
    case "continue":
      return visitor.continueStmt(node);
    case "print":
      return visitor.printStmt(node);
    case "expressionStmt":
      return visitor.expressionStmt(node);
    case "numberLiteral":
      return visitor.numberLiteral(node);
    case "stringLiteral":
      return visitor.stringLiteral(node);
    case "booleanLiteral":
      return visitor.booleanLiteral(node);
    case "nullLiteral":
      return visitor.nullLiteral(node);
    case "variable":
      return visitor.variable(node);
    case "unary":
      return visitor.unary(node);
    case "binary":
      return visitor.binary(node);
    case "logical":
      return visitor.logical(node);
    case "assignment":
      return visitor.assignment(node);
    case "call":
      return visitor.call(node);
    case "index":
      return visitor.index(node);
    case "fieldAccess":
      return visitor.fieldAccess(node);
    case "fieldAssign":
      return visitor.fieldAssign(node);
    case "indexAssign":
      return visitor.indexAssign(node);
    case "arrayLiteral":
      return visitor.arrayLiteral(node);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
