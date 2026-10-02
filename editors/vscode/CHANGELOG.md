# Changelog

## 0.2.0

- Highlight the `const` keyword.
- Highlight all twenty-three built-ins, which were not distinguished from ordinary
  calls before, including the nine new string functions and `append`.
- Highlight the `->` of a written function signature.
- Highlight array literals and array types. The brackets were already highlighted
  as punctuation, so `T[]` and `[1, 2]` inherit that; there is nothing to add for
  indexing syntax, which uses the same punctuation.
- Highlight the `null` literal, alongside `true` and `false`.
- Highlight the `?` of a nullable type, as its own operator scope so that `T?` and
  `T[]?` read as a type rather than as a question mark.
- Highlight the `struct` keyword.
- Highlight the `?` of an optional field. It reuses the nullable scope, since it is
  the same character doing the same job — `label?: string` and `next: Node?` are two
  different uses of one token, and a separate colour would suggest a distinction the
  language does not make.

## 0.1.0

Initial release.

- Register `.vela` as the `vela` language.
- Contribute light and dark file icons derived from the Vela wordmark.
- Add a TextMate grammar covering keywords, types, literals, operators, numbers,
  strings and comments.
- Add bracket matching, auto-closing pairs and comment configuration.
