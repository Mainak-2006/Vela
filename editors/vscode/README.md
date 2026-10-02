# Vela for Visual Studio Code

Language support for [Vela](https://github.com/Mainak-2006/Vela) — a small statically-typed
language and its compiler (lexer, parser, type checker, tree-walking interpreter).

## What you get

- **File icons** for `.vela` files, in both light and dark themes.
- **Syntax highlighting** for keywords, types, literals, operators, numbers, strings and comments.
- **Bracket matching and auto-closing** for `()` and `{}`.
- **Comment toggling** with `//` and `/* */`.

This extension is purely declarative — it contains no code, no build step and no
dependencies. Everything is contributed through the manifest.

## Install

From the Marketplace — search for `Vela by Mainak` in VS Code's Extensions view, or:

```sh
code --install-extension mainakkundu.vela-language
```

The listing is not called plain `Vela` because display names are unique across the
whole Marketplace, and an unrelated extension already holds that one. The
extension id is still `vela-language`, so the install command above never changes.

To install a local build instead, including one made from uncommitted changes:

```sh
cd editors/vscode
npx @vscode/vsce@4 package
code --install-extension vela-language-*.vsix
```

## Language reference

| Category | Tokens |
| --- | --- |
| Declarations | `let`, `const`, `fn`, `struct` |
| Control flow | `if`, `else`, `while`, `for`, `break`, `continue`, `return` |
| Builtins | `print`, `tostring`, `tonumber`, `typeOf`, `len`, `trunc`, `floor`, `ceil`, `round`, `abs`, `min`, `max`, `idiv`, `read`, `upper`, `lower`, `trim`, `startsWith`, `endsWith`, `indexOf`, `substr`, `repeat`, `replace`, `append` |
| Types | `number`, `string`, `bool`, `void`, `function` |
| Literals | `true`, `false`, `null` |
| Operators | `+` `-` `*` `/` `%` `!` `=` `==` `!=` `<` `<=` `>` `>=` `&&` `\|\|` `++` `--` `+=` `-=` `*=` `/=` `%=` `->` `?` |
| Punctuation | `(` `)` `{` `}` `[` `]` `,` `;` `:` |
| Comments | `//`, `/* */` (not nestable) |
| Numbers | `123`, `1_000_000`, `3.14`, `1.5e-3` |

`?` is the nullable suffix on a type — `number?`, `Node?`, `number?[]` — not a
ternary, and Vela has no `?.` or `??`. It also marks an optional struct field when
it follows the field's *name* — `label?: string` — so the same character is
highlighted in both positions.

`[` and `]` are array brackets: a literal `[1, 2]`, a type `number[]`, or an index
`xs[0]`. They highlight, but the extension does not auto-close them: `[` opens on
both of the first two, and auto-closing an index would fight the type bracket.

## License

MIT. See [LICENSE](LICENSE).
