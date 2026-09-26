/**
 * The Interpreter — a tree walker.
 *
 * Each AST node maps to one visitor method that returns the `Value` its
 * expression denotes. There is no bytecode and no intermediate form: the tree is
 * the program, and `visit` is the dispatch loop.
 *
 * **Control flow uses exceptions.** `return`, `break`, and `continue` need to
 * unwind an arbitrary number of nested visitor calls, and exceptions express that
 * directly. `ReturnSignal` carries a value; `break` and `continue` are two
 * singletons, so the common iteration allocates nothing.
 *
 * **The checker has already done the work that makes this simple.** Types are
 * known to be correct, so the evaluator does not re-check operand types. What is
 * left are the runtime-only failures, chiefly division by zero. The type
 * assertions that do appear are a backstop for programs run without the checker
 * (a REPL entry line, for instance), and they report through `RuntimeError`
 * rather than crashing.
 */

import type { SourceLocation } from "../diagnostics.js";
import type {
  AssignmentExpression,
  BinaryExpression,
  Block,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  ContinueStatement,
  Declaration,
  Expression,
  ExpressionStatement,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  LogicalExpression,
  NumberLiteral,
  PrintStatement,
  Program,
  ReturnStatement,
  Statement,
  StringLiteral,
  UnaryExpression,
  Variable,
  WhileStatement,
} from "../ast/nodes.js";
import { visit, type NodeVisitor } from "../ast/visitor.js";
import { Environment } from "./environment.js";
import {
  bool,
  closure,
  createBuiltins,
  isCallable,
  number,
  string,
  VOID,
  write,
  type Value,
} from "./values.js";

/** A failure only a running program can hit. Carries a source location. */
export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly location: SourceLocation,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

class ReturnSignal {
  constructor(readonly value: Value) {}
}

class BreakSignal {
  static readonly INSTANCE = new BreakSignal();
  private constructor() {}
}

class ContinueSignal {
  static readonly INSTANCE = new ContinueSignal();
  private constructor() {}
}

/** Create a global scope preloaded with the built-in functions. */
export function createGlobalEnvironment(): Environment {
  const globals = new Environment(null);
  for (const builtin of createBuiltins()) {
    if (builtin.kind === "native") globals.define(builtin.name, builtin);
  }
  return globals;
}

export type DeclarationObserver = (declaration: Declaration) => void;

export class Interpreter implements NodeVisitor<Value> {
  /**
   * The scope currently in effect. Swapped for a child scope while running a
   * block, a `for` header, or a function call, and swapped back afterwards. A
   * mutable single field is what makes lexical scope work without threading an
   * environment parameter through every method.
   */
  private scope: Environment;

  constructor(globals: Environment) {
    this.scope = globals;
  }

  /**
   * Run a whole program. Returns the value of the last top-level expression
   * statement, or `void`, which is what the REPL echoes.
   */
  run(program: Program, onDeclaration?: DeclarationObserver): Value {
    let last: Value = VOID;
    for (const declaration of program.declarations) {
      const value = this.executeTopLevel(declaration);
      onDeclaration?.(declaration);
      if (declaration.kind === "expressionStmt") last = value;
    }
    return last;
  }

  private visit(node: Declaration | Statement | Expression): Value {
    return visit(node, this);
  }

  private evaluate(expression: Expression): Value {
    return this.visit(expression);
  }

  private execute(statement: Statement): void {
    this.visit(statement);
  }

  // ------------------------------------------------------- top-level bindings

  private executeTopLevel(declaration: Declaration): Value {
    switch (declaration.kind) {
      case "letDecl":
        this.scope.define(declaration.name, this.evaluate(declaration.initializer));
        return VOID;
      case "fnDecl":
        this.scope.define(declaration.name, closure(declaration, this.scope));
        return VOID;
      case "expressionStmt":
        return this.evaluate(declaration.expression);
      default:
        this.execute(declaration);
        return VOID;
    }
  }

  // ----------------------------------------------------------------- program

  program(_node: Program): Value {
    return VOID;
  }

  /** Reached only via `visit` for a declaration in an unexpected position. */
  letDecl(_node: Declaration): Value {
    return VOID;
  }

  fnDecl(node: FunctionDeclaration): Value {
    this.scope.define(node.name, closure(node, this.scope));
    return VOID;
  }

  // --------------------------------------------------------------- statements

  block(node: Block): Value {
    return this.inChildScope(() => {
      for (const declaration of node.declarations) this.executeLocal(declaration);
    });
  }

