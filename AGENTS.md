<!-- vela-skill-install: 0.1.1 -->

# Vela

A small, imperative, C-shaped, statically-typed language with a tree-walking
interpreter. Four types, no inference, no collections, no modules.

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

4. **Functions are declared before use.** A function's own name is in scope
   inside its body, so recursion works — but forward references do not, so mutual
   recursion is a compile error. Collapse both directions into one function with a
   mode parameter, or restructure so only one direction is needed.

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
| `x++`, `x--`, `x += 1` | No compound assignment | `x = x + 1;` |
| `a[i]`, indexing | `[` is not even a token — lex error | Restructure, or loop over a counter |
| arrays, lists, `a[i] = x` | No collections exist | A function + recursion, or fixed variables |
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
| `s.length`, `s.upper()`, `s.split()` | `len` is the only string function | `len(s)`; build the rest with `+` and `==` |
| `Math.sqrt`, `abs`, `min`, `max`, `floor`, `round`, `pow` | No math library | Write them — see *Recipes* |
| `f(1,)` trailing comma | Not accepted | `f(1)` |
| `'single quotes'` | Double quotes only | `"double quotes"` |
| `f"text {x}"`, backtick templates | No interpolation at all | `"text " + tostring(x)` |
| raw strings, multi-line strings | A newline inside a string is an error | `+ "\n" +` |
| `#` comments | `//` and `/* */` only | |
| bitwise `& \| ^ ~ << >>` | Not in the vocabulary | `/ % 2` and a boolean, or recursion |
| `**` | No exponentiation operator | A `for` loop multiplying |
| `try` / `catch` / `throw` | No exceptions to catch | Validate inputs up front, return a sentinel |
| `stdin`, `input()`, files, time, random | `print` is the only I/O | |

### Two that constrain program *design*, not just syntax

**No indexing means no character access.** A string can be built with `+` and
measured with `len`, but never taken apart. String reversal, case conversion,
substring search, and per-character processing are **impossible**, not merely
awkward. Don't try — you'll loop forever or produce wrong answers.

**No function values.** A function can be called by name but never stored,
passed, or returned. Higher-order functions, callbacks, and function tables do
not exist. To vary behaviour, branch on a `bool` or an integer tag.

---

## Built-ins

Exactly **four callables** plus the `print` statement. No modules, no imports,
no other global name.

| Name | Signature | Behaviour |
| --- | --- | --- |
| `tostring(x)` | `(any) -> string` | Renders like `print`. Numbers never get a trailing `.0`. |
| `tonumber(s)` | `(any) -> number` | `Number(s)` for a string; `0` for a non-numeric string **and for any non-string argument**. Never fails. |
| `typeOf(x)` | `(any) -> string` | `"number"`, `"string"`, `"bool"`, `"void"`, `"function"`, or `"native"`. |
| `len(s)` | `(string) -> number` | UTF-16 code-unit count. A `number` argument is a compile error. |

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

`%` is a remainder, not a mathematical modulus. That is what makes `trunc` below
work on negative numbers.

**Strings** support `+` (concatenation, both operands `string`) and `==` / `!=`
(value comparison, not identity). Those two are the **only** comparisons that
work on strings — `<`, `<=`, `>`, `>=` require `number` operands, so `"abc" <
"abd"` is a compile error. Strings cannot be sorted. `len` counts UTF-16 code
units, so an emoji is `2`.

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

**Only three runtime errors survive type checking:** `division by zero`,
`remainder by zero`, and `expected a 'bool' condition, but got 'number'`. Plus
scope failures. Everything else is caught before the program starts.

---

## Recipes

The replacements for the missing library. All of this compiles and runs on the
current implementation. The numeric toolkit chains — `floor`, `ceil`, `round`,
`idiv`, and `digits` all call `trunc` — so define them in this order.

```vela
fn trunc(x: number): number {
    if (x >= 0) { return x - (x % 1); }
    return x + ((0 - x) % 1);
}

fn abs(x: number): number { if (x < 0) { return 0 - x; } return x; }
fn min(a: number, b: number): number { if (a <= b) { return a; } return b; }
fn max(a: number, b: number): number { if (a >= b) { return a; } return b; }
fn idiv(a: number, b: number): number { return trunc(a / b); }
```

`trunc(2.7)` is `2`, `trunc(-2.7)` is `-2` — it rounds toward zero.

```vela
fn floor(x: number): number {
    let t: number = trunc(x);
    if (t == x) { return t; }
    if (x < 0) { return t - 1; }
    return t;
}

fn ceil(x: number): number {
    let t: number = trunc(x);
    if (t == x) { return t; }
    if (x > 0) { return t + 1; }
    return t;
}

fn round(x: number): number {
    if (x >= 0) { return trunc(x + 0.5); }
    return trunc(x - 0.5);
}
```

`floor(2.7)` is `2`, `floor(-2.7)` is `-3`, `round(2.5)` is `3`, `round(-2.5)` is
`-3` (half away from zero).

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
of a computed length. Digits are extracted with `%` and **prepended**.

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

### Do not attempt these

They are impossible, not merely verbose. The workaround for all of them is the
same: **flatten the data into `number`s and loop**, or encode it as a base-256
integer and decode with `% 256` and `idiv(x, 256)`.

- Character-by-character string processing — reverse, case conversion,
  per-character search, substring extraction, character comparison.
- Anything over a list of values.
- Higher-order functions, callbacks, dispatch tables, function composition.
- `try`/`catch`, error propagation, exception types.
- File, network, time, randomness, or stdin access.

### The rest of the standard library

`digits`, `group` (thousands separators), `isPrime`, and a general `format`
live in the full reference, alongside the complete diagnostic catalogue, the
worked examples, and the compiler internals.

---

## The full reference

This file is the fast path. When you need more — the complete diagnostic
catalogue with exact messages, the full grammar and precedence table, worked
examples, the CLI and REPL, or the compiler architecture for extending Vela —
read it:

/home/mikey2006/CODING/PRODUCT/Compiler-Design/docs/SKILLS.md

It is roughly 59 KB. Read the sections you need rather than the whole file.

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
`1` is not a condition.
