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
 * Vela's type system is deliberately small: four primitives, function signatures,
 * and fixed-shape arrays, with no subtyping, no unions, and no inference. Every
 * rule below is a direct consequence of that.
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
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  Block,
  BooleanLiteral,
  BreakStatement,
  CallExpression,
  ConstDeclaration,
  ContinueStatement,
  Declaration,
  Expression,
  ExpressionStatement,
  FieldAccessExpression,
  FieldAssignmentExpression,
  ForInitializer,
  ForStatement,
  FunctionDeclaration,
  IfStatement,
  IndexAssignmentExpression,
  IndexExpression,
  LetDeclaration,
  LogicalExpression,
  NumberLiteral,
  PrintStatement,
  Program,
  ReturnStatement,
  Statement,
  NullLiteral,
  StringLiteral,
  StructDeclaration,
  TypeNode,
  UnaryExpression,
  Variable,
  WhileStatement,
} from "../ast/nodes.js";
import { visit, type NodeVisitor } from "../ast/visitor.js";
import { BUILTIN_SPECS, type BuiltinSpec } from "../runtime/values.js";
import {
  anyType,
  arrayType,
  boolType,
  nullableType,
  errorType,
  fieldTypeOf,
  functionType,
  isArithmeticOperator,
  isAssignable,
  isComparisonOperator,
  isEqualityOperator,
  isError,
  nullType,
  numberType,
  resolveTypeNode,
  stringType,
  structType,
  typeToString,
  typesEqual,
  type FunctionType,
  type StructFieldType,
  type StructType,
  type Type,
} from "./types.js";

/**
 * One thing a condition established: a place, and the type it now has.
 *
 * The place is a binding plus a path — `""` for the name itself, `".next"` for a field
 * of it, `".owner.next"` for a field of that. Keys on the *symbol*, so a shadowing
 * `let x` is a different fact from an outer `x` however alike they look.
 */
interface Fact {
  readonly symbol: Symbol;
  readonly path: string;
  readonly type: Type;
}

/** The binding and field path an expression reads from, when it reads only fields. */
interface Place {
  readonly name: string;
  readonly path: string;
}

/** One edge of a walk through struct fields, used to describe a cycle. */
interface CycleStep {
  readonly name: string;
  readonly field: string;
}

/** What a name in scope refers to. `kind` only sharpens diagnostics. */
export interface Symbol {
  readonly name: string;
  readonly type: Type;
  readonly kind: "variable" | "constant" | "parameter" | "function" | "struct";
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

  /** True when this is not the root scope. A `struct` is only legal at the root. */
  get isNested(): boolean {
    return this.parent !== null;
  }

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
export function check(
  program: Program,
  bag: DiagnosticBag,
  known: readonly Symbol[] = [],
  knownStructs: readonly StructDeclaration[] = [],
): void {
  new Checker(bag, known, knownStructs).checkProgram(program);
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
  /**
   * Built-in specs keyed on the *seeded symbol* rather than the name.
   *
   * The key matters. A built-in can be shadowed inside a block, and a shadowing
   * `let append: function` is an ordinary user function that happens to share a
   * name — applying `append`'s argument rules to it would reject `append(1, 2)`
   * for a reason that has nothing to do with the call. Comparing symbols makes
   * `call` apply a spec only when the name resolved to the seeded binding itself,
   * so the rules follow the value rather than the spelling.
   */
  private readonly builtins = new Map<Symbol, BuiltinSpec>();
  /**
   * The type the expression currently being visited is required to have, or null.
   *
   * Almost every expression can be checked without one — `1 + 2` is `number`
   * whatever the surrounding declaration says. An array literal is the exception,
   * because its element type is not written anywhere in it: `[1, 2]` is
   * `number[]` and `["a"]` is `string[]` purely by what it holds, and `[]` holds
   * nothing at all. So the checker keeps the context in a field while it visits,
   * and the literal reads it. A field rather than a parameter threaded through the
   * visitor, because the context applies to exactly one node and every visitor
   * method would otherwise have to pass it along.
   *
   * `visitExpecting` sets and restores it, so it is never visible to a later node.
   */
  private expected: Type | null = null;

  /**
   * What a `== null` test has established about each name on the path being checked.
   *
   * A `T?` cannot be used as a `T` — that is the whole point of writing `T?` rather
   * than `T` — so the only way to reach the value inside one is to test it and be
   * *told* by the test. This map is that telling: it maps a symbol to the type the
   * name has in the branch currently being checked, so `x` reads as a `number`
   * inside `if (x != null)` and as `null` inside the `else` of `if (x == null)`.
   *
   * **Keyed on the symbol rather than the name**, which is what makes shadowing safe:
   * a `let x` inside a block is a *different* binding, so it starts unnarrowed while
   * the outer `x` keeps whatever the test said about it. Keyed on the name, the
   * inner declaration would silently un-narrow the outer one.
   *
   * Replaced rather than mutated at a branch, and restored afterwards, so a fact
   * learned in one arm of an `if` cannot be seen in the other. An assignment to a
   * name drops its fact (`assignment`), because the assignment is exactly the event
   * that makes the earlier test stale — and that is the one hole, stated plainly: a
   * *function* that assigns the name is not seen, so narrowing `x` and then calling
   * something that sets `x = null` inside the same branch is a program the checker
   * accepts and the runtime cannot honour. `docs/grammar.md` lists it under known
   * gaps, and narrowing is worth that one hole: it is what makes a nullable type
   * usable at all.
   */
  private narrowed = new Map<Symbol, Map<string, Type>>();

  /**
   * Declared structs by name, and the same table memoised as resolved types.
   *
   * Two tables rather than one because resolution is not a single pass: `struct A
   * { b: B; }` may be written above `struct B`, so every *name* has to be known
   * before any field is resolved, while the type a name resolves to is built once
   * and shared — which is what makes `A` in one place and `A` in another the same
   * type object as well as the same name.
   */
  private readonly structDecls = new Map<string, StructDeclaration>();
  private readonly structTypes = new Map<string, StructType>();
  /** Structs already proven to contain no cycle, so each is walked once. */
  private readonly cycleFree = new Set<string>();
  /**
   * Structs on a cycle, and therefore types no value can ever have.
   *
   * Kept so that a *use* of one of them can be passed over in silence. The fault was
   * reported once, at the declaration that has to change; repeating it as an arity or
   * argument error at every call site would be the same complaint several times over,
   * and would bury the one that can be acted on.
   */
  private readonly unbuildable = new Set<string>();
  /** Cycles already reported, so a cycle found from two directions is described once. */
  private readonly reportedCycles = new Set<string>();
  /** Redeclared struct declarations, so each duplicate is reported exactly once. */
  private readonly duplicateStructs = new WeakSet<StructDeclaration>();

  constructor(
    private readonly bag: DiagnosticBag,
    known: readonly Symbol[],
    knownStructs: readonly StructDeclaration[] = [],
  ) {
    this.scope = new Scope(null);
    for (const symbol of known) this.scope.define(symbol);
    this.seedBuiltins();
    // The REPL's structs are part of the program as far as types are concerned, so
    // they are collected before this entry's own, and a redeclaration is reported
    // against whichever came first.
    for (const declaration of knownStructs) this.collectStruct(declaration);
  }

  /**
   * Install the built-in signatures into the root scope, so `tostring(1)` and
   * friends type-check. The signatures come from the same table the runtime uses
   * to build the actual values, which is what keeps the two in agreement.
   */
  private seedBuiltins(): void {
    for (const spec of BUILTIN_SPECS) {
      // `paramTypes` still declares the signature, because a plain `Type` has no
      // room for `accepts` — without it `len` would be seeded as taking `any` and
      // would accept a number. `accepts` is what narrows it at the call site.
      const symbol: Symbol = {
        name: spec.name,
        type: functionType(spec.paramTypes, spec.returnType),
        kind: "function",
        location: { offset: 0, length: 0, line: 1, column: 1 },
      };
      this.scope.define(symbol);
      this.builtins.set(symbol, spec);
    }
  }

  /**
   * The built-in spec a call resolves to, or null when the callee is not a
   * built-in. Only the seeded symbol counts: a shadowing binding of the same name
   * is a user function and gets ordinary call checking.
   */
  private builtinFor(callee: Expression): BuiltinSpec | null {
    if (callee.kind !== "variable") return null;
    const symbol = this.scope.lookup(callee.name);
    return symbol ? this.builtins.get(symbol) ?? null : null;
  }

  checkProgram(program: Program): void {
    // Structs come first: a function above a struct, or a field naming a struct
    // declared further down, is legal and should not depend on where the
    // declaration happens to sit in the file.
    for (const declaration of program.declarations) {
      if (declaration.kind === "structDecl") this.collectStruct(declaration);
    }
    this.resolveStructs();
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
      node.params.map((p) => this.resolveAnnotation(p.type)),
      this.resolveAnnotation(node.returnType),
    );
  }