  /** A declaration in statement position inside a block. */
  private executeLocal(declaration: Declaration): void {
    if (declaration.kind === "letDecl") {
      this.scope.define(declaration.name, this.evaluate(declaration.initializer));
      return;
    }
    if (declaration.kind === "fnDecl") {
      this.scope.define(declaration.name, closure(declaration, this.scope));
      return;
    }
    this.execute(declaration);
  }

  /** Run `body` with `this.scope` replaced by a fresh child, then restore it. */
  private inChildScope(body: () => void): Value {
    const outer = this.scope;
    this.scope = outer.child();
    try {
      body();
    } finally {
      this.scope = outer;
    }
    return VOID;
  }

  ifStmt(node: IfStatement): Value {
    const condition = this.evaluate(node.condition);
    if (isTrue(condition, node.condition.location)) {
      this.execute(node.thenBranch);
    } else if (node.elseBranch) {
      this.execute(node.elseBranch);
    }
    return VOID;
  }

  whileStmt(node: WhileStatement): Value {
    while (isTrue(this.evaluate(node.condition), node.condition.location)) {
      if (this.runIteration(node.body)) return VOID; // `break`
    }
    return VOID;
  }

  forStmt(node: ForStatement): Value {
    // The header variable is scoped to the loop, so it is gone once the loop ends.
    return this.inChildScope(() => {
      if (node.initializer !== null) {
        if (node.initializer.kind === "letDecl") {
          this.scope.define(node.initializer.name, this.evaluate(node.initializer.initializer));
        } else {
          this.evaluate(node.initializer);
        }
      }
      while (node.condition === null || isTrue(this.evaluate(node.condition), node.condition.location)) {
        const broke = this.runIteration(node.body);
        if (broke) return; // `break`: skip the update, as C does.
        if (node.update) this.evaluate(node.update);
      }
    });
  }

  /**
   * Run one iteration's body. Returns true if the loop should stop, which is how
   * `break` is reported without unwinding the `while` itself.
   */
  private runIteration(body: Statement): boolean {
    try {
      this.execute(body);
      return false;
    } catch (signal) {
      if (signal instanceof BreakSignal) return true;
      if (signal instanceof ContinueSignal) return false;
      throw signal;
    }
  }

  returnStmt(node: ReturnStatement): Value {
    throw new ReturnSignal(node.value ? this.evaluate(node.value) : VOID);
  }

  breakStmt(_node: BreakStatement): Value {
    throw BreakSignal.INSTANCE;
  }

  continueStmt(_node: ContinueStatement): Value {
    throw ContinueSignal.INSTANCE;
  }

  printStmt(node: PrintStatement): Value {
    write(this.evaluate(node.value));
    return VOID;
  }

  expressionStmt(node: ExpressionStatement): Value {
    this.evaluate(node.expression);
    return VOID;
  }

  // -------------------------------------------------------------- expressions

  numberLiteral(node: NumberLiteral): Value {
    return number(node.value);
  }

  stringLiteral(node: StringLiteral): Value {
    return string(node.value);
  }

  booleanLiteral(node: BooleanLiteral): Value {
    return bool(node.value);
  }

  variable(node: Variable): Value {
    const value = this.scope.get(node.name);
    if (value === undefined) {
      // The checker rejects unknown names, so this only happens for code run
      // without it, such as a REPL line entered in an inconsistent state.
      throw new RuntimeError(`cannot find '${node.name}' in this scope`, node.location);
    }
    return value;
  }

  unary(node: UnaryExpression): Value {
    const operand = this.evaluate(node.operand);
    if (node.operator === "!") {
      return bool(!asBool(operand, "!", node.location));
    }
    return number(-asNumber(operand, "-", node.location));
  }

  binary(node: BinaryExpression): Value {
    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);
    const op = node.operator;

