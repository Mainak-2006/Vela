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
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  Block,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  IndexExpression,
  ConstDeclaration,
  ContinueStatement,
  Declaration,
  Expression,
  ExpressionStatement,
  FieldAccessExpression,
  FieldAssignmentExpression,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  IndexAssignmentExpression,
  LogicalExpression,
  NullLiteral,
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
} from "../ast/nodes.js";
import { visit, type NodeVisitor } from "../ast/visitor.js";
import { Environment } from "./environment.js";
import {
  bool,
  closure,
  createBuiltins,
  isCallable,
  NULL,
  number,
  registerStruct,
  store,
  string,
  struct as structValue,
  typeNameOf,
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
    if (builtin.kind === "native") globals.definePermanent(builtin.name, builtin);
  }
  return globals;
}

export type DeclarationObserver = (declaration: Declaration) => void;

/**
 * How many nested Vela calls are allowed before the run is abandoned.
 *
 * Chosen against the host's own limit, measured rather than guessed: a Vela
 * frame costs several host frames, and on this runtime V8's stack runs out
 * somewhere between 800 and 900 nested Vela calls. 750 leaves headroom above the
 * deepest recursion a correct program here needs — a 500-frame recursion is a
 * large one for a language with no tail calls — while still failing before the
 * host limit does. The point is a diagnostic that names the Vela program, not
 * the V8 stack overflow it happened to hit first.
 */
const MAX_CALL_DEPTH = 750;

export class Interpreter implements NodeVisitor<Value> {
  /**
   * The scope currently in effect. Swapped for a child scope while running a
   * block, a `for` header, or a function call, and swapped back afterwards. A
   * mutable single field is what makes lexical scope work without threading an
   * environment parameter through every method.
   */
  private scope: Environment;
  /** How many Vela calls are currently on the stack, for the depth guard. */
  private depth = 0;
  /**
   * Declared structs by name, so a call to a struct name can be built rather than
   * looked up. A struct is a type rather than a value, so there is nothing in the
   * environment under its name — which is why the interpreter needs its own table.
   */
  private readonly structs = new Map<string, StructDeclaration>();

  constructor(globals: Environment) {
    this.scope = globals;
  }

  /**
   * Run a whole program. Returns the value of the last top-level expression
   * statement, or `void`, which is what the REPL echoes.
   */
  run(program: Program, onDeclaration?: DeclarationObserver): Value {
    // Structs are registered before anything runs, so a call above the declaration
    // — `let p: Point = Point(1, 2);` written first — still builds a value. The
    // checker allows that order, so the runtime has to as well.
    for (const declaration of program.declarations) {
      if (declaration.kind === "structDecl") this.registerStructType(declaration);
    }
    let last: Value = VOID;
    for (const declaration of program.declarations) {
      const value = this.executeTopLevel(declaration);
      onDeclaration?.(declaration);
      if (declaration.kind === "expressionStmt") last = value;
    }
    return last;
  }

