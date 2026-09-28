<!-- vela-skill-install: 0.1.2 -->

# Vela

A small, imperative, C-shaped, statically-typed language with a tree-walking
interpreter. Four primitives plus a function type, no inference, no collections,
no modules.

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

**Where the missing pieces went.** Almost every restriction below exists because
the thing it removes is also the thing that makes a program hard to read. When a
construct is missing, the answer is nearly always a two-line function you write
yourself, not a language feature. See *Recipes* below.

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

Every entry is a real feature in some other language, and every one is a compile
error here. Read this before assuming anything.

| You want to write | Why it fails | Do this instead |
| --- | --- | --- |
| `let x = 1;` | Types are mandatory | `let x: number = 1;` |
| `let y: number = i++;` | `++` has no value — it is a statement | `i++;` on its own line |
| `i + j++` | Same: no value to add | `i++;` then use `i` |
| `arrays[i] = x` | No collections exist | Flatten into `number`s, or fixed variables |
| `for (x of xs)`, `for (let x in xs)` | `for` has one C-style form | Three-part C `for`, or `while` with an index |
| `a ? b : c` | No ternary | `if (a) { b = 1; } else { b = 2; }` |
| `a ?? b`, `?.` | No optional chaining | `if (a != "") { ... }` |
| `fn f() {}` | Return type is mandatory | `fn f(): void { ... }` |
| `None`, `null`, `undefined`, `NaN` | Not nameable or constructible | Sentinel numbers (`0 - 1`, `-1`) with a documented meaning |
| `while (x) { ... }` | Conditions must be `bool` | `while (x != 0) { ... }` |
| `"a" < "b"` | Ordering is numeric-only | `==` and `!=` only; use `len(s)` for magnitude |
| `"a" + 1` | No coercion | `"a" + tostring(1)` |
| `import`, `require`, `use` | No modules | One file; the global scope is the only scope |
| `class`, `struct`, `enum`, `interface` | No user-defined types | Functions over primitives |
| generics `T`, `list<T>` | No generics | A function per element type |
| `public` / `private` / `static` | No access modifiers | Top-level `fn` is the whole API |
| `s.length`, `s.upper()`, `s.split()`, `s[i]` on a non-string | `len` and `s[i]` are all there is | `len(s)`, `s[i]`; build the rest with `+` |
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

**No collections.** There is no way to hold a list, so a string is the only thing
that can be indexed and `s[i]` is the only subscript. Anything over a sequence of
values has to be flattened into `number`s, one variable per slot. See *Recipes* for
what that looks like in practice.

---

## Built-ins

Exactly **thirteen callables** plus the `print` statement. No modules, no imports,
no other global name.

| Name | Signature | Behaviour |
| --- | --- | --- |
| `tostring(x)` | `(any) -> string` | Renders like `print`. Numbers never get a trailing `.0`. |
| `tonumber(s)` | `(any) -> number` | `Number(s)` for a string; `0` for a non-numeric string **and for any non-string argument**. Never fails. |
| `typeOf(x)` | `(any) -> string` | `"number"`, `"string"`, `"bool"`, `"void"`, `"function"`, or `"native"`. |
| `len(s)` | `(string) -> number` | UTF-16 code-unit count. A `number` argument is a compile error. |
| `trunc(x)` | `(number) -> number` | Toward zero, so `trunc(-2.7)` is `-2`. |
| `floor(x)` | `(number) -> number` | `floor(-2.7)` is `-3`. |
| `ceil(x)` | `(number) -> number` | `ceil(-2.7)` is `-2`. |
| `round(x)` | `(number) -> number` | Halves **away from zero**: `round(2.5)` is `3`, `round(-2.5)` is `-3`. |
| `abs(x)` | `(number) -> number` | `abs(-3)` is `3`. |
| `min(a, b)` | `(number, number) -> number` | |
| `max(a, b)` | `(number, number) -> number` | |
| `idiv(a, b)` | `(number, number) -> number` | Truncates toward zero, like `%`. Dividing by zero gives `0`. |
| `read()` | `() -> string` | One line of stdin, newline stripped. `""` at end of input. |

`print` adds a trailing newline. Printing `void` is a compile error.

`tostring` renders strings **unquoted**, so `tostring("1")` and `tostring(1)` both
give `"1"` — you cannot round-trip a type through it. Use `typeOf` for that.

Built-ins are first-class values, so `typeOf(tostring)` is `"native"`. They can
be shadowed inside a block; shadowing one at top level is an error.

---

## Semantics that surprise

**Numbers** are IEEE-754 doubles. Integer and fractional literals are the same
type.