  /** Dispatch to the visitor method for this node, returning its type. */
  private visit(node: Declaration | Statement | Expression): Type {
    return visit(node, this);
  }

  /** Visit `node` with `expected` recorded as the type it has to have. */
  private visitExpecting(node: Expression, expected: Type | null): Type {
    const previous = this.expected;
    this.expected = expected;
    try {
      return this.visit(node);
    } finally {
      this.expected = previous;
    }
  }

  // ---------------------------------------------------------------- narrowing

  /**
   * Run `body` with `facts` added to what is known, then restore, and give back
   * whatever it returned.
   *
   * The map is replaced rather than edited so that the two arms of an `if` cannot see
   * each other's facts, and restored rather than discarded so that a fact learned
   * before an `if` is still there inside both of its arms. Returning a value rather
   * than just running a statement keeps `logical` honest: the right operand's *type*
   * comes out of the narrowed visit, not from a field the visitor left behind.
   */
  private withFacts<T>(facts: readonly Fact[], body: () => T): T {
    const outer = this.narrowed;
    if (facts.length > 0) {
      const next = new Map(outer);
      for (const fact of facts) {
        // Copied per binding, so adding a fact about one name cannot disturb another
        // name's — including another path on the same name.
        const paths = new Map(next.get(fact.symbol) ?? []);
        paths.set(fact.path, fact.type);
        next.set(fact.symbol, paths);
      }
      this.narrowed = next;
    }
    try {
      return body();
    } finally {
      this.narrowed = outer;
    }
  }

  /**
   * What the checker knows inside an `if`/`while` arm, given the condition's value.
   *
   * `truth` is what the condition evaluated to. Both directions are asked for because
   * both are used: `if (x != null)` narrows in the body, and `if (x == null) { ... }
   * else { ... }` narrows in *each* arm differently, which is the shape a reader of
   * `x == null` expects to see.
   */
  private factsWhen(expression: Expression, truth: boolean): Fact[] {
    // `a && b` is true only when both are, so both sets of facts hold. `a || b` is
    // true when *either* is, and which one is unknown here — so nothing follows,
    // rather than the union of the two, which would claim a fact from the arm that
    // did not happen.
    if (expression.kind === "logical") {
      // The right half is asked *under* the left half's facts, because that is the only
      // order in which `p.next != null && p.next.next != null` can be read: the second
      // test is only meaningful once the first has been established.
      if (expression.operator === "and") {
        if (!truth) return [];
        const left = this.factsWhen(expression.left, true);
        return [...left, ...this.withFacts(left, () => this.factsWhen(expression.right, true))];
      }
      // The mirror image: `a || b` is false only when both are false.
      if (truth) return [];
      const left = this.factsWhen(expression.left, false);
      return [...left, ...this.withFacts(left, () => this.factsWhen(expression.right, false))];
    }

    if (expression.kind !== "binary") return [];
    if (!isEqualityOperator(expression.operator)) return [];
    const test = this.nullTest(expression);
    if (!test) return [];
    // `x == null` true means absent; `x != null` true means present. Each direction is
    // the other's negation, which is why one operator gives both facts.
    const present = (test.operator === "==") !== truth;
    return this.factsFor(test.place, present);
  }

  /** The place a `== null` or `!= null` comparison is about, if that is what it is. */
  private nullTest(
    expression: BinaryExpression,
  ): { place: Place; operator: "==" | "!=" } | null {
    const other =
      expression.left.kind === "nullLiteral"
        ? expression.right
        : expression.right.kind === "nullLiteral"
          ? expression.left
          : null;
    if (!other) return null;
    // Reached only for `==` and `!=` — `factsWhen` has already filtered on that — but
    // the type has to be narrowed here as well, because `BinaryOperator` is the whole
    // vocabulary and only these two are the answer.
    const place = this.placeOf(other);
    if (!place) return null;
    return { place, operator: expression.operator as "==" | "!=" };
  }

  /**
   * The binding and field path an expression reads, if it is a name or a chain of
   * fields from one.
   *
   * `p.next.next` is one place reached in two steps, so it narrows as a single fact
   * and — better — composes: a fact about `p.next` makes the inner read of
   * `p.next.next` a `Node`, which is then a place that can be narrowed in turn.
   *
   * An *index* is not one of these, because `xs[i]` has no fixed text to key on: `i`
   * could be anything by the time it is read again, and two syntactically identical
   * `xs[i]` need not be the same element. A computed place is therefore not narrowed,
   * and a use of one says so; a local name and field chain are.
   */
  private placeOf(expression: Expression): Place | null {
    if (expression.kind === "variable") return { name: expression.name, path: "" };
    if (expression.kind === "fieldAccess") {
      const base = this.placeOf(expression.target);
      return base ? { name: base.name, path: `${base.path}.${expression.field}` } : null;
    }
    return null;
  }

  /**
   * The fact about a place, if it has one.
   *
   * Only a nullable place produces a fact, because only a nullable one has two states
   * to be in: `present` asks for the type the value has when there is one, and
   * otherwise for `null` itself. Anything else is already what it says it is.
   */
  private factsFor(place: Place, present: boolean): Fact[] {
    const symbol = this.scope.lookup(place.name);
    if (!symbol) return [];
    if (symbol.kind === "function" || symbol.kind === "struct") return [];
    const type = this.typeAt(symbol, place.path);
    if (type.kind !== "nullable") return [];
    return [{ symbol, path: place.path, type: present ? type.inner : nullType }];
  }

