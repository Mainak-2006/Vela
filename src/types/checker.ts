/**
 * The Checker — AST in, diagnostics out.
 *
 * Two jobs, done in one pass because they share the same scope stack:
 *
 *   1. **Name resolution.** Every `Variable` is looked up in the scope chain. An
 *      unknown name is an error, not a runtime surprise.
 *   2. **Type checking.** Every expression is given a `Type`, and every operator,
 *      condition, assignment, argument, and return is checked against it.
 *
 * Vela's type system is deliberately small: four primitives, no subtyping, no
 * unions, no inference. Every rule below is a direct consequence of that.
 *
 * Two deliberate design choices worth knowing about:
 *
 *   - **Functions are declared before use, but may recurse.** A `fnDecl` installs
 *     its own signature into the enclosing scope *before* the body is checked, so
 *     `fn fib(n) { ... fib(n - 1) ... }` type-checks. Mutual recursion and
 *     forward references do not, and cannot.
 *
 *   - **A non-void function must end with `return`.** This is a syntactic check,
 *     not path analysis: a function whose last statement is `if` with returns in
 *     both arms is still rejected. Full flow-sensitive return analysis is a
 *     natural exercise once the rest of this file feels comfortable.
 */

import type { SourceLocation } from "../diagnostics.js";
import { DiagnosticBag, span } from "../diagnostics.js";
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
  ForInitializer,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  IndexExpression,
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
import { BUILTIN_SPECS } from "../runtime/values.js";
import {
  anyType,
  boolType,
  errorType,
  functionType,
  isArithmeticOperator,
  isAssignable,
  isComparisonOperator,
  isEqualityOperator,
  isError,
  numberType,
  primitiveType,
  stringType,
  typeToString,
  type FunctionType,
  type Type,
} from "./types.js";

/** What a name in scope refers to. `kind` only sharpens diagnostics. */
export interface Symbol {
  readonly name: string;
  readonly type: Type;
  readonly kind: "variable" | "parameter" | "function";
  readonly location: SourceLocation;
}

/**
 * A lexical scope. `lookup` walks outward; `declaredHere` does not, which is what
 * makes shadowing (`let x` inside a block) legal while a duplicate in the *same*
 * scope is an error.
 */
export class Scope {
  private readonly symbols = new Map<string, Symbol>();

  constructor(private readonly parent: Scope | null) {}

  define(symbol: Symbol): void {
    this.symbols.set(symbol.name, symbol);
  }

  lookup(name: string): Symbol | null {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const found = scope.symbols.get(name);
      if (found) return found;
    }
    return null;
  }

  declaredHere(name: string): boolean {
    return this.symbols.has(name);
  }

  /** Names in this scope only, for "did you mean" style hints. */
  namesHere(): string[] {
    return [...this.symbols.keys()];
  }
}

/**
 * Type-check `program`, reporting problems to `bag`.
 *
 * `known` seeds the root scope with names that already exist. The REPL passes the
 * bindings accumulated from earlier entries here, so that a line referencing a
 * variable defined in a previous line still resolves. Nothing in a source file
 * ever needs this.
 */
export function check(program: Program, bag: DiagnosticBag, known: readonly Symbol[] = []): void {
  new Checker(bag, known).checkProgram(program);
}

class Checker implements NodeVisitor<Type> {
  private scope: Scope;
  /** Return type of the function currently being checked, or null at top level. */
  private currentReturn: Type | null = null;
  /** Innermost function declaration, for naming the function in messages. */
  private currentFunction: string | null = null;
  /**
   * Offsets of function declarations whose signature is already installed by
   * hoisting. Keyed on the declaration's own location so that a nested re-entry
   * into the same node is still recognised as hoisted.
   */
  private readonly hoisted = new Set<number>();

  constructor(
    private readonly bag: DiagnosticBag,
    known: readonly Symbol[],
  ) {
    this.scope = new Scope(null);
    for (const symbol of known) this.scope.define(symbol);
    this.seedBuiltins();
  }

  /**
   * Install the built-in signatures into the root scope, so `tostring(1)` and
   * friends type-check. The signatures come from the same table the runtime uses
   * to build the actual values, which is what keeps the two in agreement.
   */
  private seedBuiltins(): void {
    for (const spec of BUILTIN_SPECS) {
      this.scope.define({
        name: spec.name,
        type: functionType(spec.paramTypes, spec.returnType),
        kind: "function",
        location: { offset: 0, length: 0, line: 1, column: 1 },
      });
    }
  }

