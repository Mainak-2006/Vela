# The Vela grammar

A reference for the syntax and static rules the compiler enforces.
`src/parser/parser.ts` and `src/types/checker.ts` are the authority; this
document describes the same language in a form that is easier to read than
recursive-descent code.

Every claim below was checked against the implementation, and where the
implementation and the obvious guess disagree, the implementation wins and the
disagreement is called out.

In the productions, `T` is a type name, `*` is zero or more, and `?` is optional.

## Lexical structure

### Whitespace and comments

Spaces, tabs, carriage returns, and newlines separate tokens and are otherwise
ignored. **Newlines are not significant.** There are no newline-sensitive
constructs, so a statement may be split across lines freely — the REPL adds that
convenience, the language does not require it.

There are two comment forms:

```
lineComment  ::= "//" { any character except newline }
blockComment ::= "/*" { any character } "*/"
```

Block comments **do not nest.** The first `*/` ends the comment, so
`/* a /* b */ print("x");` closes at the first `*/` and leaves
`print("x");` as real code. A block comment with no closing `*/` is an error, as
is a `//` comment that is the last thing in a file only if it is unterminated —
which it never is, since a line comment runs to the end of the line.

### Identifiers

An identifier starts with an ASCII letter or `_` and continues with letters,
digits, or `_`.

```
identifier ::= ( letter | "_" ) { letter | digit | "_" }
letter     ::= "A" … "Z" | "a" … "z"
```

Identifiers are case-sensitive, and `_1` is a perfectly ordinary identifier
rather than a malformed number.

### Keywords

These seventeen words are reserved and cannot be used as identifiers:

```
fn   let   return   if   else   while   for   break   continue   print
true   false   number   string   bool   void   function
```

`true` and `false` are literals of type `bool`, listed here because they are
also reserved. The last five are type names, so `let number: number = 1;` is a
parse error rather than a variable named `number`.

### Numbers

A decimal integer or fraction, with an optional exponent. Digit separators
(`_`) may be placed between digits and are ignored entirely.

```
number    ::= digits [ "." digits ] [ exponent ] | digits exponent
exponent  ::= ( "e" | "E" ) [ "+" | "-" ] digits
digits    ::= digit { digit | "_" }
```

Examples: `0`, `42`, `1_000_000`, `3.14`, `1e6`, `2.5e-3`, `1_0.0_1`.

Two things that surprise people:

- **A leading `.` is not a number.** `.5` is a lex error, not `0.5`. Write `0.5`.
- **A separator must be followed by a digit.** `1__0` is fine and equals `10`,
  but a trailing `1_` is an error. A separator is not a "grouping" marker with
  rules about placement; it is simply skipped wherever a digit may follow one.

There is one numeric type. A literal written `1` and one written `1.0` have the
same type, and `1 == 1.0` is true.

### Strings

A double-quoted sequence of characters. There are no single-quoted strings, no
raw strings, and no multi-line strings — a newline inside a string is an error,
so `"unterminated` does not run on looking for a closing quote.

```
string    ::= '"' { char | escape } '"'
char      ::= any character except '"' '\' and newline
escape    ::= "\\" ( '"' | "\\" | "n" | "t" | "r" | "0" )
```

The escapes are `\"`, `\\`, `\n`, `\t`, `\r`, and `\0`. **Any other escape is
an error** rather than passing through, so a typo like `\d` is reported instead
of silently becoming the letter `d`.

## Declarations

```
program       ::= declaration *
declaration   ::= fnDecl | letDecl
fnDecl        ::= "fn" identifier "(" params ")" ":" T block
letDecl       ::= "let" identifier ":" T "=" expression ";"
params        ::= [ param { "," param } ]
param         ::= identifier ":" T
```

Both a type and an initialiser are mandatory. `let x: number;` is a parse error
and `let x = 1;` is a parse error, not a warning: there is no uninitialised
variable, no `undefined`, and no type inference.

A `void` function is written with an explicit return type, and a bare `return;`
is allowed in it:

```vela
fn greet(name: string): void {
    print("hello, " + name);
    return;
}
```

A function declaration may be nested inside another function's body.

## Statements

