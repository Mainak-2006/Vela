# Vela — Skill Reference

Everything an AI model needs to write, debug, read, and extend Vela: the
language, the standard library, the complete error catalogue, the tooling, and
the compiler internals.

`docs/grammar.md` is the prose grammar. This file is the operational version:
it is organised by task, states the traps explicitly, and every example's output
was executed against the current compiler before being written down.

`docs/vela.SKILL.md` is the condensed version, and `vela install-skill` puts it
into a coding assistant for you. See
[Installing this guide into an assistant](#installing-this-guide-into-an-assistant).

**Authority.** `src/parser/parser.ts` and `src/types/checker.ts` are the
authority on the language. Where this document and the implementation disagree,
the implementation is right and this document is a bug. Where this document
disagrees with the *obvious guess* about a language you know, this document is
right and the guess is wrong.

---

## Table of contents

1. [What Vela is](#1-what-vela-is)
2. [The five rules that break code when ignored](#2-the-five-rules-that-break-code-when-ignored)
3. [Things that do not exist in Vela](#3-things-that-do-not-exist-in-vela)
4. [Lexical structure](#4-lexical-structure)
5. [Declarations](#5-declarations)
6. [Statements](#6-statements)
7. [Expressions and precedence](#7-expressions-and-precedence)
8. [Types and static rules](#8-types-and-static-rules)
9. [Built-ins](#9-built-ins)
10. [Runtime semantics reference](#10-runtime-semantics-reference)
11. [Standard library recipes](#11-standard-library-recipes)
12. [Diagnostic catalogue](#12-diagnostic-catalogue)
13. [Worked examples](#13-worked-examples)
14. [Tooling: CLI and REPL](#14-tooling-cli-and-repl)
15. [Compiler architecture](#15-compiler-architecture)
16. [Extending Vela](#16-extending-vela)
17. [Testing](#17-testing)
18. [Design rationale and known gaps](#18-design-rationale-and-known-gaps)
19. [Pre-submission checklist](#19-pre-submission-checklist)

---

## 1. What Vela is

Vela is a small, imperative, C-shaped, statically-typed language with four
primitive types, arrays, structs, nullable types, and a tree-walking
interpreter.

```console
$ npm install --global vela-lang
$ vela run program.vela
```

```vela
fn fizzbuzz(n: number): string {
    if (n % 15 == 0) { return "FizzBuzz"; }
    if (n % 3 == 0) { return "Fizz"; }
    if (n % 5 == 0) { return "Buzz"; }
    return tostring(n);
}

for (let i: number = 1; i <= 20; i = i + 1) {
    print(fizzbuzz(i));
}
```

Types: `number`, `string`, `bool`, `void`, the bare `function`, fixed-length arrays
written `T[]`, a nullable written `T?` with `null` as its absence, and one
user-defined type — the `struct`. Nothing is inferred: every variable, every
parameter, and every return type is written out. There are no modules, no classes,
and no unions.

Vela's design goal is legibility over convenience. Almost every restriction below
exists because the thing it removes is also the thing that makes a program hard
to read. When a construct is missing, the answer is nearly always a two-line
function you write yourself (see [section 11](#11-standard-library-recipes)), not
a language feature.

---

## 2. The five rules that break code when ignored

These account for nearly every Vela mistake. Read them before writing a line.

### Rule 1 — Every statement ends with `;`

There is no newline sensitivity. A statement may span lines, but it must end with
a semicolon. A `let` missing its `;` swallows everything after it.

```vela
let n: number = 1;   // correct
let m: number = 2    // wrong: the next line is parsed as part of this
```

### Rule 2 — Types are mandatory, everywhere

No inference, no `undefined`, no uninitialised variables.

```vela
let x: number = 1;                              // correct
fn f(a: number, b: string): bool { ... }        // correct

let x = 1;              // parse error: expected ':' followed by a type
let x: number;          // parse error: expected '=' followed by an initial value
fn f(a) { ... }         // parse error: every parameter needs a type
fn f(a: number) { ... } // parse error: every function needs a return type
```

### Rule 3 — Conditions must be `bool`. There is no truthiness

`0` is not false. `""` is not false. `if (n)` is a type error.

```vela
if (n > 0) { ... }     // correct
if (n) { ... }         // error: this condition must be 'bool', but it is 'number'
```

### Rule 4 — Functions may be used before they are written

Every function signature in a declaration list is installed before any body in
that list is checked. A forward call resolves, and two functions that call each
other both resolve.

```vela
fn isEven(n: number): bool { if (n == 0) { return true; } return isOdd(n - 1); }
fn isOdd(n: number): bool { if (n == 0) { return false; } return isEven(n - 1); }
print(tostring(isEven(10)));   // true
```

This is the same in every scope, not just at the top level: a block hoists its
own functions too, so a pair of mutually recursive helpers can be siblings
inside a function body.

Variables are different. A `let` must be declared before use, because its type
comes from a value that has to be computed first.

```vela
print(later);
let later: number = 1;         // error: cannot find 'later' in this scope
```

### Rule 5 — Nothing is ever coerced

`+` requires both operands to be the same type. Comparison requires matching
types. Conversion is explicit via `tostring` and `tonumber`.

```vela
print("n=" + 1);                 // error: cannot apply '+' to 'string' and 'number'
print(1 == "0");                 // error: cannot compare 'number' with 'string'
print("n=" + tostring(1));       // correct
```

This is the single most common failure when porting code from another language.
Every number that meets a string goes through `tostring`, explicitly, every time.

---

## 3. Things that do not exist in Vela

Read this section before assuming anything. Every entry here is a real language
feature elsewhere, and every one of them is a compile error in Vela.

| You want to write | Why it fails | Do this instead |
| --- | --- | --- |
| `let x = 1;` | Types are mandatory | `let x: number = 1;` |
| `let y: number = i++;` | `++` is a statement, so it has no value | `i++;` on its own line |
| `i + j++` | Same: nothing to add | `i++;` then use `i` |
| `xs[len(xs)] = x` | An array's length never changes | `xs = append(xs, x)`, which returns a new array |
| `for (x of xs)`, `for (let x in xs)` | `for` has exactly one C-style form | `for (let i: number = 0; i < len(xs); i++) { ... }` |
| `[1, 2]` as a value | No top-level array constants | `let xs: number[] = [1, 2];` |
| `xs.length`, `xs.push(v)`, `xs.sort()` | No fields, and nothing grows in place | `len(xs)`, `xs = append(xs, v)`, [section 11](#arrays) |
| A list of mixed types, or arrays of differing length | `T[]` is one element type | Nested `T[]`, or parallel arrays |
| `a ? b : c` | No ternary | `if (a) { b = 1; } else { b = 2; }` |
| `a ?? b`, `?.` | No optional chaining or nullish coalescing | `if (a != null) { ... }`, then use `a` |
| `a ?: b`, `a?.b ?: c` | Same: a fallback is an `if` | `if (a != null) { print(a); } else { print(c); }` |
| `x!.y`, `as number`, `is number` | No assertions and no casts — the answer is a test | `if (x != null) { x.y }` |
| `T | U` | No unions | Two names, or `T?` where absence is the only other answer |
| `fn f() {}` | Return type is mandatory | `fn f(): void { ... }` |
| `def f(): pass` / `None` | No other keywords, no `None` | `return;` in a `void` function |
| `while (x) { ... }` truthy check | Conditions must be `bool` | `while (x != 0) { ... }` |
| `"a" < "b"` | Ordering comparisons are numeric-only | `==` and `!=` only; use `len(s)` for magnitude |
| `"a" + 1` | No coercion | `"a" + tostring(1)` |
| `import`, `require`, `use` | No modules | Everything is one file; the global scope is the only scope |
| `class`, `interface`, `enum`, `impl`, `trait` | No classes or enums; a `struct` is the one named type | `struct Point { x: number; }`, or a function over `number` |
| `p.method()` | No methods; a struct is data and nothing else | `fn move(p: Point, dx: number): Point` |
| `Point { x: 1 }` | No struct literal | `Point(1)` — one argument per field |
| `fn f(x?: number)` | No optional *parameters*; an optional *field* is not the same | `fn f(x: number?)`, and test for `null` |
| Generic `T`, `list<T>` | No generics | A function per element type |
| `public` / `private` / `static` | No access modifiers | Top-level `fn` is the whole API |
| `s.length`, `s.upper()`, `s.split()` | `len()` and `s[i]` are all there is | `len(s)`, `s[i]`; build the rest with `+` |
| `Math.sqrt`, `Math.pow` | Only the eight numeric built-ins exist | `trunc`, `abs`, ... then write `sqrt` — see [section 11](#11-standard-library-recipes) |
| `undefined`, `NaN`, `None` | No such values | `null` in a `T?`, or a documented sentinel such as `0 - 1` |
| `f(1,)` trailing comma | No trailing commas in argument or parameter lists | `f(1)` |
| `'single quotes'` | Double quotes only | `"double quotes"` |
| `f"text {x}"`, `\`templates\`` | No interpolation of any kind | `"text " + tostring(x)` |
| Raw strings `r"..."`, multi-line strings | A newline inside a string is an error | `+ "\n" +` |
| `#` comments, `--` comments | `//` and `/* */` only | |
| Bitwise `& \| ^ ~ << >>` | Not in the vocabulary | `/ % 2` and a boolean, or recursion |
| `**` | No exponentiation operator | A `for` loop multiplying |
| `try` / `catch` / `throw` | No exceptions to catch | Validate inputs up front and return a sentinel |
| `input("prompt")` | `read()` takes no arguments | `let s: string = read();` |
| Files, time, randomness | `print` and `read` are the only I/O | |

One of these constrains program *design* rather than just syntax:

**Arrays are fixed in length.** `T[]` holds any number of elements — but a number
decided when the array was built. Nothing grows an array in place: a write past
the end is a runtime error rather than a silent append, and `append` returns a
*new* array whose caller must reassign. So a program that collects while it runs
pays a copy per step:

```vela
let out: number[] = [];
for (let i: number = 0; i < 3; i = i + 1) { out = append(out, i * i); }
print(out);   // [0, 1, 4]
```

That is the trade for the rule, and the rule is the point: a write past the end
would otherwise hide the bug that wrote the wrong index.

---

## 4. Lexical structure

### Whitespace and newlines

Spaces, tabs, carriage returns, and newlines separate tokens and are otherwise
ignored. **Newlines are never significant.** A statement may be split across any
number of lines.

### Comments

```
lineComment  ::= "//" { any character except newline }
blockComment ::= "/*" { any character } "*/"
```

Block comments **do not nest** — the first `*/` ends the comment, so this is a
comment followed by a real statement:

```vela
/* a /* b */ print("this still runs");
```

The trailing `*/` above is *not* part of the comment. If you write one, it is a
parse error.

### Identifiers

```
identifier ::= ( letter | "_" ) { letter | digit | "_" }
letter     ::= "A" … "Z" | "a" … "z"
```

ASCII only: no Unicode identifiers, no `$`. Case-sensitive. `_1` is an ordinary
identifier, not a malformed number. `letter`, `ifs`, and `forx` are identifiers —
keywords are matched whole, not by prefix.

### Keywords

Nineteen reserved words:

```
let  const  fn  struct  return  if  else  while  for  break  continue  print
number  string  bool  void  function  true  false  null
```

`number`, `string`, `bool`, `void`, and `function` are type keywords and are
equally reserved. They are *distinct token kinds* from the same lexeme used
elsewhere, which is why `"number"` is a string but bare `number` in an
expression position is a parse error — the lexer already knows which one it is.

`null` is a literal, not a type keyword: it is a value of type `null`, and there
is no way to write it where a type is expected, because a nullable type is written
`T?` and absence is a value rather than a type you can name.

### Numbers

```
number    ::= digits [ "." digits ] [ exponent ] | digits exponent
exponent  ::= ( "e" | "E" ) [ "+" | "-" ] digits
digits    ::= digit { digit | "_" }
```

Valid: `0`, `42`, `1_000_000`, `3.14`, `1e6`, `2.5e-3`, `1_0.0_1`.

- `_` is skipped wherever a digit may follow one. `1__0` is valid and equals `10`;
  a trailing `1_` is an error.
- **A leading `.` is a lex error.** `.5` is not `0.5` — write `0.5`.
- `1.` and `1e` are errors (missing digits).
- All numbers are IEEE-754 doubles. There is one numeric type: `1` and `1.0` have
  the same type and `1 == 1.0` is `true`. `1e400` lexes to `Infinity` with no
  diagnostic.

### Strings

```
string    ::= '"' { char | escape } '"'
char      ::= any character except '"' '\' and newline
escape    ::= "\" ( '"' | "'" | "\" | "n" | "t" | "r" | "0" )
```

- Double quotes only. No single-quoted strings, no raw strings, no multi-line
  strings.
- Escapes: `\"`, `\'`, `\\`, `\n`, `\t`, `\r`, `\0`. Any other escape is an
  error rather than passing through, so `\d` is reported instead of silently
  becoming `d`.
- No `\u` and no `\x`.
- A newline inside a string is an error: `unterminated string: strings may not span lines`.
- `""` is a valid empty string.

### Operators

Complete list, tightest binding last:

```
+   -   *   /   %
!   -                      (unary)
==  !=  <   <=  >   >=
&&  ||
=                           (assignment)
```

There is no `++`, `--`, `+=`, `-=`, `*=`, `/=`, `**`, `??`, `?:`, `>>`, `<<`, or
any bitwise operator. `>>` lexes as two separate `>` tokens.

`->` is the one operator that is not an operator: it appears only inside a type,
as in `fn(number) -> number`, and is a syntax error anywhere else.

### Diagnostic positions

Every token carries a `SourceLocation` of `offset`, `length`, `line`, and
`column` (1-based). Error underlines span the offending construct. The `eof`
token's column is meaningless and prints as `-1`.

---

## 5. Declarations

```
program       ::= declaration *
declaration   ::= fnDecl | letDecl | constDecl | structDecl | statement
structDecl    ::= "struct" identifier "{" { field } "}"
field         ::= identifier [ "?" ] ":" T ";"
fnDecl        ::= "fn" identifier "(" params ")" ":" T block
letDecl       ::= "let" identifier ":" T "=" expression ";"
constDecl     ::= "const" identifier ":" T "=" expression ";"
params        ::= [ param { "," param } ]
param         ::= identifier ":" T
T             ::= "number" | "string" | "bool" | "void"
```

Both a type and an initialiser are mandatory on a `let`. There is no
uninitialised variable and no `undefined`.

### Functions

```vela
fn greet(name: string): void {
    print("hello, " + name);
    return;
}
```

- A `void` function may `return;` with no value, or omit `return` entirely.
- A non-`void` function **must** end with a `return` statement on every path the
  checker can see. See the known limitation in
  [section 18](#18-design-rationale-and-known-gaps) — a loop never counts as
  returning.
- A function name is in scope inside its own body, so recursion works.
- A function name is *not* in scope before its declaration.
- **A `fn` may be nested inside another function's body**, and is then local to
  that block.
- Parameter names must be unique within a function.
- The grammar admits zero parameters: `fn f(): void { ... }`.

### Let

```vela
let count: number = 0;
let label: string = "count";
let ready: bool = true;
```

- A variable cannot have type `void` — `void` is only a return type.
- Redeclaring a name in the same scope is an error.
- A block may shadow an outer name.
- Top-level statements are allowed, but only `let`, `const`, and `fn` create
  top-level bindings. A bare `print(...)` or a `for` loop at file scope is fine.

### Const

```vela
const MAX: number = 3;
const LABEL: string = "count";
```

`const` is spelled and typed exactly like `let`, binds in the same scope, and
shadows the same way. The one difference is that the name can never be assigned
to again:

```vela
const K: number = 1;
K = 2;      // error: 'K' is declared with 'const' and cannot be assigned to
K += 2;     // the same error — '+=' is sugar for 'K = K + 2'
K++;        // the same error
```

- The rule follows the **name**, not the declaration's position. A `const` at the
  top of a file is still a `const` inside a loop inside a function, so a distant
  assignment is rejected too.
- It is a **compile-time** rule. The interpreter stores a `const` exactly as it
  stores a `let`, and nothing about the value is made immutable. Until there are
  arrays and structs, every value is already immutable, so the distinction does
  not yet have anything to protect.
- A block may still shadow a `const` with a new declaration; the new binding is
  its own name, so this is not a violation.
- `const` is accepted in a `for` header, which is worth it for a loop that
  deliberately never updates its own counter and is driven by something else:
  `let done: number = 0; for (const i: number = 42; done < 3; ) { print(i); done = done + 1; }`
  prints `42` three times. Note that `const` makes a loop's *own* update
  impossible, so the counter has to live outside — `i++` is a compile error
  there.

---

### Optional struct fields

A `?` after a field's **name** makes the field optional — the constructor may leave
it out, and the field's type becomes `T?`. The two positions answer two different
questions, so they are two different spellings:

```vela
struct Config { retries: number; label?: string; note?: string; }

let a: Config = Config(3);                     // label: null, note: null
let b: Config = Config(3, "prod");             // label: prod,  note: null
let c: Config = Config(3, "prod", "written");  // all three given
let d: Config = Config(3, null);               // the same as `a`
```

An omitted field is stored as `null`, which is the whole of its semantics:
`Config(3) == Config(3, null, null)`, `typeOf` is unchanged, and a test against
`null` narrows the field exactly as it would a variable.

```vela
struct Config { retries: number; label?: string; }

fn labelOf(c: Config): string {
    if (c.label != null) { return c.label; }   // a 'string' from here down
    return "(none)";
}
```

Because the fields are filled in order, the optional ones must be a **suffix**.
`struct Bad { label?: string; retries: number; }` is a parse error naming
`retries`: there is no way for an omitted field to sit between two given ones, as
the argument for it would have nothing in front of it. Matching arguments by name
instead would need named arguments, which is a much larger feature, so the rule is
about position rather than syntax. The diagnostic is reported once per struct, at
the first field that breaks the order — every later one breaks it too, and one
mistake deserves one message.

Two more are refused at the declaration: `label?: string?`, because the field is
already nullable and a second `?` would change nothing, and `y?: void`, because
there is no value for absence to be absent from.

An optional field is **not a default value** — nothing is assumed, the field is
`null` until something writes to it, and the write is ordinary:

```vela
let c: Config = Config(3);
c.label = "later";   // Config(retries: 3, label: later)
```

Struct *parameters* are a separate feature and are not in Vela: `fn f(x?: number)`
is a parse error, and `fn f(x: number?)` is the way to accept absence.

## 6. Statements

```
statement    ::= printStmt | letStmt | returnStmt | ifStmt | whileStmt
               | forStmt | block | breakStmt | continueStmt | exprStmt
printStmt    ::= "print" "(" expression ")" ";"
returnStmt   ::= "return" [ expression ] ";"
ifStmt       ::= "if" "(" expression ")" statement [ "else" statement ]
whileStmt    ::= "while" "(" expression ")" statement
forStmt      ::= "for" "(" forInit ";" expression ";" expression ")" statement
block        ::= "{" statement * "}"
breakStmt    ::= "break" ";"
continueStmt ::= "continue" ";"
exprStmt     ::= expression ";"
```

### print

`print` is a **statement keyword, not a function**. It cannot appear in an
expression, and it cannot be shadowed at the top level.

```vela
print("hello");          // correct
let a: number = print(1); // parse error: expected an expression, found 'print'
```

`print` accepts any type except `void`. Printing a `void` value is a compile
error.

### if / else

```vela
if (n > 0) {
    print("positive");
} else if (n < 0) {
    print("negative");
} else {
    print("zero");
}
```

- Braces are optional around a single statement: `if (n > 0) print("hi");` is legal.
- `else` binds to the nearest unmatched `if`, as in C.
- `else if` is a nested `if` inside the `else` branch, never a flattened chain.
- The condition must be `bool`.

### while

```vela
let i: number = 0;
while (i < 10) {
    print(i);
    i = i + 1;
}
```

- The condition must be `bool` and is re-evaluated before every iteration.
- The body may be any single statement, including a bare block.

### for

```vela
for (let i: number = 0; i < 10; i = i + 1) {
    print(i);
}
```

- C's three-part form: `initializer; condition; update`.
- The update is an **expression**, so it takes no trailing semicolon.
- With a `let` initializer, the loop variable is **scoped to the loop** and
  cannot be read after it.
- The initializer may also be a plain assignment expression, in which case the
  variable is one declared outside and survives the loop:

```vela
let i: number = 0;
for (i = 0; i < 3; i = i + 1) { print(i); }
print(i);   // 3 — legal, because `i` was declared outside
```

- In practice the parser also accepts omitted parts: `for (;;)` is an infinite
  loop, and a missing condition means "always true". Rely on the canonical
  three-part form in code you intend to maintain.
- `break` and `continue` work in both `while` and `for`. `continue` jumps to the
  `for` update, or to the `while` condition.

### return / break / continue

- `return` requires a semicolon, and is rejected outside a function.
- `return;` with no value is valid only in a `void` function.
- `break;` and `continue;` require a semicolon, and are rejected outside a loop.
  They work at any nesting depth of loop.
- There are no labels and no `break value`.

### Blocks and scoping

A block `{ ... }` is a statement that creates a new lexical scope.

```vela
let s: string = "outer";
{
    let s: string = "inner";   // shadows
    print(s);                  // inner
}
print(s);                      // outer
```

---

## 7. Expressions and precedence

Precedence, loosest to tightest. Each binary level is **left-associative**.

| Precedence | Operators | Associativity |
| --- | --- | --- |
| 1 | `\|\|` | left |
| 2 | `&&` | left |
| 3 | `==` `!=` | left |
| 4 | `<` `<=` `>` `>=` | left |
| 5 | `+` `-` | left |
| 6 | `*` `/` `%` | left |
| 7 | unary `-` `!` | right |
| — | call `f(...)`, index `s[i]` | left |
| — | assignment `=`, compound `+=` `-=` `*=` `/=` `%=` | right |

```
expression   ::= assignment
assignment   ::= identifier ( "=" | "+=" | "-=" | "*=" | "/=" | "%=" ) assignment
               | indexed ( "=" | "+=" | "-=" | "*=" | "/=" | "%=" ) assignment
               | or
or           ::= and { "||" and }
and          ::= equality { "&&" equality }
equality     ::= comparison { ( "==" | "!=" ) comparison }
comparison   ::= term { ( "<" | "<=" | ">" | ">=" ) term }
term         ::= factor { ( "+" | "-" ) factor }
factor       ::= unary { ( "*" | "/" | "%" ) unary }
unary        ::= ( "-" | "!" ) unary | call
call         ::= primary { ( "(" [ expression { "," expression } ] ")" )
                        | ( "[" expression "]" ) }
primary      ::= number | string | "true" | "false"
               | array
               | identifier | "(" expression ")"
array        ::= "[" [ expression { "," expression } ] "]"
```

### Assignment

Right-associative, and the left side **must be an identifier or an index**.

```vela
a = b = 3;          // assigns 3 to b, then to a — legal
xs[0] = xs[1] = 3;  // the same through two elements of two arrays
1 = 2;              // error: the left-hand side of '=' must be a variable or an index
(a) = 2;            // error, same
a + 1 = 2;          // error, same
f()[0] = 1;         // error: a call result cannot be assigned through
```

An assignment is also an expression, so it produces a value. `print(x = 5);`
prints `5`. An indexed assignment produces the value that was stored.

**Only the final index of a chain is a target.** `grid[0][1] = 9` is a write into
a sub-array reached from `grid`; `grid[0] = xs` would be replacing the sub-array
itself, and is accepted only if `xs` is a `number[]` when `grid` is a `number[][]`.

### Indexing

`x[i]` reads, and `x[i] = v` writes one element. The index must be a `number`, and
its value must be in `0 .. len(x) - 1`.

| Type of `x` | `x[i]` is | `x[i] = v` is |
| --- | --- | --- |
| `string` | a one-code-unit `string` | error: a string has fixed length |
| `T[]` | a `T` | a write of a `T` |
| anything else | compile error | compile error |

```vela
let xs: number[] = [1, 2, 3];
xs[0] = xs[2];      // legal: the same value, read and written
xs[0] += 10;        // legal: sugar for xs[0] = xs[0] + 10
let n: string = xs[0];   // error: 'xs[0]' has type 'number' but 'string' was expected
let bad: number[] = ["a"];   // error: a literal has to be homogeneous
```

Suffixes share the loop with calls, so `f()[0]` and `s[0][1]` parse. Only a name at
the *start* of a chain can be assigned through, which is a grammar rule rather
than a type rule — see [section 15](#the-parser).

### Compound assignment and increment

Both are **desugared in the parser**, so neither the AST, the checker, nor the
interpreter knows they exist:

| Written | Becomes |
| --- | --- |
| `x += y` | `x = x + y` |
| `x -= y` | `x = x - y` |
| `x *= y` | `x = x * y` |
| `x /= y` | `x = x / y` |
| `x %= y` | `x = x % y` |
| `xs[i] += y` | `xs[i] = xs[i] + y` |
| `i++` | `i = i + 1` |
| `i--` | `i = i - 1` |

The payoff is that every type rule comes for free. `n += "a"` reports the ordinary
`cannot apply '+' to 'number' and 'string'`, and `x /= 0` is the ordinary
`division by zero` — neither needed a rule of its own. `+=` works on strings,
because `+` does; the other four are numeric only, for the same reason.

`++` and `--` are **statements, not expressions**, so they have no value:

```vela
i++;              // correct
for (...; i++)   // correct: a for update is an expression slot
let y: number = i++;   // error: '++' is a statement and has no value
i + j++;          // error: same reason
```

The one place `--` is ambiguous is prefix position. `--1` is a doubled negation
and evaluates to `1`, which is the reading the language has always documented; a
name in front is what makes it a decrement. A statement ends in `;` or a loop
header's `)`, which is what tells `i--;` from `- -1`.

### Calls

- Arguments are comma-separated. **No trailing comma**: `f(1,)` is an error.
- Arity is checked at compile time: `expected 1 argument but got 2`.
- Argument types are checked at compile time: `argument 1 has type 'string' but
  'number' was expected`.
- Call suffixes bind tighter than every operator, so `-f(1)` is `-(f(1))` and
  `!a == b` is `(!a) == b`.
- Calls chain syntactically (`f(1)(2)` parses) but only a declared function name
  is callable, so the checker rejects the rest with `this is not a function`.
- Index suffixes share the suffix loop with calls and chain the same way, so
  `s[0][1]` and `f()[0]` parse. An index at the end of that chain can be assigned
  through, so `g[0][1] = 9` is legal; a call cannot, so `f()[0] = 1` is reported.

### Grouping

Parentheses produce no AST node — `(1)` *is* `1` in the tree. They exist only to
override precedence.

---

## 8. Types and static rules

```
T         ::= simple { suffix }
suffix    ::= "[]" | "?"
simple    ::= "number" | "string" | "bool" | "void" | "function" | signature
signature ::= "fn" [ "(" T { "," T } ")" ] "->" T
```

The first four `simple` types are primitives. `function` is the odd one out: it
names the *shape* of a value without naming a signature, and it is what makes it
possible to store, pass, and return a function at all. There is no `any` in
source, no unions, no generics, and no inference.

`[]` is an **array** and it binds to the whole type in front of it, so `number[]`
is an array of numbers and `number[][]` is an array of those, with no parentheses.
`void[]` is rejected outright: an array of absences could never be used, since
every use of a `void` is already an error. Arrays are homogeneous, fixed in
length, and compared by reference — see [section 10](#arrays).

`?` is **nullable** and it may be written in either order with `[]`, because both
are suffixes and the list is read left to right. `number?[]` is an array whose
elements may be absent; `number[]?` is an array that may be absent. They are
different types and neither is the special case.

### Nullable types

`T?` holds either a `T` or nothing, and `null` is the nothing:

```vela
let missing: number? = null;     // absent
let present: number? = 5;        // a number, in a type that permits absence
let plain: number = 5;           // never absent
```

`null` is a type of its own rather than "any type, possibly absent", which is
what keeps the two apart: a `T?` is *about* the absence, and `null` is the
absence. There is no `Option` and no `Some`, so there is nothing to match on and
nothing to unwrap with — a comparison against `null` is both.

```vela
fn describe(n: number?): string {
    if (n == null) { return "absent"; }
    return tostring(n + 1);          // `n` is a `number` here — see narrowing
}
```

**The four assignability facts.** A `T` and `null` both fit a `T?`, because each
is one of the two things it allows. Nothing fits *out* of one: `let n: number =
maybe;` is rejected even when `maybe` holds a number right now, because the type
says it might not and the checker does not run the program to find out.

| From | To | |
| --- | --- | --- |
| `T` | `T?` | correct |
| `null` | `T?` | correct |
| `T?` | `T?` | correct |
| `T?` | `U?` | only when `T` fits `U` |
| `T?` | `T` | **error** |
| `T?` | `U` | **error** |

`void?` and a second `?` are both parse errors: there is no value for absence to
be absent *from*, and `number??` would ask the same question twice, so the
constructor that builds a nullable collapses `T??` to `T?` and the two can never
compare unequal while being the same type.

**What can be compared with `null`.** `null` compares with anything — including a
value that cannot be absent, where the test is always false — because the
alternative is a test that cannot be written once a type has been pinned down.
Vela reports faults rather than tautologies, so it says nothing about that case.
Everything else still requires matching types, and two nullable types match only
when their inner types do: `number? == string?` is an error, and so is
`number? == number`, because the second may be absent and the first may not.

**Ordering is not defined for a nullable.** `x < 1` where `x` is `number?` is an
error; there is no number on the absent side to compare.

### Narrowing

A nullable is useless if it cannot be used, so a comparison against `null` narrows
the rest of the branch it appears in — and the checker tracks it per *binding*
rather than per name, which is what makes shadowing safe.

```vela
fn firstLetter(s: string?): string {
    if (s != null) { return s[0]; }   // `s` is a `string` in this block
    return "-";                       // and the else needs no test of its own
}
```

- **An `if` with no `else` whose body always leaves** narrows what comes after it,
  because those statements are only reached the other way. That is the guard
  clause in `describe` above.
- **A loop body and a `for` update** are checked as though the condition held, and
  the statements after a `while` as though it did not — unless the body can leave
  first, which is the one case the analysis refuses.
- **`&&` narrows its right operand.** `||` narrows neither, because it is not known
  which side was true: `x != null && x > 0` works, `x == null || y == null` teaches
  nothing. Each half is read under the one before it, so a chain works:
  `p.next != null && p.next.next != null`.
- **Writing to a name or a field drops the fact** about it, and about anything
  reached through it: after `p.next = null`, `p.next` is a `Node?` again.
- **An indexed element is not narrowed.** `xs[0]` has no fixed identity, so a test
  of it teaches nothing that could be relied on; the use is reported instead.

The honest hole: **a call is not tracked.** The checker sees what a test
established and what an assignment removed, but not that a function assigned to a
name, so

```vela
let x: number? = 1;
if (x != null) {
    clear(x);                  // a call — the checker does not know it assigns
    print(tostring(x + 1));    // accepted, and wrong
}
```

compiles. Assigning `x` directly is tracked; only the call is not. See
[section 18](#18-design-rationale-and-known-gaps).

### The rules

**Nothing is coerced.** `+` requires both operands to be the same primitive type.
`"n=" + 1` is an error, not `"n=1"`. `true + 1` is an error, not `2`.

**Comparisons require matching types.** `1 == "0"` and `1 == true` are both
errors. There is no cross-type equality, and an array's element type is part of
its type, so `number[] == string[]` is an error on the same grounds.

**Array types are exact.** `number[]` is unrelated to `string[]` and to
`number[][]`, with no subtyping and no widening. Because the element type is part
of the type, one array per element type is enough: `fn f(xs: number[])` serves
every `number[]` in the program, and a `string[]` argument is rejected rather than
silently converted.

**An array literal's type comes from context.** A nonempty literal infers from its
first element, so `[1, 2]` is `number[]` and `["a"]` is `string[]`. An expected
type wins over that inference, which is what lets a nested literal be written
without repeating it: `let xs: number[][] = [[1], [2]];`. `[]` has nothing to infer
from, so it needs a concrete array type from somewhere — a declaration's
annotation, a `return`'s declared type, or a parameter — and with no context at all
it is an error rather than a guess:

```vela
let xs: number[] = [];   // correct: the annotation supplies 'number[]'
let ys = [];             // error anyway — the type annotation is mandatory
print([]);               // error: nothing says what an empty array holds
append([], "a");         // error: same reason
```

Every element of a literal must match the array's element type, and a nested
literal must match the *element* type: `let xs: number[][] = [[1], ["a"]];` is
reported at the second element.

**Ordering comparisons require `number` operands.** `<`, `<=`, `>`, and `>=` are
numeric-only; `"a" < "b"` and `true < false` do not compile. Only `==` and `!=`
work on `string` and `bool`. The interpreter enforces the same rule, so this is a
language rule rather than a checker gap. See
[section 10](#10-runtime-semantics-reference).

**Conditions must be `bool`.** No truthiness anywhere.

**`&&` and `||` short-circuit for real,** and require `bool` operands. This is a
guarantee, not a description of the common case:

```vela
print(false && (1 / 0 == 0));   // safe: prints false
```

**Assignment is type-checked both ways.** `x = <value of a different type>` is
an error. Assignment to a function name is an error: `'fact' is a function and
cannot be assigned to`.

**The bare `function` type is checked in one direction only.** Any function
satisfies it, so storing one is checked:

```vela
fn double(x: number): number { return x * 2; }

let f: function = double;   // correct — a function is a function
let n: number = 5;
let g: function = n;        // error: cannot initialise 'g' of type 'function'
                            //        with a value of type 'number'
```

But the signature is not recorded, so a call through such a variable cannot be
checked: no arity check at compile time and no known result type. `f(1, 2, 3)`
type-checks and then fails at runtime with `'double' expects 1 arguments but got
3`, and `f()` returning no known type is why `tostring` is so common around one.
The alternative — a writable signature type like `(number) -> number` — would check
both, at the cost of a function being storable under only one exact signature, so
there would be no way to write "a function that takes a number" without also fixing
its return type at every use. See
[section 18](#18-design-rationale-and-known-gaps) for the reasoning.

**Redeclaration in the same scope is an error,** with a note pointing at the
previous declaration. Shadowing in a nested scope is fine.

**Functions may be used before they are declared; variables may not.** Every
`fn` signature in a declaration list is installed before any body in that list is
checked, so a forward call and a mutually recursive pair both resolve. A `let`
must still be declared before use, because its type comes from a value that has
to be computed first.

**Errors stop the pipeline.** A program with any compile error does not run at
all, so statements before the error never execute. Diagnostics are collected,
not thrown — a single run reports many errors.

### Return analysis

A non-`void` function must end with a `return` on every path the checker
recognises. The analysis handles sequential early returns and `if`/`else`
correctly:

```vela
fn f(n: number): number {
    if (n > 0) { return 1; }
    if (n == 0) { return 0; }
    return 0 - 1;          // trailing return satisfies the checker
}
```

It treats a **loop** as never returning, which is sound but incomplete — see
[section 18](#18-design-rationale-and-known-gaps).

---

## 9. Built-ins

There are exactly **twenty-three callable built-ins** plus the `print` statement.
There is no module system, no import, and no other global name.

| Name | Signature | Behaviour |
| --- | --- | --- |
| `tostring(x)` | `(any) -> string` | Renders using the same rules as `print`. Numbers never get a trailing `.0`. |
| `tonumber(s)` | `(any) -> number` | `Number(s)` for a string. Returns `0` for a non-numeric string **and for any non-string argument**. Never fails. |
| `typeOf(x)` | `(any) -> string` | Returns `"number"`, `"string"`, `"bool"`, `"void"`, `"array"`, `"function"`, or `"native"`. |
| `len(s)` | `(string \| T[]) -> number` | UTF-16 code-unit count for a string, element count for an array. A `number` argument is a compile error. |
| `trunc(x)` | `(number) -> number` | Toward zero, so `trunc(-2.7)` is `-2`. |
| `floor(x)` | `(number) -> number` | Down, so `floor(-2.7)` is `-3`. |
| `ceil(x)` | `(number) -> number` | Up, so `ceil(-2.7)` is `-2`. |
| `round(x)` | `(number) -> number` | Nearest, halves **away from zero**: `round(2.5)` is `3`, `round(-2.5)` is `-3`. |
| `abs(x)` | `(number) -> number` | `abs(-3)` is `3`. |
| `min(a, b)` | `(number, number) -> number` | |
| `max(a, b)` | `(number, number) -> number` | |
| `idiv(a, b)` | `(number, number) -> number` | Truncates toward zero, like `%`. `idiv(17, 5)` is `3`; `idiv(-17, 5)` is `-3`. Dividing by zero gives `0`. |
| `read()` | `() -> string` | One line of stdin, with the newline stripped. `""` at end of input. |
| `upper(s)` | `(string) -> string` | Unicode upper case. The result can be longer: `upper("straße")` is `STRASSE`. |
| `lower(s)` | `(string) -> string` | Unicode lower case. |
| `trim(s)` | `(string) -> string` | Whitespace stripped from both ends. |
| `startsWith(s, pre)` | `(string, string) -> bool` | **Subject first, then the prefix.** |
| `endsWith(s, suf)` | `(string, string) -> bool` | **Subject first, then the suffix.** |
| `indexOf(s, sub)` | `(string, string) -> number` | First index of `sub`, or `-1` when absent. An empty `sub` is at `0`. |
| `substr(s, from, count)` | `(string, number, number) -> string` | Clamped: a start past the end or a negative count gives `""`, a negative start counts from the end, and a count running off the end stops. |
| `repeat(s, n)` | `(string, number) -> string` | `n` copies. `n` of zero or less gives `""`; `n` is truncated, so `repeat("ab", 2.9)` is `abab`. |
| `replace(s, from, to)` | `(string, string, string) -> string` | **First occurrence only.** Absent pattern or an empty `from` returns `s` unchanged. |
| `append(xs, v)` | `(T[], T) -> T[]` | A **new** array with `v` on the end. `xs` is unchanged, so the caller reassigns. |

### What the string built-ins guarantee

Every one of the nine string functions is **total**: none of them can raise a
runtime error, and none of them has a failure case to check for. That is a
deliberate contrast with `s[i]`, which reports an out-of-range index, because a
substring that runs off the end has an obvious answer while a missing element
does not. The index expression stays strict so a typo is still caught; these are
for building text, where clamping is what you want.

The argument order is **subject first, pattern second** across the whole family —
`startsWith(greeting, "hell")`, not `startsWith("hell", greeting)`. This is the
reverse of the `startsWith(pre, s)` recipe these functions replaced, and it is
the order that reads like the method calls they stand in for.

`upper`/`lower` map by Unicode rather than by an ASCII table, which is why
`upper("straße")` is `STRASSE`: the mapping is not one character to one
character, so indexing into the result cannot assume one index is one letter.

The numeric eight are specified rather than approximated, which is the point:
`trunc` and `idiv` both go toward zero so they agree with `%`, and `round` breaks
halves away from zero so it is symmetric. `idiv(x, 0)` is `0` rather than an error
because a built-in has no source location to point at, and `Infinity` is not a
value this language can hold meaningfully. `sqrt` and `pow` are *not* built-ins;
they are [recipes](#11-standard-library-recipes), because their exact
floating-point behaviour is the part that is hard to promise.

### `tostring` rendering rules

| Input | Output |
| --- | --- |
| `42` | `"42"` |
| `42.0` | `"42"` (no trailing `.0`) |
| `3.14` | `"3.14"` |
| `1e6` | `"1000000"` (no exponent for integers) |
| `true` | `"true"` |
| `"hi"` | `"hi"` — **unquoted** |
| a declared function | `"<fn name>"` |
| a built-in | `"<built-in name>"` |
| a `void` value | `"void"` |

Because strings come back unquoted, `tostring("1")` and `tostring(1)` both
produce `"1"`. You cannot round-trip a string through `tostring` to recover its
type — use `typeOf` for that.

### `len` and `append` are not one signature each

`len` accepts a `string` **or** an array, and `append(xs, v)` returns whatever
array type it was given: `append([1], 2)` is `number[]`, `append(["a"], "b")` is
`string[]`, and `append(xs, xs[0])` keeps `xs`'s own type. Two written signatures
would each have to be declared twice, once per element type, which the language
cannot express — there are no generics and no overload syntax. So the table
carries a **check** and a **return** for these two rather than a signature, and
the check is positional: the first argument has to be the right shape and the
second is checked against the first argument's element type. That is the only
place in the checker where a built-in's result type is computed rather than
looked up; see [section 15](#the-single-source-of-truth-for-built-ins).

```vela
let xs: number[] = [1, 2];
xs = append(xs, 3);          // correct
let ys: string[] = append(xs, "a");   // error: 'xs[0]' is a 'number'
let zs: number[] = append([], 1);     // error: nothing says what [] holds
```

`append` copies, so `append(xs, 1);` on its own line changes nothing at all. That
is deliberate: the alternative was a mutating `push`, which would make the length
of an array depend on how far a program got before a bug.

### `typeOf` can return `"native"`

```vela
print(typeOf(tostring));   // native
```

This happens because built-ins are first-class values in the environment. It is
worth knowing if you branch on `typeOf`.

### Built-ins can be shadowed inside a block

```vela
{
    let tostring: number = 1;   // legal in a nested scope
    print(tostring);             // 1
}
```

Shadowing a built-in at **top level** is an error: `'tostring' is already declared
in this scope`.

### `read` details

`read()` takes no arguments and prints no prompt, so a program that wants a prompt
prints one itself. One line comes back per call, with the newline stripped, and a
`\r\n` file does not leave a stray `\r` on every line.

End of input is the empty string, not an error and not a sentinel. There is no
`null` in Vela to signal it, and an empty line is a real value a program can
produce, so a loop condition on `line != ""` is how "until the user is done" is
written:

```vela
let line: string = read();
while (line != "") {
    print(line);
    line = read();
}
```

The input source is indirected through `setInput`, the same way output goes
through `setOutput`. That is how the tests feed a fixed list of lines instead of a
pipe, and how the REPL avoids consuming the terminal: readline has already
buffered stdin by the time an entry runs, so descriptor 0 is empty and re-reading
it would race the next thing typed. An embedder passes the lines to serve through
the REPL's `inputLines` option; with none, `read()` is immediately at end of input
and returns `""`.

Worth knowing when writing a program: the REPL **cannot** be a data-entry point.
Serving `read()` from the line that ended the entry was the obvious shortcut, and
it is a trap — `tonumber(read())` would answer with the number in `print(3);`.
Returning the empty string is the same answer end-of-input gives, and it is
predictable.

### `print` details

`print` adds a trailing newline. It accepts `number`, `string`, `bool`, and
function values; printing `void` is a compile error. The output sink is
indirected, which is how the tests capture output.

---

## 10. Runtime semantics reference

### Numbers

One type, IEEE-754 doubles. Integer and fractional literals are the same type.

| Operation | Semantics | Example |
| --- | --- | --- |
| `+ - *` | IEEE-754 | `0.1 + 0.2` is `0.30000000000000004` |
| `/` | **Always true division.** No integer division. | `7 / 2` is `3.5`; `7 / 2 * 2` is `7`, not `8` |
| `/ 0` | Runtime error `division by zero` | `1 / 0` throws |
| `%` | **Truncated remainder**, sign follows the left operand. Works on fractions. | `-7 % 2` is `-1`; `2 % 1.5` is `0.5` |
| `% 0` | Runtime error `remainder by zero` | `1 % 0` throws |
| `== != < <= > >=` | Numeric comparison | |
| unary `-` | Numeric negation | `--1` is `1` |

`%` is a remainder, not a mathematical modulus. This matters for negative
operands: `trunc` and `idiv` are both specified to go toward zero so they agree
with it, and `oneDecimal` in [section 11](#11-standard-library-recipes) depends
on it to catch a negative fraction.

### Strings

| Operation | Semantics |
| --- | --- |
| `+` | Concatenation. Both operands must be `string`. |
| `==` `!=` | Value comparison, not identity. **These are the only comparisons that work on strings** — see below. |
| `len(s)` | UTF-16 code-unit count: `len("hello")` is 5, `len("日本語")` is 3, an emoji is **2**. `len(xs)` is an element count. |

**Ordering comparisons do not work on strings.** `<`, `<=`, `>`, and `>=` require
`number` operands, so `"abc" < "abd"` is a compile error:

```
error: cannot apply '<' to 'string' and 'string'
  |
1 | print("abc" < "abd");
  |       ^^^^^^^^^^^^^
  | note: '<' needs operands of the same primitive type, and the 'string' form of '+' needs two 'string' operands
  |
```

(The note is misleading here — it is emitted by the shared operand checker, which
also serves `+`.) So strings can be tested for equality but **cannot be sorted or
ordered** without converting to `number` first, which is not a meaningful
conversion. The only ordering available is `len(s)`, which is a number.

### Indexing

`x[i]` is the only subscript in the language. A `string` yields one UTF-16 code
unit as a one-code-unit `string`, so `len(s[i])` is `1` and the ordinary `string`
rules still apply to it; a `T[]` yields a `T`.

```vela
let s: string = "hello";
print(s[0]);                    // h
print(s[len(s) - 1]);           // o
print(s[0] + "|" + s[1]);       // h|e

let xs: number[] = [10, 20, 30];
print(xs[1]);                   // 20
```

Valid indices are `0` through `len(x) - 1`. Anything else, negative included, is a
runtime error, not an empty answer:

```
error: index 5 is out of range: this string has length 2
error: index 2 is out of range: this array has length 2
```

A `number`, `bool`, or `void` cannot be indexed at all — the checker reports
`this has type 'number' and cannot be indexed; only a 'string' or an array can`,
because neither has parts to read.

`len` counts code units, so a surrogate pair occupies two indices. Reading half of
an emoji gives a broken character, and there is no code-point iteration to offer
instead. There is still no case conversion, because characters can be read and
compared but not mapped to new ones.

### Arrays

| Operation | Semantics |
| --- | --- |
| `xs[i]` | A `T`. Reads one element. |
| `xs[i] = v` | Replaces one element. The array's length does not change. |
| `xs[i] += v` | Sugar for `xs[i] = xs[i] + v`, with the ordinary type rules. |
| `len(xs)` | Element count. |
| `==` `!=` | **Reference** comparison, not contents. |
| `append(xs, v)` | A new array of the same type, with `v` on the end. |

**An array is a reference, so two names can share one array.** That is what makes
a write visible through both names, and it is why sorting an array in place works
at all — the recipe in [section 11](#arrays) returns the same array it was given.

```vela
let xs: number[] = [1, 2];
let ys: number[] = xs;
xs[0] = 99;
print(ys[0]);      // 99: one array under two names
print(xs == ys);   // true
print(xs == [99, 2]);   // false: a different array, contents or not
```

So `==` on arrays answers "are these the same array?", and it is not a way to
compare contents. `[1, 2] == [1, 2]` is false for two separate literals.

**A write past the end is an error, not an append.** The length is fixed when the
array is built, so there is no form of assignment that grows one:

```
error: index 2 is out of range: this array has length 2
```

`append` is the only way to make an array longer, and it **copies** into a new one.
The caller reassigns, or the result is discarded:

```vela
let xs: number[] = [1];
append(xs, 2);       // correct, and does nothing: the new array is thrown away
xs = append(xs, 2);  // this is the one that grows it
```

The cost is a copy per step, so a loop that appends in a hot path is slower than a
program with one array the right size. That is the trade for making the length
depend on nothing but how the array was built, which is what lets `xs[i]` mean the
same element on every iteration of every loop.

**A `const` array is still writable through its elements.** `const` is a rule about
the *name*, and it applies to the name only:

```vela
const xs: number[] = [1, 2];
xs = append(xs, 3);   // error: 'xs' is declared with 'const' and cannot be assigned to
xs[0] = 9;            // correct: what the array holds is not the name
```

A `const` is not deep immutability, and holding one is never an aliasing bug.

### Booleans

`true`, `false`, `==`, `!=`, `&&`, `||`, `!`. No truthiness, no coercion, no
conversion to a number.

### Short-circuit evaluation

`&&` and `||` evaluate the right operand only when the left does not determine the
result. This is a hard guarantee you can rely on for guard clauses:

```vela
fn safeDiv(a: number, b: number): number {
    if (b != 0 && a / b > 1) { return a / b; }
    return 0;
}
```

### Output

`print` writes to stdout with a trailing newline. `displayValue` is the shared
renderer: numbers via `String(value)` with `NaN`/`Infinity`/`-Infinity` special-
cased, strings bare, bools as `true`/`false`, functions as `<fn name>`, natives
as `<built-in name>`.

### Scoping

`let` and `fn` bind in the current block. Lookup walks outward through enclosing
blocks. Assignment (`=`) writes to the *outermost* binding of that name — it
never creates one:

```vela
let x: number = 1;
{
    x = 2;          // updates the outer x
    let y: number = 3;
}
print(x);           // 2
```

Function calls get a fresh child scope for parameters and locals. A `void`
function that falls off the end returns the `void` value, not `null` —
`null` is not a value a Vela program can create, name, or compare.

### Runtime errors

Five checks survive type checking:

```
division by zero
remainder by zero
expected a 'bool' condition, but got 'number'
index 5 is out of range for a string of length 2
call depth 750 exceeded
```

Only the last two are a consequence of a design decision rather than an ordinary
mistake. An out-of-range index is undetectable statically because nothing in the
type system carries a length, and the depth cap replaces a V8 stack overflow with
a message that names the language's own limit. Plus scope failures that the static
check could not rule out (`cannot find 'x' in this scope`, `cannot assign to 'x':
it is not declared here`) and arity re-checks, which matter for a call through a
`function` value. Everything else is caught before the program starts.

---

## 11. Standard library recipes

Vela has no standard library. These are the idioms that replace the functions you
would otherwise reach for. **All of the code below compiles and runs on the
current implementation**, with the output shown.

> **Do not redefine the built-ins.** A top-level `fn trunc`, `fn floor`, `fn abs`,
> `fn min`, `fn idiv`, `fn read`, `fn upper`, `fn append`, or `fn substring` is a
> compile error — the same rule that stops you shadowing `tostring` at the top
> level. The twenty-three built-ins are in [section 9](#9-built-ins); they are not
> repeated below.
>
> **Read the recipes in order.** They build on each other: `sqrt` and `powInt`
> come first because `digits` and `group` call them. Each snippet is shown in
> isolation, so copy the whole section in sequence rather than a single block.

### Integer exponentiation

There is no `**` and no `powInt`, so multiplication in a loop is the whole thing.
A negative exponent gives `0` here, because the loop body never runs — check the
sign yourself if you care.

```vela
fn powInt(base: number, e: number): number {
    let out: number = 1;
    for (let i: number = 0; i < e; i = i + 1) { out = out * base; }
    return out;
}
```

```
powInt(2, 10) -> 1024
powInt(7, 0)  -> 1
```

### Square root (Newton's method)

No `Math.sqrt`, so iterate. Float equality would never terminate this loop, so
the iteration count is fixed.

```vela
fn sqrt(x: number): number {
    if (x < 0) { return 0 - 1; }   // sentinel: negative input
    if (x == 0) { return 0; }
    let g: number = x;
    for (let i: number = 0; i < 60; i = i + 1) {
        g = (g + x / g) / 2;
    }
    return g;
}
```

```
sqrt(2)          -> 1.414213562373095
sqrt(0)          -> 0
sqrt(16)         -> 4
```

60 iterations overshoots the achievable precision, which is what you want: it
settles into a fixed point and stops.

### GCD

`let` inside a `while` body is legal, and declaring the temporary inside the loop
is the idiomatic way to swap two values without a third top-level name.

```vela
fn gcd(a: number, b: number): number {
    let x: number = abs(a);
    let y: number = abs(b);
    while (y != 0) {
        let t: number = y;
        y = x % y;
        x = t;
    }
    return x;
}
```

```
gcd(48, 18) -> 6
gcd(17, 5)  -> 1
```

### Digit count

The shape to reach for whenever you need to walk a number's digits from the
right: `n % 10` peels one off, `trunc(n / 10)` removes it, `n % 2` tests
divisibility without a bitwise operator.

```vela
fn digits(n: number): number {
    let x: number = abs(n);
    if (x == 0) { return 1; }
    let d: number = 0;
    while (x >= 1) {
        x = trunc(x / 10);
        d = d + 1;
    }
    return d;
}
```

```
digits(0) -> 1   digits(7) -> 1   digits(1000) -> 4   digits(-12345) -> 5
```

### Thousands separators

The most involved string-building recipe, and the one that shows the whole
idiom. Because there is no collection, digits are extracted with `%` and
**prepended** to an accumulator, and a separator is prepended whenever the
placed-digit count hits a multiple of three — but only if digits remain, or you
get a trailing comma. The digit-to-character step is one `s[i]` into a lookup
string, which is what indexing is for.

```vela
fn digitChar(d: number): string {
    return "0123456789"[d];
}

fn group(n: number): string {
    let neg: bool = n < 0;
    let x: number = trunc(abs(n));
    let out: string = "";
    let pos: number = 0;
    while (x >= 1) {
        out = digitChar(x % 10) + out;
        x = trunc(x / 10);
        pos = pos + 1;
        if (pos % 3 == 0 && x >= 1) { out = "," + out; }
    }
    if (out == "") { out = "0"; }
    if (neg) { return "-" + out; }
    return out;
}
```

```
group(0)          -> 0
group(7919)       -> 7,919
group(1234567)    -> 1,234,567
group(-123456789) -> -123,456,789
group(100)        -> 100
```

### Looking inside a string

`s[i]` returns a one-code-unit `string`, so per-character work is a loop with
`+`. Reversal prepends, and it is the one string primitive still worth writing
by hand; the rest are [built in](#9-built-ins).

```vela
fn reverse(s: string): string {
    let out: string = "";
    for (let i: number = 0; i < len(s); i = i + 1) { out = s[i] + out; }
    return out;
}
```

```
reverse("abc") -> cba
```

The reason reversal is not built in while `startsWith` is: reversal has no
sentinel and no clamping decision, so a loop is the whole answer. Search and
slicing have to decide what "not found" and "past the end" mean, which is exactly
the judgement a built-in should make once rather than every reader re-making.

`indexOf` returns `-1` when there is no match, because the result is a `number` and
`null` would not fit in one. The built-in keeps that sentinel, and answers `-1` for
an absent pattern and `0` for an empty one.

### String padding and repetition

Accumulating in a loop is the *only* way to build a string of a computed length.
`repeat` is built in, so only a padding rule is left to write.

```vela
fn pad(s: string, width: number): string {
    let out: string = s;
    while (len(out) < width) { out = " " + out; }
    return out;
}
```

```
"[" + pad("7", 5) + "]"      -> [    7]
"[" + repeat("ab", 3) + "]"  -> [ababab]
```

### Fixed-decimal formatting

Round to an integer count of tenths, then split whole from fraction. This is
exactly what `examples/temperature.vela` does.

```vela
fn oneDecimal(value: number): string {
    let tenths: number = round(value * 10);
    let whole: number = idiv(tenths, 10);
    let fraction: number = tenths % 10;
    if (fraction < 0) { fraction = 0 - fraction; }
    return tostring(whole) + "." + tostring(fraction);
}
```

`fraction < 0` is reachable because `%` follows the sign of the left operand.

```
oneDecimal(3.14159) -> 3.1
oneDecimal(-2.5)    -> -2.5
oneDecimal(7)       -> 7.0
```

### Reading input

`read()` returns one line, and `""` at end of input, so a loop condition on an
empty line is how "until the user is done" is written. See
[section 9](#9-built-ins) for why the REPL is not one of the places this works.

```vela
let count: number = 0;
let total: number = 0;

let line: string = read();
while (line != "") {
    count = count + 1;
    total = total + len(line);
    line = read();
}

if (count == 0) {
    print("no input");
} else {
    print("lines: " + tostring(count));
    print("average: " + tostring(idiv(total, count)));
}
```

### Recursion

Recursion is the only way to express unbounded data traversal. It costs a stack
frame per call, so prefer a loop for linear work. Because signatures are hoisted,
a mutually recursive pair needs no forward declaration.

```vela
fn fact(n: number): number {
    if (n <= 1) { return 1; }
    return n * fact(n - 1);
}

fn isPrime(n: number): bool {
    if (n < 2) { return false; }
    if (n == 2) { return true; }
    if (n % 2 == 0) { return false; }
    let d: number = 3;
    while (d * d <= n) {
        if (n % d == 0) { return false; }
        d = d + 2;
    }
    return true;
}

fn isEven(n: number): bool { return n % 2 == 0; }
fn isOdd(n: number): bool { return isEven(n) == false; }   // mutual, no forward decl
```

### Arrays

There is no `for ... of`, no `map`/`filter`/`reduce`, and nothing that grows an
array in place, so array work is a loop over indexes. Three operations cover
almost everything.

```vela
// Build one whose length is only known while running. `append` copies, so the
// assignment is the point: without it the loop would go nowhere.
fn squares(limit: number): number[] {
    let out: number[] = [];
    for (let n: number = 1; n <= limit; n = n + 1) { out = append(out, n * n); }
    return out;
}

// Visit. `xs` is a reference, so this sorts in place and returns the same array.
fn sort(xs: number[]): number[] {
    for (let i: number = 0; i < len(xs) - 1; i = i + 1) {
        for (let j: number = 0; j < len(xs) - 1 - i; j = j + 1) {
            if (xs[j] > xs[j + 1]) {
                let swap: number = xs[j];
                xs[j] = xs[j + 1];
                xs[j + 1] = swap;
            }
        }
    }
    return xs;
}

// Search. `-1` is the sentinel: the result is a `number`, so it cannot be `null`.
fn find(xs: number[], needle: number): number {
    for (let i: number = 0; i < len(xs); i = i + 1) {
        if (xs[i] == needle) { return i; }
    }
    return 0 - 1;
}

fn sum(xs: number[]): number {
    let total: number = 0;
    for (let i: number = 0; i < len(xs); i = i + 1) { total = total + xs[i]; }
    return total;
}
```

`sort` is **in place** and legal because an array is a reference: `sort(xs)` and
`print(xs)` see the same array. It returns the array only so the call can be
chained — the print below shows one side, so the return earns its place.

```vela
fn show(xs: number[]): void { print(xs); }

show(sort([3, 1, 2]));   // [1, 2, 3]
```

A `number[][]` needs no parentheses, because the brackets bind to the element
type. This is a grid read one row at a time:

```vela
let board: number[][] = [[1, 2], [3, 4]];
print(board[1][0]);   // 3 — board[1] is a number[], so this reads its first element
print(len(board));    // 2 rows
```

That inner row is itself an array and an alias, so `board[1][0] = 9` writes
through two levels to the one cell, while `board[1] = [9, 9]` replaces the whole
row instead.

### Things you genuinely cannot write

Do not attempt these; they are impossible, not merely verbose.

- A list of mixed types, or a list of records. `T[]` is one element type, so an
  array of things that differ has no representation; `number[][]` and parallel
  arrays get you further, not further than that.
- Anything that needs an array to grow while it is being read at the same length,
  or a sparse or negatively-indexed one. Length is fixed at construction, there
  are no holes, and index `-1` is the last element written the C way — a runtime
  error, not a feature.
- Dispatch tables and function composition. A `function` value holds no
  signature, so there is nothing to build a table out of and nothing to inspect.
- Try/catch, error propagation, exception types. Validate up front and return a
  documented sentinel: `-1` for "not found", `0` for "division by zero".
- File, network, time, or randomness access. `print` and `read` are the only I/O.

The workaround pattern for most of them is the same: **flatten the data into
`number`s and loop,** or encode it as a base-256 integer and decode with `% 256`
and `idiv(x, 256)`. A set of records fits in `number[][]` when every record has
the same fields, and otherwise goes in a base-256 integer, one function per case,
or a tag you branch on.

---

## 12. Diagnostic catalogue

Diagnostics are **collected, not thrown** — one run reports every error it finds.
The pipeline stops after the first stage that produced errors, so a parse error
suppresses all type errors.

Rendering format:

```
path/to/file.vela
error: <message>
  |
3 | let n: number = "ten";
  |     ^
  | note: <hint>
  |
```

### Lexer errors

| Message | Cause |
| --- | --- |
| `unexpected character 'X'` | Unknown character. `[` `]` `.` `'` `#` `$` `@` all land here. |
| `unexpected character '&' (did you mean '&&'?)` | Lone `&` |
| `unexpected character '\|' (did you mean '\|\|'?)` | Lone `\|` |
| `expected a digit after '_'` | Trailing digit separator, as in `1_` |
| `expected a digit after the decimal point` | As in `1.` |
| `expected a digit in the exponent` | As in `1e` |
| `unterminated string: expected a closing '"'` | EOF inside a string |
| `unterminated string: strings may not span lines` | Newline inside a string |
| `unknown escape sequence '\d'` | Unsupported escape |
| `unterminated block comment: expected a matching '*/'` | EOF inside a block comment |

The lexer recovers: it drops the bad character or keeps scanning, so one typo can
produce several errors.

### Parser errors

Structural: `expected X, found Y` and the specific forms below.

| Message | Cause |
| --- | --- |
| `expected ':' followed by a type` | `let x = 1;` — missing type annotation |
| `expected a type name, found X` | An unknown or misplaced type. The notes list the five type keywords and the signature form |
| `expected '(' to start the parameter types` | `let f: fn = g;` — `fn` alone is the declaration keyword, not a type |
| `expected ')' to close the parameter list` | Trailing or missing `,` in a signature |
| `expected '->' followed by a return type` | `fn(number) number` — a signature needs its arrow |
| `expected '=' followed by an initial value` | `let x: number;` |
| `expected a variable name` / `a function name` / `a parameter name` | Bad identifier position |
| `expected '(' to start the parameter list` | Malformed `fn` header |
| `expected ',' between parameters or ')' to close the list` | Trailing comma, or missing comma |
| `expected ',' between arguments or ')' to close the call` | Trailing comma in a call |
| `expected ':' followed by a return type` | Missing return type |
| `expected '{' to start a block` / `expected '}' to close the block` | Malformed block |
| `expected '(' after 'if'` / `'while'` / `'for'` | Missing condition paren |
| `expected ')' after the condition` / `after the loop update` | Unclosed paren |
| `expected ';' after the loop initializer` / `after the loop condition` | Missing `;` in a `for` header |
| `expected ';' after 'return'` / `'break'` / `'continue'` / `the value to print` / `the expression` | Missing statement terminator |
| `expected ')' to close the group` | Unclosed grouping paren |
| `expected an expression, found 'X'` | Missing operand |
| `expected an expression, found 'print'` | `print` used as a value |
| `the left-hand side of '=' must be a variable` | Assignment to a non-identifier |
| `'return' is only allowed inside a function` | Top-level `return` |
| `'break' / 'continue' is only allowed inside a loop` | Loop control outside a loop |
| `required field 'b' cannot follow an optional one` | An optional field is not last. Reported once per struct, at the first field that breaks the order. Notes: `a constructor takes one argument per field, in order, so leaving one out leaves out everything after it` and `move the optional fields to the end of the list` |
| `field 'x' is already nullable, so '?' changes nothing` | `x?: number?`. Notes: `write either 'next?: Node' or 'next: Node?', not both` and `the first may be left out of the constructor; the second must be given one` |
| `a field cannot be optional and have type 'void'` | `y?: void` |
| `unexpected X at the top level` | Stray token |

Every structural error carries the note `every declaration in Vela needs an
explicit type` where a type is what is missing.

### Nullable diagnostics

| Message | Cause |
| --- | --- |
| `a type cannot be a nullable 'void'` | `void?` or `void?[]`. There is no value for absence to be absent from. |
| `this type is already nullable, so another '?' changes nothing` | `number??` or `number?[]??`. |
| `cannot compare 'number' with 'string?' using '=='` | A non-nullable against a nullable of another type. Two nullables must agree on their inner type. |
| `this has type 'Node?' and has no fields` | A field read through a nullable that has not been narrowed. Note: `test it first: 'if (x != null) { ... }' narrows it for the rest of that branch`. |
| `argument 1 has type 'number?', which 'len' does not accept` | A built-in that does not take a nullable. The same note as above, so the test that fixes it is named. |
| `cannot initialise 'x' of type 'number' with a value of type 'number?'` | Narrowing back out of a nullable. Note: `'number?' may be absent, so it is not a 'number' until a test has proved it is there`. |
| `cannot initialise 'x' of type 'number' with a value of type 'null'` | `null` where a non-nullable is expected. Note: `annotate the target as 'number?' rather than 'number', or store a real value instead`. |
| `'A' cannot contain itself` | A struct cycle with no nullable edge to break it. Note names the field that closes the cycle and prints the way round. Reported once per cycle; uses of such a struct then pass in silence. |
| `expected at least 1 argument but got 0` | A struct with optional fields called with too few. The note is the fix: it prints the constructor's signature and names the fields that may be left out. |
| `expected at most 3 arguments but got 4` | The same constructor called with too many. |

### Type errors

| Message | Cause |
| --- | --- |
| `cannot find 'x' in this scope` | Undeclared name, or used before declaration. Carries a `did you mean 'y'?` note using edit distance. |
| `'x' is already declared in this scope` | Redeclaration in one scope. Note points at the previous declaration. |
| `cannot initialise 'x' of type 'number' with a value of type 'string'` | Annotation disagrees with initialiser |
| `a variable cannot have type 'void'` | `let x: void = ...` |
| `'void' is only meaningful as a function return type` | (the note for the above) |
| `duplicate parameter 'x'` | Two parameters with one name |
| `this condition must be 'bool', but it is 'number'` | Non-`bool` `if`/`while`/`for` condition. Note: `Vela has no truthiness: comparisons must produce a 'bool'` |
| `operator '!' requires a 'bool' operand, but this is 'number'` | Bad `!` |
| `operator '-' requires a 'number' operand, but this is 'string'` | Bad unary minus |
| `operator '&&' / '\|\|' requires 'bool' operands, but these are '...' and '...'` | Bad logical operand |
| Cannot apply `'<'` to `'string'` and `'string'` | Ordering comparison on a non-number |
| `cannot apply '+' to 'string' and 'number'` | Mismatched binary operands. Note explains that `+` needs matching primitive types. |
| `cannot compare 'number' with 'string' using '=='` | Cross-type comparison |
| `cannot assign a value of type 'string' to 'n', which is 'number'` | Bad assignment |
| `'f' is a function and cannot be assigned to` | Assigning over a `fn` name |
| `this is not a function (it has type 'number')` | Calling a non-function |
| `expected 1 argument but got 2` | Arity. Note gives the full signature. |
| `argument 1 has type 'string' but 'number' was expected` | Argument type. The checker still walks the remaining arguments, so you get one round trip instead of two. |
| `a function returning 'number' must end with a return statement` | Missing return. Note: `the body of 'f' can finish without producing a 'number'` |
| `this function must return a 'number'` | Return type mismatch in a nested function |
| `this return has type 'string' but 'f' returns 'number'` | Wrong returned type |
| `a function returning 'void' cannot return a value` | `return x;` in a `void` function |
| `cannot print a value of type 'void'` | `print(voidFn());` |

### Runtime errors

Only reachable for things the static check cannot rule out.

| Message | Cause |
| --- | --- |
| `division by zero` | `/ 0` |
| `remainder by zero` | `% 0` |
| `expected a 'bool' condition, but got 'number'` | Should be unreachable; defensive |
| `operator 'X' cannot be applied to a value of type 'Y'` | Defensive counterpart of a type error |
| `cannot find 'x' in this scope` | Same message as the type error, thrown at run time |
| `cannot assign to 'x': it is not declared here` | Assignment to an undeclared name |
| `this is not a function (it has type 'Y')` | Defensive |
| `'f' expects 2 arguments but got 1` | Re-checked at run time |
| `unsupported operator 'X'` | Defensive |

### Reading an error

The underline spans the offending construct, not just the first token. A caret
under `"ten"` in `let n: number = "ten";` points at the whole literal. When two
errors point at overlapping spans, the first one printed is not necessarily the
root cause — fix the earliest one and re-run.

---

## 13. Worked examples

The complete set lives in `examples/`, and `npm run check-examples` type-checks
and runs every one of them on each build.

### hello.vela

```vela
print("hello, world");
```

### fizzbuzz.vela — modulo chain and early returns

```vela
fn fizzbuzz(n: number): string {
    if (n % 15 == 0) { return "FizzBuzz"; }
    if (n % 3 == 0) { return "Fizz"; }
    if (n % 5 == 0) { return "Buzz"; }
    return tostring(n);
}

for (let i: number = 1; i <= 20; i = i + 1) {
    print(fizzbuzz(i));
}
```

### fib.vela — recursion and iteration, side by side

```vela
fn fibRecursive(n: number): number {
    if (n < 2) { return n; }
    return fibRecursive(n - 1) + fibRecursive(n - 2);
}

fn fibIterative(n: number): number {
    let a: number = 0;
    let b: number = 1;
    for (let i: number = 0; i < n; i = i + 1) {
        let next: number = a + b;
        a = b;
        b = next;
    }
    return a;
}
```

The iterative version assigns to `a` and `b` inside the loop body, which is legal
because they were declared outside. `let next` is declared inside the body, so a
fresh `next` is created each iteration — the idiomatic way to get a temporary
without a top-level name.

### primes.vela — `while`, `break`, short-circuiting

```vela
fn isPrime(n: number): bool {
    if (n < 2) { return false; }
    if (n == 2) { return true; }
    if (n % 2 == 0) { return false; }

    let d: number = 3;
    while (d * d <= n) {
        if (n % d == 0) { return false; }
        d = d + 2;
    }
    return true;
}
```

A sieve is out of reach without arrays; trial division is the substitute.

### strings.vela — the full string surface

Everything a string can do: concatenate, compare, escape, measure, and index.
Indexing is the point, so the file spends its length on character work:

```vela
// A positional comparison: equal length, then the same character at every index.
fn sameCharacters(a: string, b: string): bool {
    if (len(a) != len(b)) { return false; }
    for (let i: number = 0; i < len(a); i = i + 1) {
        if (a[i] != b[i]) { return false; }
    }
    return true;
}

// A real anagram test needs order-independence, which means counting.
fn countIn(s: string, c: string): number {
    let n: number = 0;
    for (let i: number = 0; i < len(s); i = i + 1) {
        if (s[i] == c) { n = n + 1; }
    }
    return n;
}
```

`greeting[0]` is `"h"`, so `len(greeting[0])` is `1` and `greeting[0] + "!"` is
`"h!"`. The file prints all of it, and its `.expected` is compared against the
real output.

### temperature.vela — formatting a number you did not choose

The best single study in the language. Pure functions over `number`, then
formatting for display with the built-ins:

```vela
fn oneDecimal(value: number): string {
    let tenths: number = round(value * 10);
    let whole: number = idiv(tenths, 10);
    let fraction: number = tenths % 10;
    if (fraction < 0) { fraction = 0 - fraction; }
    return tostring(whole) + "." + tostring(fraction);
}
```

This file used to carry hand-written copies of `trunc`, `round`, and `idiv`,
because the language had no numeric built-ins. It does not any more — and could
not, since a top-level `fn trunc` is a compile error.

### callbacks.vela — function values

Storing a function in a `function`-typed variable, passing one as an argument,
and reassigning it:

```vela
fn double(x: number): number { return x * 2; }

let f: function = double;
print(applyToText(f, 21));   // f(21) = 42
f = square;
print(applyToText(f, 21));   // f(21) = 441
```

The file also works through the cost of the bare type: `op(x)` has type `any`
because the signature was not recorded, so the helper converts it with
`tostring` and says so.

### linecount.vela — reading stdin

The only example that reads input, so it runs with a `.input` sibling that
`check-examples` feeds to it:

```console
$ vela run examples/linecount.vela < examples/linecount.input
```

The summary is held in five `number`s and no string is ever stored, because a
summary never needs the values themselves. That turns out to be the natural way
to write it: with no array of lines to walk, the accumulation *is* the algorithm.

### arrays.vela — the whole array surface

`examples/arrays.vela` is the one program to read for arrays, because every rule
about them shows up somewhere in it: literals, `len`, reading and writing one
element, aliasing, reference equality, sorting in place, building a new array with
`append`, and a `number[][]` read and written one cell at a time.

```
literal:    [5, 3, 8, 1]
length:     4
...
row 1:      [4, 5, 6]
cell:       5
changed:    [[1, 2, 3], [4, 0, 6], [7, 8, 9]]
```

Two lines in it are worth quoting for what they prove. `alias[3] = 42;` changes
`xs`, because an array is a reference, and then `xs == [100, 10, 8, 42]` is
`false` — the contents match exactly and the answer is still no, because the
literal is a different array. And `append(empty, 1)` is `[1]`, which is the only
way an empty array ever grows.

### nullable.vela — absence, and the test that settles it

`examples/nullable.vela` is the one program to read for nullable types, because each
rule shows up somewhere in it: a value and an absence in the same declaration, a
guard clause that narrows by leaving, a `while` that walks a nullable field one step
at a time, an array of nullable elements beside a nullable array, and `typeOf` on
both kinds.

```
absent
present: 6
h
-
chain: 7
elements: 3
first:    false
no array at all
type:    null
string?: string
```

The `sum` function is the reason the feature exists. `next: Node?` is what makes a
struct refer to itself — every field has to be given a value at construction, so a
plain `next: Node` could never be built — and `while (at != null) { … at = at.next }`
needs no test inside the loop, because a loop body is checked as though its
condition held.

### Nested declarations

`fn` is a statement, so functions nest and are local to their block:

```vela
{
    fn helper(): number { return 2; }
    print(helper());   // 2
}
```

### Braceless bodies and top-level statements

```vela
if (true) print("braceless");
for (let i: number = 0; i < 3; i = i + 1) { print(i); }
```

Both are legal at file scope.

### Deliberately invalid programs

`examples/invalid/` holds programs that must *not* compile. `check-examples`
skips this directory. `type-error.vela` is a two-line type error:

```vela
let n: number = "ten";
```

```
error: cannot initialise 'n' of type 'number' with a value of type 'string'
  |
3 | let n: number = "ten";
  |     ^
  |
```

---

## 14. Tooling: CLI and REPL

### CLI

| Command | Does |
| --- | --- |
| `vela run <file>` | Type-check and execute |
| `vela check <file...>` | Type-check only, several files allowed |
| `vela tokens <file>` | Print the lexer's token stream |
| `vela ast <file>` | Print the parser's tree as an S-expression |
| `vela repl` | Interactive prompt |
| `vela install-skill` | Install the Vela skill into a coding assistant |
| `vela --help` | Usage |

Exit status is `0` on success and `1` if any stage reported an error. Add
`--locations` to `tokens` and `ast` to annotate every node with `@line:column`.

Without installing: `npx vela-lang run file.vela`, or from a clone
`npm run vela -- run file.vela`.

### Installing this guide into an assistant

`vela install-skill` copies `docs/vela.SKILL.md` into wherever a coding assistant
looks for instructions, rewriting the one placeholder that needs a
machine-specific answer: the absolute path of this file.

```
$ vela install-skill --list      # what was detected, and what is installed
$ vela install-skill             # install for everything detected
$ vela install-skill --uninstall
```

Targets, by id: `agents`, `claude`, `opencode`, `claude-md`, `cursor`, `copilot`,
`claude-rules`, `agents-project`, `gemini`, `aider`. Flags: `--target <id>`
(repeatable), `--scope user|project|both`, `--dry-run`, `--force`, `--uninstall`,
`--list`. Exit status is `0` unless a target conflicted with a file Vela did not
write.

**Why it does not install this file.** This document is 59 KB, and every
instruction-loading mechanism has a limit below that: Codex caps a project doc at
32 KiB, Devin at 12,000 characters, the Agent Skills specification asks for a
body under 500 lines, and Claude Code targets under 200 lines per `CLAUDE.md`.
So `docs/vela.SKILL.md` is the loadable artifact — roughly 350 lines carrying the
five rules, the does-not-exist table, the built-ins, the semantic traps, and the
short recipes — and it points here for the diagnostic catalogue, the worked
examples, and the compiler internals.

Three details are deliberate. The full reference is named by **absolute path**
rather than imported, because a relative link is not a lazy load and a markdown
`@import` of a file outside the project raises an approval prompt on every start.
`AGENTS.md` is installed as plain markdown with no frontmatter, because YAML
frontmatter is not a format it reads. And every installed file carries a
`vela-skill-install` marker, which is what lets `--uninstall` remove exactly what
it wrote and leave the user's own files alone.

Aider has no auto-discovery, so that target reports the `read:` line to add rather
than rewriting the user's YAML.

### Token dump

```
$ vela tokens examples/hello.vela
3:1  print    print
3:6  (        (
3:7  string   "hello, world"
3:21 )        )
3:22 ;        ;
4:-1  eof
```

Format is `line:column`, then the kind padded to eight columns, then the lexeme.
String and number tokens print their resolved value, not their raw text.

### AST dump

```
$ vela ast examples/hello.vela
(program
  (print
    (stringLiteral "hello, world")
  )
)
```

Node header forms: `(letDecl x: number ...`, `(fnDecl name (a: number, b: number) -> number ...`,
`(if ...)`, `(while ...)`, `(for ...)`, `(print ...)`, `(expressionStmt ...)`,
`(unary - ...)`, `(binary + ...)`, `(logical and ...)`, `(assign x ...)`,
`(call callee arg...)`, `(empty)` for a missing `for` part, and bare `(return)`,
`(break)`, `(continue)`. A `missing for` part prints as `(empty)`.

### REPL

```
vela> let x: number = 7;
vela> x * 6;
42
vela> fn double(n: number): number { return n * 2; }
vela> double(x);
14
vela> .reset
state cleared
vela> x;
error: cannot find 'x' in this scope
```

| Command | Does |
| --- | --- |
| `.help` | List commands |
| `.reset` | Clear all bindings and start over |
| `.exit` / `.quit` | Quit |

State persists across entries, and each entry is compiled with the previous
bindings seeded in. A non-final expression echoes its value; statements and
`void` do not. The REPL's multi-line heuristic reads balanced brackets and
trailing operators — it is a convenience, **not** part of the language.

### Embedding

```js
import { compile, Interpreter, createGlobalEnvironment } from "vela-lang";

const result = compile("example.vela", 'print("hi");');
if (result.stage === "ok") {
  new Interpreter(createGlobalEnvironment()).run(result.program);
}
```

---

## 15. Compiler architecture

```
source text
   │
   ▼
Lexer ────────▶ Token[]          src/lexer/       text  →  tokens
   │
   ▼
Parser ───────▶ AST              src/parser/      tokens  →  tree
   │
   ▼
Checker ──────▶ typed AST        src/types/       tree  →  tree + errors
   │
   ▼
Interpreter ──▶ output           src/runtime/     tree  →  effects
```

Each stage is a separate module with **no back-references to earlier stages**.
There is no bytecode and no VM; the interpreter is a tree walker.

| File | Responsibility |
| --- | --- |
| `src/diagnostics.ts` | `SourceFile`, `SourceLocation`, `DiagnosticBag`, rendering |
| `src/lexer/token.ts` | `TokenKind` vocabulary, `Token` interface, `KEYWORDS` |
| `src/lexer/lexer.ts` | Hand-written scanner |
| `src/ast/nodes.ts` | The AST as a discriminated union on `kind` |
| `src/ast/visitor.ts` | `NodeVisitor<T>` with an exhaustive `visit` |
| `src/ast/astPrinter.ts` | S-expression printer for `vela ast` |
| `src/parser/parser.ts` | Recursive descent + Pratt expression parser |
| `src/types/types.ts` | `Type` union, `typesEqual`, `isAssignable`, `typeToString` |
| `src/types/checker.ts` | Scope chain, type checking, return analysis |
| `src/runtime/values.ts` | `Value` union, `BUILTIN_SPECS`, output sink |
| `src/runtime/environment.ts` | Lexical scope chain |
| `src/runtime/interpreter.ts` | `Interpreter`, `RuntimeError` |
| `src/pipeline.ts` | The driver, `compile` / `compileFile` |
| `src/repl/repl.ts` | Interactive loop |
| `src/cli.ts` | Argument parsing and command dispatch |
| `src/index.ts` | Public API surface |

### Diagnostics are collected, never thrown

Every stage takes a `DiagnosticBag` and appends to it. The driver stops after the
first stage that produced errors, because there is no point type-checking a tree
the parser did not fully understand. This is why a single run reports many
independent errors instead of one per invocation.

### The AST is an exhaustive discriminated union

Every node extends `NodeBase` and carries a `readonly location`. `NodeVisitor<T>`
requires one method per `kind`, and `visit` ends with `const exhaustive: never =
node`, so adding a node without handling it everywhere is a **compile error**, not
a silent gap.

`kind` → visitor method name:

| `kind` | method | `kind` | method |
| --- | --- | --- | --- |
| `program` | `program` | `numberLiteral` | `numberLiteral` |
| `letDecl` | `letDecl` | `stringLiteral` | `stringLiteral` |
| `constDecl` | `constDecl` | `booleanLiteral` | `booleanLiteral` |
| `fnDecl` | `fnDecl` | `nullLiteral` | `nullLiteral` |
| `structDecl` | `structDecl` | `variable` | `variable` |
| `structField` | `structField` | `unary` | `unary` |
| `block` | `block` | `binary` | `binary` |
| `if` | `ifStmt` | `logical` | `logical` |
| `while` | `whileStmt` | `assignment` | `assignment` |
| `for` | `forStmt` | `call` | `call` |
| `return` | `returnStmt` | `index` | `index` |
| `break` | `breakStmt` | `fieldAccess` | `fieldAccess` |
| `continue` | `continueStmt` | `fieldAssign` | `fieldAssign` |
| `print` | `printStmt` | `indexAssign` | `indexAssign` |
| `expressionStmt` | `expressionStmt` | `arrayLiteral` | `arrayLiteral` |

The `kind`s for *types* — `number`, `string`, `bool`, `void`, `function`, `signature`,
`array`, `structType`, `nullable` — appear in an annotation, never in an
expression, so they have no visitor method; `resolveAnnotation` in the checker is
the one reader, and the parser is their only producer.

### The parser

Recursive descent for declarations and statements; **Pratt (precedence climbing)**
for expressions:

```ts
const BP = { none: 0, or: 10, and: 20, equality: 30,
             comparison: 40, term: 50, factor: 60, primary: 100 } as const;
```

The loop test is `entry.left > minBp` and recursion passes `entry.left`, which
makes every binary operator left-associative. Assignment is recognised separately
from the token stream and is right-associative. Call suffixes are applied in
`parsePrefix`, so they bind tighter than every operator.

**Indexed assignment is the one place the two halves of expression parsing have to
agree.** An `xs[i] = v` and an `xs[i] + 1` share their first three tokens, and the
subscript must only be read once, so the parser cannot parse an expression and
then check what it got. It looks ahead instead: a name followed by `[` is read as
an index target, and *what follows the closing bracket decides what it was* — an
assignment operator means this was a target, anything else means the same
`IndexExpression` is the left operand of the rest of the expression, built by
`parseBinaryRest` on the node already in hand. `xs[0] + 1` therefore parses
through exactly the same code path as before the feature existed, and no
expression is ever constructed twice. A chain is a target when its **last** suffix
is an index, which is what makes `grid[0][1] = 9` legal and `f()[0] = 1` not.

Error recovery uses `synchronize()`, which skips to the next `;`, to a
declaration or statement start token, or to a `}`. `parseProgram` forces progress
so hostile input terminates rather than looping. An unclosed `number[` synthesises
its `]` and moves on, so one missing bracket does not bury the rest of the file in
type errors.

### The checker

A `Scope` chain mirrors the runtime `Environment` chain. `Symbol` records a
name's `type`, `kind` (`variable` | `parameter` | `function`), and `location`.
Type checking is a visitor over the same AST. Assignability is plain structural
equality plus poison propagation:

```ts
isAssignable(target, value)  // error/any poison, then nullable widening, then typesEqual
```

The nullable rules are the only widening in the language: a plain `T` assigns into
a `T?`, `null` assigns into a `T?`, and `T?` into `U?` exactly when `T` assigns
into `U`. Nothing absorbs a nullable *value* into a plain target, which is what
keeps `x + 1` on a possibly-absent `x` a compile error rather than a runtime
surprise.

`ErrorType` is a poison value: once an expression has an error, every downstream
use is accepted silently, so one mistake produces one diagnostic instead of a
cascade.

**The checker holds one piece of context at a time:** the type an expression is
*required* to have. Almost every expression's type follows from itself — `1 + 2` is
a `number` whatever the declaration around it says — and threading an expected type
through every visitor method for the sake of the one node that needs it would be
noise. An array literal is the exception, because its element type appears
nowhere inside it, so `visitExpecting` sets a field, the literal reads it, and the
field is restored afterwards.

Unknown names get a `did you mean` suggestion computed with **Levenshtein edit
distance** over the names in scope.

**Struct resolution is two passes, and the second is a cycle search.** A field
annotation names a struct, so a first pass gives every declaration its nominal
type and a second pass resolves the fields. That is also where a cycle is found:
`structReachedBy` walks each field's type for a target struct, following struct and
array edges and *stopping at a nullable*, which is why `next: Node?` terminates the
walk and `next: Node` does not — an optional field is nullable, so `next?: Node`
terminates it for the same reason. A cycle is reported once, at the field that closes
it, with the route printed (`'A.b' -> 'B.a'`), and the struct is marked
unbuildable so its uses pass in silence instead of repeating the complaint.

**Narrowing is a map of facts, and the map is copied rather than mutated.** A fact
is a `Symbol`, a path from it, and the type proved there — so it is keyed on the
binding, not the name, and a shadowing `let` cannot overwrite an outer fact.
`nullTest` reads a comparison and `placeOf` reads a place, which is what lets a
field chain (`p.next.next`) narrow as one path. `withFacts` takes a fact list,
checks an expression under it, and returns the map to use *after*; the four
branching sites are `if`/`else`, a loop condition with its body, the right operand
of `&&`, and a `for` update with its body. An assignment calls `forget` on the
place it writes, and a block saves and restores the map so a fact cannot escape its
branch.

### The runtime

Values are a tagged union: `number`, `string`, `bool`, `null`, `void`, `array`,
`struct`, `function` (closure), `native` (built-in). `void` is a singleton `VOID`
value and `null` a singleton `NULL` one, which is what makes `==` between two of
them a value comparison rather than a reference one.

An `array` value is a mutable box around a `Value[]`, not a value of that element
type. That is what gives `xs` and `ys = xs` one shared array, so a write through
either name is seen by the other, and what makes `xs == ys` a reference question
rather than a contents one.

`Environment` has two deliberately distinct operations, and conflating them is
the classic hand-written-interpreter bug:

- `define(name, value)` always writes to **this** scope, so `let` inside a block
  shadows.
- `assign(name, value)` **walks the chain** and writes wherever the name was
  found, so `x = 1` inside a block updates the outer `x`. It never creates a
  binding, so a bare assignment to an unknown name is an error, not a declaration.

`return` is implemented with a `ReturnSignal` exception caught by `invoke`.
Output goes through an indirected sink, and swapping the sink is the *only*
difference between running a program and testing it.

### The single source of truth for built-ins

`BUILTIN_SPECS` in `src/runtime/values.ts` declares each built-in's name, arity,
parameter types, return type, and behaviour. The runtime builds `NativeValue`s
from it; the checker seeds its root scope from the same table. **They cannot
drift.**

Two entries do not fit a signature, and both say so with a function instead:

- `accepts(type, position, argTypes)` replaces the parameter type at a position the
  declared `any` cannot. `len` accepts a string or an array, and `append`'s second
  argument has to match the first argument's *element* type — a relation one
  argument's own type cannot express. Passing every argument type along is what
  makes the second one checkable.
- `returns(argTypes)` computes the result type, so `append` returns whatever array
  type it was given rather than one fixed one.

The checker keys its specs on the **seeded symbol**, not the name, and looks the
callee up before applying them. A shadowing `let append: function` in a block is
an ordinary user function that shares a spelling, and keying on the name would
reject its calls for a rule about an array.

---

## 16. Extending Vela

### Adding a built-in

One entry in `BUILTIN_SPECS` is all that is required — the runtime and the
checker both read from it.

```ts
{
  name: "abs",
  arity: 1,
  paramTypes: [numberType],
  returnType: numberType,
  call: (args) => {
    const target = args[0];
    if (!target || target.kind !== "number") return number(0);
    return number(Math.abs(target.value));
  },
},
```

Note the `anyType` convention: use it only where the built-in is genuinely
polymorphic, as `tostring`, `tonumber`, and `typeOf` are.

### Adding a statement

1. Add the `kind` and interface to `src/ast/nodes.ts`.
2. Add a `parseStatement` case in `src/parser/parser.ts`.
3. Add a visitor method — the `never` exhaustiveness check will point you at every
   site that needs updating (`checker.ts`, `interpreter.ts`, `astPrinter.ts`).
4. Add tests to `test/parser.test.ts`, `test/checker.test.ts`, and
   `test/interpreter.test.ts`.
5. Add a fenced `*.vela` example if the statement is meant to be user-facing.

### Adding a type

Substantially more work, and the design pushes back on it. A new primitive means a
new `Type` variant, a new `Value` variant, lexer and parser changes, checker
changes, and an update to every operator's type rules. Nothing in the
architecture is extensible along this axis, which is a large part of why the type
list is four items long. Prefer expressing the new concept as a function over
existing primitives.

### Adding a type constructor

Cheaper than a new primitive, because the representation is shared — this is how
`T[]`, `fn(...) -> R`, `struct`, and `T?` were each added. The work is:

1. `src/types/types.ts`: a `Type` variant, a constructor, `isAssignable` for it, and
   a case in `typeToString`. `nullableType` is deliberately idempotent, so `number??`
   collapses rather than nesting.
2. The AST and the parser: a suffix in `src/parser/parser.ts`, so `T[]`, `T?`, and
   `fn(...) -> R` compose in one left-to-right pass. Reject what cannot exist
   (`void?`, a second `?`) at parse time, with a note naming the legal form.
3. Every place that *asks* about a type rather than constructs one — the operator
   rules, `==` compatibility, `isTruthy`, the built-in specs, assignment, and
   return checking. `comparableForEquality` is the clearest example: it handles
   `null` before it handles kinds, because `x == null` has to be writable for any
   expression.
4. The runtime: a `Value` variant and a case in the interpreter and `displayValue`.
5. Narrowing, if the type can hold an absence: `nullTest`, `placeOf`, `splitPath`,
   and `forget` in `src/types/checker.ts`, and `withFacts` at the four sites that
   branch — `if`/`else`, a loop condition and body, a `&&` right operand, and a
   `for` update.

### Conventions to follow

- Comments explain **why**, not what. The codebase's comment style is dense
  reasoning about design trade-offs, not restating the code.
- Prefer collecting diagnostics over throwing.
- Keep stages independent — nothing in `src/lexer/` may import from
  `src/parser/`.
- Add a `note:` hint to a diagnostic whenever a specific fix exists.
- Ground a new claim in a test, and prefer `npm run check-examples` for
  end-to-end coverage.

---

## 17. Testing

```console
$ npm run typecheck        # tsc --noEmit
$ npm test                 # node:test via tsx
$ npm run check-examples   # type-check and run every examples/*.vela
$ npm run build            # emit dist/
```

`npm test` runs ~385 cases across seven files:

| File | Covers |
| --- | --- |
| `test/lexer.test.ts` | Token kinds, positions, escapes, error recovery |
| `test/parser.test.ts` | Grammar acceptance and rejection, precedence, associativity |
| `test/checker.test.ts` | Type rules, scoping, return analysis, diagnostics |
| `test/interpreter.test.ts` | Runtime semantics, scoping, built-ins, indexing, `read()` |
| `test/pipeline.test.ts` | Stage ordering, stage stopping, error recovery, the REPL |
| `test/cli.test.ts` | Argument parsing, exit codes, output rendering, real stdin |
| `test/install-skill.test.ts` | Every `vela` block in `docs/vela.SKILL.md` compiles, and each `// error:` block still fails |

**`npm run check-examples` is the test that matters most.** Every `*.vela` file
in `examples/` is type-checked and executed for real, so an example that stops
compiling — or a compiler regression — fails there. Files in `examples/invalid/`
are deliberately excluded. A program with a sibling `<name>.input` has those lines
fed to its `read()` calls, and a sibling `<name>.expected` is compared against the
real output, so an example's *output* is asserted rather than just its exit code.
That matters for `examples/strings.vela` in particular: a `for` loop that never
runs also exits 0.

Capture output with `setOutput`:

```ts
const lines: string[] = [];
const restore = setOutput((text) => lines.push(text));
try {
  new Interpreter(createGlobalEnvironment()).run(program);
} finally {
  restore();
}
assert.deepEqual(lines, ["expected output"]);
```

---

## 18. Design rationale and known gaps

### Why the restrictions exist

Most of the early cuts came from one rule: **accept only what the type system can
fully describe.** Four features have since been added, and the reasoning behind
each is worth recording, because three of them relax that rule in a specific and
deliberate way.

**`s[i]` — indexing a string, but not a collection.** The original cut was on
*collections*: nothing in the type system has an element type, so an `a[i]` over
some container could never type-check. A string is different. It already exists as
a value, `len` already describes its length, and reading one code unit out of it
returns another `string` — so the whole construct is describable without a new type
concept. That made it possible to add indexing without adding a collection type.
`n[0]` is still a type error, and the diagnostic says why.

**`trunc`, `floor`, `ceil`, `round`, `abs`, `min`, `max`, `idiv`.** These were
originally left out on the grounds that guessing rounding behaviour would be worse
than omitting it. The resolution was to specify each one exactly rather than
approximate it: `trunc` and `idiv` toward zero, `round` halves away from zero,
`idiv(x, 0)` is `0`. Specified semantics beat no semantics. `sqrt` and `pow` are
still recipes rather than built-ins, because their exact floating-point behaviour
is the part that is genuinely hard to promise.

**Forward references and mutual recursion.** Declaring before use made "is this
name in scope here?" a question with a one-word answer, which is what kept the
checker's messages precise. Hoisting function *signatures* per declaration list
preserves that: the question still has a one-word answer at the start of each
body, and the only names that appear early are the ones whose signatures are
already known. Variables are not hoisted, because a variable's type comes from a
value that has to be computed first.

**Nullable types and flow narrowing — the one place soundness is bent on
purpose.** `T?` is fully describable and so is unremarkable; what is worth
recording is that the `if` that settles it needs the *checker* to remember what a
test proved. It does: a comparison against `null` records a fact about a place, per
branch, and a fact is keyed on the **symbol** rather than the name, so a shadowing
`let x` is a different fact from an outer `x` rather than an accidental
overwrite of it. Writing to a place removes its fact, and the places that can be
narrowed are a name and a chain of fields from one.

Two things are deliberately not done. An **indexed element is not narrowed**,
because `xs[0]` has no fixed identity — `i` may be something else by the time it is
read again, and two syntactically identical `xs[i]` need not be the same element.
Narrowing it would be unsound in a way a reader could not see. And a **function
call does not invalidate anything**: the checker tracks what a test established and
what an assignment removed, and it cannot see into a call that assigns.

```vela
let x: number? = 1;
if (x != null) {
    clear(x);                 // a call — the checker does not know it assigns
    print(tostring(x + 1));   // accepted, and wrong
}
```

This is the one hole in the feature, and it is the same shape as the bare
`function` type's unchecked call: a limited, documented unsoundness bought in
exchange for a feature that is otherwise unusable without a cast. It is also
narrower than it looks — an explicit `x = null` is seen, and so is writing to a
field or an element — and it is the *absence* of the hole that would cost more,
since the alternative is refusing `x + 1` after a test the programmer can plainly
see has proved it.

**Function values: two ways to name one.** A function can be stored, passed, and
returned, and there are two types for that. A written signature,
`fn(number) -> number`, names the parameters and the return type, so a call
through it has its arity, its arguments, and its result all checked. The bare
`function` records *that* a function is stored and nothing more, so a call
through one is unchecked: no arity check at compile time, and no known result
type.

```vela
fn double(x: number): number { return x * 2; }

let f: fn(number) -> number = double;   // checked on every call
let n: number = f(21);                  // 42, and 'n' is really a number
let g: function = double;               // stored, but not checked when called
let m: number = g(1, 2, 3);             // compiles; fails at runtime
```

The bare type is the one place where the "fully describe it" rule is knowingly
bent. Its value is that a function is storable without committing to one shape,
which is what a variable that gets swapped between different operations needs. The
cost is that a call through it cannot be verified, and its result is `any`, so
`tostring` is often needed around one. A call that gets the arity wrong still
fails at runtime, with a message naming the function that was actually called.

**Optional struct fields — describable, with one rule borrowed from the call.** A
field whose type is `T?` is fully described by the type system, and it was already
possible. What `field?: T` adds is that the *constructor* may leave it out, and
that is a fact about argument lists rather than about types. It was worth adding
because the alternative is a nullable field that every construction has to spell
out — `Node(1, null)` — and because an optional field is the natural way to write a
recursive struct now that `Node(1)` means "no next node" without a sentinel.

Two decisions follow from the arguments being positional. An omitted field is
stored as `null` rather than as some separate "absent" state, so there is one
value per field, one comparison story, and no third thing to print. And the
optional fields must be a **suffix**, because `Config(3)` fills the first field and
there is no spelling that fills the third and skips the second; supporting the gap
would mean named arguments. The arity check is therefore a *range* rather than a
single count, and its diagnostic prints the constructor's signature and names the
fields that may be left out, which is the note that turns an arity complaint into
the fix.

**The two types are not interchangeable.** A concrete signature assigns to the
bare `function`, but a bare `function` does not satisfy a signature:

```vela
fn d(x: number): number { return x; }
let b: function = d;                    // correct: a signature widens to 'function'
let f: fn(number) -> number = b;        // error: 'function' is not fn(number) -> number
```

Accepting it would claim knowledge of parameters the type does not have, and then
the call would be checked against a signature that was never stated. For the same
reason a signature must match exactly: there is no subtyping, so a
two-parameter function is not a `fn(number) -> number`, and `fn(number) -> number`
is not a `fn(number) -> string`. That strictness is what makes the call sites
trustworthy.

Parameter *names* may be written in a signature and are ignored, because a name is
not part of a type. `fn(n: number) -> number` and `fn(number) -> number` are the
same type, which keeps a signature visually parallel to a `fn` declaration:

```vela
fn apply(op: fn(number) -> number, v: number): number { return op(v); }
let named: fn(x: number) -> number = double;   // the 'x' is documentation
```

Signatures nest, so a function that takes a function is written without any
special syntax beyond the nesting:

```vela
fn twice(f: fn(number) -> number, v: number): number { return f(f(v)); }
```

The one thing a signature cannot express is a function of *several* shapes at
once. `map` over a list of mixed arities has no spelling here, because there are
no generics and no subtyping; the answer is the bare `function` type and an
unchecked call, or a function per shape.

The remaining restrictions still stand on the original rule:

- **No collections.** A `string` is a sequence, not a collection. Nothing has an
  element type, so there is no way to declare a list of `number` and index it.
  Data that varies in length has to be flattened into named `number` variables, or
  processed a value at a time.
- **No `sqrt` or `pow`.** The eight numeric built-ins cover rounding and integer
  division, which is the part worth promising exactly; the other two are written
  out of `trunc` in [section 11](#11-standard-library-recipes). Case conversion,
  trimming, search, slicing, repetition, and replacement *are* built in — see
  [section 9](#9-built-ins) — so there is no string-library gap left.

### Known limitations

**Return analysis is sound but incomplete.** It handles early returns and
`if`/`else` correctly, but treats a loop as never returning. So this is
rejected even though every execution returns:

```vela
fn f(n: number): number {
    while (n > 0) { return 1; }
    // error: a function returning 'number' must end with a return statement
}
```

The fix is a trailing `return`:

```vela
fn f(n: number): number {
    while (n > 0) { return 1; }
    return 0 - 1;   // sentinel
}
```

Being wrong in the safe direction is the right trade for a first version, and it
is the most significant known gap in the checker.

**Narrowing is not invalidated by a call.** The checker knows what a test proved and
what an assignment removed, but not that a called function assigned to a name, so
this compiles and can fail at runtime:

```vela
let x: number? = 1;
if (x != null) {
    clear(x);                 // not tracked
    print(tostring(x + 1));   // accepted, and x may be null here
}
```

An explicit `x = null`, or a write to `x` or to one of its fields, *is* tracked, and
so is entering a function or leaving a block. Assigning the value explicitly is the
fix, and it is one line. See
[section 18](#18-design-rationale-and-known-gaps) for why the feature is worth the
hole.

**An indexed element is not narrowed.** `if (xs[0] != null) { xs[0] + 1 }` is
rejected: an index is a place with no fixed identity, so nothing could invalidate
the fact or keep it honest. Copy it into a named variable to use it twice.

**A struct cycle is reported once, at the declaration,** and every use of such a
struct then passes in silence — including a constructor call with the wrong arity.
A reader fixing the declaration gets one error to fix rather than the same
complaint at every use, at the cost of a second error appearing once the first is
resolved.

**The REPL's multi-line heuristic is not part of the language.** It reads balanced
brackets and trailing operators, so a `while` body is legal on one REPL line just
as it is across several in a file.

**`typeOf` can return `"native"`,** which the README does not mention. This is
correct — built-ins are values — but surprising.

**`read()` cannot be used in the REPL.** Readline owns the terminal and has
buffered stdin before an entry runs, so `read()` is at end of input there. An
embedder that wants it to work passes `inputLines` to the REPL. This is a property
of the tool, not the language, but it is the one place a program that reads input
behaves differently from the same program in a file.

**Numbers are unbounded doubles.** `1e400` becomes `Infinity` with no diagnostic.

**Recursion depth is capped at 750 calls,** which is a runtime error rather than a
V8 stack overflow — an interpreted frame costs several host frames, and the host
limit is a number that would change with the runtime rather than the language.

### Not in this version

Generics · modules · optional *parameters* · default field values · named
arguments · a writable function type · bytecode compilation · `sqrt` and `pow` ·
ordering on `string` and `bool` · ordering or `Option` on a nullable · code-point
iteration · intersection narrowing for an indexed element.

---

## 19. Pre-submission checklist

Before calling a `.vela` program correct, verify each of these:

- [ ] Every statement ends with `;`.
- [ ] Every `let` has a type **and** an initialiser.
- [ ] Every parameter and every function has an explicit return type.
- [ ] No variable has type `void`.
- [ ] Every `if` / `while` / `for` condition is a `bool` expression — a
      comparison, a `bool` variable, or a `&&`/`||` of those.
- [ ] No ternary, trailing comma, single-quoted string, bitwise operator, or
      `try` anywhere.
- [ ] Every `x++` / `x--` is a statement or a `for` update, never inside a larger
      expression.
- [ ] Every index is in `0 .. len(s) - 1`, or it is a runtime error waiting to
      happen.
- [ ] Every number meeting a string goes through `tostring`.
- [ ] Every string meeting a number goes through `tonumber`.
- [ ] Every binary `+` has two operands of the **same** type.
- [ ] Every comparison has two operands of the **same** type. `null` is the
      exception: it compares against anything, and a value that cannot be absent
      is always `!= ` it.
- [ ] Every `T?` is tested against `null` before its value is read — a field
      chain included — and no indexed element is being narrowed, because it is not
      narrowed.
- [ ] Every field of a `struct` can actually be given a value; a recursive one
      needs the `?`, or the declaration does not build.
- [ ] Every `?` on a struct field is **after the name** (`label?: string`), and
      every optional field is after every required one.
- [ ] Every variable is declared before it is used. Functions are exempt —
      signatures are hoisted, so a forward or mutual call is fine.
- [ ] Every non-`void` function ends with a `return` that the checker will
      accept — add a trailing return if any earlier return is inside a loop.
- [ ] `break` and `continue` are inside a loop; `return` is inside a function.
- [ ] No division or remainder by a value that can be zero, or the division is
      guarded by short-circuit `&&`.
- [ ] `print` is used as a statement, never as a value, and never given a `void`.
- [ ] Every `read()` result is checked for `""` if the program loops on input.
- [ ] The program was actually run: `vela run file.vela` exited `0`.

Then confirm the mental model against
[section 3](#3-things-that-do-not-exist-in-vela) once more. Most Vela bugs are a
feature from another language leaking in, and that table is the fastest way to
catch them.