    switch (op) {
      case "+":
        if (left.kind === "string" && right.kind === "string") {
          return string(left.value + right.value);
        }
        return number(asNumber(left, op, node.location) + asNumber(right, op, node.location));
      case "-":
        return number(asNumber(left, op, node.location) - asNumber(right, op, node.location));
      case "*":
        return number(asNumber(left, op, node.location) * asNumber(right, op, node.location));
      case "/": {
        const divisor = asNumber(right, op, node.location);
        if (divisor === 0) throw new RuntimeError("division by zero", node.location);
        return number(asNumber(left, op, node.location) / divisor);
      }
      case "%": {
        const divisor = asNumber(right, op, node.location);
        if (divisor === 0) throw new RuntimeError("remainder by zero", node.location);
        return number(asNumber(left, op, node.location) % divisor);
      }
      case "==":
        return bool(valuesEqual(left, right));
      case "!=":
        return bool(!valuesEqual(left, right));
      case "<":
        return bool(asNumber(left, op, node.location) < asNumber(right, op, node.location));
      case ">":
        return bool(asNumber(left, op, node.location) > asNumber(right, op, node.location));
      case "<=":
        return bool(asNumber(left, op, node.location) <= asNumber(right, op, node.location));
      case ">=":
        return bool(asNumber(left, op, node.location) >= asNumber(right, op, node.location));
      default:
        throw new RuntimeError(`unsupported operator '${op}'`, node.location);
    }
  }

  logical(node: LogicalExpression): Value {
    const spelling = node.operator === "and" ? "&&" : "||";
    const left = this.evaluate(node.left);

    // Short-circuit: the right operand is not evaluated when the left already
    // decides the result. This is observable, not merely an optimisation, because
    // the right operand may have a side effect such as an assignment.
    if (left.kind === "bool") {
      if (node.operator === "and" && !left.value) return bool(false);
      if (node.operator === "or" && left.value) return bool(true);
    }

    const right = this.evaluate(node.right);
    return bool(asBool(right, spelling, node.location));
  }

  assignment(node: AssignmentExpression): Value {
    const value = this.evaluate(node.value);
    if (!this.scope.assign(node.name, value)) {
      throw new RuntimeError(
        `cannot assign to '${node.name}': it is not declared here`,
        node.nameLocation,
      );
    }
    return value;
  }

  call(node: CallExpression): Value {
    const callee = this.evaluate(node.callee);
    if (!isCallable(callee)) {
      throw new RuntimeError(
        `this is not a function (it has type '${callee.kind}')`,
        node.callee.location,
      );
    }
    const args = node.args.map((arg) => this.evaluate(arg));

    if (callee.kind === "native") {
      if (args.length !== callee.arity) {
        throw new RuntimeError(
          `'${callee.name}' expects ${callee.arity} argument${callee.arity === 1 ? "" : "s"} but got ${args.length}`,
          node.location,
        );
      }
      return callee.call(args);
    }

    if (args.length !== callee.declaration.params.length) {
      throw new RuntimeError(
        `'${callee.declaration.name}' expects ${callee.declaration.params.length} arguments but got ${args.length}`,
        node.location,
      );
    }
    return this.invoke(callee.declaration, callee.closure, args);
  }

  /** Bind arguments into a fresh child scope and run a Vela function body. */
  private invoke(
    declaration: FunctionDeclaration,
    closureScope: Environment,
    args: readonly Value[],
  ): Value {
    const outer = this.scope;
    const scope = closureScope.child();
    declaration.params.forEach((param, i) => {
      scope.define(param.name, args[i] ?? VOID);
    });
    this.scope = scope;
    try {
      for (const inner of declaration.body.declarations) this.executeLocal(inner);
      return VOID;
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    } finally {
      this.scope = outer;
    }
  }
}

/** Only `bool` counts as true. The checker enforces this statically. */
function isTrue(value: Value, location: SourceLocation): boolean {
  if (value.kind !== "bool") {
    throw new RuntimeError(`expected a 'bool' condition, but got '${value.kind}'`, location);
  }
  return value.value;
}

function asNumber(value: Value, op: string, location: SourceLocation): number {
  if (value.kind !== "number") {
    throw new RuntimeError(
      `operator '${op}' cannot be applied to a value of type '${value.kind}'`,
      location,
    );
  }
  return value.value;
}

function asBool(value: Value, op: string, location: SourceLocation): boolean {
  if (value.kind !== "bool") {
    throw new RuntimeError(
      `operator '${op}' cannot be applied to a value of type '${value.kind}'`,
      location,
    );
  }
  return value.value;
}

/** Equality only ever holds between two values of the same kind, which the checker guarantees. */
function valuesEqual(left: Value, right: Value): boolean {
  switch (left.kind) {
    case "number":
      return right.kind === "number" && left.value === right.value;
    case "string":
      return right.kind === "string" && left.value === right.value;
    case "bool":
      return right.kind === "bool" && left.value === right.value;
    case "function":
    case "native":
      return left === right;
    case "void":
      return right.kind === "void";
  }
}
