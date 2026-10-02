---
name: vela
description: Write, fix, and debug Vela (`.vela`) programs. Use whenever the user mentions Vela, a .vela file, or the vela CLI, and when creating, editing, reviewing, or debugging Vela source. Covers the four primitive types (number, string, bool, void) plus the bare function type, fixed-length arrays, nominal structs, nullable types (T?, null) and the flow-sensitive narrowing that makes them usable, the mandatory type annotations, string, array and field indexing, compound assignment and ++/--, forward and mutual recursion, optional struct fields (`field?: T`), the constructs Vela deliberately lacks (no for...of, no ternary, no truthiness, no coercion, no modules, no string ordering), the twenty-three built-ins including read(), the string functions, and the recipes that replace the missing math library.
license: MIT
compatibility: opencode, Claude Code, Cursor, Copilot, Gemini CLI, Zed, Roo Code, Kilo Code, Aider
---

# Vela

A small, imperative, C-shaped, statically-typed language with a tree-walking interpreter.
Four primitives, a function type, arrays, structs and nullables, no inference, no modules.

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

Run it with `vela run program.vela`, type-check it with `vela check program.vela`.

**Where the missing pieces went.** Almost every restriction below exists because the thing
it removes is also the thing that makes a program hard to read, and the answer is nearly
always a two-line function you write yourself — see *Recipes* below.

---

## The five rules that break code when ignored

Nearly every Vela mistake is one of these five.

1. **Every statement ends with `;`.** No newline sensitivity — a statement may
   span lines, but a `let` missing its `;` swallows everything after it.

2. **Types are mandatory, everywhere.** No inference, no uninitialised
   variables. `let x = 1;`, `let x: number;`, `fn f(a)`, and `fn f(a: number) {}`
   are all parse errors.

3. **Conditions must be `bool`. There is no truthiness.** `0` is not false, `""`
   is not false, `if (n)` is a type error. Write `if (n != 0)`.

4. **Functions may be used before they are written.** A signature is hoisted
   before any body is checked, so forward references and mutual recursion both
   work. Variables are different: a `let` must still be declared before use,
   because its type comes from a value that has to be computed first.

5. **Nothing is ever coerced.** `+` needs both operands the same type; comparison
   needs matching types. Convert explicitly with `tostring` and `tonumber`, every
   time. This is the single most common failure when porting from another
   language.

```vela
print("n=" + 1);            // error: cannot apply '+' to 'string' and 'number'
print(1 == "0");            // error: cannot compare 'number' with 'string'
print("n=" + tostring(1));  // correct
```

---

## Things that do not exist in Vela

Every entry is a real feature in some other language, and every one is a compile error here.
Read this before assuming anything.