  /**
   * The type a place has on this path: the fact if there is one, otherwise the type
   * reached by following the path from the declared type.
   *
   * Following rather than looking up is what makes the chain compose, and it means a
   * place with no fact of its own is still checked against whatever its base has been
   * narrowed to.
   */
  private typeAt(symbol: Symbol, path: string): Type {
    const facts = this.narrowed.get(symbol);
    let type = facts?.get("") ?? symbol.type;
    let prefix = "";
    // One step at a time, consulting a fact at every step: `p.next.next` is reached
    // through `p.next`, so narrowing `p.next` is what makes the second step know it is
    // walking a `Node` rather than a `Node?`.
    for (const step of splitPath(path)) {
      if (type.kind !== "struct") return errorType;
      const field = type.fields.find((candidate) => candidate.name === step);
      if (!field) return errorType;
      // Built with the leading dot so it matches the keys `placeOf` writes.
      prefix = `${prefix}.${step}`;
      type = facts?.get(prefix) ?? field.type;
    }
    return type;
  }

  /**
   * Forget what a test established about `symbol.path`, because that place has just
   * been assigned to.
   *
   * Deeper paths go with it: assigning `p.next` says nothing any more about
   * `p.next.next`, because the `p.next` it would have been read from is no longer the
   * same value. The current path's map is edited in place rather than replaced, since
   * an assignment is a fact about *this* path only.
   */
  private forget(symbol: Symbol, path: string): void {
    const paths = this.narrowed.get(symbol);
    if (!paths) return;
    for (const known of [...paths.keys()]) {
      if (known === path || known.startsWith(path === "" ? "" : `${path}.`)) paths.delete(known);
    }
    if (paths.size === 0) this.narrowed.delete(symbol);
  }

