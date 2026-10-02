/**
 * AST printer — renders a program as an indented S-expression.
 *
 * This is a debugging aid, reachable as `vela ast`. It is deliberately a direct
 * recursive walk rather than a `NodeVisitor`: the point of `NodeVisitor` is that
 * the checker and the interpreter cannot forget a node kind, and neither of those
 * cares about pretty-printing. Prefer whichever is more readable locally.
 *
 * With `locations: true` each node is tagged with its line and column, which is
 * how you confirm that a node's span really does cover what you expect.
 */

import type {
  Declaration,
  Expression,
  ForInitializer,
  Parameter,
  Program,
  Statement,
  TypeNode,
} from "./nodes.js";

export interface PrintOptions {
  /** Append `@line:column` to each node. */
  readonly locations?: boolean;
  /** Indentation string. Defaults to two spaces. */
  readonly indent?: string;
}

const INDENT = "  ";

export function printProgram(program: Program, options: PrintOptions = {}): string {
  const printer = new AstPrinter(options.indent ?? INDENT, options.locations ?? false);
  printer.printProgram(program);
  return printer.finish();
}

class AstPrinter {
  private readonly lines: string[] = [];
  private depth = 0;

  constructor(
    private readonly indent: string,
    private readonly showLocations: boolean,
  ) {}

  finish(): string {
    return this.lines.join("\n");
  }

  private open(text: string): void {
    this.lines.push(this.pad() + text);
    this.depth++;
  }

  private close(text: string): void {
    this.depth--;
    this.lines.push(this.pad() + text);
  }

  private pad(): string {
    return this.indent.repeat(this.depth);
  }

  private leaf(text: string, location?: { line: number; column: number }): void {
    this.lines.push(this.pad() + text + this.at(location));
  }

  private at(location?: { line: number; column: number }): string {
    return this.showLocations && location ? `  @${location.line}:${location.column}` : "";
  }

  printProgram(program: Program): void {
    this.open(`(program${this.at(program.location)}`);
    for (const declaration of program.declarations) this.printDeclaration(declaration);
    this.close(")");
  }

  // ------------------------------------------------------------- declarations

  printDeclaration(declaration: Declaration): void {
    switch (declaration.kind) {
      case "letDecl":
      case "constDecl": {
        // `let` and `const` are the same node apart from the keyword, so the printed
        // form differs only in that word. Rendering both from one branch is what
        // keeps the two from drifting apart in the output.
        this.open(
          `(${declaration.kind} ${declaration.name}: ${formatType(declaration.type)}${this.at(declaration.nameLocation)}`,
        );
        this.printExpression(declaration.initializer);
        this.close(")");
        return;
      }
      case "fnDecl": {
        this.open(
          `(fnDecl ${declaration.name} (${declaration.params
            .map(formatParam)
            .join(", ")}) -> ${formatType(declaration.returnType)}${this.at(declaration.nameLocation)}`,
        );
        this.printStatement(declaration.body);
        this.close(")");
        return;
      }
      case "structDecl": {
        this.open(`(structDecl ${declaration.name}${this.at(declaration.nameLocation)}`);
        for (const field of declaration.fields) {
          // The `?` is written after the name, where the source writes it, so a
          // reader comparing `vela ast` output against the file sees the same shape
          // in both.
          const optional = field.optional ? "?" : "";
          this.leaf(`(field ${field.name}${optional}: ${formatType(field.type)})`, field.location);
        }
        this.close(")");
        return;
      }
      default:
        this.printStatement(declaration);
    }
  }

  // --------------------------------------------------------------- statements

  printStatement(statement: Statement): void {
    switch (statement.kind) {
      case "block":
        this.open(`(block${this.at(statement.location)}`);
        for (const declaration of statement.declarations) this.printDeclaration(declaration);
        this.close(")");
        return;

      case "if": {
        this.open(`(if${this.at(statement.location)}`);
        this.printExpression(statement.condition);
        this.printStatement(statement.thenBranch);
        if (statement.elseBranch) this.printStatement(statement.elseBranch);
        this.close(")");
        return;
      }

      case "while": {
        this.open(`(while${this.at(statement.location)}`);
        this.printExpression(statement.condition);
        this.printStatement(statement.body);
        this.close(")");
        return;
      }

      case "for": {
        this.open(`(for${this.at(statement.location)}`);
        this.printForInitializer(statement.initializer);
        if (statement.condition) this.printExpression(statement.condition);
        else this.leaf("(empty)");
        if (statement.update) this.printExpression(statement.update);
        else this.leaf("(empty)");
        this.printStatement(statement.body);
        this.close(")");
        return;
      }

      case "return": {
        if (statement.value) {
          this.open(`(return${this.at(statement.location)}`);
          this.printExpression(statement.value);
          this.close(")");
        } else {
          this.leaf(`(return)`, statement.location);
        }
        return;
      }

      case "break":
        this.leaf(`(break)`, statement.location);
        return;

      case "continue":
        this.leaf(`(continue)`, statement.location);
        return;

      case "print": {
        this.open(`(print${this.at(statement.location)}`);
        this.printExpression(statement.value);
        this.close(")");
        return;
      }

      case "expressionStmt": {
        this.open(`(expressionStmt${this.at(statement.location)}`);
        this.printExpression(statement.expression);
        this.close(")");
        return;
      }
    }
  }