| You want to write | Why it fails | Do this instead |
| --- | --- | --- |
| `let x = 1;` | Types are mandatory | `let x: number = 1;` |
| `K = 2` after `const K: number = 1;` | A `const` name can never be assigned to | `let K: number = 1;` if it has to change |
| `let y: number = i++;` | `++` has no value — it is a statement | `i++;` on its own line |
| `i + j++` | Same: no value to add | `i++;` then use `i` |
| `xs[len(xs)] = x` | An array's length never changes | `xs = append(xs, x)` — a new array |
| `for (x of xs)`, `for (let x in xs)` | `for` has one C-style form | `for (let i: number = 0; i < len(xs); i++) { ... }` |
| `[1, 2]` as a value | No top-level array constants | `let xs: number[] = [1, 2];` |
| `xs.length` | An array has no fields | `len(xs)` |
| `xs.push(v)` | Nothing grows an array in place | `xs = append(xs, v)` |
| `a ? b : c` | No ternary | `if (a) { b = 1; } else { b = 2; }` |
| `a ?? b`, `a?.b` | No optional chaining or coalescing | `if (a != null) { ... }` |
| `fn f() {}` | Return type is mandatory | `fn f(): void { ... }` |
| `None`, `undefined`, `NaN` | Not nameable or constructible | Sentinel numbers (`0 - 1`, `-1`) with a documented meaning |
| `let x: number = null;` | `null` only fits a `T?` | `let x: number? = null;` |
| `let x: void?;`, `number??` | `void` has nothing to be absent from, and `?` twice changes nothing | One `?`, on a real type |
| `if (p != null) { print(p.x); }` with `p: P?` | That is the fix, and it is what works | `p.x` is legal *inside*, and after it |
| `while (x) { ... }` | Conditions must be `bool` | `while (x != 0) { ... }` |
| `"a" < "b"` | Ordering is numeric-only | `==` and `!=` only; use `len(s)` for magnitude |
| `"a" + 1` | No coercion | `"a" + tostring(1)` |
| `import`, `require`, `use` | No modules | One file; the global scope is the only scope |
| `class`, `enum`, `interface` | No classes, no enumerations | `struct` for a named group of fields; functions over primitives |
| generics `T`, `list<T>` | No generics | A function per element type |
| `public` / `private` / `static` | No access modifiers | Top-level `fn` is the whole API |
| `s.upper()`, `s.split()`, `xs.map(f)` | No methods on any type | `upper(s)`; build the rest with `+` and indexes |
| methods inside `struct` | A struct has fields, not functions | A `fn` takes the struct as an argument |
| `struct P { p: P; }` | Every field must be given a value, and there is none to give | `struct P { p: P?; }` — a nullable or an optional breaks the cycle |
| `struct C { a?: number; b: string; }` | Optional fields must come last | `struct C { b: string; a?: number; }` |
| `if (xs[0] != null) { tostring(xs[0] + 1); }` | An index is not a place a test can pin | Copy it out first: `let e: number? = xs[0];` |
| `x.y` when `x` is `T?` | Absence has no fields | `if (x != null) { ... }` first |
| `Math.sqrt`, `Math.pow` | Only the eight numeric built-ins exist | `trunc`, `abs`, ... then write `sqrt` — see *Recipes* |
| `f(1,)` trailing comma | Not accepted | `f(1)` |
| `'single quotes'` | Double quotes only | `"double quotes"` |
| `f"text {x}"`, backtick templates | No interpolation at all | `"text " + tostring(x)` |
| raw strings, multi-line strings | A newline inside a string is an error | `+ "\n" +` |
| `#` comments | `//` and `/* */` only | |
| bitwise `& \| ^ ~ << >>` | Not in the vocabulary | `/ % 2` and a boolean, or recursion |
| `**` | No exponentiation operator | A `for` loop multiplying |
| `try` / `catch` / `throw` | No exceptions to catch | Validate inputs up front, return a sentinel |
| `input("prompt")` | `read()` takes no arguments | `let s: string = read();` |
| files, time, random | `print` and `read` are the only I/O | |

### One that constrains program *design*, not just syntax

**A struct's fields must be constructible.** A struct cannot contain itself, directly
or through another, *without a nullable in the way*: every field must be given a value
by the constructor, and there is none to give. A nullable breaks the cycle — `next:
Node?`, or an optional field, `next?: Node` — and leaving the `?` off is rejected
once, at the field that closes the loop, with the way round printed.

**Arrays are fixed in length.** `T[]` holds any number of elements — but a number
decided when the array was built. Nothing grows an array in place, so a program
collecting while it runs reassigns as it goes:

```vela
let out: number[] = [];
for (let i: number = 0; i < 3; i = i + 1) { out = append(out, i * i); }
```

---

## Built-ins

Exactly **twenty-three callables** plus the `print` statement. No modules, no
imports, no other global name.