  /**
   * Record one struct's field names and arity. Field *names* are only needed for
   * printing; the runtime keeps fields positionally, which is the declaration's
   * order, so `Point(1, 2)` fills them in that order too.
   */
  registerStructType(declaration: StructDeclaration): void {
    if (this.structs.has(declaration.name)) return;
    this.structs.set(declaration.name, declaration);
    registerStruct(
      declaration.name,
      declaration.fields.map((field) => field.name),
    );
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
      case "constDecl":
        // `const` binds exactly as `let` does. The rule that stops an assignment is
        // the checker's, and it is a rule about the name rather than about the value
        // stored in it, so there is nothing to enforce at runtime.
        this.scope.define(declaration.name, store(this.evaluate(declaration.initializer)));
        return VOID;
      case "fnDecl":
        this.scope.define(declaration.name, closure(declaration, this.scope));
        return VOID;
      case "structDecl":
        // Registered up front by `run`. Reaching it here means a struct inside a
        // block, which the checker rejects; there is nothing to do either way.
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

  structDecl(node: StructDeclaration): Value {
    this.registerStructType(node);
    return VOID;
  }

  constDecl(_node: ConstDeclaration): Value {
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
    if (declaration.kind === "letDecl" || declaration.kind === "constDecl") {
      this.scope.define(declaration.name, store(this.evaluate(declaration.initializer)));
      return;
    }
    if (declaration.kind === "fnDecl") {
      this.scope.define(declaration.name, closure(declaration, this.scope));
      return;
    }
    if (declaration.kind === "structDecl") {
      this.registerStructType(declaration);
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
        if (node.initializer.kind === "letDecl" || node.initializer.kind === "constDecl") {
          this.scope.define(node.initializer.name, store(this.evaluate(node.initializer.initializer)));
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
    // A struct crossing a function boundary is copied, like any other store: the
    // callee's value and the caller's are two values afterwards.
    throw new ReturnSignal(node.value ? store(this.evaluate(node.value)) : VOID);
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

  nullLiteral(_node: NullLiteral): Value {
    return NULL;
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
    const value = store(this.evaluate(node.value));
    if (!this.scope.assign(node.name, value)) {
      throw new RuntimeError(
        `cannot assign to '${node.name}': it is not declared here`,
        node.nameLocation,
      );
    }
    return value;
  }

  index(node: IndexExpression): Value {
    const target = this.evaluate(node.target);
    if (target.kind !== "string" && target.kind !== "array") {
      throw new RuntimeError(
        `this has type '${target.kind}' and cannot be indexed`,
        node.target.location,
      );
    }
    const index = this.evaluate(node.index);
    if (index.kind !== "number") {
      throw new RuntimeError(
        `an index has type '${index.kind}' but 'number' was expected`,
        node.index.location,
      );
    }
    // A position past the end is a runtime error rather than an empty answer,
    // because an empty string is a real value that a program can build and
    // compare. Both targets are checked the same way; only the element differs.
    const i = index.value;
    const length = target.value.length;
    if (i < 0 || i >= length) {
      throw new RuntimeError(
        `index ${i} is out of range: this ${target.kind} has length ${length}`,
        node.index.location,
      );
    }
    if (target.kind === "string") {
      // `len` counts UTF-16 code units, so indexing does the same.
      return { kind: "string", value: target.value[i]! };
    }
    return target.value[i]!;
  }

  /**
   * `xs[0] = 1`.
   *
   * Two things have to be true at runtime that the checker could not know: the
   * target has to be an array, and the index has to be inside it. The second is
   * the same rule a read obeys, and it is what makes an array fixed in length —
   * writing past the end would have to grow it, and growing it silently would
   * hide the bug that wrote the wrong index.
   *
   * The cell is written in place, so every name bound to this array sees the new
   * element. That is the point of a shared reference.
   */
  indexAssign(node: IndexAssignmentExpression): Value {
    const target = this.evaluate(node.target);
    if (target.kind !== "array") {
      throw new RuntimeError(
        `cannot assign through a value of type '${target.kind}': only an array can be written to`,
        node.target.location,
      );
    }
    const index = this.evaluate(node.index);
    if (index.kind !== "number") {
      throw new RuntimeError(
        `an array index has type '${index.kind}' but 'number' was expected`,
        node.index.location,
      );
    }
    const value = store(this.evaluate(node.value));
    const i = index.value;
    if (i < 0 || i >= target.value.length) {
      throw new RuntimeError(
        `index ${i} is out of range: this array has length ${target.value.length}`,
        node.index.location,
      );
    }
    const cell = target.value as Value[];
    cell[i] = value;
    return value;
  }

  /**
   * `p.x`
   *
   * The field name has already been resolved to a position by the checker, so all
   * that is left at runtime is finding the struct and reading the cell. A field is
   * found by name here rather than by position because the value carries only the
   * name of its struct — the *order* comes from the declaration, which is
   * registered, and matching on that is what keeps `StructValue` itself small.
   */
  fieldAccess(node: FieldAccessExpression): Value {
    const target = this.evaluate(node.target);
    if (target.kind !== "struct") {
      throw new RuntimeError(
        `this has type '${typeNameOf(target)}' and has no fields`,
        node.target.location,
      );
    }
    const position = this.fieldPosition(target, node.field);
    return target.value[position] ?? VOID;
  }

  /**
   * `p.x = 1`
   *
   * The cell is written in place, so this changes the one struct. Every other name
   * holding that struct got its own copy when it was stored, which is the whole
   * difference between a struct and an array.
   */
  fieldAssign(node: FieldAssignmentExpression): Value {
    const target = this.evaluate(node.target);
    if (target.kind !== "struct") {
      throw new RuntimeError(
        `cannot assign a field of a value of type '${typeNameOf(target)}'`,
        node.target.location,
      );
    }
    const position = this.fieldPosition(target, node.field);
    const value = store(this.evaluate(node.value));
    (target.value as Value[])[position] = value;
    return value;
  }

  /** Which field of `value` the name refers to. */
  private fieldPosition(value: Value & { kind: "struct" }, field: string): number {
    const declaration = this.structs.get(value.name);
    const position = declaration?.fields.findIndex((f) => f.name === field) ?? -1;
    if (position < 0) {
      // Unreachable through the checker; a struct value whose declaration the
      // runtime never saw prints rather than fails, so neither does a read.
      return 0;
    }
    return position;
  }

  /**
   * `[1, 2, 3]`.
   *
   * Each element is evaluated first and the array is built from the results, so a
   * literal is a value like any other: `let xs: number[] = [f(), g()];` runs both
   * calls, left to right.
   */
  arrayLiteral(node: ArrayLiteral): Value {
    // Each element is stored, so a struct in an array is copied into it: the array
    // holds its own value and the name the struct was built from still has its own.
    return { kind: "array", value: node.elements.map((element) => store(this.evaluate(element))) };
  }

  call(node: CallExpression): Value {
    // `Point(1, 2)` builds a value rather than calling one. The callee is looked up
    // rather than evaluated because a struct's name is not a value: there is
    // nothing in the environment under that name to evaluate.
    const struct = this.structCallee(node);
    if (struct) {
      const fields = node.args.map((arg) => store(this.evaluate(arg)));
      if (fields.length > struct.fields.length) {
        // Unreachable through the checker, which reports the arity first.
        throw new RuntimeError(
          `'${struct.name}' takes ${struct.fields.length} arguments but got ${fields.length}`,
          node.location,
        );
      }
      // An omitted argument is `null`, which is what the field's resolved type already
      // promises. The optional fields are a suffix — the parser refuses a required one
      // after an optional one — so padding at the end fills exactly the fields that
      // were left out, and nothing else can be missing.
      while (fields.length < struct.fields.length) fields.push(NULL);
      return structValue(struct.name, fields);
    }
    const callee = this.evaluate(node.callee);
    if (!isCallable(callee)) {
      throw new RuntimeError(
        callee.kind === "struct"
          ? `this is a '${callee.name}' value, not a function`
          : `this is not a function (it has type '${typeNameOf(callee)}')`,
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
  /** The struct a call is constructing, or null when the callee is not a struct name. */
  private structCallee(node: CallExpression): StructDeclaration | null {
    if (node.callee.kind !== "variable") return null;
    return this.structs.get(node.callee.name) ?? null;
  }

  private invoke(
    declaration: FunctionDeclaration,
    closureScope: Environment,
    args: readonly Value[],
  ): Value {
    // Guard the call depth rather than letting a runaway recursion run the host
    // stack out. An uncatchable `RangeError` from V8 would bypass every
    // `RuntimeError` handler in the program, the REPL, and the CLI alike, and
    // report a host implementation detail instead of anything about the Vela
    // program that caused it.
    if (this.depth >= MAX_CALL_DEPTH) {
      throw new RuntimeError(
        `maximum call depth exceeded (${MAX_CALL_DEPTH} nested calls): the program is probably recursing without a base case`,
        declaration.location,
      );
    }
    const outer = this.scope;
    const scope = closureScope.child();
    declaration.params.forEach((param, i) => {
      scope.define(param.name, store(args[i] ?? VOID));
    });
    this.scope = scope;
    this.depth++;
    try {
      for (const inner of declaration.body.declarations) this.executeLocal(inner);
      return VOID;
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    } finally {
      // Decremented here rather than on the success path alone, so a throw from
      // a nested call does not leave the count permanently raised.
      this.depth--;
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
    // Functions, natives and arrays are compared by reference, not by contents. A
    // closure has no contents to compare — two closures over the same code are
    // still two closures — and an array is a shared value: `xs` and a second name
    // for it are the same array, while `[1, 2] == [1, 2]` is false because they are
    // two arrays that happen to hold the same elements.
    case "function":
    case "native":
    case "array":
      return left === right;
    // A struct is compared by its fields instead, because it is a value rather than
    // a reference: storing one copies it, so identity would answer "are these the
    // same box" — which is true only for one name on one variable, and false the
    // moment a struct is copied. A comparison that reports every copy as unequal to
    // its original cannot be used to ask whether two structs hold the same thing.
    //
    // An array *inside* a struct is still compared by reference, because that is
    // what `==` on two arrays does anywhere else, and one rule for arrays at every
    // depth is worth more than one exception. It also cannot loop: a struct cannot
    // contain itself, and every container inside a struct was copied when it was
    // stored, so the graph of values reachable from a struct is a finite tree.
    case "struct":
      return (
        right.kind === "struct" &&
        left.name === right.name &&
        left.value.length === right.value.length &&
        left.value.every((field, i) => valuesEqual(field, right.value[i]!))
      );
    case "null":
      return right.kind === "null";
    case "void":
      return right.kind === "void";
  }
}