  checkProgram(program: Program): void {
    this.hoistFunctions(program.declarations);
    for (const declaration of program.declarations) this.visitDeclaration(declaration);
  }

  /**
   * Install every function's signature in this scope before any body is checked.
   *
   * This is what makes a forward reference and mutual recursion work: when `isEven`
   * calls `isOdd` in its body, `isOdd`'s signature is already visible, so the name
   * resolves. The interpreter has always supported this at runtime — a function
   * declaration is hoisted there too — so the two passes are also what keeps the
   * checker's verdict and the runtime's behaviour in agreement.
   *
   * `let` declarations are deliberately not hoisted. A variable's type comes from
   * its initialiser, which is a value that has to be computed, so using one before
   * it appears is a genuine error rather than a missing lookup.
   */
  private hoistFunctions(declarations: readonly Declaration[]): void {
    for (const declaration of declarations) {
      if (declaration.kind !== "fnDecl") continue;
      this.hoisted.add(declaration.location.offset);
      this.declare(
        declaration.name,
        this.signatureOf(declaration),
        "function",
        declaration.nameLocation,
      );
    }
  }

  /** The declared signature of a function, as a `FunctionType`. */
  private signatureOf(node: FunctionDeclaration): FunctionType {
    return functionType(
      node.params.map((p) => primitiveType(p.type)),
      primitiveType(node.returnType),
    );
  }

  /** Dispatch to the visitor method for this node, returning its type. */
  private visit(node: Declaration | Statement | Expression): Type {
    return visit(node, this);
  }

  private visitDeclaration(declaration: Program["declarations"][number]): void {
    switch (declaration.kind) {
      case "letDecl":
        this.checkLetDecl(
          declaration.name,
          primitiveType(declaration.type),
          declaration.initializer,
          declaration.nameLocation,
        );
        return;
      case "fnDecl":
        visit(declaration, this);
        return;
      default:
        visit(declaration, this);
    }
  }

  // ------------------------------------------------------------------- scopes

  private declare(
    name: string,
    type: Type,
    kind: Symbol["kind"],
    location: SourceLocation,
  ): void {
    const existing = this.scope.lookup(name);
    if (this.scope.declaredHere(name)) {
      this.bag.add(`'${name}' is already declared in this scope`, location, [
        `the previous ${existing?.kind ?? "declaration"} of '${name}' is here`,
      ]);
      return;
    }
    this.scope.define({ name, type, kind, location });
  }

  // ------------------------------------------------------------- declarations

  private checkLetDecl(
    name: string,
    declaredType: Type,
    initializer: Expression,
    nameLocation: SourceLocation,
  ): void {
    const actual = this.visit(initializer);
    // A variable needs a value it can hold, and `void` is the absence of one.
    if (declaredType.kind === "void") {
      this.bag.add(`a variable cannot have type 'void'`, nameLocation, [
        "'void' is only meaningful as a function return type",
      ]);
    } else if (!isAssignable(declaredType, actual)) {
      this.bag.add(
        `cannot initialise '${name}' of type '${typeToString(declaredType)}' with a value of type '${typeToString(actual)}'`,
        nameLocation,
      );
    }
    this.declare(name, declaredType, "variable", nameLocation);
  }

  fnDecl(node: FunctionDeclaration): Type {
    const signature = this.signatureOf(node);
    // Hoisting already installed this signature; declaring it again would report a
    // duplicate. Anything not hoisted is installed here, which is what lets a
    // function still recurse.
    if (!this.hoisted.has(node.location.offset)) {
      this.declare(node.name, signature, "function", node.nameLocation);
    }

    const outer = this.scope;
    this.scope = new Scope(this.scope);
    for (const param of node.params) {
      if (this.scope.declaredHere(param.name)) {
        this.bag.add(`duplicate parameter '${param.name}'`, param.nameLocation);
      } else {
        this.scope.define({
          name: param.name,
          type: primitiveType(param.type),
          kind: "parameter",
          location: param.nameLocation,
        });
      }
    }

    const previousReturn = this.currentReturn;
    const previousFunction = this.currentFunction;
    this.currentReturn = signature.returnType;
    this.currentFunction = node.name;
    this.block(node.body);
    this.requireTerminatingReturn(node);
    this.currentReturn = previousReturn;
    this.currentFunction = previousFunction;
    this.scope = outer;

    return errorType; // A declaration is not an expression.
  }

