/**
 * The Parser — token stream to AST.
 *
 * Two techniques are combined, and the split is the interesting part:
 *
 *   - **Recursive descent** for statements and declarations. Each form gets its
 *     own `parseX` method, so the control flow mirrors the grammar and any single
 *     rule is easy to read in isolation.
 *
 *   - **Pratt parsing** (precedence climbing) for expressions. A flat precedence
 *     table plus one recursive function handles all thirteen binary operators
 *     without a hand-written method per level. Binding powers decide both when the
 *     loop should stop and which way an operator associates, so `2 * 3 + 4` and
 *     right-associativity fall out of the table rather than being special-cased.
 *
 * The parser recovers from errors by resynchronising at a `;` or `}`, so one pass
 * reports several syntax errors instead of only the first.
 */

import { DiagnosticBag, type SourceLocation, span } from "../diagnostics.js";
import { describeKind, TOKEN, type Token, type TokenKind } from "../lexer/token.js";
import type {
  BinaryExpression,
  BinaryOperator,
  Block,
  Declaration,
  Expression,
  ForInitializer,
  FunctionDeclaration,
  LetDeclaration,
  Parameter,
  PrimitiveTypeName,
  Program,
  Statement,
  UnaryOperator,
  Variable,
} from "../ast/nodes.js";

/** Parse `tokens` into a Program, reporting problems to `bag`. */
export function parse(tokens: readonly Token[], bag: DiagnosticBag): Program {
  return new Parser(tokens, bag).parseProgram();
}

/**
 * Binding powers. Higher binds tighter. `Or` doubles as the entry point for a
 * whole expression, so the lowest-precedence operator is also the floor.
 */
const BP = {
  none: 0,
  or: 10,
  and: 20,
  equality: 30,
  comparison: 40,
  term: 50,
  factor: 60,
  primary: 100,
} as const;

type BindingPower = (typeof BP)[keyof typeof BP];

interface Precedence {
  readonly left: number;
  readonly right: number;
  readonly operator: BinaryOperator;
}

/**
 * Left and right binding powers per operator. When right exceeds left the operator
 * is right-associative. All thirteen operators here are left-associative, so left
 * and right are equal and the recursion is a plain left-leaning loop.
 */
const BINARY_PRECEDENCE: ReadonlyMap<TokenKind, Precedence> = new Map<TokenKind, Precedence>([
  [TOKEN.EQUAL_EQUAL, { left: BP.equality, right: BP.equality, operator: "==" }],
  [TOKEN.BANG_EQUAL, { left: BP.equality, right: BP.equality, operator: "!=" }],
  [TOKEN.LESS, { left: BP.comparison, right: BP.comparison, operator: "<" }],
  [TOKEN.GREATER, { left: BP.comparison, right: BP.comparison, operator: ">" }],
  [TOKEN.LESS_EQUAL, { left: BP.comparison, right: BP.comparison, operator: "<=" }],
  [TOKEN.GREATER_EQUAL, { left: BP.comparison, right: BP.comparison, operator: ">=" }],
  [TOKEN.PLUS, { left: BP.term, right: BP.term, operator: "+" }],
  [TOKEN.MINUS, { left: BP.term, right: BP.term, operator: "-" }],
  [TOKEN.STAR, { left: BP.factor, right: BP.factor, operator: "*" }],
  [TOKEN.SLASH, { left: BP.factor, right: BP.factor, operator: "/" }],
  [TOKEN.PERCENT, { left: BP.factor, right: BP.factor, operator: "%" }],
]);

/** `&&` and `||` are their own nodes because they short-circuit at runtime. */
const LOGICAL_PRECEDENCE: ReadonlyMap<TokenKind, { bp: BindingPower; operator: "and" | "or" }> =
  new Map([
    [TOKEN.AND_AND, { bp: BP.and, operator: "and" }],
    [TOKEN.OR_OR, { bp: BP.or, operator: "or" }],
  ]);

/**
 * Compound assignment operators mapped to the binary operator they stand for.
 * `x += y` parses as `x = x + y`, so this table only has to name the operator.
 */
const COMPOUND_ASSIGNMENT: ReadonlyMap<TokenKind, BinaryOperator> = new Map([
  [TOKEN.PLUS_EQUAL, "+"],
  [TOKEN.MINUS_EQUAL, "-"],
  [TOKEN.STAR_EQUAL, "*"],
  [TOKEN.SLASH_EQUAL, "/"],
  [TOKEN.PERCENT_EQUAL, "%"],
]);