| Name | Signature | Behaviour |
| --- | --- | --- |
| `tostring(x)` | `(any) -> string` | Renders like `print`. Numbers never get a trailing `.0`. |
| `tonumber(s)` | `(any) -> number` | `Number(s)` for a string; `0` for a non-numeric string **and for any non-string argument**. Never fails. |
| `typeOf(x)` | `(any) -> string` | `"number"`, `"string"`, `"bool"`, `"null"`, `"void"`, `"array"`, `"function"`, or `"native"` — and a struct's **declared name**, so `typeOf(p)` is `"Point"`. |
| `len(x)` | `(string \| T[]) -> number` | UTF-16 code-unit count for a string, element count for an array. Any other argument is a compile error. |
| `trunc(x)` | `(number) -> number` | Toward zero, so `trunc(-2.7)` is `-2`. |
| `floor(x)` | `(number) -> number` | `floor(-2.7)` is `-3`. |
| `ceil(x)` | `(number) -> number` | `ceil(-2.7)` is `-2`. |
| `round(x)` | `(number) -> number` | Halves **away from zero**: `round(2.5)` is `3`, `round(-2.5)` is `-3`. |
| `abs(x)` | `(number) -> number` | `abs(-3)` is `3`. |
| `min(a, b)` | `(number, number) -> number` | |
| `max(a, b)` | `(number, number) -> number` | |
| `idiv(a, b)` | `(number, number) -> number` | Truncates toward zero, like `%`. Dividing by zero gives `0`. |
| `read()` | `() -> string` | One line of stdin, newline stripped. `""` at end of input. |
| `upper(s)` | `(string) -> string` | Unicode upper case; `upper("straße")` is `STRASSE`, so the result can be longer. |
| `lower(s)` | `(string) -> string` | Unicode lower case. |
| `trim(s)` | `(string) -> string` | Whitespace stripped from both ends. |
| `startsWith(s, pre)` | `(string, string) -> bool` | **Subject first**, then the prefix. |
| `endsWith(s, suf)` | `(string, string) -> bool` | **Subject first**, then the suffix. |
| `indexOf(s, sub)` | `(string, string) -> number` | First index of `sub`, or `-1`. An empty `sub` is at `0`. |
| `substr(s, from, count)` | `(string, number, number) -> string` | Clamped: a start past the end or a negative count gives `""`. |
| `repeat(s, n)` | `(string, number) -> string` | `n` copies; zero or less gives `""`, and `n` is truncated. |
| `replace(s, from, to)` | `(string, string, string) -> string` | **First occurrence only.** No match, or an empty `from`, returns `s`. |
| `append(xs, v)` | `(T[], T) -> T[]` | A **new** array with `v` on the end. `xs` is unchanged, so the caller reassigns. |

`print` adds a trailing newline, and printing `void` is a compile error. `tostring`
renders strings **unquoted**, so `tostring("1")` and `tostring(1)` both give `"1"` — use
`typeOf` to round-trip a type. Built-ins are first-class, so `typeOf(tostring)` is
`"native"`; they can be shadowed inside a block, and shadowing one at top level is an error.

---

## Semantics that surprise

**Numbers** are IEEE-754 doubles; integer and fractional literals are one type.

| Operation | Semantics |
| --- | --- |
| `+ - *` | IEEE-754, so `0.1 + 0.2` is `0.30000000000000004` |
| `/` | **Always true division.** No integer division: `7 / 2` is `3.5`, and `7 / 2 * 2` is `7`, not `8`. |
| `%` | **Truncated remainder**, sign follows the *left* operand. `-7 % 2` is `-1`; `2 % 1.5` is `0.5`. |
| unary `-` | Negation, so `--1` is `1`. |
| `++`, `--` | Statements, not expressions. `i++` is sugar for `i = i + 1`. |
| `+=`, `-=`, `*=`, `/=`, `%=` | Sugar for `x = x <op> value`, with the same type rules. Also for `xs[i]` and `p.x`. |

**A leading `--` is still a doubled negation.** `i--` decrements, because a name comes
first; `--1` is `1`, because nothing does. A statement ends in `;` or a loop header's `)`, which is what tells the two apart.

**Strings** support `+` (concatenation, both operands `string`) and `==` / `!=` (value
comparison, not identity). Those two are the **only** comparisons that work on strings —
`<` and friends need `number` operands, so `"abc" < "abd"` is a compile error, and
strings cannot be sorted.

**`s[i]` reads one code unit** and returns a one-character `string`, so `len(s[i])` is
`1` and the usual `+` rules still apply. Indices are `0` through `len(s) - 1`; anything
else is a runtime error. `len` counts code units too, so an emoji is `2` — read one
index at a time it is a broken character.