  /**
   * A non-void function must not be able to finish without producing a value.
   *
   * The test is `definitelyReturns` below, which is real (if small) flow analysis
   * rather than a syntactic check on the last statement. An `if`/`else` chain
   * whose arms all return is the single most common shape of a non-void function
   * in a C-like language, so a purely syntactic rule would reject most
   * well-written programs.
   */
  private requireTerminatingReturn(node: FunctionDeclaration): void {
    const returnType = primitiveType(node.returnType);
    if (returnType.kind === "void") return;
    if (definitelyReturnsBlock(node.body)) return;
    this.bag.add(
      `a function returning '${node.returnType}' must end with a return statement`,
      node.body.location,
      [`the body of '${node.name}' can finish without producing a '${node.returnType}'`],
    );
  }

  // --------------------------------------------------------------- statements

  block(node: Block): Type {
    const outer = this.scope;
    this.scope = new Scope(outer);
    // A block is a scope, so it hoists its own functions the same way the program
    // does. This is what lets a pair of mutually recursive helpers be written as
    // sibling declarations inside a function body.
    this.hoistFunctions(node.declarations);
    for (const declaration of node.declarations) this.visitDeclaration(declaration);
    this.scope = outer;
    return errorType;
  }

  ifStmt(node: IfStatement): Type {
    this.requireCondition(node.condition, "condition");
    this.visit(node.thenBranch);
    if (node.elseBranch) this.visit(node.elseBranch);
    return errorType;
  }

  whileStmt(node: WhileStatement): Type {
    this.requireCondition(node.condition, "condition");
    this.visit(node.body);
    return errorType;
  }

  forStmt(node: ForStatement): Type {
    // The header's `let` is scoped to the loop, so it is invisible afterwards.
    const outer = this.scope;
    this.scope = new Scope(outer);
    this.visitForInit(node.initializer);
    if (node.condition) this.requireCondition(node.condition, "condition");
    if (node.update) this.visit(node.update);
    this.visit(node.body);
    this.scope = outer;
    return errorType;
  }

  private visitForInit(initializer: ForInitializer): void {
    if (initializer === null) return;
    if (initializer.kind === "letDecl") {
      this.checkLetDecl(
        initializer.name,
        primitiveType(initializer.type),
        initializer.initializer,
        initializer.nameLocation,
      );
      return;
    }
    this.visit(initializer);
  }

  returnStmt(node: ReturnStatement): Type {
    const expected = this.currentReturn;
    if (!expected) {
      // The parser already reports a `return` outside a function; nothing to add.
      if (node.value) this.visit(node.value);
      return errorType;
    }
    if (node.value === null) {
      if (expected.kind !== "void" && expected.kind !== "error") {
        this.bag.add(
          `this function must return a '${typeToString(expected)}'`,
          node.location,
          [`'${this.currentFunction}' is declared to return '${typeToString(expected)}'`],
        );
      }
      return errorType;
    }
    const actual = this.visit(node.value);
    if (expected.kind === "void") {
      this.bag.add(
        `a function returning 'void' cannot return a value`,
        node.location,
        [`this 'return' has type '${typeToString(actual)}'`],
      );
    } else if (!isAssignable(expected, actual)) {
      this.bag.add(
        `this return has type '${typeToString(actual)}' but '${this.currentFunction}' returns '${typeToString(expected)}'`,
        node.location,
      );
    }
    return errorType;
  }

  breakStmt(_node: BreakStatement): Type {
    return errorType;
  }

  continueStmt(_node: ContinueStatement): Type {
    return errorType;
  }

  printStmt(node: PrintStatement): Type {
    const actual = this.visit(node.value);
    if (actual.kind === "void") {
      this.bag.add("cannot print a value of type 'void'", node.value.location);
    }
    return errorType;
  }

  expressionStmt(node: ExpressionStatement): Type {
    this.visit(node.expression);
    return errorType;
  }

  private requireCondition(condition: Expression, what: string): void {
    const actual = this.visit(condition);
    if (actual.kind === "error") return;
    if (actual.kind !== "bool") {
      this.bag.add(
        `this ${what} must be 'bool', but it is '${typeToString(actual)}'`,
        condition.location,
        ["Vela has no truthiness: comparisons must produce a 'bool'"],
      );
    }
  }

  // -------------------------------------------------------------- expressions

  numberLiteral(_node: NumberLiteral): Type {
    return numberType;
  }

  stringLiteral(_node: StringLiteral): Type {
    return stringType;
  }

  booleanLiteral(_node: BooleanLiteral): Type {
    return boolType;
  }