  private visitDeclaration(declaration: Program["declarations"][number]): void {
    switch (declaration.kind) {
      case "letDecl":
        this.checkBindingDecl(declaration, "variable");
        return;
      case "constDecl":
        this.checkBindingDecl(declaration, "constant");
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

  // ------------------------------------------------------------------ structs

  /**
   * Record one struct declaration, reporting a name that is already taken.
   *
   * Only the name is recorded here. Resolving fields can name another struct, and
   * that struct may be declared further down the file, so nothing is resolved
   * until every name in the program has been seen.
   */
  private collectStruct(declaration: StructDeclaration): void {
    const existing = this.structDecls.get(declaration.name);
    if (existing) {
      this.bag.add(
        `'${declaration.name}' is already declared as a struct`,
        declaration.nameLocation,
        [`the previous declaration of '${declaration.name}' is here`],
      );
      // Remembered so that checking the declaration itself does not report the
      // same duplicate a second time, as a name already in scope.
      this.duplicateStructs.add(declaration);
      return;
    }
    this.structDecls.set(declaration.name, declaration);
  }

  /**
   * Resolve every declared struct's fields, then check that none of them is a type
   * nobody could build.
   *
   * Two passes, and the split is what makes a recursive type expressible. Every name
   * gets its `StructType` *before* any field is resolved, and the field list is
   * filled in place afterwards. So a field that names a struct already being
   * resolved — the direct case, `struct Node { next: Node?; }` — finds that same
   * object rather than nothing, and both names refer to one type. Resolving fields
   * into a temporary and only then installing it would make recursion impossible,
   * which is the opposite of what a language with nullable types should do.
   *
   * Whether a cycle is *legal* is a separate question, answered afterwards by
   * `findSelfCycle`, because the answer is not about resolution at all: a cycle is
   * buildable exactly when a nullable field on it can be `null`.
   */
  private resolveStructs(): void {
    // The mutable arrays are kept here and pushed into, rather than being written
    // through the `StructType`: its field list is typed readonly, because a struct's
    // fields are its type and do not change once resolved. The array a struct was
    // built with *is* that list, so filling it in fills the type in.
    const pending = new Map<string, StructFieldType[]>();
    for (const name of this.structDecls.keys()) {
      if (this.structTypes.has(name)) continue;
      const fields: StructFieldType[] = [];
      pending.set(name, fields);
      this.structTypes.set(name, structType(name, fields));
    }
    for (const name of this.structDecls.keys()) {
      const declaration = this.structDecls.get(name);
      const fields = pending.get(name);
      if (!declaration || !fields) continue;
      for (const field of declaration.fields) {
        const declared = this.resolveAnnotation(field.type);
        if (declared.kind === "void") {
          this.bag.add(`a struct field cannot have type 'void'`, field.nameLocation, [
            "'void' is the absence of a value, and a field is a value that has to hold one",
          ]);
        }
        // An optional field is stored as `T?`, because that is what the constructor
        // stores when the argument is left out. Resolving it here rather than in the
        // parser keeps one definition of what an optional field *is*: the parser has
        // to record the `?` on the declaration (the arity needs it), and the type
        // needs it in the field list, and one of them has to be where they meet.
        fields.push({
          name: field.name,
          type: field.optional ? nullableType(declared) : declared,
          optional: field.optional,
          location: field.nameLocation,
        });
      }
    }
    // Every name is tried, because a cycle can be entered from anywhere in it. The
    // walk returns the names *on* the cycle, which is what the two things after it
    // need: one report per cycle rather than one per way in, and a record of every
    // struct involved, so a use of one of them does not repeat the same mistake.
    for (const name of this.structDecls.keys()) {
      const cycle = this.findSelfCycle(name, []);
      if (!cycle) continue;
      for (const member of cycle) this.unbuildable.add(member);
      // Sorted, because a cycle is the same cycle however it is walked: `A -> B -> A`
      // and `B -> A -> B` are one fault, and saying so twice would be the same
      // complaint at two lines of the same two declarations.
      const signature = [...cycle].sort().join(" -> ");
      if (this.reportedCycles.has(signature)) continue;
      this.reportedCycles.add(signature);
      this.reportCycle(cycle);
    }
  }

  /**
   * The fault itself, described at the field that closes the cycle.
   *
   * Separated from the walk that finds it, because the walk stops at the first cycle
   * it meets and the reporting has to happen once per cycle however many times it is
   * rediscovered.
   */
  private reportCycle(cycle: readonly string[]): void {
    const first = cycle[0];
    const last = cycle[cycle.length - 1];
    // The closing edge is the field of the last struct on the cycle whose type reaches
    // the first one: the one line a reader has to change.
    const closing = first && last ? this.closingField(last, first) : undefined;
    if (!first || !closing) return;
    const edges = cycle.map((name, index) => {
      const target = cycle[index + 1] ?? first;
      const field = this.closingField(name, target);
      return `'${name}.${field?.name ?? closing.name}'`;
    });
this.bag.add(
        `'${first}' cannot contain itself`,
        closing.location,
        [
          `every field has to be given a value, so ${edges.join(" -> ")} would need a value of type '${first}' to already exist: the type could never be built`,
          "a nullable field breaks the cycle, as in 'next: Node?' or 'next?: Node', and no other field type does",
        ],
      );
  }

  /** The first field of `name` whose type reaches the struct `target`. */
  private closingField(name: string, target: string): StructFieldType | undefined {
    return this.structTypes.get(name)?.fields.find((field) => structReachedBy(field.type) === target);
  }

  /**
   * Report a struct that contains itself with nothing on the cycle able to stop.
   *
   * **A nullable edge breaks a cycle, and only a nullable edge does.** `struct Node
   * { next: Node?; }` is buildable: `Node(1, null)` is a `Node` whose `next` is
   * absent, and nothing forces the chain to be infinite. `struct Self { me: Self; }`
   * is not, because every field has to be given a value at construction and there
   * is no value to give.
   *
   * So the search follows struct-typed fields and *stops at every nullable one*. A
   * cycle it can still reach is a type with no finite value, and the report says
   * how to fix it rather than only that it is wrong. A field whose type is an array
   * of the struct is followed as well, because an array stores copies rather than
   * links, so it cannot break a cycle either.
   *
   * Names with no cycle are memoised, so a diamond of structs costs one walk per
   * struct rather than one per path.
   */
  private findSelfCycle(name: string, path: readonly CycleStep[]): string[] | null {
    if (this.cycleFree.has(name)) return null;
    const type = this.structTypes.get(name);
    if (!type) return null;
    for (const field of type.fields) {
      const reached = structReachedBy(field.type);
      if (reached === null) continue; // A nullable edge, or not a struct at all.
      const closing = path.findIndex((step) => step.name === reached);
      if (closing >= 0) {
        // The cycle is the part of the path from where the name first appeared to
        // here, plus the closing edge back to it. Returned as names, in order, so
        // the report can show the way round and so every member is known afterwards.
        const names = path.slice(closing).map((step) => step.name);
        names.push(name);
        return names;
      }
      const found = this.findSelfCycle(reached, [...path, { name, field: field.name }]);
      if (found) return found;
    }
    this.cycleFree.add(name);
    return null;
  }

  /**
   * Resolve a written type, so a struct name in an annotation becomes a `StructType`.
   *
   * The only annotation that can fail here is a name that is not a struct: the
   * parser accepted it because a name *could* be one, and this is the stage that
   * knows what was declared.
   */
  private resolveAnnotation(node: TypeNode): Type {
    // Recursing rather than delegating is what makes `Point[]` and `fn(Point) -> R`
    // report an unknown name the same way a bare `Point` does. `resolveTypeNode`
    // resolves a name silently, because it is also used where a name is already
    // known to exist; only this stage can say which names were declared.
    if (node.kind === "nullable") return nullableType(this.resolveAnnotation(node.inner));
    if (node.kind === "array") return arrayType(this.resolveAnnotation(node.element));
    if (node.kind === "signature") {
      return functionType(
        node.params.map((param) => this.resolveAnnotation(param)),
        this.resolveAnnotation(node.returnType),
      );
    }
    if (node.kind !== "structType") return resolveTypeNode(node, this.structTypes);
    const declared = this.structDecls.get(node.name);
    if (!declared) {
      this.bag.add(
        `cannot find a struct called '${node.name}'`,
        node.location,
        [
          this.structDecls.size === 0
            ? "this program declares no structs yet"
            : `the structs here are ${[...this.structDecls.keys()].map((n) => `'${n}'`).join(", ")}`,
          "a type is one of number, string, bool, void, function, or a declared struct's name",
        ],
      );
      return errorType;
    }
    // Every declared name has a `StructType` by now, filled in with its fields as it
    // went. One whose field could not be resolved is already reported, at the
    // declaration that caused it, which is the place a reader has to fix; the type
    // object exists and holds `errorType` in that field, so the use here is only
    // made to fail quietly.
    return this.structTypes.get(node.name) ?? errorType;
  }

  structDecl(node: StructDeclaration): Type {
    // A second declaration of one name has already been reported, by the pass that
    // collected them, and the type this node would declare is the first one's.
    // Declaring it again here would only repeat the same mistake as a scope
    // duplicate, so the duplicate gets nothing but the error it already has.
    if (this.duplicateStructs.has(node)) return errorType;
    if (this.scope.isNested) {
      this.bag.add(`a struct can only be declared at the top level`, node.location, [
        "a struct is a type, and a type declared inside a block would have two meanings",
        "move the declaration to the top of the file",
      ]);
      return errorType;
    }
    const type = this.structTypes.get(node.name);
    if (!type) return errorType;
    this.declare(node.name, type, "struct", node.nameLocation);
    return errorType; // A declaration is not an expression.
  }

  // ------------------------------------------------------------- declarations

  /**
   * Check a `let` or a `const` and put it in scope.
   *
   * The two differ only in the kind of symbol they create, which is what decides
   * whether a later assignment to the name is allowed. Sharing one routine is what
   * guarantees they cannot drift apart on everything else — the type rule, the
   * `void` rule, and the duplicate-name rule.
   */
  private checkBindingDecl(
    declaration: LetDeclaration | ConstDeclaration,
    kind: Symbol["kind"],
  ): void {
    const name = declaration.name;
    const nameLocation = declaration.nameLocation;
    const declaredType = this.resolveAnnotation(declaration.type);
    // The declared type is the context an array literal needs: `let xs: number[] =
    // [];` gets its element type from the annotation rather than from the empty
    // literal.
    const actual = this.visitExpecting(declaration.initializer, declaredType);
    // A variable needs a value it can hold, and `void` is the absence of one.
    if (!declaredType || declaredType.kind === "error") return;
    if (declaredType.kind === "void") {
      this.bag.add(`a variable cannot have type 'void'`, nameLocation, [
        "'void' is only meaningful as a function return type",
      ]);
    } else if (!isAssignable(declaredType, actual)) {
      this.bag.add(
        `cannot initialise '${name}' of type '${typeToString(declaredType)}' with a value of type '${typeToString(actual)}'`,
        nameLocation,
        [...nullableNotes(actual), ...nullableNotes(declaredType)],
      );
    }
    this.declare(name, declaredType, kind, nameLocation);
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
          type: this.resolveAnnotation(param.type),
          kind: "parameter",
          location: param.nameLocation,
        });
      }
    }

    const previousReturn = this.currentReturn;
    const previousFunction = this.currentFunction;
    // A body starts with nothing known: a fact learned at the call site belongs to
    // the caller's variable, and a parameter has whatever its own test proves inside
    // *this* body. So the map is replaced rather than extended.
    const previousNarrowed = this.narrowed;
    this.currentReturn = signature.returnType;
    this.currentFunction = node.name;
    this.narrowed = new Map();
    this.block(node.body);
    this.requireTerminatingReturn(node);
    this.narrowed = previousNarrowed;
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
    const returnType = this.resolveAnnotation(node.returnType);
    if (returnType.kind === "void") return;
    if (definitelyReturnsBlock(node.body)) return;
    // The resolved type is named, not the `TypeNode` the source spelled: a
    // diagnostic has to describe the type the checker is reasoning about, and
    // `typeToString` is the one place that knows how to write one.
    const named = typeToString(returnType);
    this.bag.add(
      `a function returning '${named}' must end with a return statement`,
      node.body.location,
      [`the body of '${node.name}' can finish without producing a '${named}'`],
    );
  }

  // --------------------------------------------------------------- statements

  block(node: Block): Type {
    const outer = this.scope;
    // A block is a boundary for what is known as well as for what is named: a fact
    // learned inside one cannot be seen outside it, because the name it is about may
    // have been re-bound or re-assigned on the way out.
    const outerFacts = this.narrowed;
    this.scope = new Scope(outer);
    // A block is a scope, so it hoists its own functions the same way the program
    // does. This is what lets a pair of mutually recursive helpers be written as
    // sibling declarations inside a function body.
    this.hoistFunctions(node.declarations);
    for (const declaration of node.declarations) this.visitDeclaration(declaration);
    this.narrowed = outerFacts;
    this.scope = outer;
    return errorType;
  }

  /**
   * Whether a statement always leaves, so the code after it can only be reached the
   * other way.
   *
   * This is the guard-clause shape — `if (x == null) { return 0; }` and then use `x`
   * as a `number` — and it is the reason narrowing is worth having at all. The answer
   * is deliberately narrow: a `return`, a block that returns, and an `if` whose *both*
   * arms return. A `while` counts as leaving only when its body does, which is
   * conservative in the safe direction: it claims less than it might be able to.
   *
   * A declaration is accepted here because a block holds both, and none of them can
   * leave — the `default` arm below is what says so.
   */
  private leavesHere(node: Declaration | Statement): boolean {
    switch (node.kind) {
      case "return":
        return true;
      case "block": {
        // A block leaves as soon as one statement in it does; the rest are then
        // unreachable, so they are not worth reasoning about.
        for (const declaration of node.declarations) {
          if (this.leavesHere(declaration)) return true;
        }
        return false;
      }
      case "if":
        return node.elseBranch !== null && this.leavesHere(node.thenBranch) && this.leavesHere(node.elseBranch);
      case "while":
        return this.leavesHere(node.body);
      default:
        return false;
    }
  }

  ifStmt(node: IfStatement): Type {
    // The condition is checked *before* the facts are read off it: the test has to be
    // a `bool`, and `x == null` is the only way of writing one that teaches the
    // checker anything.
    this.requireCondition(node.condition, "condition");
    // Each arm gets its own facts, derived from the same condition. `withFacts`
    // restores the outer map afterwards, so a fact learned inside a branch is not
    // visible outside it.
    this.withFacts(this.factsWhen(node.condition, true), () => this.visit(node.thenBranch));
    // Captured first: the narrowing of `node.elseBranch` does not survive into a
    // callback, since the checker cannot know when the closure runs.
    const elseBranch = node.elseBranch;
    if (elseBranch) {
      this.withFacts(this.factsWhen(node.condition, false), () => this.visit(elseBranch));
    }
    // An `if` with no `else` whose body always leaves has an implicit `else`: the
    // statements after it in this block are only reached when the condition was false,
    // and that is the fact they are checked under. So `if (x == null) { return 0; }`
    // leaves `x` a `number` for the rest of the function.
    if (!elseBranch && this.leavesHere(node.thenBranch)) {
      this.narrowed = new Map([...this.narrowed, ...mapFacts(this.factsWhen(node.condition, false))]);
    }
    return errorType;
  }

  whileStmt(node: WhileStatement): Type {
    this.requireCondition(node.condition, "condition");
    // The body is checked as though the condition held, which is what makes
    // `while (node != null) { ... node = node.next; }` type-check. Nothing is carried
    // *back* out to the condition: after one iteration the name may have changed, and
    // re-testing it from scratch is both simpler and the only honest reading.
    this.withFacts(this.factsWhen(node.condition, true), () => this.visit(node.body));
    // A loop leaves through its condition and nothing else, so when the body cannot
    // leave first, the statements after it are reached only with the condition false.
    // `while (x == null) { x = next(); }` therefore leaves `x` a `number`, which is how
    // a chain like that is walked without a cast.
    if (!this.leavesHere(node.body)) {
      this.narrowed = new Map([...this.narrowed, ...mapFacts(this.factsWhen(node.condition, false))]);
    }
    return errorType;
  }

  forStmt(node: ForStatement): Type {
    // The header's `let` is scoped to the loop, so it is invisible afterwards.
    const outer = this.scope;
    this.scope = new Scope(outer);
    this.visitForInit(node.initializer);
    if (node.condition) this.requireCondition(node.condition, "condition");
    // The update and the body both run only when the condition held, so both are
    // checked as though it does — which is what lets the walking-a-chain loop be
    // written without a test inside it:
    //
    //     for (let at: Node? = head; at != null; at = at.next) { total = total + at.value; }
    //
    // The update comes first, because it runs first. Nothing carries past the loop:
    // the header's `let` is out of scope by then, and the condition is re-tested from
    // the declared type every iteration anyway.
    // Derived once and installed twice, because the update and the body are each at
    // the top of an iteration, where the condition held — whatever the update did to
    // a fact on its way is not evidence about the iteration after it.
    const facts = node.condition ? this.factsWhen(node.condition, true) : [];
    this.withFacts(facts, () => {
      if (node.update) this.visit(node.update);
    });
    this.withFacts(facts, () => this.visit(node.body));
    this.scope = outer;
    return errorType;
  }

  private visitForInit(initializer: ForInitializer): void {
    if (initializer === null) return;
    if (initializer.kind === "letDecl") {
      this.checkBindingDecl(initializer, "variable");
      return;
    }
    if (initializer.kind === "constDecl") {
      this.checkBindingDecl(initializer, "constant");
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
    const actual = this.visitExpecting(node.value, expected);
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
        nullableNotes(actual),
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
        [
          "Vela has no truthiness: comparisons must produce a 'bool'",
          ...nullableNotes(actual),
        ],
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

  nullLiteral(_node: NullLiteral): Type {
    return nullType;
  }

  variable(node: Variable): Type {
    const symbol = this.scope.lookup(node.name);
    if (!symbol && this.structDecls.has(node.name)) {
      // The same struct, reached before its declaration was visited. The name is
      // still a type and not a value, and saying so is more use than "cannot find
      // it in this scope" for a name the program does declare.
      return this.reportStructAsValue(node.name, node.location);
    }
    if (!symbol) {
      const hints = this.suggestNames(node.name);
      this.bag.add(`cannot find '${node.name}' in this scope`, node.location, hints);
      return errorType;
    }
    // A struct's name is a type, not a value. Reporting it here rather than
    // letting it resolve means `let p = Point;` says what to do instead of
    // carrying a type around that no expression can produce.
    if (symbol.kind === "struct") return this.reportStructAsValue(node.name, node.location);
    // A `== null` test has proved what this name holds on this path, and that
    // overrides the declared type — which is what lets `x + 1` inside
    // `if (x != null)` be checked as the `number` it now is.
    return this.narrowed.get(symbol)?.get("") ?? symbol.type;
  }

  /** The one diagnostic for reading a struct's name as though it were a value. */
  private reportStructAsValue(name: string, location: SourceLocation): Type {
    this.bag.add(`'${name}' is a struct, not a value`, location, [
      `build one by calling it: '${name}(...)' takes one argument per field`,
    ]);
    return errorType;
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
          nullableNotes(operandType),
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
        nullableNotes(operandType),
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
      const compatible = comparableForEquality(leftType, rightType);
      if (!compatible) {
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
        ...nullableNotes(leftType),
        ...nullableNotes(rightType),
      ],
    );
    return false;
  }

  logical(node: LogicalExpression): Type {
    const leftType = this.visit(node.left);
    const spelling = node.operator === "and" ? "&&" : "||";
    // The right operand is checked knowing what the left one already established:
    // `x != null && x > 0` is the shape this exists for, and it only works because
    // the second operand is checked after the first has had its say. It is restored
    // straight afterwards, because what `a && b` proved about a name is not a fact
    // about the expression as a whole — `(x != null) && (y != null)` says nothing
    // about `x` once it has been evaluated.
    const rightType = this.withFacts(
      this.factsWhen(node.left, node.operator === "and"),
      // Nested on purpose: the right operand's own facts are read *after* the left
      // one's have been installed, because that is what lets a chain be tested in one
      // condition — `p.next != null && p.next.next != null`, where knowing the first
      // `p.next` is a `Node` is what makes the second one readable at all. Restored in
      // the same order, so each level sees only the level below it.
      () =>
        this.withFacts(
          this.factsWhen(node.right, node.operator === "and"),
          () => this.visit(node.right),
        ),
    );
    if (leftType.kind === "error" || rightType.kind === "error") return errorType;
    if (leftType.kind !== "bool" || rightType.kind !== "bool") {
      this.bag.add(
        `operator '${spelling}' requires 'bool' operands, but these are '${typeToString(leftType)}' and '${typeToString(rightType)}'`,
        node.location,
        [...nullableNotes(leftType), ...nullableNotes(rightType)],
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
    if (symbol.kind === "constant") {
      this.bag.add(
        `'${node.name}' is declared with 'const' and cannot be assigned to`,
        node.nameLocation,
        [`the declaration of '${node.name}' is here`],
      );
      return errorType;
    }
    const valueType = this.visitExpecting(node.value, symbol.type);
    // The assignment makes any earlier test stale, so the fact is dropped before the
    // value is checked: `if (x != null) { x = null; print(tostring(x + 1)); }` has to
    // be rejected on the `+`, and that only happens if `x` is a `number?` again.
    this.forget(symbol, "");
    if (!isAssignable(symbol.type, valueType)) {
      this.bag.add(
        `cannot assign a value of type '${typeToString(valueType)}' to '${node.name}', which is '${typeToString(symbol.type)}'`,
        node.nameLocation,
        nullableNotes(valueType),
      );
      return errorType;
    }
    return symbol.type;
  }

  fieldAccess(node: FieldAccessExpression): Type {
    const targetType = this.visit(node.target);
    if (isError(targetType)) return errorType;
    // A fact about this exact place wins over the declared field type, which is what
    // makes the linked-list shape work: `if (p.next != null) { p.next.value }`. The
    // target has already been visited, so a broken base is still reported here.
    const place = this.placeOf(node);
    const symbol = place ? this.scope.lookup(place.name) : undefined;
    const fact = place && symbol ? this.narrowed.get(symbol)?.get(place.path) : undefined;
    if (fact) return fact;
    if (targetType.kind !== "struct") {
      this.bag.add(
        `this has type '${typeToString(targetType)}' and has no fields`,
        node.location,
        [
          "a field belongs to a struct, and only a struct has fields",
          "an array is read with an index instead: 'xs[0]'",
          ...nullableNotes(targetType),
        ],
      );
      return errorType;
    }
    const field = fieldTypeOf(targetType, node.field);
    if (!field) {
      this.bag.add(
        `'${targetType.name}' has no field '${node.field}'`,
        node.location,
        [describeFields(targetType)],
      );
      return errorType;
    }
    return field.type;
  }

  fieldAssign(node: FieldAssignmentExpression): Type {
    const targetType = this.visit(node.target);
    // As for a name, writing to a place makes an earlier test of it stale: after
    // `p.next = null` the `if (p.next != null)` that preceded it no longer holds.
    const place = this.placeOf(node.target);
    const symbol = place ? this.scope.lookup(place.name) : undefined;
    if (symbol) this.forget(symbol, place?.path ?? "");
    if (isError(targetType)) return errorType;
    if (targetType.kind !== "struct") {
      this.bag.add(
        `cannot assign a field of a value of type '${typeToString(targetType)}'`,
        node.location,
        [
          "only a struct has fields, and a struct is built by calling its name",
          "to replace the whole value, assign the name instead: 'p = Point(1, 2)'",
        ],
      );
      return errorType;
    }
    const field = fieldTypeOf(targetType, node.field);
    if (!field) {
      this.bag.add(
        `'${targetType.name}' has no field '${node.field}'`,
        node.location,
        [describeFields(targetType)],
      );
      return errorType;
    }
    const valueType = this.visitExpecting(node.value, field.type);
    if (!isAssignable(field.type, valueType)) {
      this.bag.add(
        `cannot assign a value of type '${typeToString(valueType)}' to '${node.field}', which is '${typeToString(field.type)}'`,
        node.value.location,
        [describeFields(targetType)],
      );
      return errorType;
    }
    return valueType;
  }

  index(node: IndexExpression): Type {
    const targetType = this.visit(node.target);
    const indexType = this.visit(node.index);
    if (isError(targetType) || isError(indexType)) return errorType;

    // A string and an array are both indexable, and the result type is the only
    // thing that differs: one code unit of a string, or one `T` of a `T[]`. The
    // bounds rule is the same for both and lives in the interpreter.
    if (targetType.kind === "string") {
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

    if (targetType.kind === "array") {
      if (indexType.kind !== "number") {
        this.bag.add(
          `an array index has type '${typeToString(indexType)}' but 'number' was expected`,
          node.index.location,
          ["array indexes are positions, so 0 is the first element"],
        );
        return errorType;
      }
      // The element type is the whole point of `T[]`: `xs[i]` is a `T`, with the
      // same type as `xs[i]` would be for every other `i`.
      return targetType.element;
    }

    this.bag.add(
      `this has type '${typeToString(targetType)}' and cannot be indexed; only a 'string' or an array can`,
      node.target.location,
      [
        "a string yields one code unit and a 'T[]' yields a 'T'",
        "a 'number' and a 'bool' have no parts to read, and 'void' has nothing at all",
        ...nullableNotes(targetType),
      ],
    );
    return errorType;
  }

  /**
   * `xs[0] = 1`.
   *
   * The element type is read out of the target, so the write is checked against
   * the same type the read would have produced. Bounds are *not* checked here: an
   * index can be computed at runtime, and Vela has no exceptions to catch, so an
   * out-of-range write is reported by the interpreter instead. That is the same
   * division of labour as `s[i]`.
   *
   * An array declared `const` still has writable elements. `const` binds a *name*
   * to a value it may not be reassigned to; what that value contains is a
   * property of the array, and an array of constants would be a strange thing to
   * add to a language whose arrays are fixed in length.
   */
  indexAssign(node: IndexAssignmentExpression): Type {
    const targetType = this.visit(node.target);
    const indexType = this.visit(node.index);
    if (isError(targetType) || isError(indexType)) return errorType;

    if (targetType.kind !== "array") {
      this.bag.add(
        `cannot assign through this, because it has type '${typeToString(targetType)}' and only an array can be written to`,
        node.target.location,
        [
          "a string can be indexed but not assigned to, since its length is fixed",
          "to replace a whole variable, assign the name instead: 'xs = [1, 2]'",
        ],
      );
      return errorType;
    }
    if (indexType.kind !== "number") {
      this.bag.add(
        `an array index has type '${typeToString(indexType)}' but 'number' was expected`,
        node.index.location,
        ["array indexes are positions, so 0 is the first element"],
      );
      return errorType;
    }

    const element = targetType.element;
    const valueType = this.visitExpecting(node.value, element);
    if (!isAssignable(element, valueType)) {
      this.bag.add(
        `cannot store a value of type '${typeToString(valueType)}' in a '${typeToString(targetType)}', whose elements are '${typeToString(element)}'`,
        node.value.location,
      );
      return errorType;
    }
    // An assignment evaluates to the value it stored, so it composes like the
    // name assignment does.
    return element;
  }

  /**
   * `[1, 2, 3]`.
   *
   * The element type is not written in the literal, so it comes from two places in
   * this order:
   *
   *   1. **The context**, when there is one — a declared type, a return type, or a
   *      parameter it is passed to. `let xs: number[] = [];` has no elements to
   *      learn from, so the annotation is the only source.
   *   2. **The elements themselves**, when there is no context. `[1, 2]` is
   *      `number[]` and `["a"]` is `string[]`, and the first element fixes the type
   *      that every later one has to agree with.
   *
   * An empty literal with no context is the one case that cannot resolve, and it is
   * an error rather than a guess: `let xs = [];` has no element type and so no way
   * to check a later `xs[0] = "a"`.
   */
  arrayLiteral(node: ArrayLiteral): Type {
    const context = this.expected;
    const contextElement = context && context.kind === "array" ? context.element : null;

    if (node.elements.length === 0) {
      if (contextElement) return arrayType(contextElement);
      this.bag.add(
        "an empty array literal has no element type",
        node.location,
        [
          "write the type in the declaration: 'let xs: number[] = [];'",
          "or put one element in to say what the array holds",
        ],
      );
      return errorType;
    }

    // Widening as it goes: the first element that arrives sets the element type
    // when the context did not, and every later element is checked against it.
    let element = contextElement;
    node.elements.forEach((item: any, i: number) => {
      const actual = this.visitExpecting(item, element);
      if (isError(actual)) return;
      if (!element) {
        element = actual;
        return;
      }
      if (!isAssignable(element, actual)) {
        this.bag.add(
          `element ${i + 1} has type '${typeToString(actual)}' but this array holds '${typeToString(element)}'`,
          item.location,
          ["every element of an array has the same type"],
        );
      }
    });

    return arrayType(element ?? errorType);
  }

  call(node: CallExpression): Type {
    // `Point(1, 2)` is a call whose callee is a type, and it is checked as the
    // function it really is: one parameter per field, in the order declared,
    // returning the struct. Reusing the ordinary call path is what means the arity
    // and argument diagnostics are the familiar ones rather than a second dialect.
    const struct = this.structCallee(node);
    if (struct) {
      // A struct on a cycle has no buildable value, so there is no signature worth
      // checking against and nothing this call could do right. Skipping it keeps the
      // cycle to the single diagnostic that says why.
      if (this.unbuildable.has(struct.name)) return errorType;
      const signature = functionType(
        struct.fields.map((field) => field.type),
        struct,
      );
      // An optional field's argument may be left out, so the arity is a range rather
      // than a count. The lower bound is the length of the required prefix, which the
      // parser has already guaranteed is a prefix by refusing a required field after
      // an optional one.
      const required = struct.fields.filter((field) => !field.optional).length;
      this.checkArguments(
        node,
        signature,
        this.visitArgs(node, signature),
        [
          "a struct takes one argument per field, in the order they are declared",
          ...optionalFieldNote(struct),
        ],
        required,
      );
      return struct;
    }

    const calleeType = this.visit(node.callee);
    // The arguments are visited before the callee is judged, so a call with both a
    // bad callee and a bad argument reports both. `expected` is what an argument
    // like `f([1, 2])` needs to learn its element type from.
    const signature = calleeType.kind === "function" ? calleeType : null;
    const argTypes = this.visitArgs(node, signature);
    if (calleeType.kind === "error") return errorType;
    // A variable declared as `function` holds a function whose signature was not
    // recorded, so the arity and the return type cannot be checked here. The call
    // is allowed and the result is `any`, which absorbs any use of it. This is the
    // documented cost of the bare type, and the alternative — a full signature type
    // — would only let a function be stored under exactly one signature.
    if (calleeType.kind === "anyFunction") return anyType;
    if (!signature) {
      this.bag.add(
        `this is not a function (it has type '${typeToString(calleeType)}')`,
        node.callee.location,
      );
      return errorType;
    }
    const spec = this.builtinFor(node.callee);
    this.checkArguments(node, signature, argTypes, []);
    // The one built-in whose result type depends on its arguments. Everything else
    // returns what its signature says, so this is the only place a call's type is
    // computed rather than looked up.
    return spec?.returns?.(argTypes) ?? signature.returnType;
  }

  /** Visit every argument, giving each the parameter type it is passed to. */
  private visitArgs(node: CallExpression, signature: FunctionType | null): readonly Type[] {
    return node.args.map((arg, i) =>
      this.visitExpecting(arg, signature ? (signature.params[i] ?? null) : null),
    );
  }

  /**
   * Check one call's arity and argument types against a signature.
   *
   * A constructor is a call whose "signature" comes from a struct's fields, so this
   * is shared rather than written twice; the extra notes are what a struct adds to
   * the same two checks. `minArgs` is the number of arguments that cannot be left
   * out, which is every parameter for a function and only the required prefix for a
   * struct with optional fields — so the arity is a range rather than a single
   * number, and the message says which end of it was missed.
   */
  private checkArguments(
    node: CallExpression,
    signature: FunctionType,
    argTypes: readonly Type[],
    extraNotes: readonly string[],
    minArgs = signature.params.length,
  ): void {
    // A parameter the checker could not work out makes the arity meaningless too:
    // "expected 1 argument but got 0" against `fn(<error>)` complains about a
    // signature that does not exist. The real error is already reported, where the
    // declaration that caused it is.
    if (signature.params.some(isError)) return;
    const expected = signature.params.length;
    if (argTypes.length < minArgs || argTypes.length > expected) {
      const got = argTypes.length;
      // Two wordings, because the two mistakes are different: too few means a value
      // was forgotten, and too many means one has no field to land in. A range is
      // only written when the two ends differ, so the ordinary call keeps its
      // familiar message and the ordinary arity mistake reads as one thing.
      const message =
        minArgs === expected
          ? `expected ${expected} argument${expected === 1 ? "" : "s"} but got ${got}`
          : got < minArgs
            ? `expected at least ${minArgs} argument${minArgs === 1 ? "" : "s"} but got ${got}`
            : `expected at most ${expected} argument${expected === 1 ? "" : "s"} but got ${got}`;
      this.bag.add(
        message,
        node.location,
        [`the signature is ${typeToString(signature)}`, ...extraNotes],
      );
      // Fall through to check the arguments anyway: a wrong-arity call often also
      // has a wrong argument, and reporting both saves a round trip.
    }

    // A built-in may narrow its own signature at the call site. `len` is seeded as
    // taking `any` because its parameter type is one of two things, and this is
    // where the second one is enforced — resolving to the seeded symbol is what
    // makes it a built-in check rather than a rule about arbitrary functions.
    const spec = this.builtinFor(node.callee);

    argTypes.forEach((actual, i) => {
      const arg = node.args[i]!;
      if (isError(actual)) return;
      if (spec?.accepts) {
        if (!spec.accepts(actual, i, argTypes)) {
          this.bag.add(
            `argument ${i + 1} has type '${typeToString(actual)}', which '${spec.name}' does not accept`,
            arg.location,
            // A nullable argument gets the narrowing hint as well as the built-in's
            // own note, because `len(x?)` fails for two reasons at once and the one
            // the reader has to act on is the missing test.
            [
              ...(spec.acceptsHint ? [spec.acceptsHint] : []),
              ...(actual.kind === "nullable" ? narrowingHint : []),
            ],
          );
        }
        return;
      }
      const expected = signature.params[i];
      if (!expected) return; // Already reported as an arity error.
      if (!isAssignable(expected, actual)) {
        this.bag.add(
          `argument ${i + 1} has type '${typeToString(actual)}' but '${typeToString(expected)}' was expected`,
          arg.location,
          [...extraNotes, ...nullableNotes(actual)],
        );
      }
    });
  }

  /**
   * The struct a call is constructing, or null when the callee is not a struct name.
   *
   * Looked up rather than visited, because a struct name is not a value: the
   * `variable` visitor reports a bare use of one, and that report must not fire for
   * the one use that is legal.
   */
  private structCallee(node: CallExpression): StructType | null {
    if (node.callee.kind !== "variable") return null;
    const symbol = this.scope.lookup(node.callee.name);
    // A binding in scope wins, because shadowing has to mean something: a local
    // `Point` is a function, not a struct, whatever the program declares.
    if (symbol) return symbol.kind === "struct" && symbol.type.kind === "struct" ? symbol.type : null;
    // Not in scope yet. A struct's existence does not depend on where its
    // declaration sits, exactly as a function's does not, so `Point(1, 2)` above
    // `struct Point` still constructs one. A name that is neither in scope nor
    // declared is simply absent here, so this cannot double-report.
    return this.structTypes.get(node.callee.name) ?? null;
  }

  program(): Type {
    return errorType;
  }

  letDecl(_node: Declaration): Type {
    return errorType;
  }

  constDecl(_node: ConstDeclaration): Type {
    return errorType;
  }
}

/**
 * Whether two types may be compared with `==` or `!=`.
 *
 * Same kind is enough for the primitives, and deliberately enough for functions: a
 * bare `function` records no signature, so demanding one here would reject `f == g`
 * for two perfectly good functions. An array is different — its element type is
 * part of the type, so `number[]` and `string[]` are as unrelated as `number` and
 * `string` are.
 */
function comparableForEquality(left: Type, right: Type): boolean {
  // `null` is comparable with everything, and that is deliberate: `x == null` has to be
  // writable for any expression, or a value could not be probed once its type had been
  // pinned down. Comparing something that cannot be absent is always false, which Vela
  // does not complain about any more than it complains about `1 == 1` — it reports
  // faults, not tautologies. What it does not allow is a *nullable* value on one side
  // and a non-nullable one on the other: those may or may not be equal, so the
  // comparison has no single answer, and hiding that would hide the case a reader is
  // looking for.
  if (left.kind === "null" || right.kind === "null") return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "array" && right.kind === "array") return typesEqual(left.element, right.element);
  // Two nullable types are comparable when their inner types are, so `number?` and
  // `string?` are as unrelated as `number` and `string` are.
  if (left.kind === "nullable" && right.kind === "nullable") return typesEqual(left.inner, right.inner);
  // Two values of two different structs are as unrelated as a number and a string,
  // even if their fields match, because the name is the whole of a nominal type.
  if (left.kind === "struct" && right.kind === "struct") return left.name === right.name;
  return true;
}

/**
 * The fields of a struct, spelled out, for a note under a diagnostic about one of
 * them. A note that lists the fields answers "what *can* I write here?" without
 * the reader having to go and look at the declaration.
 */
function describeFields(type: StructType): string {
  if (type.fields.length === 0) return `'${type.name}' has no fields`;
  return `the fields of '${type.name}' are ${type.fields
    .map((field) => `'${field.name}: ${typeToString(field.type)}'`)
    .join(", ")}`;
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

    // A loop may run zero times, so it never counts as returning. A `struct`
    // declaration is not a statement at all — it produces no value and cannot
    // transfer control — so it belongs with the rest of the "nothing happens here".
    case "while":
    case "for":
    case "letDecl":
    case "constDecl":
    case "fnDecl":
    case "structDecl":
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

/**
 * What to say under a diagnostic whose cause is a nullable value.
 *
 * One wording for every site, because the message has already said which two types
 * did not match and what a reader needs next is how to fix it: test the value, or give
 * it one. Returns nothing for a type that is not nullable, so a caller can spread it
 * into a note list without asking about the type twice.
 */
function nullableNotes(value: Type): string[] {
  if (value.kind === "nullable") {
    return [
      `'${typeToString(value)}' may be absent, so it is not a '${typeToString(value.inner)}' until a test has proved it is there`,
      ...narrowingHint,
    ];
  }
  if (value.kind === "null") {
    return [
      "'null' holds no value, so it is only usable where a nullable type is expected",
      "annotate the target as 'number?' rather than 'number', or store a real value instead",
    ];
  }
  return [];
}

/**
 * The fix, without the claim it belongs to.
 *
 * A diagnostic whose message names something *other* than the type mismatch — a
 * built-in saying which shapes it takes, say — should carry the test and not the
 * "'T?' is not a 'T'" sentence, which reads as an explanation of a mismatch the
 * reader is not being told about.
 */
const narrowingHint = [
  "test it first: 'if (x != null) { ... }' narrows it for the rest of that branch",
];

/**
 * The struct a field's type reaches without passing through a nullable edge, or null
 * when it reaches none.
 *
 * Used only by the cycle search, where "does this edge break the chain" is the whole
 * question: a nullable edge can be `null`, and a `null` stops the walk at that point,
 * so it is deliberately not followed. An array is followed to its element type
 * because an array stores copies rather than links, so it holds the cycle as firmly
 * as a field does.
 */
/**
 * A note naming the fields a constructor call may leave out, or nothing when every
 * field is required.
 *
 * It exists because "expected at least 1 argument but got 0" does not say *why* one
 * would be acceptable, and the reason is written in the struct rather than at the
 * call. Naming the fields turns an arity complaint into a fix: the reader learns
 * which argument they may drop without going back to the declaration.
 */
function optionalFieldNote(struct: StructType): string[] {
  const optional = struct.fields.filter((field) => field.optional);
  if (optional.length === 0) return [];
  const names = optional.map((field) => `'${field.name}'`).join(", ");
  return [
    `${names} ${optional.length === 1 ? "is" : "are"} optional, so ${optional.length === 1 ? "it" : "they"} may be left out of the call`,
  ];
}

/** Facts as entries, for copying into the map a following path is checked under. */
function mapFacts(facts: readonly Fact[]): [Symbol, Map<string, Type>][] {
  return facts.map((fact) => [fact.symbol, new Map([[fact.path, fact.type]])]);
}

/** The field names of a path, so it can be walked one step at a time. */
function splitPath(path: string): string[] {
  return path === "" ? [] : path.slice(1).split(".");
}

function structReachedBy(type: Type): string | null {
  if (type.kind === "struct") return type.name;
  if (type.kind === "array") return structReachedBy(type.element);
  return null;
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