| Operation | Semantics |
| --- | --- |
| `+ - *` | IEEE-754, so `0.1 + 0.2` is `0.30000000000000004` |
| `/` | **Always true division.** No integer division: `7 / 2` is `3.5`, and `7 / 2 * 2` is `7`, not `8`. |
| `%` | **Truncated remainder**, sign follows the *left* operand. `-7 % 2` is `-1`; `2 % 1.5` is `0.5`. |
| unary `-` | Negation, so `--1` is `1`. |
| `++`, `--` | Statements, not expressions. `i++` is sugar for `i = i + 1`. |
| `+=`, `-=`, `*=`, `/=`, `%=` | Sugar for `x = x <op> value`, with the same type rules. |

`%` is a remainder, not a mathematical modulus. That is what makes `trunc` below
work on negative numbers.

**A leading `--` is still a doubled negation.** `i--` decrements, because a name
comes first; `--1` is `1`, because nothing does. A statement ends in `;` or a
loop header's `)`, which is what tells the two apart.

**Strings** support `+` (concatenation, both operands `string`) and `==` / `!=`
(value comparison, not identity). Those two are the **only** comparisons that
work on strings — `<`, `<=`, `>`, `>=` require `number` operands, so `"abc" <
"abd"` is a compile error. Strings cannot be sorted. `len` counts UTF-16 code
units, so an emoji is `2`.

**`s[i]` reads one code unit** and returns a one-character `string`, so
`len(s[i])` is `1` and the usual `+` rules still apply. Indices are `0` through
`len(s) - 1`; anything else, negative included, is a runtime error. A `number`,
`bool`, or `void` cannot be indexed at all — there are no collections to index.
A surrogate pair occupies two indices, so an emoji read one half at a time gives
a broken character; the language has no code-point iteration to offer instead.

**Booleans** are `true`, `false`, `==`, `!=`, `&&`, `||`, `!`. No truthiness, no
coercion to a number.

**`&&` and `||` short-circuit** — a hard guarantee you can rely on for guards:

```vela
fn safeDiv(a: number, b: number): number {
    if (b != 0 && a / b > 1) { return a / b; }
    return 0;
}
```

**Scoping.** `let` and `fn` bind in the current block; lookup walks outward.
Assignment (`=`) writes to the *outermost* binding of that name and never creates
one. Calls get a fresh child scope. A `void` function that falls off the end
returns the `void` value, not `null`.

**Function signatures are hoisted.** Every `fn` in a block is visible before any
body in that block is checked, so forward references and mutual recursion work.
`let` is not hoisted, and a variable still has to be declared before use.

**Function values.** A variable of type `function` can hold any function, and can
be passed and returned. The cost is that the signature is not recorded, so a call
through one is unchecked: no arity check, and the result has no known type, which
is why `tostring` appears so often around one.

```vela
fn double(x: number): number { return x * 2; }

let f: function = double;
print(tostring(f(21)));   // 42, so the real function still applies at runtime
let n: number = 5;
let g: function = n;      // error: a number is not a function
print(f(1, 2, 3));         // accepted by the checker, then a runtime error
```

**Runtime errors that survive type checking:** `division by zero`, `remainder by
zero`, a non-`bool` condition, an out-of-range string index, and running past the
call-depth limit on runaway recursion. Everything else is caught before the
program starts.

---

## Recipes

### The numeric built-ins

`trunc`, `floor`, `ceil`, `round`, `abs`, `min`, `max`, and `idiv` are built-ins.
Do not define them: a top-level declaration that reuses a built-in's name is a
compile error, which is the same rule that stops you shadowing `tostring` at the
top level.

```vela
fn show(x: number): string {
    return "trunc " + tostring(trunc(x))
        + "  floor " + tostring(floor(x))
        + "  ceil " + tostring(ceil(x))
        + "  round " + tostring(round(x))
        + "  abs " + tostring(abs(x));
}
print(show(2.5));
print(show(0 - 2.5));
print("min/max: " + tostring(min(2, 7)) + " " + tostring(max(2, 7)));
print("idiv: " + tostring(idiv(17, 5)) + " " + tostring(idiv(0 - 17, 5)));
```

`trunc` rounds toward zero, so `trunc(-2.7)` is `-2` while `floor(-2.7)` is `-3`.
`round` rounds halves **away from zero**, so `round(2.5)` is `3` and
`round(-2.5)` is `-3`. `idiv` truncates toward zero like `%` does, so
`idiv(-17, 5)` is `-3`; dividing by zero gives `0`.

### The rest of the library

Everything below is still written by hand — there is no `sqrt`, no `pow`, and no
string library. These are the replacements.

All of this compiles and runs on the current implementation. The numeric toolkit
chains — `powInt`, `sqrt`, and `digits` all build on `trunc` — so define them in
this order.