  variable(node: Variable): Type {
    const symbol = this.scope.lookup(node.name);
    if (!symbol) {
      const hints = this.suggestNames(node.name);
      this.bag.add(`cannot find '${node.name}' in this scope`, node.location, hints);
      return errorType;
    }
    return symbol.type;
  }

  /** Offer a near-miss name from the innermost scopes, to catch typos. */
  private suggestNames(name: string): string[] {
    const candidates: string[] = [];
    for (const candidate of this.scope.namesHere()) {
      if (candidate.startsWith(name[0] ?? "") && editDistance(candidate, name) <= 2) {
        candidates.push(candidate);
      }
    }
    if (candidates.length === 0) return [];
    return [`did you mean ${candidates.map((c) => `'${c}'`).join(" or ")}?`];
  }

  unary(node: UnaryExpression): Type {
    const operandType = this.visit(node.operand);
    if (operandType.kind === "error") return errorType;
    if (node.operator === "!") {
      if (operandType.kind !== "bool") {
        this.bag.add(
          `operator '!' requires a 'bool' operand, but this is '${typeToString(operandType)}'`,
          node.operand.location,
        );
        return errorType;
      }
      return boolType;
    }
    // '-'
    if (operandType.kind !== "number") {
      this.bag.add(
        `operator '-' requires a 'number' operand, but this is '${typeToString(operandType)}'`,
        node.operand.location,
      );
      return errorType;
    }
    return numberType;
  }

  binary(node: BinaryExpression): Type {
    const leftType = this.visit(node.left);
    const rightType = this.visit(node.right);
    if (leftType.kind === "error" || rightType.kind === "error") return errorType;
    const op = node.operator;

    if (isArithmeticOperator(op)) {
      // `+` is the only operator that is overloaded: it also concatenates strings.
      if (op === "+" && leftType.kind === "string" && rightType.kind === "string") {
        return stringType;
      }
      if (!this.requireOperands(node, op, leftType, rightType, isNumber)) return errorType;
      return numberType;
    }

    if (isEqualityOperator(op)) {
      if (leftType.kind !== rightType.kind) {
        this.bag.add(
          `cannot compare '${typeToString(leftType)}' with '${typeToString(rightType)}' using '${op}'`,
          node.location,
        );
        return errorType;
      }
      return boolType;
    }

    if (isComparisonOperator(op)) {
      if (!this.requireOperands(node, op, leftType, rightType, isNumber)) return errorType;
      return boolType;
    }

    return errorType;
  }