**Arrays** are `T[]`: homogeneous, fixed in length, and shared rather than copied.
`xs[i]` is a `T` and `xs[i] = v` replaces one element, both within `0` through
`len(xs) - 1`; anything else is a runtime error, and `xs[0] += 1` is sugar for
`xs[0] = xs[0] + 1`. Two names bound to the same array see the same writes, which
is why `==` compares the *reference*: true for one array under two names, false for
`[1, 2] == [1, 2]`.

**Structs are values, and storing one copies it.** A `struct Point { x: number; }`
is declared once at the top level and built by calling its name, one argument per
field in the order written: `Point(1, 2)`. There are no methods, no inheritance, no
defaults, and no struct literal — a type is not a value, so `let p = Point;` is an
error. Structs are **nominal**: two structs with identical fields are different
types, and `==` between them is an error rather than a `false`. A field is a place,
so `p.x = 9` and `ps[0].x = 42` both write, and `==` compares two structs of the
same type **field by field** — so a copy equals what it was copied from, and an
array inside one is still compared by reference.

**`T?` is one type: a value or `null`.** `null` is the only value of its own type
and fits any `T?`, so `let x: number? = null;` checks and `let n: number = null;`
does not. `number?[]` is an array *of nullable numbers*; `number[]?` is a nullable
array — the brackets bind to what they follow.

**A comparison against `null` narrows the branch it is in**, so no cast is ever
needed. `if`/`else` branches are separate, a guard clause narrows everything after
it, the right side of `&&` narrows, a loop body is checked as though its condition
held, and a field chain narrows whole: `if (p.next != null) { p.next.value }`.
Writing to the name or field — `x = null` included — takes the fact back. Two gaps,
both deliberate and explained in `docs/SKILLS.md` §18: an **indexed element does not
narrow**, and **a function call does not invalidate** a narrowed name, so
`if (x != null) { clear(x); }` is accepted even if `clear` assigns. `==` treats
`null` as comparable to anything, which is what makes the test legal at all.

**An array literal takes its element type from context.** `[1, 2]` is `number[]` and
`["a"]` is `string[]` on their own; `[]` needs a type from somewhere — the annotation,
the return type, or the parameter it is passed to. With no context at all, `[]` is an
error rather than a guess.

**Booleans** are `true`, `false`, `==`, `!=`, `&&`, `||`, `!`: no truthiness, no coercion to a number.

**`&&` and `||` short-circuit** — a hard guarantee you can rely on for guards, as in
`if (b != 0 && a / b > 1) { return a / b; }`.

**Scoping.** `let`, `const`, and `fn` bind in the current block and lookup walks
outward; assignment (`=`) writes to the *outermost* binding of a name and never
creates one. Calls get a fresh child scope, and a `void` function that falls off the
end returns the `void` value, not `null`.

**`const` names can never be assigned to.** `const K: number = 1;` is typed and bound
exactly like `let`, and the name is then rejected by every later assignment — `K = 2`,
`K += 2`, `K++`, from any distance. It is a rule about the name; the runtime stores it
no differently.

**Function signatures are hoisted.** Every `fn` in a block is visible before any body in
that block is checked, so forward references and mutual recursion work; a `let` is not
hoisted, and must be declared before use.

**Function values, two ways to name one.** A function can be stored, passed, and
returned, and there are two types for that. A written signature
`fn(number) -> number` names the parameters and the return type, so a call
through it has its arity, its arguments, and its result all checked. The bare
`function` records only *that* a function is stored, so a call through one is
unchecked and its result has no known type — which is why `tostring` appears so
often around one.

```vela
fn double(x: number): number { return x * 2; }

let f: fn(number) -> number = double;
let n: number = f(1);            // checked: arity, argument, and result
let bad: fn(string) -> number = double;   // error: wrong parameter type
let g: function = double;
print(tostring(g(21)));          // 42, so the real function still applies
let h: function = 5;             // error: a number is not a function
print(g(1, 2, 3));               // accepted by the checker, then a runtime error
```