```vela
fn powInt(base: number, e: number): number {
    let out: number = 1;
    for (let i: number = 0; i < e; i = i + 1) { out = out * base; }
    return out;
}

// No Math.sqrt, so iterate. Float equality would never terminate the loop,
// so the iteration count is fixed; 60 settles into a fixed point.
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

`powInt(2, 10)` is `1024`, `idiv(17, 5)` is `3`, `idiv(-17, 5)` is `-3` (toward
zero, like C), `sqrt(16)` is `4`.

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

`let` inside a `while` body is legal, and declaring the swap temporary inside the
loop is the idiomatic way to exchange two values without a third top-level name.

**Building strings.** Accumulating in a loop is the *only* way to build a string
of a computed length. Digits are extracted with `%` and **prepended**. A `for`
update can be `i++`, which is sugar for `i = i + 1`.

```vela
fn repeat(s: string, times: number): string {
    let out: string = "";
    for (let i: number = 0; i < times; i = i + 1) { out = out + s; }
    return out;
}

fn pad(s: string, width: number): string {
    let out: string = s;
    while (len(out) < width) { out = " " + out; }
    return out;
}
```

`"[" + repeat("ab", 3) + "]"` is `[ababab]`; `"[" + pad("7", 5) + "]"` is
`[    7]`.

**Formatting decimals.** Round to a whole count of tenths, then split. `fraction
< 0` is reachable because `%` follows the sign of the left operand.

```vela
fn oneDecimal(value: number): string {
    let tenths: number = round(value * 10);
    let whole: number = idiv(tenths, 10);
    let fraction: number = tenths % 10;
    if (fraction < 0) { fraction = 0 - fraction; }
    return tostring(whole) + "." + tostring(fraction);
}
```

**Looking inside a string.** `s[i]` makes per-character work possible. Reversal is
a loop that appends, a search is a loop that compares, and a substring is a slice
assembled with `+`.

```vela
fn reverse(s: string): string {
    let out: string = "";
    for (let i: number = 0; i < len(s); i = i + 1) { out = s[i] + out; }
    return out;
}

fn startsWith(pre: string, s: string): bool {
    if (len(pre) > len(s)) { return false; }
    for (let i: number = 0; i < len(pre); i = i + 1) {
        if (pre[i] != s[i]) { return false; }
    }
    return true;
}

fn substring(s: string, from: number, count: number): string {
    let out: string = "";
    for (let i: number = from; i < from + count; i = i + 1) { out = out + s[i]; }
    return out;
}
```

`reverse("abc")` is `cba`, `startsWith("hell", "hello")` is `true`, and
`substring("hello", 1, 3)` is `ell`. Case conversion is still not possible: there
is no way to map one character to another, only to compare them, so a
substitution table would have to be a chain of `if` statements over every
character you care about.

**Reading input.** `read()` returns one line, and `""` at end of input, so a loop
condition on an empty line is how "until the user is done" is written.

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

`read()` is for a **program run**, not a REPL session. The REPL's line editor has
already taken the terminal by the time an entry runs, so there is nothing left to
read and `read()` returns `""` there.

### Do not attempt these

They are impossible, not merely verbose. The workaround is the same: **flatten the
data into `number`s and loop**, or encode it as a base-256 integer and decode with
`% 256` and `idiv(x, 256)`.

- Case conversion. Characters can be read and compared but not mapped to new
  ones, so there is no `upper` or `lower` to write.
- Anything over a list of values. A string is a sequence, not a collection.
- Dispatch tables and function composition. A function value holds no signature,
  so there is nothing to build a table of.
- `try`/`catch`, error propagation, exception types.
- File, network, or time access. `print` and `read` are the only I/O.

### The rest of the standard library

`powInt`, `sqrt`, `gcd`, `digits`, `group` (thousands separators), `reverse`,
`startsWith`, `indexOf`, `substring`, `pad`, `repeat`, `oneDecimal`, and
`isPrime` live in the full reference, alongside the complete diagnostic
catalogue, the worked examples, and the compiler internals.

---

## The full reference

This file is the fast path. When you need more — the complete diagnostic
catalogue with exact messages, the full grammar and precedence table, worked
examples, the CLI and REPL, or the compiler architecture for extending Vela —
read it:

/home/mikey2006/CODING/PRODUCT/Compiler-Design/docs/SKILLS.md

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

Diagnostics are rendered with the offending source line and a caret span, so
read the message rather than guessing. The parser returns a partial tree even
when it reports errors, so the presence of an AST does not mean the parse
succeeded — check the exit status.

A few habits that prevent most rework: declare variables before use, `return`
explicitly from every non-`void` path, keep conditions `bool`, and remember that
`1` is not a condition. Functions are the exception to declaring-before-use: a
signature is hoisted, so a forward or mutual call is fine.