  private printForInitializer(initializer: ForInitializer): void {
    if (initializer === null) {
      this.leaf("(empty)");
      return;
    }
    // A `letDecl` or `constDecl` in a header is still a Declaration, so print it the
    // same way as any other rather than inventing a header-specific form.
    if (initializer.kind === "letDecl" || initializer.kind === "constDecl") {
      this.printDeclaration(initializer);
      return;
    }
    this.printExpression(initializer);
  }

  // -------------------------------------------------------------- expressions

  printExpression(expression: Expression): void {
    switch (expression.kind) {
      case "numberLiteral":
        this.leaf(`(numberLiteral ${expression.value})`, expression.location);
        return;

      case "stringLiteral":
        this.leaf(`(stringLiteral ${JSON.stringify(expression.value)})`, expression.location);
        return;

      case "nullLiteral":
        this.leaf(`(nullLiteral)`, expression.location);
        return;
      case "booleanLiteral":
        this.leaf(`(booleanLiteral ${expression.value})`, expression.location);
        return;

      case "variable":
        this.leaf(`(variable ${expression.name})`, expression.location);
        return;

      case "unary":
        this.open(`(unary ${expression.operator}${this.at(expression.location)}`);
        this.printExpression(expression.operand);
        this.close(")");
        return;

      case "binary":
        this.open(`(binary ${expression.operator}${this.at(expression.location)}`);
        this.printExpression(expression.left);
        this.printExpression(expression.right);
        this.close(")");
        return;

      case "logical":
        this.open(`(logical ${expression.operator}${this.at(expression.location)}`);
        this.printExpression(expression.left);
        this.printExpression(expression.right);
        this.close(")");
        return;

      case "assignment":
        this.open(`(assign ${expression.name}${this.at(expression.nameLocation)}`);
        this.printExpression(expression.value);
        this.close(")");
        return;

      case "call": {
        this.open(`(call${this.at(expression.location)}`);
        this.printExpression(expression.callee);
        for (const arg of expression.args) this.printExpression(arg);
        this.close(")");
        return;
      }

      case "index": {
        this.open(`(index${this.at(expression.location)}`);
        this.printExpression(expression.target);
        this.printExpression(expression.index);
        this.close(")");
        return;
      }

      case "indexAssign": {
        this.open(`(indexAssign${this.at(expression.location)}`);
        this.printExpression(expression.target);
        this.printExpression(expression.index);
        this.printExpression(expression.value);
        this.close(")");
        return;
      }

      // The field name is a leaf rather than a tail on the closing paren: it is
      // part of the node, not of the bracket, and it is the one thing in the dump
      // that says which field was meant.
      case "fieldAccess": {
        this.open(`(fieldAccess${this.at(expression.location)}`);
        this.printExpression(expression.target);
        this.leaf(expression.field, expression.location);
        this.close(")");
        return;
      }

      case "fieldAssign": {
        this.open(`(fieldAssign${this.at(expression.location)}`);
        this.printExpression(expression.target);
        this.leaf(expression.field, expression.location);
        this.printExpression(expression.value);
        this.close(")");
        return;
      }

      case "arrayLiteral": {
        this.open(`(arrayLiteral${this.at(expression.location)}`);
        for (const element of expression.elements) this.printExpression(element);
        this.close(")");
        return;
      }
    }
  }
}

function formatParam(param: Parameter): string {
  return `${param.name}: ${formatType(param.type)}`;
}

/**
 * How a type annotation is written back out.
 *
 * The printer renders the tree the way the source spelled it, so a `TypeNode`
 * prints as its own text and not as the resolved `Type` the checker produces.
 * Those are different representations of the same fact and only the first belongs
 * in a tree. Every `TypeNode` kind is deliberately spelled exactly as it is written,
 * so for a type with no structure `kind` is the whole answer; a kind that gains
 * structure (a signature's parameters, an array's element type) needs a real
 * rendering here.
 */
function formatType(type: TypeNode): string {
  if (type.kind === "signature") {
    const params = type.params.map(formatType).join(", ");
    return `fn(${params}) -> ${formatType(type.returnType)}`;
  }
  // No parentheses around the element: the brackets bind to it, which is how it
  // was written and how it parses back, so `number[][]` round-trips as itself.
  if (type.kind === "array") return `${formatType(type.element)}[]`;
  // A `?` after the type it applies to, for the same reason there are no
  // parentheses: `number?[]` is an array of nullable numbers and reads as itself.
  if (type.kind === "nullable") return `${formatType(type.inner)}?`;
  // A struct annotation is its name, so the dump shows the same word the source
  // did rather than a shape nobody wrote.
  if (type.kind === "structType") return type.name;
  return type.kind;
}