The two are not interchangeable. A signature widens to `function`, but a bare
`function` does not satisfy a signature, because that would claim parameters the
type never stated. For the same reason a signature must match exactly: there is no
subtyping, so a two-parameter function is not a `fn(number) -> number`. Parameter
names in a signature are documentation and are ignored — `fn(n: number) -> number`
and `fn(number) -> number` are one type — and signatures nest, so
`fn(fn(number) -> number) -> number` is a function taking a function.

**Runtime errors that survive type checking:** `division by zero`, `remainder by zero`, a
non-`bool` condition, an out-of-range string or array index (read or write), and running
past the call-depth limit. Everything else is caught first.

---

## Recipes

### The numeric built-ins

`trunc`, `floor`, `ceil`, `round`, `abs`, `min`, `max`, and `idiv` are built-ins. Do not
define them: a top-level declaration that reuses a built-in's name is a compile error, the
same rule that stops you shadowing `tostring`. `trunc` rounds toward zero, so `trunc(-2.7)`
is `-2` while `floor(-2.7)` is `-3`; `round` rounds halves **away from zero**, so
`round(-2.5)` is `-3`; `idiv` truncates toward zero like `%` does, and gives `0` for a
zero divisor.

### The rest of the library

Everything below is written by hand — there is no `sqrt`, no `pow`, and no string
library. All of it compiles and runs as written; `powInt`, `sqrt`, and `digits`
chain through `trunc`, so define them in that order.

```vela
fn powInt(base: number, e: number): number {
    let out: number = 1;
    for (let i: number = 0; i < e; i = i + 1) { out = out * base; }
    return out;
}

// No Math.sqrt, so iterate. Float equality would never terminate the loop,
// so the iteration count is fixed (60).
fn sqrt(x: number): number {
    if (x < 0) { return 0 - 1; }   // sentinel: negative input
    if (x == 0) { return 0; }
    let g: number = x;
    for (let i: number = 0; i < 60; i = i + 1) { g = (g + x / g) / 2; }
    return g;
}

fn gcd(a: number, b: number): number {
    let x: number = abs(a);
    let y: number = abs(b);
    while (y != 0) { let t: number = y; y = x % y; x = t; }
    return x;
}
```

A `let` inside a `while` body is legal, so the swap temporary lives in the loop.

**Building strings.** Accumulating in a loop is the *only* way to build a string of a
computed length; digits come out with `%` and are **prepended**. A `for` update can be
`i++`, and `repeat` is built in, so only padding is left to write:

```vela
fn pad(s: string, width: number): string {
    let out: string = s;
    while (len(out) < width) { out = " " + out; }
    return out;
}
```

`"[" + repeat("ab", 3) + "]"` is `[ababab]`; `"[" + pad("7", 5) + "]"` is `[    7]`.

**Formatting decimals.** Round to a whole count of tenths, then split it.

```vela
fn oneDecimal(value: number): string {
    let tenths: number = round(value * 10);
    let whole: number = idiv(tenths, 10);
    let fraction: number = tenths % 10;
    if (fraction < 0) { fraction = 0 - fraction; }
    return tostring(whole) + "." + tostring(fraction);
}
```

**Looking inside a string.** `s[i]` makes per-character work possible, and reversal is the one job still worth a loop; the rest are built in.

```vela
fn reverse(s: string): string {
    let out: string = "";
    for (let i: number = 0; i < len(s); i = i + 1) { out = s[i] + out; }
    return out;
}
```

Every string built-in takes the **subject first, pattern second**, and every one is
**total** — none can fail at runtime: `substr("hello", 1, 3)` is `ell` and clamps out of
range to `""`, `indexOf` is `-1` when absent, `upper("straße")` is `STRASSE`, longer.

**Reading input.** `read()` returns one line and `""` at end of input, so a loop on an
empty line is how "until the user is done" is written:

```vela
let line: string = read();
while (line != "") { print(line); line = read(); }
```

That is for a **program run**, not a REPL session: the line editor has the terminal by
then, so `read()` is at end of input there.

### Arrays

No `for ... of` and no collection library, so an array is worked on by index.
`append` copies and returns a **new** array, which is what makes building one whose
length is only known while running a loop that reassigns:

