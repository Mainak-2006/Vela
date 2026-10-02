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

These nineteen words are reserved and cannot be used as identifiers:

```
fn   let   const   return   if   else   while   for   break   continue   print
true   false   null   number   string   bool   void   function
```

`true` and `false` are literals of type `bool`, and `null` is a literal of type
`null`; all three are listed here because they are also reserved. The last five
are type names, so `let number: number = 1;` is a parse error rather than a
variable named `number`. `null` is *not* one of them: there is no way to write
`null` where a type is expected, because a nullable type is written `T?` and the
absence it stands for is a value rather than a type you can name.

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
declaration   ::= structDecl | fnDecl | letDecl | constDecl
structDecl    ::= "struct" identifier "{" { field } "}"
field         ::= identifier [ "?" ] ":" T ";"
fnDecl        ::= "fn" identifier "(" params ")" ":" T block
letDecl       ::= "let" identifier ":" T "=" expression ";"
constDecl     ::= "const" identifier ":" T "=" expression ";"
params        ::= [ param { "," param } ]
param         ::= identifier ":" T
```

Both a type and an initialiser are mandatory. `let x: number;` is a parse error
and `let x = 1;` is a parse error, not a warning: there is no uninitialised
variable, no `undefined`, and no type inference.

A `struct` is a declaration, so it lives where declarations live — the top level.
Each field is written like a parameter, type and all, and ends with `;` like every
other statement, so the one-line and multi-line forms are the same thing:

```vela
struct Point { x: number; y: number; }

struct Box {
    label: string;
    at: Point;
}
```

The braces are `{`…`}` rather than an indentation block, because the list is
declarations rather than executable statements. A struct declared inside a block is
a type error, not a parse error, so the tree survives to be reported properly.

A struct is built by **calling its name**, with one argument per field in the
order declared — `Point(1, 2)`, `Box("origin", p)`. There is no struct literal and
no default value, which is why a field count and an argument count always agree.
The name itself is not a value: `let p: Point = Point;` is an error, because a type
is not something a program can hold.

A `?` **after a field's name** makes the field optional: the constructor may leave
it out, and the field's type becomes `T?`. The two questions are separate, so the
two spellings are separate — `label?: string` may be omitted, `label: string?` may
not be:

```
struct Config { retries: number; label?: string; note?: string; }

Config(3)                     // retries: 3, label: null, note: null
Config(3, "prod")             // retries: 3, label: prod, note: null
Config(3, "prod", "written")  // all three given
```

An omitted field is stored as `null`, so omission and an explicit `null` are the
same state: `Config(3) == Config(3, null, null)`. The call therefore accepts any
number of arguments from the count of required fields to the total, and a call
outside that range is refused — `Config()` is too few, `Config(3, "a", "b", "c")` is
too many. A struct with no optional fields keeps the single exact count it always
had.

Optional fields must be a **suffix** of the field list. The arguments are
positional, so a missing field cannot sit between two given ones: there would be no
argument for it and no way to leave a later one out. `struct Bad { a?: number;
b: string; }` is a parse error naming `b`. `a?: number?` is refused as well —
already nullable, so the `?` would change nothing — and so is an optional `void`.

`const` is spelled and typed exactly like `let`, and binds in the same scope with
the same shadowing rules. The only difference is that every later assignment to
the name is a type error. See *static rules* below. A `const` may also appear in
a `for` header, where it is useful for a loop that deliberately does not update
its own counter: `let done: number = 0; for (const i: number = 42; done < 3; ) { print(i); done = done + 1; }`
prints `42` three times. A `const` in a `for` header rules out that loop's own
update expression, so its counter has to live outside the header.

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
`x = x <op> value` — or `xs[i] = xs[i] <op> value` and `p.x = p.x <op> value` when
the target is an index or a field.
They desugar in the parser, so the AST, checker, and interpreter are unchanged
and every type rule applies unchanged.

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

`->` is not in this table. It is the arrow of a written signature, legal only
inside a type, and a syntax error anywhere an expression is expected.

```
expression   ::= assignment
assignment   ::= place assignOp assignment | or
place        ::= identifier { "." identifier | "[" expression "]" }
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
               | "." identifier
primary      ::= number | string | "true" | "false"
               | array
               | identifier | "(" expression ")"
