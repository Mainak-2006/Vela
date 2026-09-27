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

From a `.vsix` built in this repo:

```sh
cd editors/vscode
npx @vscode/vsce package
code --install-extension vela-language-0.1.0.vsix
```

## Language reference

| Category | Tokens |
| --- | --- |
| Declarations | `let`, `fn` |
| Control flow | `if`, `else`, `while`, `for`, `break`, `continue`, `return` |
| Builtins | `print` |
| Types | `number`, `string`, `bool`, `void` |
| Literals | `true`, `false` |
| Operators | `+` `-` `*` `/` `%` `!` `=` `==` `!=` `<` `<=` `>` `>=` `&&` `\|\|` |
| Punctuation | `(` `)` `{` `}` `,` `;` `:` |
| Comments | `//`, `/* */` (not nestable) |
| Numbers | `123`, `1_000_000`, `3.14`, `1.5e-3` |

Vela has no `[]` brackets — `[` is not even a token — so this extension deliberately
does not auto-close them.

## License

MIT. See [LICENSE](LICENSE).
