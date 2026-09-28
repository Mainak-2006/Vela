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
      case "letDecl": {
        this.open(`(letDecl ${declaration.name}: ${declaration.type}${this.at(declaration.nameLocation)}`);
        this.printExpression(declaration.initializer);
        this.close(")");
        return;
      }
      case "fnDecl": {
        this.open(
          `(fnDecl ${declaration.name} (${declaration.params
            .map(formatParam)
            .join(", ")}) -> ${declaration.returnType}${this.at(declaration.nameLocation)}`,
        );
        this.printStatement(declaration.body);
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
    // A `letDecl` in a header is still a Declaration, so print it the same way
    // as any other rather than inventing a header-specific form.
    if (initializer.kind === "letDecl") {
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
    }
  }
}

function formatParam(param: Parameter): string {
  return `${param.name}: ${param.type}`;
}