```vela
fn squares(limit: number): number[] {
    let out: number[] = [];
    for (let n: number = 1; n <= limit; n = n + 1) { out = append(out, n * n); }
    return out;
}

fn find(xs: number[], needle: number): number {
    for (let i: number = 0; i < len(xs); i = i + 1) { if (xs[i] == needle) { return i; } }
    return 0 - 1;   // the sentinel: the result is a `number`, not a nullable
}
```

A `number[][]` needs no parentheses: the brackets bind to the element type, so
`board[1][1]` is a `number`. Sorting in place is in the full reference.

### Structs

A struct replaces a pile of parallel arrays, or a tuple encoded as an array. Declare it once
at the top level, call its name to build one, and reach a field with `.`:

```vela
struct Point { x: number; y: number; }

let p: Point = Point(3, 4);
p.x += 1;              // sugar for p.x = p.x + 1
print(p);              // Point(x: 4, y: 4)

let q: Point = p;      // a copy, so writing through q leaves p alone
q.x = 100;
print(p.x);            // 4

fn move(p: Point, dx: number): Point { return Point(p.x + dx, p.y); }
```

Structs nest and go in arrays with no extra syntax: `struct Box { at: Point; }` gives
`b.at.x`, and `let ps: Point[] = [Point(0, 0)];` gives `ps[0].x`. Printing a struct shows
its name and every field, and `typeOf` answers with the declared name. A **nullable
field** is what lets a struct describe something that ends:

```vela
struct Node { value: number; next: Node?; }

let head: Node = Node(1, Node(2, null));    // the tail's next is the absence
fn total(from: Node?): number {
    let sum: number = 0;
    for (let at: Node? = from; at != null; at = at.next) { sum = sum + at.value; }
    return sum;                             // no test inside: the loop body has one
}
print(total(head));                         // 3
```

`Node[]` is an array of nodes whose `next` may be absent; `Node?[]` holds absences.

A `?` after a field's **name** makes the field optional, so the constructor may leave
it out. The field's type becomes `T?`, and an omitted field is stored as `null`:

```vela
struct Config { retries: number; label?: string; note?: string; }

let a: Config = Config(3);                    // label: null, note: null
let b: Config = Config(3, "prod", "written");  // label: prod,  note: written
print(tostring(a == Config(3, null, null)));  // true: omission *is* `null`
if (b.label != null) { print(b.label); }      // narrowed, like any other `T?`
b.label = "later";                            // a field is still a place
```

Optional fields must be a **suffix** — arguments are positional, so `struct Bad { a?:
number; b: string; }` is a parse error, as are `x?: number?` and `x?: void`.
Struct *parameters* have no such form: write `fn f(x: number?)`.

### Do not attempt these

Impossible, not merely verbose: a list of mixed types, dispatch tables, exceptions,
a cyclic struct, and file or network access are all in the table above. The
workaround is the same either way — **flatten the data into `number`s and loop**,
or encode it as a base-256 integer and decode it with `% 256`.

---

## The full reference

This file is the fast path. When you need more — the complete diagnostic
catalogue with exact messages, the full grammar and precedence table, worked
examples, the CLI and REPL, or the compiler architecture for extending Vela,
including `digits`, `group` and `isPrime` — read it:

{{FULL_REFERENCE}}

It is long. Read the sections you need rather than the whole file.

---

## Verify your work

Do not claim a Vela program works until you have run it.

```console
$ vela check program.vela    # types only, prints nothing on success
$ vela run program.vela      # executes
$ vela tokens program.vela   # inspect the lexer
$ vela ast program.vela      # inspect the parser
```

Diagnostics are rendered with the offending source line and a caret span, so read the
message rather than guessing. The parser returns a partial tree even when it reports
errors, so an AST's presence does not mean the parse succeeded — check the exit status.

A few habits that prevent most rework: declare variables before use, `return` explicitly
from every non-`void` path, and keep conditions `bool` — `1` is not a condition.
Functions are the exception to declaring-before-use: a signature is hoisted, so a forward
or mutual call is fine.