  /**
   * Shared operand check for the numeric operators. Returns false after reporting,
   * so the caller propagates `errorType` and no follow-on message is produced.
   */
  private requireOperands(
    node: BinaryExpression,
    op: string,
    leftType: Type,
    rightType: Type,
    accepts: (type: Type) => boolean,
  ): boolean {
    if (accepts(leftType) && accepts(rightType)) return true;
    this.bag.add(
      `cannot apply '${op}' to '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
      node.location,
      [
        `'${op}' needs operands of the same primitive type, and the 'string' form of '+' needs two 'string' operands`,
      ],
    );
    return false;
  }

  logical(node: LogicalExpression): Type {
    const leftType = this.visit(node.left);
    const rightType = this.visit(node.right);
    const spelling = node.operator === "and" ? "&&" : "||";
    if (leftType.kind === "error" || rightType.kind === "error") return errorType;
    if (leftType.kind !== "bool" || rightType.kind !== "bool") {
      this.bag.add(
        `operator '${spelling}' requires 'bool' operands, but these are '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
        node.location,
      );
      return errorType;
    }
    return boolType;
  }

  assignment(node: AssignmentExpression): Type {
    const symbol = this.scope.lookup(node.name);
    if (!symbol) {
      this.bag.add(`cannot find '${node.name}' in this scope`, node.nameLocation, this.suggestNames(node.name));
      return errorType;
    }
    if (symbol.kind === "function") {
      this.bag.add(`'${node.name}' is a function and cannot be assigned to`, node.nameLocation);
      return errorType;
    }
    const valueType = this.visit(node.value);
    if (!isAssignable(symbol.type, valueType)) {
      this.bag.add(
        `cannot assign a value of type '${typeToString(valueType)}' to '${node.name}', which is '${typeToString(symbol.type)}'`,
        node.nameLocation,
      );
      return errorType;
    }
    return symbol.type;
  }

  index(node: IndexExpression): Type {
    const targetType = this.visit(node.target);
    const indexType = this.visit(node.index);
    if (isError(targetType) || isError(indexType)) return errorType;

    // Only a string can be indexed. Vela has no collections, so this is the whole
    // of what indexing means; `number[0]` and `bool[0]` are type errors, not
    // coercions to a string.
    if (targetType.kind !== "string") {
      this.bag.add(
        `this has type '${typeToString(targetType)}' and cannot be indexed; only a 'string' can`,
        node.target.location,
        ["Vela has no arrays, so a string is the only thing that can be indexed"],
      );
      return errorType;
    }
    if (indexType.kind !== "number") {
      this.bag.add(
        `a string index has type '${typeToString(indexType)}' but 'number' was expected`,
        node.index.location,
        ["indexes count code units, so 0 is the first character"],
      );
      return errorType;
    }
    // The result is a one-code-unit string, so `+` and `len` still apply to it.
    return stringType;
  }

  call(node: CallExpression): Type {
    const calleeType = this.visit(node.callee);
    const argTypes = node.args.map((arg) => this.visit(arg));
    if (calleeType.kind === "error") return errorType;
    // A variable declared as `function` holds a function whose signature was not
    // recorded, so the arity and the return type cannot be checked here. The call
    // is allowed and the result is `any`, which absorbs any use of it. This is the
    // documented cost of the bare type, and the alternative — a full signature
    // type — would only let a function be stored under one exact signature.
    if (calleeType.kind === "anyFunction") return anyType;
    if (calleeType.kind !== "function") {
      this.bag.add(
        `this is not a function (it has type '${typeToString(calleeType)}')`,
        node.callee.location,
      );
      return errorType;
    }
    const signature: FunctionType = calleeType;
    if (argTypes.length !== signature.params.length) {
      const expected = signature.params.length;
      const got = argTypes.length;
      this.bag.add(
        `expected ${expected} argument${expected === 1 ? "" : "s"} but got ${got}`,
        node.location,
        [`the signature is ${typeToString(signature)}`],
      );
      // Fall through to check the arguments anyway: a wrong-arity call often also
      // has a wrong argument, and reporting both saves a round trip.
    }
    argTypes.forEach((actual, i) => {
      const expected = signature.params[i];
      if (!expected) return; // Already reported as an arity error.
      if (!isAssignable(expected, actual)) {
        const arg = node.args[i]!;
        this.bag.add(
          `argument ${i + 1} has type '${typeToString(actual)}' but '${typeToString(expected)}' was expected`,
          arg.location,
        );
      }
    });
    return signature.returnType;
  }

  program(): Type {
    return errorType;
  }

  letDecl(_node: Declaration): Type {
    return errorType;
  }
}

/**
 * Whether a statement is guaranteed to transfer control out of the function,
 * either by returning or by not finishing.
 *
 * This is deliberately a small, sound, and incomplete analysis. Soundness matters
 * most: it must never claim a function returns when it might not, or the
 * interpreter would be asked for a value that was never produced. Incompleteness
 * only ever costs a superfluous `return` at the end of a function.
 *
 * In particular, loops are treated as *not* returning, even `while (true) {...}`,
 * because proving that needs `break` analysis, and getting it wrong would be
 * unsound. The same reasoning rules out short-circuit expressions as the final
 * statement, since `return` is a statement in Vela and cannot appear inside one.
 */
function definitelyReturns(declaration: Declaration | Statement): boolean {
  switch (declaration.kind) {
    case "return":
      return true;

    case "block": {
      const last = declaration.declarations[declaration.declarations.length - 1];
      return last !== undefined && definitelyReturns(last);
    }

    case "if": {
      // Both arms must return, and an `if` with no `else` can fall through.
      if (declaration.elseBranch === null) return false;
      return definitelyReturns(declaration.thenBranch) && definitelyReturns(declaration.elseBranch);
    }

    // A loop may run zero times, so it never counts as returning.
    case "while":
    case "for":
    case "letDecl":
    case "fnDecl":
    case "print":
    case "expressionStmt":
    case "break":
    case "continue":
      return false;
  }
}

function definitelyReturnsBlock(block: Block): boolean {
  const last = block.declarations[block.declarations.length - 1];
  return last !== undefined && definitelyReturns(last);
}

/** Predicate reused by the checker's numeric operator rules. */
function isNumber(type: Type): boolean {
  return type.kind === "number";
}

/** Plain Levenshtein distance, capped for speed. Used only for typo hints. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 99;
}

/** Re-exported so the CLI can report the type of a program without importing both files. */
export { typeToString, span };