class Parser {
  private current = 0;
  /** Loop nesting depth, so `break`/`continue` can be validated. */
  private loopDepth = 0;
  /** Enclosing function count, so a bare `return` can be rejected. */
  private functionDepth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly bag: DiagnosticBag,
  ) {}

  // ------------------------------------------------------------ token helpers

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.current + ahead, this.tokens.length - 1)]!;
  }

  private get previous(): Token {
    return this.tokens[Math.max(0, this.current - 1)]!;
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private atEof(): boolean {
    return this.check(TOKEN.EOF);
  }

  private advance(): Token {
    if (!this.atEof()) this.current++;
    return this.previous;
  }

  private match(...kinds: readonly TokenKind[]): Token | null {
    for (const kind of kinds) {
      if (this.check(kind)) return this.advance();
    }
    return null;
  }

  /**
   * Consume a token of `kind`, or report a brief error naming what was wanted and
   * what was found. Recovery is left to the caller.
   */
  private expect(kind: TokenKind, what?: string): Token | null {
    if (this.check(kind)) return this.advance();
    const found = this.peek();
    this.bag.add(`expected ${what ?? describeKind(kind)}, found ${describeKind(found.kind)}`, found.location);
    return null;
  }

  /**
   * After an error, skip forward to something that can plausibly start a
   * declaration so that one bad declaration does not cascade into twenty errors.
   * Stops at `}` so the enclosing block can still be closed and parsed.
   */
  private synchronize(): void {
    if (this.match(TOKEN.SEMICOLON)) return;
    while (!this.atEof()) {
      if (this.previous.kind === TOKEN.RIGHT_BRACE) return;
      if (isDeclarationStart(this.peek().kind)) return;
      this.advance();
    }
  }

  // ------------------------------------------------------------------ program

  parseProgram(): Program {
    const declarations: Declaration[] = [];
    while (!this.atEof()) {
      const before = this.current;
      const declaration = this.parseDeclaration();
      if (declaration) declarations.push(declaration);
      if (this.current === before) {
        // No progress was made, so step past the offending token to guarantee
        // termination rather than spinning here forever.
        this.bag.add(
          `unexpected ${describeKind(this.peek().kind)} at the top level`,
          this.peek().location,
        );
        this.advance();
      }
    }
    const end = this.previous.location;
    return {
      kind: "program",
      declarations,
      location: { offset: 0, length: Math.max(1, end.offset + end.length), line: 1, column: 1 },
    };
  }

  // ------------------------------------------------------------- declarations

  private parseDeclaration(): Declaration | null {
    if (this.check(TOKEN.LET)) {
      this.advance();
      return this.parseLetRest();
    }
    if (this.check(TOKEN.FN)) return this.parseFunction();
    return this.parseStatement();
  }

  /** A `let` statement: the `let` keyword has already been consumed. */
  private parseLetRest(): LetDeclaration | null {
    const name = this.expect(TOKEN.IDENT, "a variable name");
    if (!name) {
      this.synchronize();
      return null;
    }
    this.expect(TOKEN.COLON, "':' followed by a type");
    const type = this.parseTypeAnnotation();
    if (!this.expect(TOKEN.EQUAL, "'=' followed by an initial value")) {
      this.synchronize();
      return null;
    }
    const initializer = this.parseExpression();
    if (this.reportIncrementInExpression(initializer)) return null;
    const semi = this.expect(TOKEN.SEMICOLON, "';' at the end of the declaration");
    if (!type || !initializer || !semi) {
      this.synchronize();
      return null;
    }
    return {
      kind: "letDecl",
      name: name.lexeme,
      nameLocation: name.location,
      type: type.name,
      typeLocation: type.location,
      initializer,
      location: span(name.location, semi.location),
    };
  }

  private parseFunction(): FunctionDeclaration | null {
    const fn = this.advance(); // 'fn'
    const name = this.expect(TOKEN.IDENT, "a function name");
    if (!name) {
      this.synchronize();
      return null;
    }
    const params = this.parseParamList();
    this.expect(TOKEN.COLON, "':' followed by a return type");
    const returnType = this.parseTypeAnnotation();
    this.functionDepth++;
    const body = this.parseBlock();
    this.functionDepth--;
    if (params === null || !returnType || !body) {
      this.synchronize();
      return null;
    }
    return {
      kind: "fnDecl",
      name: name.lexeme,
      nameLocation: name.location,
      params,
      returnType: returnType.name,
      returnTypeLocation: returnType.location,
      body,
      location: span(fn.location, body.location),
    };
  }

  private parseParamList(): Parameter[] | null {
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' to start the parameter list")) return null;
    const params: Parameter[] = [];
    if (this.match(TOKEN.RIGHT_PAREN)) return params;

    while (true) {
      const name = this.expect(TOKEN.IDENT, "a parameter name");
      if (!name) return null;
      this.expect(TOKEN.COLON, "':' followed by a type");
      const type = this.parseTypeAnnotation();
      if (!type) return null;
      params.push({
        name: name.lexeme,
        nameLocation: name.location,
        type: type.name,
        typeLocation: type.location,
      });
      if (this.match(TOKEN.RIGHT_PAREN)) return params;
      if (!this.expect(TOKEN.COMMA, "',' between parameters or ')' to close the list")) return null;
    }
  }

  private parseTypeAnnotation(): { name: PrimitiveTypeName; location: SourceLocation } | null {
    const token = this.peek();
    switch (token.kind) {
      case TOKEN.TYPE_NUMBER:
      case TOKEN.TYPE_STRING:
      case TOKEN.TYPE_BOOL:
      case TOKEN.TYPE_VOID:
      case TOKEN.TYPE_FUNCTION:
        this.advance();
        return { name: token.lexeme as PrimitiveTypeName, location: token.location };
      default:
        this.bag.add(
          `expected a type name (number, string, bool, void, or function), found ${describeKind(token.kind)}`,
          token.location,
          ["every declaration in Vela needs an explicit type"],
        );
        return null;
    }
  }

  // --------------------------------------------------------------- statements

  private parseStatement(): Statement | null {
    if (this.check(TOKEN.LEFT_BRACE)) {
      this.advance();
      return this.parseBlockRest();
    }
    if (this.check(TOKEN.IF)) return this.parseIf();
    if (this.check(TOKEN.WHILE)) return this.parseWhile();
    if (this.check(TOKEN.FOR)) return this.parseFor();
    if (this.check(TOKEN.RETURN)) return this.parseReturn();
    if (this.check(TOKEN.BREAK)) return this.parseBreak();
    if (this.check(TOKEN.CONTINUE)) return this.parseContinue();
    if (this.check(TOKEN.PRINT)) return this.parsePrint();
    // `i++;` starts with the name, so it is recognised as `ident` followed by
    // `++`/`--`. A leading `++` is never a prefix operator, so it can only be a
    // mistyped increment and is reported as one.
    if (this.check(TOKEN.IDENT) && (this.peek(1).kind === TOKEN.PLUS_PLUS || this.peek(1).kind === TOKEN.MINUS_MINUS)) {
      return this.parseIncrement();
    }
    if (this.check(TOKEN.PLUS_PLUS)) {
      return this.parseBareIncrement();
    }
    // A leading `--` is left alone. It is two unary minuses here, so `--1;` stays
    // the documented 1, and parsePrefix handles it.
    if (this.check(TOKEN.LET) || this.check(TOKEN.FN)) {
      return this.parseDeclaration() as Statement | null;
    }
    return this.parseExpressionStatement();
  }

  /**
   * The `for` loop update, which is the one place `i++` is written without a
   * trailing semicolon. It is an expression slot, so the same desugaring applies;
   * the only difference from a standalone statement is the terminator.
   */
  private parseForUpdate(): Expression | null {
    if (this.check(TOKEN.IDENT) && (this.peek(1).kind === TOKEN.PLUS_PLUS || this.peek(1).kind === TOKEN.MINUS_MINUS)) {
      const name = this.advance();
      const op = this.advance();
      return this.buildCompoundAssignment(name, op.kind === TOKEN.PLUS_PLUS ? "+" : "-", {
        kind: "numberLiteral",
        value: 1,
        location: name.location,
      });
    }
    if (this.check(TOKEN.PLUS_PLUS) || this.check(TOKEN.MINUS_MINUS)) {
      this.advance();
      this.bag.add(
        "expected a variable name before the increment operator",
        this.previous.location,
        ["the loop update is written as an expression, for example: i++"],
      );
      return null;
    }
    return this.parseExpression();
  }

  /**
   * `i++;` and `i--;`, which are statements and not expressions.
   *
   * There is no post-increment value to hand back, so this desugars to an
   * expression statement assigning `i = i + 1`.
   *
   * `--` is only a decrement when it directly follows a name. Written any other
   * way it stays the unary minus it has always been, so `--1` is still 1 — the
   * documented reading of a doubled negation. A statement ends in `;` or a loop
   * header's `)`, which is what tells `i--;` from `- -1`.
   */
  private parseIncrement(): Statement | null {
    const name = this.advance();
    const op = this.advance();
    if (!this.expect(TOKEN.SEMICOLON, "';' at the end of the statement")) return null;
    const value = this.buildCompoundAssignment(name, op.kind === TOKEN.PLUS_PLUS ? "+" : "-", {
      kind: "numberLiteral",
      value: 1,
      location: name.location,
    });
    return { kind: "expressionStmt", expression: value, location: name.location };
  }

  /** A leading `++` or `--` with no variable in front of it. */
  private parseBareIncrement(): Statement | null {
    this.advance();
    this.bag.add(
      "expected a variable name before the increment operator",
      this.previous.location,
      ["write it as a statement, for example: i++;"],
    );
    this.synchronize();
    return null;
  }

  private parseBlock(): Block | null {
    if (!this.expect(TOKEN.LEFT_BRACE, "'{' to start a block")) return null;
    return this.parseBlockRest();
  }

  /** The opening brace has already been consumed. */
  private parseBlockRest(): Block | null {
    const open = this.previous;
    const declarations: Declaration[] = [];
    while (!this.check(TOKEN.RIGHT_BRACE) && !this.atEof()) {
      const before = this.current;
      const declaration = this.parseDeclaration();
      if (declaration) declarations.push(declaration);
      if (this.current === before) this.advance(); // guarantee progress
    }
    const close = this.expect(TOKEN.RIGHT_BRACE, "'}' to close the block");
    if (!close) return null;
    return {
      kind: "block",
      declarations,
      location: span(open.location, close.location),
    };
  }

  private parseIf(): Statement | null {
    const ifToken = this.advance();
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' after 'if'")) {
      this.synchronize();
      return null;
    }
    const condition = this.parseExpression();
    if (!this.expect(TOKEN.RIGHT_PAREN, "')' after the condition")) {
      this.synchronize();
      return null;
    }
    const thenBranch = this.parseStatement();
    // `else if` stays nested rather than being flattened into a chain, which keeps
    // the dangling-else rule the simple "attach to the nearest `if`".
    const elseBranch = this.match(TOKEN.ELSE) ? this.parseStatement() : null;
    if (!condition || !thenBranch) {
      this.synchronize();
      return null;
    }
    return {
      kind: "if",
      condition,
      thenBranch,
      elseBranch,
      location: span(ifToken.location, (elseBranch ?? thenBranch).location),
    };
  }

  private parseWhile(): Statement | null {
    const whileToken = this.advance();
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' after 'while'")) {
      this.synchronize();
      return null;
    }
    const condition = this.parseExpression();
    if (!this.expect(TOKEN.RIGHT_PAREN, "')' after the condition")) {
      this.synchronize();
      return null;
    }
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    if (!condition || !body) {
      this.synchronize();
      return null;
    }
    return {
      kind: "while",
      condition,
      body,
      location: span(whileToken.location, body.location),
    };
  }

  private parseFor(): Statement | null {
    const forToken = this.advance();
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' after 'for'")) {
      this.synchronize();
      return null;
    }
    const initializer = this.parseForInitializer();
    const condition = this.check(TOKEN.SEMICOLON) ? null : this.parseExpression();
    if (!this.expect(TOKEN.SEMICOLON, "';' after the loop condition")) {
      this.synchronize();
      return null;
    }
    const update = this.check(TOKEN.RIGHT_PAREN) ? null : this.parseForUpdate();
    if (!this.expect(TOKEN.RIGHT_PAREN, "')' after the loop update")) {
      this.synchronize();
      return null;
    }
    this.loopDepth++;
    const body = this.parseStatement();
    this.loopDepth--;
    if (!body) {
      this.synchronize();
      return null;
    }
    return {
      kind: "for",
      initializer,
      condition,
      update,
      body,
      location: span(forToken.location, body.location),
    };
  }

  /**
   * A `let` in a `for` header has no trailing `;` of its own; the separator
   * belongs to the header. This method consumes that separator in every case, so
   * the rest of `parseFor` can assume the initializer is already behind it.
   */
  private parseForInitializer(): ForInitializer {
    if (this.match(TOKEN.SEMICOLON)) return null;

    let initializer: ForInitializer;
    if (this.check(TOKEN.LET)) {
      this.advance();
      initializer = this.parseLetHeader();
    } else {
      initializer = this.parseExpression();
    }
    this.expect(TOKEN.SEMICOLON, "';' after the loop initializer");
    return initializer;
  }

  private parseLetHeader(): LetDeclaration | null {
    const name = this.expect(TOKEN.IDENT, "a variable name");
    if (!name) return null;
    this.expect(TOKEN.COLON, "':' followed by a type");
    const type = this.parseTypeAnnotation();
    if (!this.expect(TOKEN.EQUAL, "'=' followed by an initial value")) return null;
    const initializer = this.parseExpression();
    if (!type || !initializer) return null;
    return {
      kind: "letDecl",
      name: name.lexeme,
      nameLocation: name.location,
      type: type.name,
      typeLocation: type.location,
      initializer,
      location: span(name.location, initializer.location),
    };
  }

  private parseReturn(): Statement | null {
    const returnToken = this.advance();
    if (this.functionDepth === 0) {
      this.bag.add("'return' is only allowed inside a function", returnToken.location);
    }
    // A `return` directly before `;` has no value, which is legal for `void`.
    const value = this.check(TOKEN.SEMICOLON) ? null : this.parseExpression();
    const semi = this.expect(TOKEN.SEMICOLON, "';' after 'return'");
    if (!semi) {
      this.synchronize();
      return null;
    }
    return {
      kind: "return",
      value,
      location: span(returnToken.location, semi.location),
    };
  }

  private parseBreak(): Statement | null {
    const token = this.advance();
    if (this.loopDepth === 0) {
      this.bag.add("'break' is only allowed inside a loop", token.location);
    }
    const semi = this.expect(TOKEN.SEMICOLON, "';' after 'break'");
    if (!semi) {
      this.synchronize();
      return null;
    }
    return { kind: "break", location: span(token.location, semi.location) };
  }

  private parseContinue(): Statement | null {
    const token = this.advance();
    if (this.loopDepth === 0) {
      this.bag.add("'continue' is only allowed inside a loop", token.location);
    }
    const semi = this.expect(TOKEN.SEMICOLON, "';' after 'continue'");
    if (!semi) {
      this.synchronize();
      return null;
    }
    return { kind: "continue", location: span(token.location, semi.location) };
  }

  private parsePrint(): Statement | null {
    const printToken = this.advance(); // 'print'
    const value = this.parseExpression();
    const semi = this.expect(TOKEN.SEMICOLON, "';' after the value to print");
    if (!value || !semi) {
      this.synchronize();
      return null;
    }
    return {
      kind: "print",
      value,
      location: span(printToken.location, semi.location),
    };
  }

  private parseExpressionStatement(): Statement | null {
    const expression = this.parseExpression();
    if (this.reportIncrementInExpression(expression)) return null;
    const semi = this.expect(TOKEN.SEMICOLON, "';' after the expression");
    if (!expression || !semi) {
      this.synchronize();
      return null;
    }
    return {
      kind: "expressionStmt",
      expression,
      location: span(expression.location, semi.location),
    };
  }

  /**
   * Report `++`/`--` written where a value was expected, and say why.
   *
   * These are statements, so the generic "expected ';'" that would otherwise
   * appear is accurate but unhelpful: it does not say that the problem is the
   * missing value, only that a semicolon is missing too. Returns true when it
   * reported, so both call sites can bail out.
   */
  private reportIncrementInExpression(expression: Expression | null): boolean {
    if (!expression || !(this.check(TOKEN.PLUS_PLUS) || this.check(TOKEN.MINUS_MINUS))) return false;
    const op = this.advance();
    this.bag.add(
      `'${op.lexeme}' is a statement and has no value, so it cannot be used in an expression`,
      op.location,
      ["write it on its own line, for example: i++;"],
    );
    this.synchronize();
    return true;
  }

  // -------------------------------------------------------------- expressions

  parseExpression(): Expression | null {
    return this.parseAssignment();
  }

  /**
   * Assignment is restricted to a bare identifier on the left. Recognising that
   * shape from the tokens directly, rather than building a general expression and
   * validating it afterwards, is what lets `a + 1 = 2` produce one clear error
   * instead of a confusing cascade.
   *
   * Compound assignment is desugared here, into the same node a plain `x = x + y`
   * would produce. Nothing downstream — the checker, the interpreter, the AST
   * printer — knows that `+=` exists, which is the whole reason it is cheap to
   * add: a new operator that means nothing new.
   */
  private parseAssignment(): Expression | null {
    if (this.check(TOKEN.IDENT) && this.peek(1).kind === TOKEN.EQUAL) {
      const name = this.advance();
      this.advance(); // '='
      const value = this.parseAssignment(); // right-associative
      if (!value) return null;
      return {
        kind: "assignment",
        name: name.lexeme,
        nameLocation: name.location,
        value,
        location: span(name.location, value.location),
      };
    }

    const compound = COMPOUND_ASSIGNMENT.get(this.peek(1).kind);
    if (this.check(TOKEN.IDENT) && compound) {
      const name = this.advance();
      this.advance(); // '+=', '-=', ...
      const value = this.parseAssignment();
      if (!value) return null;
      return this.buildCompoundAssignment(name, compound, value);
    }

    return this.parseBinary(BP.none);
  }

  /**
   * Build `name = name <op> value` for a compound assignment. The left operand is
   * a fresh `Variable` node rather than the assignment's own target, because the
   * target is a name and an expression is what the binary operator needs.
   */
  private buildCompoundAssignment(
    name: Token,
    operator: BinaryOperator,
    value: Expression,
  ): Expression {
    const target: Variable = {
      kind: "variable",
      name: name.lexeme,
      location: name.location,
    };
    const binary: BinaryExpression = {
      kind: "binary",
      operator,
      left: target,
      right: value,
      location: span(name.location, value.location),
    };
    return {
      kind: "assignment",
      name: name.lexeme,
      nameLocation: name.location,
      value: binary,
      location: span(name.location, value.location),
    };
  }

  /**
   * The heart of the expression parser. Parse a prefix, then keep folding in
   * binary operators for as long as the next operator binds more tightly than
   * `minBp`. The loop exits on the first operator that does not, and that is
   * exactly how precedence is enforced.
   *
   * The loop condition is `entry.left > minBp` and the recursion passes
   * `entry.left`. That pairing is what makes equal-precedence operators
   * left-associative: in `1 - 2 - 3` the inner call receives `minBp = 50`, so the
   * second `-` fails the `50 > 50` test and returns just `2`, yielding
   * `(1 - 2) - 3`. Using `<` for the test and recursing with a *right* power
   * here silently flips every operator to right-associative.
   */
  private parseBinary(minBp: number): Expression | null {
    let left = this.parsePrefix();
    if (!left) return null;

    while (true) {
      const token = this.peek();

      const logical = LOGICAL_PRECEDENCE.get(token.kind);
      if (logical) {
        if (logical.bp <= minBp) break;
        this.advance();
        const right = this.parseBinary(logical.bp);
        if (!right) return null;
        left = {
          kind: "logical",
          operator: logical.operator,
          left,
          right,
          location: span(left.location, right.location),
        };
        continue;
      }

      const entry = BINARY_PRECEDENCE.get(token.kind);
      if (entry) {
        if (entry.left <= minBp) break;
        this.advance();
        const right = this.parseBinary(entry.left);
        if (!right) return null;
        left = {
          kind: "binary",
          operator: entry.operator,
          left,
          right,
          location: span(left.location, right.location),
        };
        continue;
      }

      // `=` only appears in the grammar as assignment, which `parseAssignment`
      // handles before reaching here. Reaching it means the left side was not a
      // bare identifier, so say that instead of the generic "expected ';'".
      if (token.kind === TOKEN.EQUAL) {
        this.bag.add(
          "the left-hand side of '=' must be a variable",
          token.location,
          ["to assign to an existing variable, write `name = value;`"],
        );
      }
      break;
    }
    return left;
  }

  private parseArguments(): Expression[] | null {
    const args: Expression[] = [];
    if (this.match(TOKEN.RIGHT_PAREN)) return args;
    while (true) {
      const arg = this.parseExpression();
      if (!arg) return null;
      args.push(arg);
      if (this.match(TOKEN.RIGHT_PAREN)) return args;
      if (!this.expect(TOKEN.COMMA, "',' between arguments or ')' to close the call")) return null;
    }
  }

  private parsePrefix(): Expression | null {
    const token = this.peek();
    let expr: Expression;

    switch (token.kind) {
      case TOKEN.NUMBER:
        this.advance();
        expr = { kind: "numberLiteral", value: token.numericValue ?? 0, location: token.location };
        break;

      case TOKEN.STRING:
        this.advance();
        expr = { kind: "stringLiteral", value: token.stringValue ?? "", location: token.location };
        break;

      case TOKEN.TRUE:
      case TOKEN.FALSE:
        this.advance();
        expr = {
          kind: "booleanLiteral",
          value: token.kind === TOKEN.TRUE,
          location: token.location,
        };
        break;

      case TOKEN.IDENT:
        this.advance();
        expr = { kind: "variable", name: token.lexeme, location: token.location };
        break;

      case TOKEN.BANG:
      case TOKEN.MINUS:
      case TOKEN.MINUS_MINUS: {
        this.advance();
        // Recursing into parsePrefix means the operand is itself a full unary
        // expression, which is what makes `--x` and `!a == b` come out right.
        //
        // `--` reaches here only in prefix position, where it is two minuses and
        // not a decrement: `i--` is a decrement, but `--1` is 1 and `---1` is -1,
        // which is what the language has always documented. A doubled minus is
        // therefore a nested unary over the same operand.
        const operand = this.parsePrefix();
        if (!operand) return null;
        const operator: UnaryOperator = token.kind === TOKEN.BANG ? "!" : "-";
        const location = span(token.location, operand.location);
        if (token.kind === TOKEN.MINUS_MINUS) {
          expr = {
            kind: "unary",
            operator: "-",
            operand: { kind: "unary", operator: "-", operand, location },
            location,
          };
          break;
        }
        expr = { kind: "unary", operator, operand, location };
        break;
      }

      case TOKEN.LEFT_PAREN: {
        this.advance();
        const inner = this.parseExpression();
        if (!this.expect(TOKEN.RIGHT_PAREN, "')' to close the group")) return null;
        if (!inner) return null;
        // A group is transparent rather than a node of its own, which keeps the
        // tree free of nodes that carry no meaning.
        expr = inner;
        break;
      }

      default:
        this.bag.add(`expected an expression, found ${describeKind(token.kind)}`, token.location);
        return null;
    }

    // Call and index suffixes are applied here, after the prefix operator, so they
    // bind tighter than everything. Doing this in parsePrefix rather than in the
    // binary loop is what makes `-f(1)` mean `-(f(1))` and not `(-f)(1)`.
    //
    // Both suffixes share one loop so they chain freely: `f()[0]` and `s[0][1]`
    // parse the same way `f()(1)` and `s(1)(2)` do.
    for (;;) {
      if (this.check(TOKEN.LEFT_PAREN)) {
        this.advance();
        const args = this.parseArguments();
        if (!args) return null;
        expr = {
          kind: "call",
          callee: expr,
          args,
          location: span(expr.location, this.previous.location),
        };
        continue;
      }
      if (this.check(TOKEN.LEFT_BRACKET)) {
        this.advance();
        const index = this.parseExpression();
        if (!this.expect(TOKEN.RIGHT_BRACKET, "']' to close the index")) return null;
        if (!index) return null;
        expr = {
          kind: "index",
          target: expr,
          index,
          location: span(expr.location, this.previous.location),
        };
        continue;
      }
      return expr;
    }
  }
}

/** Token kinds that can begin a statement or declaration, used by `synchronize`. */
function isDeclarationStart(kind: TokenKind): boolean {
  switch (kind) {
    case TOKEN.LET:
    case TOKEN.FN:
    case TOKEN.IF:
    case TOKEN.WHILE:
    case TOKEN.FOR:
    case TOKEN.RETURN:
    case TOKEN.BREAK:
    case TOKEN.CONTINUE:
    case TOKEN.PRINT:
    case TOKEN.LEFT_BRACE:
      return true;
    default:
      return false;
  }
}