```
statement    ::= printStmt | letStmt | returnStmt | ifStmt | whileStmt
               | forStmt | block | breakStmt | continueStmt | exprStmt
printStmt    ::= "print" "(" expression ")" ";"
letStmt      ::= "let" identifier ":" T "=" expression ";"
returnStmt   ::= "return" [ expression ] ";"
ifStmt       ::= "if" "(" expression ")" statement [ "else" statement ]
whileStmt    ::= "while" "(" expression ")" statement
forStmt      ::= "for" "(" forInit ";" expression ";" forUpdate ")" statement
forUpdate    ::= increment | expression
forInit      ::= "let" identifier ":" T "=" expression
block        ::= "{" statement * "}"
breakStmt    ::= "break" ";"
continueStmt ::= "continue" ";"
exprStmt     ::= expression ";"
increment    ::= identifier ( "++" | "--" ) ";"
```

Braces are not required around a single statement, so `if (n > 0) print("hi");`
is legal. `else` binds to the nearest unmatched `if`, as in C.

`for` has exactly the three-part C form with no optional parts. The initialiser
must be a `let`, which means **the loop variable is scoped to the loop** and
cannot be read after it. The update is an expression, so it takes no semicolon:

```vela
for (let i: number = 0; i < 10; i = i + 1) {
    print(i);
}
```

The update is an expression slot, so `i++` is accepted there — it is the one
place a statement form appears without its semicolon.

`++` and `--` are **statements**, not expressions, so they have no value:
`let y: number = i++;` and `i + j++;` are both errors. Outside the `for` update
they require a trailing semicolon. A leading `--` is *not* a decrement: `--1` is
a doubled negation and equals `1`, which is why `i--` needs a name in front of it
to be one.

Compound assignment `+=`, `-=`, `*=`, `/=`, and `%=` exist, and are sugar for
`x = x <op> value`. They desugar in the parser, so the AST, checker, and
interpreter are unchanged and every type rule applies unchanged.

`break` exits the innermost `while` or `for`. `continue` jumps to the update
expression of a `for`, or to the condition of a `while`.

## Expressions

Precedence, loosest to tightest. Each level is left-associative.

| Precedence | Operators |
| --- | --- |
| 1 | `\|\|` |
| 2 | `&&` |
| 3 | `==` `!=` |
| 4 | `<` `<=` `>` `>=` |
| 5 | `+` `-` |
| 6 | `*` `/` `%` |
| 7 | unary `-` `!` |

```
expression   ::= assignment
assignment   ::= identifier assignOp assignment | or
assignOp     ::= "=" | "+=" | "-=" | "*=" | "/=" | "%=" 
or           ::= and { "||" and }
and          ::= equality { "&&" equality }
equality     ::= comparison { ( "==" | "!=" ) comparison }
comparison   ::= term { ( "<" | "<=" | ">" | ">=" ) term }
term         ::= factor { ( "+" | "-" ) factor }
factor       ::= unary { ( "*" | "/" | "%" ) unary }
unary        ::= ( "-" | "!" ) unary | call
call         ::= primary { suffix }
suffix       ::= "(" [ expression { "," expression } ] ")"
               | "[" expression "]"
primary      ::= number | string | "true" | "false"
               | identifier | "(" expression ")"
```

**Assignment is right-associative and its left side must be a bare identifier.**
`a = b = 3;` assigns 3 to `b` and then to `a`. The parser recognises that shape
directly from the token stream rather than building a general expression and
rejecting it afterwards, which is what lets `a + 1 = 2` report one clear error —
"the left-hand side of '=' must be a variable" — instead of a cascade about a
missing semicolon.

**Indexing is `s[i]`, and a `string` is the only thing it accepts.** The result is
a one-code-unit `string`. `len` counts code units, so valid indices are `0`
through `len(s) - 1`; anything else is a runtime error, not an empty string. A
`number`, `bool`, or `void` is a compile error — there is no collection in the
language to subscript, so the diagnostic says so.

Suffixes share one loop, so calls and indexes chain freely: `f()[0]` and `s[0][1]`
parse the way `f()(1)` does.

**Calls take no trailing comma.** `f(1,)` is an error.

## Types

```
T ::= "number" | "string" | "bool" | "void" | "function"
```

The first four are primitives. `function` is a bare function type: it lets a
function be stored, passed, and returned, without naming a signature.

```vela
fn double(x: number): number { return x * 2; }

let f: function = double;   // correct
let n: number = 5;
let g: function = n;        // error: a number is not a function
```

The signature is not recorded, so a call through one is unchecked: `f(1, 2, 3)`
compiles and then fails at runtime, and the result has no known type, which is why
`tostring` is often needed around one.

A `fnDecl` may be nested, and its body sees its own name, so recursion works. More
than that, every signature in a declaration list is hoisted before any body in it
is checked, so a forward call and a mutually recursive pair both resolve. A `let`
is *not* hoisted and must be declared before use.