array        ::= "[" [ expression { "," expression } ] "]"
```

**Assignment is right-associative, and its left side must be a place.** A place is
a name followed by any chain of `.field` and `[index]` suffixes: `x`, `p.x`,
`p.at.y`, `xs[0]`, `pts[0].x`, `p.tags[1]`. `a = b = 3;` assigns 3 to `b` and then
to `a`, and `xs[0] = ys[1] = 3;` does the same through two arrays. The parser
recognises that shape directly from the token stream rather than building a general
expression and rejecting it afterwards, which is what lets `a + 1 = 2` report one
clear error — "the left-hand side of '=' must be a name, an element or a field" —
instead of a cascade about a missing semicolon.

The chain has to *start* with a name, because that is the only thing that gives an
assignment something to write back into. A chain that runs through a call names a
temporary instead: `f()[0] = 1` and `p.f() = 2` are both reported, while `ps[0].x`
and `p.tags[1]` are fine.

An index target is recognised by starting with a name and a `[`, and the subscript
is read *once*: if an assignment operator follows, the two are an indexed
assignment, and if anything else follows then the very same `IndexExpression`
becomes the left operand of the rest of the expression. That is why `xs[0] + 1` and
`xs[0][1]` parse exactly as they would with no assignment in sight, and why no
part of the tree is built twice.

**Indexing is `s[i]` or `xs[i]`.** A `string` yields one code unit as a `string`;
a `T[]` yields a `T`. `len` counts code units or elements, so valid indices are `0`
through `len(x) - 1`; anything else, negative included, is a runtime error rather
than an empty answer. A `number`, `bool`, or `void` is a compile error — it has no
parts to read. A `string` can be read but not written, because its length is
fixed: `s[0] = "x"` is a type error, while `xs[0] = 1` replaces one element.

Suffixes share one loop, so calls, indexes and fields chain freely: `f()[0]`,
`s[0][1]` and `p.at.y` parse the way `f()(1)` does, left to right. A field at the
end of such a chain can be assigned through, which is what makes `p.x = 1` and
`p.at.y = 2` legal; a call cannot, so `p.f() = 2` is reported.

**An array literal takes no type of its own.** `[1, 2]` is `number[]` and `["a"]` is
`string[]` by what it holds. The brackets may appear once per element type, so
`[[1], [2]]` is `number[][]`, and a trailing comma is an error.

**Calls take no trailing comma.** `f(1,)` is an error.

## Types

```
T         ::= simple { suffix }
suffix    ::= "[]" | "?"
simple    ::= "number" | "string" | "bool" | "void" | "function"
            | signature | identifier
signature ::= "fn" [ "(" T { "," T } ")" ] "->" T
```

An `identifier` in a type is a declared struct's name: `Point`, `Point[]`,
`fn(Point) -> Box`. It parses as a name even when nothing declares it, because only
the checker knows the declarations; an unknown name is reported there as
`cannot find a struct called 'Nope'`.

The brackets bind to the element type, so `number[][]` is an array of arrays and
needs no parentheses. `void[]` is rejected: an array of absences could never be
used, since every use of a `void` is already an error.

**`?` and `[]` are suffixes and may be written in either order.** `number?[]` is an
array of nullable numbers; `number[]?` is a nullable array. They are different
types, and neither is a special case: the suffix list is simply read left to right.
`void?` is rejected, for the same reason as `void[]`, and so is a second `?` —
absent has no inner type to qualify, so `number??` would ask the same question
twice.

The first four are primitives. `function` is a bare function type: it lets a
function be stored, passed, and returned, without naming a signature. A signature
names the parameters and the return type, which is the other way to hold a
function.

```vela
fn double(x: number): number { return x * 2; }

let f: function = double;      // correct
let n: number = 5;
let g: function = n;           // error: a number is not a function
let h: fn(number) -> number = double;   // correct
let bad: fn(string) -> number = double; // error: wrong parameter type
```

Parameter *names* may be written and are ignored, since a name is not part of a
type: `fn(n: number) -> number` and `fn(number) -> number` are the same type. This
keeps a signature parallel to a `fn` declaration. A signature nests, so
`fn(fn(number) -> number) -> number` is a function that takes a function.

**The two ways to name a function are not interchangeable.** A concrete signature
assigns to the bare `function` type, but not the other way round: a bare
`function` does not satisfy `fn(number) -> number`, because doing so would claim
knowledge of parameters the type does not have. For the same reason a signature
must match exactly. There is no subtyping, so a two-parameter function is not a
`fn(number) -> number` and `fn(number) -> number` is not a
`fn(number) -> string`.

A call through a signature-typed variable is fully checked — arity, argument
types, and the result type. A call through a bare `function` is not: `f(1, 2, 3)`
compiles and then fails at runtime, and the result has no known type, which is why
`tostring` is often needed around one. Reach for a signature when the shape is
known; reach for `function` when one name has to stand in for several shapes.

A `fnDecl` may be nested, and its body sees its own name, so recursion works. More
than that, every signature in a declaration list is hoisted before any body in it
is checked, so a forward call and a mutually recursive pair both resolve. A `let`
is *not* hoisted and must be declared before use.

## Nullable types

A type written `T?` holds either a `T` or nothing, and `null` is the nothing.
There is no `Option`, no `Some`, and no second constructor to unwrap with: the
type records the possibility, and a comparison against `null` is what settles
it.

```vela
let missing: number? = null;     // absent
let present: number? = 5;        // a number, in a type that permits absence
let plain: number = 5;           // never absent
```

**A `T` widens into a `T?`, and nothing narrows back.** `null` and any `T` are
both assignable to `T?`, because each of them is one of the two things the type
allows. A `T?` is assignable to no narrower type, so `let n: number = maybe;` is
rejected even when `maybe` happens to hold a number right now — the type says it
might not, and the checker does not run the program to find out.

**`null` is a type of its own,** not "any type, possibly absent". That is what
makes it comparable to a nullable and to nothing else in a useful sense:

```vela
if (maybe == null) { print("absent"); }        // correct: `maybe` is `number?`
if (plain == null) { print("never"); }          // legal, and always false
let a: number? = 1;
let b: string? = "s";
if (a == b) { print("unreachable"); }          // error: two different inner types
```

**`null` compares with anything, and anything else needs matching types.** A value
that cannot be absent may still be compared with `null` — the test is always
false, and Vela reports faults rather than tautologies — because the alternative
would be a test that cannot be written once its type has been pinned down. What
*is* refused is a nullable on one side and a non-nullable on the other, or two
nullables with different inner types: those have no single answer, which is
exactly the case a reader is looking for.

### Narrowing

A nullable is useless if it cannot be used, so a comparison against `null`
narrows the rest of the branch it appears in. Inside `if (x != null) { … }` the
name `x` is a `number`, and inside the `else` of `if (x == null) { … }` it is
`null`:

```vela
fn describe(n: number?): string {
    if (n == null) { return "absent"; }
    return tostring(n + 1);          // `n` is a `number` here
}

fn firstLetter(s: string?): string {
    if (s != null) { return s[0]; }  // narrowed for this block
    return "-";                      // and the else needs no test of its own
}
```

Five rules, all of which matter:

- **A narrowing `if` with no `else` whose body always leaves** narrows the code
  *after* it too, because those statements are only reached the other way. That
  is what makes the guard clause at the top of `describe` above work.
- **A loop body — `while` or `for` — is checked as though its condition held,**
  and so is a `for` update, which also runs only when it held. So the chain-walking
  loop needs no test inside it:

  ```vela
  for (let at: Node? = head; at != null; at = at.next) { total = total + at.value; }
  ```

  The statements after a `while` are checked as though its condition did *not*
  hold, unless the body can leave first — which is the one case the analysis
  refuses to reason about, because a body that returns may have run zero times.
- **`&&` narrows its right operand,** and `||` narrows neither, since it is not
  known which side was true. `x != null && x > 0` works; `x != null || y != null`
  teaches nothing.
- **A fact is per binding, not per name.** It is keyed on the symbol, so a `let x`
  inside a branch is a different binding from an outer `x` and starts unnarrowed,
  which is what makes shadowing safe.
- **Writing to a name or field drops the fact about it,** and about anything
  reached through it. `if (p.next != null) { p.next = null; … }` is a `Node?`
  again on the next line, because that is what it is.

**A chain of fields narrows too,** which is what makes a linked structure
readable without copying anything into a temporary:

```vela
struct Node { value: number; next: Node?; }

if (head.next != null && head.next.next != null) {
    print(tostring(head.next.next.value));   // a `number`
}
```

Each test is read under the one before it, so the second is only meaningful
because the first has been established. An **indexed** element is not narrowed:
`xs[0]` has no fixed text that identifies the same element next time, so a test of
it teaches nothing the checker could rely on, and a use of one says so rather than
guessing. Copy it to a name first if it is needed twice.

## Structs

A struct is a named group of typed fields. It is declared once, at the top level,
and its name is then a type:

```vela
struct Point { x: number; y: number; }

struct Box {
    label: string;
    at: Point;
    tags: string[];
}

let p: Point = Point(3, 4);        // one argument per field, in order
print(p.x);                        // 4
p.x = 9;
p.x += 1;                          // sugar for p.x = p.x + 1
print(p);                          // Point(x: 10, y: 4)
print(typeOf(p));                  // Point
```

**Structs are nominal.** Two structs with identical fields are different types,
because the name *is* the type: `Point(1,2) == Other(1,2)` is a compile error, not
a `false`. There is no structural compatibility and no subtyping, so a value of one
struct cannot be passed where another is expected.

**A struct is a value, and storing one copies it.** Not just the fields — the
whole thing, including an array or another struct a field holds:

```vela
let q: Point = p;
q.x = 100;                         // p.x is still 10
```

The same copy happens on an argument, on a return, and into an array element, so
two names never share one struct. An array bound on its own is *not* copied — an
array is the one reference value in Vela — so `let ys: number[] = xs;` still shares.

**`==` compares fields.** Two structs of the same type are equal when their fields
are, recursively, which is what makes a copy equal to what it was copied from. An
array *inside* a struct is still compared by reference, as arrays are everywhere
else.

The rules that are not there are as much of the design as the ones that are: no
methods, no inheritance, no defaults, no struct literal, and no struct value on the
heap that two names can share. A field may be *optional*, which is not the same as
having a default: nothing is assumed, the value is `null` until something is
written to the field.

Two things are rejected because nothing could satisfy them. A struct that contains
itself, directly or through another, could never be built — every field must be
given a value and there is no value to give — so `struct Self { me: Self; }` is an
error. A **nullable field is the one thing that does break such a loop**, because
it can hold `null` and `null` ends the chain:

```vela
struct Node { value: number; next: Node?; }

let a: Node = Node(1, null);
let b: Node = Node(2, a);       // fine: `a` already exists
```

The cycle search follows struct-typed fields and array-of-struct fields, and stops
at every nullable one, so `struct Self { me: Self?; }` is accepted while
`struct Self { me: Self; }` is not. An optional field is nullable too, so
`struct Self { me?: Self; }` is accepted on the same grounds — and the diagnostic
for the unbreakable case names both spellings, because either `?` fixes it. The diagnostic names the struct the cycle comes
back to, at the field that closes it, and spells out the way round, because
"cannot contain itself" is false as a statement about a mutual pair. It is reported
once: every use of a struct on a cycle then passes in silence, since a use has
nothing to add and the declaration is the only place the reader can fix.

A field of type `void` is rejected for the same shape of reason: `void` is the
absence of a value and a field is a value that has to hold one.

## Static rules

These are not syntax, but a program must satisfy them to run, and several are
surprising enough to be worth stating plainly.

**Types are never coerced.** `+` requires both operands to be the same type, so
`"n=" + 1` is an error rather than producing `"n=1"`, and `true + 1` is an error
rather than `2`. Use `tostring` and `tonumber` to convert deliberately.

**Comparisons require matching types.** `1 == "0"` and `1 == true` are both
errors. There is no cross-type equality. For an array the element type is part of
the type, so `number[] == string[]` is an error on the same grounds.

**A nullable type is not a wider type.** `number?` is unrelated to `number` in
both directions of a *narrowing* request: a `number` widens into a `number?`, and
nothing comes back out. Two nullable types are compatible when their inner types
are, so `number?` fits `number?` and `number?` fits nothing else. A `T?` and a
`T??` are the same type, because absence has no inner type to qualify twice.

**Ordering is not defined for a nullable.** `x < 1` where `x` is `number?` is an
error, because the absent value has no number to compare. Only `==` and `!=` are
available, and those only with `null` or another nullable of the same inner type.

**A `void` cannot be nullable,** and neither can a `void` be an array element:
there is no value to be absent *from*, so `void?` and `void[]` are both parse
errors rather than types that could never be used.

**Array types are exact.** `number[]` is unrelated to `string[]` and to
`number[][]`, and there is no subtyping and no widening. `number[][]` is an array
of arrays, so `board[i]` is a `number[]` and `board[i][j]` is a `number`.

**Two structs are equal when their fields are.** `==` and `!=` on two values of the
same struct type compare field by field, recursively, so `Point(1, 2) == Point(1, 2)`
is `true` and a copy of a struct equals what it was copied from. An array inside a
struct is compared by reference, as arrays are everywhere else. Two *different*
struct types cannot be compared at all, however alike their fields.

**Ordering comparisons are numeric-only.** `==` and `!=` work on any two values
of the same type, but `<`, `<=`, `>`, and `>=` require `number` operands, so
`"a" < "b"` and `true < false` are both errors. There is no lexicographic order
on strings and no order on `bool`; the only magnitude available for a string is
`len`, which is a number. The checker and the interpreter agree on this — the
interpreter routes every ordering operator through the same numeric assertion, so
it is a rule about the language rather than a gap in the checker. The diagnostic
is easy to misread, though: `cannot apply '<' to 'string' and 'string'` carries a
note about `+`, because one operand check serves both operators.

**Conditions must be `bool`.** `if (n)` is an error, and so is `if (p)` for a
struct `p`. `0` and `""` are ordinary values of their own types, not falsy, and
there is no truthiness anywhere.

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

**A `const` name cannot be assigned to, anywhere.** `K = 2`, `K += 2`, `K++`, and
a `for` header that updates its own `const` counter are all rejected with
`'K' is declared with 'const' and cannot be assigned to`. This is a rule the
checker applies to the *name*, and it holds however far away the assignment is —
a `const` at the top of a program is still a `const` inside a loop inside a
function. It is not a runtime guarantee, and there is no immutability anywhere
else: nothing about the stored value changes, so a `const` holding a mutable
thing is as mutable as ever.

**An index out of range is a runtime error,** not an empty answer: `s[5]` on
`"ab"` reports `index 5 is out of range: this string has length 2`, and `xs[2]` on
`[1, 2]` reports `index 2 is out of range: this array has length 2`. Negative
indices are included in this, and so is a *write* past the end: an array's length
never changes, so `xs[2] = 1` is reported rather than quietly appending. The
checker cannot know the length, so this is one of the errors that survives type
checking.

**`print` is a statement, not a function.** `print` cannot appear in an
expression, so `let a: number = print(1);` is a parse error. The twenty-three
callable built-ins are `tostring`, `tonumber`, `typeOf`, `len`, `trunc`, `floor`,
`ceil`, `round`, `abs`, `min`, `max`, `idiv`, `read`, `upper`, `lower`, `trim`,
`startsWith`, `endsWith`, `indexOf`, `substr`, `repeat`, `replace`, and `append`.

Two of them are not a fixed signature, and the table declares that with a check
rather than with a second signature, because Vela has no source syntax for an
overload. `len` accepts a `string` or a `T[]` and nothing else. `append(xs, v)`
takes an array and returns the same element type it was given, which is why one
built-in serves every element type: a parameterised type is not a type the
language can write.

**`read()` takes no arguments and prints no prompt,** returning one line of stdin
with the newline stripped, and `""` at end of input. `read()` cannot return `null`,
so an empty string is how end-of-input is spelled — and a loop condition on
`line != ""` is how "until the user is done" is written.

**Errors stop the pipeline.** A program with a type error does not run, so
statements before the error never execute.

## Known gaps

- **Narrowing is not invalidated by a function call.** The checker tracks what a
  *test* established and what an *assignment* took away, but it cannot see that a
  called function assigned to a name:

  ```vela
  let x: number? = 1;
  if (x != null) {
      clear(x);            // a call, and the checker does not know it assigns
      print(tostring(x + 1));   // accepted, and wrong
  }
  ```

  Assigning `x` directly, or writing to a field or element of it, is tracked; the
  hole is only the call. It is stated here because it is unsound, and it is narrow:
  the fix in a program is to assign `null` explicitly, which the checker does see.
- **An indexed element is not narrowed,** and neither is anything reached through
  one. `xs[0]` and `m["next"]` are places with no fixed identity, so a test of one
  is not tracked; the use is reported instead.
- A narrowing loop does not carry its fact into the *condition* — the loop is
  re-tested from the declared type each time, which is sound, and costs one test per
  iteration rather than per program.
- The `while`-only-return limitation described above, in the return analysis.
- No `sqrt` or `pow`, so `docs/SKILLS.md` section 11 writes both out of `trunc`.
  The eight numeric built-ins cover rounding and integer division, which is the
  part worth promising exactly.
- `s[i]` counts UTF-16 code units, so a surrogate pair occupies two indices and
  reading one half of an emoji gives a broken character. There is no code-point
  iteration to offer instead.
- The bare `function` type records no signature, so a call through one is not
  checked. Writing the signature out closes the hole, so this is a choice rather
  than a limit: see `docs/SKILLS.md` section 18.
- There is no `for ... of`, no `map`/`filter`/`reduce`, and no way to grow an
  array in place, so array work is a loop over indexes and `append` reassigning.
  There is no `sort` either, though `docs/SKILLS.md` writes one out.
- No ordering on `string` or `bool`, as described under static rules. `==` and
  `!=` are the whole of the comparison vocabulary for those two types.
- The REPL's multi-line heuristic is not part of this grammar. It reads balanced
  brackets and trailing operators, so a `while` body is legal on one line here
  just as it is across several.
