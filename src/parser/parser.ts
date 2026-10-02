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

import { DiagnosticBag, span, type SourceLocation } from "../diagnostics.js";
import { describeKind, TOKEN, type Token, type TokenKind } from "../lexer/token.js";
import type {
  ArrayLiteral,
  BinaryExpression,
  BinaryOperator,
  Block,
  ConstDeclaration,
  Declaration,
  Expression,
  FieldAccessExpression,
  FieldAssignmentExpression,
  ForInitializer,
  FunctionDeclaration,
  IndexAssignmentExpression,
  IndexExpression,
  LetDeclaration,
  Parameter,
  Program,
  SignatureTypeNode,
  Statement,
  StructDeclaration,
  StructField,
  TypeNode,
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
      return this.parseLetRest("letDecl");
    }
    if (this.check(TOKEN.CONST)) {
      this.advance();
      return this.parseLetRest("constDecl");
    }
    if (this.check(TOKEN.FN)) return this.parseFunction();
    if (this.check(TOKEN.STRUCT)) return this.parseStruct();
    return this.parseStatement();
  }

  /**
   * The rest of a `let` or a `const`: the keyword has already been consumed.
   *
   * The two are the same grammar with different keywords, and the only thing that
   * differs downstream is whether the name may be assigned to. `kind` is threaded in
   * rather than duplicated so the two can never drift apart in the grammar.
   */
  private parseLetRest(kind: "letDecl" | "constDecl"): LetDeclaration | ConstDeclaration | null {
    const name = this.expect(TOKEN.IDENT, "a variable name");
    if (!name) {
      this.synchronize();
      return null;
    }
    // Bailing out when the `:` is missing is what keeps one mistake to one message.
    // The parser would otherwise go on to read a type out of whatever token is there,
    // and report the same problem a second time in different words.
    if (!this.expect(TOKEN.COLON, "':' followed by a type")) {
      this.synchronize();
      return null;
    }
    // Same reasoning for the type itself. A signature is long enough that a
    // mistake inside it leaves the parser deep in the wrong place, so bailing here
    // keeps one malformed annotation to one message instead of also complaining
    // that the `=` it swallowed was missing.
    const type = this.parseTypeAnnotation();
    if (!type) {
      this.synchronize();
      return null;
    }
    if (!this.expect(TOKEN.EQUAL, "'=' followed by an initial value")) {
      this.synchronize();
      return null;
    }
    const initializer = this.parseExpression();
    if (this.reportIncrementInExpression(initializer)) return null;
    const semi = this.expect(TOKEN.SEMICOLON, "';' at the end of the declaration");
    if (!initializer || !semi) {
      this.synchronize();
      return null;
    }
    return {
      kind,
      name: name.lexeme,
      nameLocation: name.location,
      type,
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
    if (!this.expect(TOKEN.COLON, "':' followed by a return type")) {
      this.synchronize();
      return null;
    }
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
      returnType,
      body,
      location: span(fn.location, body.location),
    };
  }

  /**
   * `struct Name { field: type; }`
   *
   * Every field ends with `;` like every other statement in the language, which is
   * what makes `struct P { a: number; b: string; }` and the multi-line form the
   * same thing. The braces are `{`...`}` rather than an indentation block, because
   * this is a list of declarations rather than executable statements.
   */
  private parseStruct(): StructDeclaration | null {
    const keyword = this.advance(); // 'struct'
    const name = this.expect(TOKEN.IDENT, "a struct name");
    if (!name) {
      this.synchronize();
      return null;
    }
    if (!this.expect(TOKEN.LEFT_BRACE, "'{' to start the field list")) {
      this.synchronize();
      return null;
    }
    const fields: StructField[] = [];
    const names = new Set<string>();
    let seenOptional = false;
    let reportedOrder = false;
    while (!this.check(TOKEN.RIGHT_BRACE) && !this.check(TOKEN.EOF)) {
      const field = this.parseStructField(names);
      // One bad field must not swallow the rest: the field list is reported, the
      // declaration is still built from the fields that parsed, so a program with
      // a typo in the last field still type-checks the first one. Skipping to the
      // next `;` is only for a field that failed — a field that parsed has already
      // consumed its own, and skipping again would eat the one after it.
      if (field) {
        // Optional fields have to be a suffix, because a constructor fills them in
        // order: `Config(1)` cannot mean "give me the label and leave out the
        // retries", because there is one argument and it is the first field's. The
        // alternative — matching by name — would need named arguments, which is a
        // much larger feature, so the rule is the position instead of the syntax.
        if (field.optional) {
          seenOptional = true;
        } else if (seenOptional && !reportedOrder) {
          // Once per declaration, at the first field that breaks the order. Every
          // field after it breaks it too, and saying so at each would be one mistake
          // reported several times, each with a fix that is the same fix.
          reportedOrder = true;
          this.bag.add(
            `required field '${field.name}' cannot follow an optional one`,
            field.nameLocation,
            [
              "a constructor takes one argument per field, in order, so leaving one out leaves out everything after it",
              "move the optional fields to the end of the list",
            ],
          );
        }
        fields.push(field);
        continue;
      }
      this.synchronizeToFieldBoundary();
    }
    const close = this.expect(TOKEN.RIGHT_BRACE, "'}' to close the field list");
    if (!close) {
      this.synchronize();
      return null;
    }
    return {
      kind: "structDecl",
      name: name.lexeme,
      nameLocation: name.location,
      fields,
      location: span(keyword.location, close.location),
    };
  }

  private parseStructField(seen: Set<string>): StructField | null {
    const name = this.expect(TOKEN.IDENT, "a field name");
    if (!name) return null;
    if (seen.has(name.lexeme)) {
      this.bag.add(`field '${name.lexeme}' is declared twice in this struct`, name.location, [
        "a struct's fields are its type, so two fields with one name would give it two values",
      ]);
    }
    seen.add(name.lexeme);
    // The `?` goes after the name, where a reader expects to see "this one might not
    // be there", rather than after the type — where a `?` already means something
    // else (`next: Node?` is *required* to be given a value, and may hold null).
    const optional = this.check(TOKEN.QUESTION);
    if (optional) this.advance();
    if (!this.expect(TOKEN.COLON, "':' followed by a field type")) return null;
    const type = this.parseTypeAnnotation();
    if (!type) return null;
    const semi = this.expect(TOKEN.SEMICOLON, "';' after the field declaration");
    if (!semi) return null;
    // An optional field stores `T?`, and both ways of writing that are refused, so a
    // field's declaration says one thing. `a?: T?` asks for the nullable twice, and
    // `a?: void` asks to leave out a value that does not exist.
    if (optional && type.kind === "nullable") {
      this.bag.add(
        `field '${name.lexeme}' is already nullable, so '?' changes nothing`,
        name.location,
        [
          "write either 'next?: Node' or 'next: Node?', not both",
          "the first may be left out of the constructor; the second must be given one",
        ],
      );
    }
    if (optional && type.kind === "void") {
      this.bag.add("a field cannot be optional and have type 'void'", name.location, [
        "'void' is the absence of a value, so there is nothing to leave out",
        "write the type of the value instead, as in 'label?: string'",
      ]);
    }
    return {
      kind: "structField",
      name: name.lexeme,
      nameLocation: name.location,
      type,
      optional,
      location: span(name.location, semi.location),
    };
  }

  /**
   * Skip to the next field. A `;` is a field boundary and a `}` ends the list, so
   * this is narrower than the statement-level `synchronize`, which would skip a
   * `}`-terminated block and lose the end of the declaration.
   */
  private synchronizeToFieldBoundary(): void {
    while (!this.check(TOKEN.SEMICOLON) && !this.check(TOKEN.RIGHT_BRACE) && !this.check(TOKEN.EOF)) {
      this.advance();
    }
    if (this.check(TOKEN.SEMICOLON)) this.advance();
  }

  private parseParamList(): Parameter[] | null {
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' to start the parameter list")) return null;
    const params: Parameter[] = [];
    if (this.match(TOKEN.RIGHT_PAREN)) return params;

    while (true) {
      const name = this.expect(TOKEN.IDENT, "a parameter name");
      if (!name) return null;
      if (!this.expect(TOKEN.COLON, "':' followed by a type")) return null;
      const type = this.parseTypeAnnotation();
      if (!type) return null;
      params.push({
        name: name.lexeme,
        nameLocation: name.location,
        type,
      });
      if (this.match(TOKEN.RIGHT_PAREN)) return params;
      if (!this.expect(TOKEN.COMMA, "',' between parameters or ')' to close the list")) return null;
    }
  }

  /**
   * Parse a type annotation into a `TypeNode`.
   *
   * The `kind` is the same string the source spelled, so the node reads as the
   * annotation did and `resolveTypeNode` stays a one-to-one mapping. The parser is
   * the only stage that can say which type names exist, so it is also where an
   * unknown one is reported — the checker downstream sees a `TypeNode` that is
   * already known to be well-formed.
   *
   * A written signature is handled here rather than at the call sites, so that
   * every annotation position accepts one without knowing whether it happens to be
   * a parameter, a return type, or a variable. The same is true of the suffixes:
   * `parseTypeSuffix` is applied here, so every annotation position accepts `[]`
   * and `?` without knowing which one it is.
   */
  private parseTypeAnnotation(): TypeNode | null {
    const token = this.peek();
    let base: TypeNode;
    switch (token.kind) {
      case TOKEN.TYPE_NUMBER:
      case TOKEN.TYPE_STRING:
      case TOKEN.TYPE_BOOL:
      case TOKEN.TYPE_VOID:
      case TOKEN.TYPE_FUNCTION:
        this.advance();
        base = { kind: token.kind, location: token.location };
        break;
      case TOKEN.FN: {
        const signature = this.parseSignatureType();
        if (!signature) return null;
        base = signature;
        break;
      }
      // A declared struct is written by name, and the parser cannot check that the
      // name is one — only the checker, which has the declarations. So an unknown
      // name parses and is diagnosed later, rather than being rejected here as a
      // bad token: `let p: Nope = ...;` has two possible causes and this is the
      // stage that can tell them apart.
      case TOKEN.IDENT: {
        this.advance();
        base = { kind: "structType", name: token.lexeme, location: token.location };
        break;
      }
      default:
        this.bag.add(
          `expected a type name, found ${describeKind(token.kind)}`,
          token.location,
          [
            "the types are number, string, bool, void, and function",
            "a signature is written 'fn(number) -> number'",
            "an array is written 'number[]'",
            "a type that may be absent is written 'number?'",
            "a struct is written by its declared name",
            "every declaration in Vela needs an explicit type",
          ],
        );
        return null;
    }
    return this.parseTypeSuffix(base);
  }

  /**
   * Parse the `?` and `[]` suffixes of a type, in any order and as many times as
   * written.
   *
   * One loop for both, because neither suffix has a fixed position relative to the
   * other and a program should not have to parenthesise an annotation to say which
   * it meant: `number?[]` is an array of nullable numbers, `number[]?` is a nullable
   * array of numbers, and `number?[]?` is the first of those or nothing. Each is the
   * only reading it has.
   *
   * The `?` nests rather than merges. `number??` would be a type that accepts
   * exactly what `number?` accepts, so it is reported rather than quietly accepted:
   * a second `?` is a mistake about what the annotation means, and hiding it would
   * leave the reader with a type they did not write.
   */
  private parseTypeSuffix(base: TypeNode): TypeNode {
    let node = base;
    while (true) {
      if (this.check(TOKEN.QUESTION)) {
        const mark = this.peek();
        this.advance();
        // `void?` is the same dead end as `void[]`: a value that is always absent
        // cannot be stored, indexed, or compared, so every use of it would already
        // be an error. It is rejected at the annotation because the rule is about the
        // type *syntax* rather than about any one expression.
        if (node.kind === "void") {
          this.bag.add("a type cannot be a nullable 'void'", mark.location, [
            "'void' is the absence of a value, and 'void?' is still an absence",
            "write the type of the value, as in 'number?'",
          ]);
        }
        if (node.kind === "nullable") {
          this.bag.add(
            `this type is already nullable, so another '?' changes nothing`,
            mark.location,
            ["'number?' accepts everything 'number' does, plus null"],
          );
          // Still wrapped, so the tree stays total: one mistake stays one mistake and
          // the rest of the declaration reads normally.
          node = { kind: "nullable", inner: node, location: span(node.location, mark.location) };
          continue;
        }
        node = { kind: "nullable", inner: node, location: span(node.location, mark.location) };
        continue;
      }
      if (this.check(TOKEN.LEFT_BRACKET)) {
        node = this.parseOneArraySuffix(node);
        continue;
      }
      return node;
    }
  }

  /**
   * Parse one `[]` of an array type.
   *
   * The brackets bind to the element type, so `number[]` is one array and
   * `number[][]` is an array of arrays with no parentheses. The caller loops, so a
   * three-deep annotation needs no special handling and no reader counting brackets.
   *
   * A bare `[]` with nothing in front of it never reaches here: the caller only
   * offers this after a complete element type, so there is always something to
   * take the brackets off.
   */
  private parseOneArraySuffix(element: TypeNode): TypeNode {
    const open = this.advance(); // '['
    // An array of absences stores nothing usable: `xs[0]` would be a `void`, and
    // every use of a `void` is already an error, so the whole annotation could
    // never appear in a program that does anything. Reported here rather than in
    // the checker because the rule is about the type *syntax* — `void` is the only
    // type that cannot be stored — not about any particular expression.
    if (element.kind === "void") {
      this.bag.add("an array cannot hold 'void' elements", open.location, [
        "'void' is only meaningful as a function return type",
        "write the type of the elements instead, as in 'number[]'",
      ]);
    }
    // Synthesise the closing bracket rather than consuming anything looking for
    // it. The `[` is unambiguous evidence of what was meant, so the type is
    // complete enough to keep checking: the rest of the declaration then reads
    // normally and the mistake costs one message instead of derailing the line.
    let location: SourceLocation;
    if (this.check(TOKEN.RIGHT_BRACKET)) {
      this.advance();
      location = span(element.location, this.previous.location);
    } else {
      this.bag.add("expected ']' to close an array type", open.location, [
        "an array type is written 'number[]'",
      ]);
      location = span(element.location, open.location);
    }
    return { kind: "array", element, location };
  }

  /**
   * Parse `fn(paramTypes) -> returnType`.
   *
   * Parameter names are optional and ignored when present: `fn(n: number) ->
   * number` reads the same as `fn(number) -> number`, because a name is not part
   * of the type. Accepting both keeps the signature parallel to a `fn`
   * declaration, which a reader will otherwise have to double-check.
   *
   * Every failure here bails out rather than continuing, so one malformed
   * signature produces one diagnostic instead of a cascade from each missing
   * piece.
   */
  private parseSignatureType(): SignatureTypeNode | null {
    const fn = this.advance(); // 'fn'
    if (!this.expect(TOKEN.LEFT_PAREN, "'(' to start the parameter types")) {
      return null;
    }
    const params: TypeNode[] = [];
    if (!this.check(TOKEN.RIGHT_PAREN)) {
      while (true) {
        // A leading `name:` is documentation for a reader, not part of the type.
        if (this.check(TOKEN.IDENT) && this.peek(1).kind === TOKEN.COLON) {
          this.advance();
          this.advance();
        }
        const type = this.parseTypeAnnotation();
        if (!type) return null;
        params.push(type);
        if (this.match(TOKEN.COMMA)) continue;
        break;
      }
    }
    if (!this.expect(TOKEN.RIGHT_PAREN, "')' to close the parameter list")) return null;
    if (!this.expect(TOKEN.ARROW, "'->' followed by a return type")) return null;
    const returnType = this.parseTypeAnnotation();
    if (!returnType) return null;
    return {
      kind: "signature",
      params,
      returnType,
      location: span(fn.location, returnType.location),
    };
  }

  /**
   * Parse `[1, 2, 3]`, or `[]`.
   *
   * The element type is deliberately not decided here. A literal has no
   * annotation of its own, so the checker reads its element type off the context —
   * the declared type of the variable being initialised, or the other side of a
   * comparison — and `[]` is the case that needs it, since an empty literal has
   * no elements to infer from. That is why `let xs = [];` cannot compile while
   * `let xs: number[] = [];` can, and it is the same shape as the rule that a
   * `void` expression needs a context.
   *
   * No trailing comma: `[1, 2,]` is an error, as `f(1,)` is.
   */
  private parseArrayLiteral(): ArrayLiteral | null {
    const open = this.advance(); // '['
    const elements: Expression[] = [];
    if (this.match(TOKEN.RIGHT_BRACKET)) {
      return { kind: "arrayLiteral", elements, location: span(open.location, this.previous.location) };
    }
    while (true) {
      const element = this.parseExpression();
      if (!element) return null;
      elements.push(element);
      if (this.match(TOKEN.RIGHT_BRACKET)) break;
      if (!this.expect(TOKEN.COMMA, "',' between elements or ']' to close the array")) return null;
      // `[,]` would otherwise loop looking for an expression.
      if (this.check(TOKEN.RIGHT_BRACKET)) {
        this.bag.add("trailing comma in an array literal", this.previous.location, [
          "write the elements separated by commas and no comma before the ']'",
        ]);
        this.advance();
        break;
      }
    }
    return {
      kind: "arrayLiteral",
      elements,
      location: span(open.location, this.previous.location),
    };
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
    if (this.check(TOKEN.LET) || this.check(TOKEN.CONST) || this.check(TOKEN.FN)) {
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
   * A `let` or `const` in a `for` header has no trailing `;` of its own; the
   * separator belongs to the header. This method consumes that separator in every
   * case, so the rest of `parseFor` can assume the initializer is already behind it.
   */
  private parseForInitializer(): ForInitializer {
    if (this.match(TOKEN.SEMICOLON)) return null;

    let initializer: ForInitializer;
    if (this.check(TOKEN.LET) || this.check(TOKEN.CONST)) {
      const kind = this.advance().kind === TOKEN.CONST ? "constDecl" : "letDecl";
      initializer = this.parseLetHeader(kind);
    } else {
      initializer = this.parseExpression();
    }
    this.expect(TOKEN.SEMICOLON, "';' after the loop initializer");
    return initializer;
  }

  private parseLetHeader(kind: "letDecl" | "constDecl"): LetDeclaration | ConstDeclaration | null {
    const name = this.expect(TOKEN.IDENT, "a variable name");
    if (!name) return null;
    if (!this.expect(TOKEN.COLON, "':' followed by a type")) return null;
    const type = this.parseTypeAnnotation();
    if (!this.expect(TOKEN.EQUAL, "'=' followed by an initial value")) return null;
    const initializer = this.parseExpression();
    if (!type || !initializer) return null;
    return {
      kind,
      name: name.lexeme,
      nameLocation: name.location,
      type,
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
    // A failed expression has already been reported by whatever rejected it, and
    // the `;` it then runs into is a consequence of that rather than a second
    // mistake. Reporting it anyway would blame the semicolon for a problem the
    // first diagnostic already located exactly.
    if (!value) {
      this.synchronize();
      return null;
    }
    const semi = this.expect(TOKEN.SEMICOLON, "';' after the value to print");
    if (!semi) {
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
    // As in `parsePrint`: one mistake gets one diagnostic.
    if (!expression) {
      this.synchronize();
      return null;
    }
    const semi = this.expect(TOKEN.SEMICOLON, "';' after the expression");
    if (!semi) {
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
   * Assignment is restricted to a chain that starts with a name on the left.
   * Recognising that shape from the tokens directly, rather than building a
   * general expression and validating it afterwards, is what lets `a + 1 = 2`
   * produce one clear error instead of a confusing cascade.
   *
   * Compound assignment is desugared here, into the same node a plain `x = x + y`
   * would produce. Nothing downstream — the checker, the interpreter, the AST
   * printer — knows that `+=` exists, which is the whole reason it is cheap to
   * add: a new operator that means nothing new.
   */
  private parseAssignment(): Expression | null {
    // The chain is read once and then kept: it becomes the `IndexExpression` or
    // `FieldAccessExpression` that an ordinary read would have produced, and any
    // further suffixes and binary operators continue from there. `xs[0] + 1`
    // therefore parses exactly as it would have without this branch, and nothing is
    // parsed twice.
    //
    // A chain has to start with a name, which is what makes `xs[0] = 1` and
    // `pts[0].x = 42` assignable while `f()[0] = 1` is not: a call is a temporary,
    // and there is nothing to write back into. What a chain that *does* parse may be
    // written through is a type question, and the checker answers it.
    if (!this.check(TOKEN.IDENT)) return this.parseBinary(BP.none);

    const name = this.advance();
    const base: Variable = { kind: "variable", name: name.lexeme, location: name.location };
    const target = this.parsePostfix(base);
    if (!target) return null;

    // Which of the three assignments this is follows from what the chain ended in,
    // not from how it started: `x` is a name, `p.x` a field, `xs[0]` an index. A
    // chain ending in a call — `f() = 1` — ends in a temporary and has nothing to
    // write to, so it falls through and is reported as a bad left-hand side.
    const compound = COMPOUND_ASSIGNMENT.get(this.peek().kind);
    // The three kinds of place a chain can end in, and therefore the three shapes an
    // assignment can have. A chain that runs through a call — `f()[0] = 1` — has only
    // a temporary to write to, so it falls through and is reported below as a bad
    // left-hand side rather than parsed as something it is not.
    const place = this.asPlace(target);
    if (place && (compound !== undefined || this.check(TOKEN.EQUAL))) {
      this.advance(); // '=' or '+=', '-=', ...
      const value = this.parseAssignment(); // right-associative
      if (!value) return null;
      if (compound !== undefined) {
        if (place.kind === "fieldAccess") return this.buildCompoundFieldAssignment(place, compound, value);
        if (place.kind === "index") return this.buildCompoundIndexAssignment(place, compound, value);
        return this.buildCompoundAssignment(name, compound, value);
      }
      if (place.kind === "variable") {
        return {
          kind: "assignment",
          name: place.name,
          nameLocation: place.location,
          value,
          location: span(place.location, value.location),
        };
      }
      if (place.kind === "fieldAccess") {
        return {
          kind: "fieldAssign",
          target: place.target,
          field: place.field,
          value,
          location: span(place.location, value.location),
        };
      }
      return {
        kind: "indexAssign",
        target: place.target,
        index: place.index,
        value,
        location: span(place.target.location, value.location),
      };
    }

    return this.parseBinaryRest(target, BP.none);
  }

  /**
   * The place `expr` names, or null when it names a value rather than a place.
   *
   * A name is a place, and so is a chain of `.field` and `[index]` suffixes over one:
   * `x`, `p.x`, `p.at.y`, `xs[0]`, `pts[0].x` and `p.tags[1]` all name somewhere an
   * assignment can write. A chain over anything else does not, because there is
   * nothing at the far end to write back into — `f()[0]`, `(p).x` and `p.f()` all
   * name a value, and the caller rejects them.
   *
   * Returning the narrowed node rather than a boolean is what lets the caller build
   * the right assignment node from it without repeating this test.
   */
  private asPlace(expr: Expression): Variable | FieldAccessExpression | IndexExpression | null {
    if (expr.kind === "variable") return expr;
    if (expr.kind === "fieldAccess" || expr.kind === "index") {
      return this.asPlace(expr.target) === null ? null : expr;
    }
    return null;
  }

  /**
   * Build `target[index] = target[index] <op> value`.
   *
   * The read on the right is a fresh `IndexExpression` rather than a reference to
   * the left, for the same reason `buildCompoundAssignment` builds a fresh
   * `Variable`: an assignment node is not an expression that can be read, so the
   * desugaring has to spell out what it means. Nothing downstream knows that
   * `+=` exists.
   */
  private buildCompoundIndexAssignment(
    read: IndexExpression,
    operator: BinaryOperator,
    value: Expression,
  ): IndexAssignmentExpression {
    const combined: BinaryExpression = {
      kind: "binary",
      operator,
      left: read,
      right: value,
      location: span(read.location, value.location),
    };
    return {
      kind: "indexAssign",
      target: read.target,
      index: read.index,
      value: combined,
      location: span(read.target.location, combined.location),
    };
  }

  /**
   * Build `target.field = target.field <op> value`.
   *
   * The read on the right is a fresh node, for the same reason the index version
   * builds one: an assignment is not something that can be read, so the
   * desugaring has to write out what it means.
   */
  private buildCompoundFieldAssignment(
    read: FieldAccessExpression,
    operator: BinaryOperator,
    value: Expression,
  ): FieldAssignmentExpression {
    const combined: BinaryExpression = {
      kind: "binary",
      operator,
      left: read,
      right: value,
      location: span(read.location, value.location),
    };
    return {
      kind: "fieldAssign",
      target: read.target,
      field: read.field,
      value: combined,
      location: span(read.location, combined.location),
    };
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
    const left = this.parsePrefix();
    if (!left) return null;
    return this.parseBinaryRest(left, minBp);
  }

  /**
   * Continue precedence-climbing from an already-parsed `left`.
   *
   * Split out of `parseBinary` so `parseAssignment` can hand in the `xs[0]` it has
   * read while deciding whether this is an assignment target. Without the split it
   * would have to either re-parse the subscript or stop before `xs[0] + 1` had
   * seen its `+ 1`.
   */
  private parseBinaryRest(left: Expression, minBp: number): Expression | null {
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
          "the left-hand side of '=' must be a name, an element or a field",
          token.location,
          [
            "to assign to an existing variable, write `name = value;`",
            "to replace an element, write `xs[0] = value;`",
            "to set a struct field, write `p.x = value;`",
          ],
        );
        // Returning rather than breaking is what keeps this from being reported
        // twice: the caller reports the `=` it could not place, and one mistake
        // gets one diagnostic.
        return null;
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
      case TOKEN.NULL: {
        const t = token;
        this.advance();
        if (t.kind === TOKEN.NULL) {
          // `null` is a literal, so it is a prefix with a value and nothing after
          // it. It has no suffix of its own — `null.x` is a field read on something
          // the checker will reject, and one mistake there is one message rather
          // than a syntax error about a keyword.
          expr = { kind: "nullLiteral", location: t.location };
        } else {
          expr = {
            kind: "booleanLiteral",
            value: t.kind === TOKEN.TRUE,
            location: t.location,
          };
        }
        break;
      }

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

      case TOKEN.LEFT_BRACKET: {
        const literal = this.parseArrayLiteral();
        if (!literal) return null;
        expr = literal;
        break;
      }

      default:
        this.bag.add(`expected an expression, found ${describeKind(token.kind)}`, token.location);
        return null;
    }

    return this.parsePostfix(expr);
  }

  /**
   * Apply call and index suffixes to `expr`, as tightly as they bind.
   *
   * This runs after a prefix operator rather than inside the binary loop, which is
   * what makes `-f(1)` mean `-(f(1))` and not `(-f)(1)`.
   *
   * Both suffixes share one loop so they chain freely: `f()[0]` and `s[0][1]`
   * parse the same way `f()(1)` and `s(1)(2)` do.
   *
   * It is a separate method because `parseAssignment` needs to resume from an
   * expression it has already parsed — `xs[0][1] = 2` has to be able to chain a
   * second index before the `=` is recognised — and resuming has to mean exactly
   * what starting from `parsePrefix` would have meant. One loop, two callers.
   */
  private parsePostfix(expr: Expression): Expression | null {
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
        const indexed = this.parseIndexSuffix(expr);
        if (!indexed) return null;
        expr = indexed;
        continue;
      }
      if (this.check(TOKEN.DOT)) {
        const accessed = this.parseFieldSuffix(expr);
        if (!accessed) return null;
        expr = accessed;
        continue;
      }
      return expr;
    }
  }

  /** Parse `[expr]` after `target` and build the index node. */
  private parseIndexSuffix(target: Expression): IndexExpression | null {
    this.advance(); // '['
    const index = this.parseExpression();
    if (!index) return null;
    if (!this.expect(TOKEN.RIGHT_BRACKET, "']' to close the index")) return null;
    return {
      kind: "index",
      target,
      index,
      location: span(target.location, this.previous.location),
    };
  }

  /** Parse `.name` after `target` and build the field node. */
  private parseFieldSuffix(target: Expression): FieldAccessExpression | null {
    this.advance(); // '.'
    const name = this.expect(TOKEN.IDENT, "a field name after '.'");
    if (!name) return null;
    return {
      kind: "fieldAccess",
      target,
      field: name.lexeme,
      location: span(target.location, name.location),
    };
  }
}

/** Token kinds that can begin a statement or declaration, used by `synchronize`. */
function isDeclarationStart(kind: TokenKind): boolean {
  switch (kind) {
    case TOKEN.LET:
    case TOKEN.CONST:
    case TOKEN.FN:
    case TOKEN.STRUCT:
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