## Static rules

These are not syntax, but a program must satisfy them to run, and several are
surprising enough to be worth stating plainly.

**Types are never coerced.** `+` requires both operands to be the same type, so
`"n=" + 1` is an error rather than producing `"n=1"`, and `true + 1` is an error
rather than `2`. Use `tostring` and `tonumber` to convert deliberately.

**Comparisons require matching types.** `1 == "0"` and `1 == true` are both
errors. There is no cross-type equality.

**Ordering comparisons are numeric-only.** `==` and `!=` work on any two values
of the same type, but `<`, `<=`, `>`, and `>=` require `number` operands, so
`"a" < "b"` and `true < false` are both errors. There is no lexicographic order
on strings and no order on `bool`; the only magnitude available for a string is
`len`, which is a number. The checker and the interpreter agree on this — the
interpreter routes every ordering operator through the same numeric assertion, so
it is a rule about the language rather than a gap in the checker. The diagnostic
is easy to misread, though: `cannot apply '<' to 'string' and 'string'` carries a
note about `+`, because one operand check serves both operators.

**Conditions must be `bool`.** `if (n)` is an error. `0` and `""` are ordinary
values of their own types, not falsy, and there is no truthiness anywhere.

**`&&` and `||` short-circuit,** and require `bool` operands. This is a real
guarantee, not a description of the common case:
`false && (1 / 0 == 0)` is a safe expression that evaluates to `false`.

**`%` is a truncated remainder,** not a mathematical modulus: the result takes
the sign of the left operand, so `-7 % 2` is `-1`, and it works on fractions, so
`2 % 1.5` is `0.5`. `% 0` is a runtime error, not `0`.

**`/` is always true division.** `7 / 2` is `3.5`, and `7 / 2 * 2` is `7`, not
`8`. There is no integer division operator.

**A non-`void` function must return on every path,** or the checker rejects it.
This is sound but incomplete: it handles early returns and `if`/`else`, but it
treats a loop as not returning, so a function whose only `return` is inside a
`while` is wrongly rejected with "a function returning 'number' must end with a
return statement". Being wrong in the safe direction is the right trade for a
first version, and it is the most significant known limitation in the checker.

**Functions may be used before they are written; variables may not.** A block may
shadow an outer name (`{ let s: string = "i"; print(s); }` is fine), but
redeclaring a name in the same scope is an error. Every `fn` signature in a
declaration list is installed before any body in that list is checked, so a
forward call and a mutually recursive pair both resolve. A `let` must be declared
before use, because its type comes from a value that has to be computed first.

**A string index out of range is a runtime error,** not an empty string:
`s[5]` on `"ab"` reports `index 5 is out of range for a string of length 2`.
Negative indices are included in this. The checker cannot know the length, so
this is one of the errors that survives type checking.

**`print` is a statement, not a function.** `print` cannot appear in an
expression, so `let a: number = print(1);` is a parse error. The thirteen callable
built-ins are `tostring`, `tonumber`, `typeOf`, `len`, `trunc`, `floor`, `ceil`,
`round`, `abs`, `min`, `max`, `idiv`, and `read`.

**`read()` takes no arguments and prints no prompt,** returning one line of stdin
with the newline stripped, and `""` at end of input. There is no `null` to signal
end-of-input with, so an empty string is the answer — and a loop condition on
`line != ""` is how "until the user is done" is written.

**Errors stop the pipeline.** A program with a type error does not run, so
statements before the error never execute.

## Known gaps

- The `while`-only-return limitation described above, in the return analysis.
- No `sqrt` or `pow`, so `docs/SKILLS.md` section 11 writes both out of `trunc`.
  The eight numeric built-ins cover rounding and integer division, which is the
  part worth promising exactly.
- `s[i]` counts UTF-16 code units, so a surrogate pair occupies two indices and
  reading one half of an emoji gives a broken character. There is no code-point
  iteration to offer instead.
- The bare `function` type records no signature, so a call through one is not
  checked. This is the one known hole in the type system, and it is deliberate:
  see `docs/SKILLS.md` section 18.
- No ordering on `string` or `bool`, as described under static rules. `==` and
  `!=` are the whole of the comparison vocabulary for those two types.
- The REPL's multi-line heuristic is not part of this grammar. It reads balanced
  brackets and trailing operators, so a `while` body is legal on one line here
  just as it is across several.
