/**
 * The environment — a chain of lexical scopes.
 *
 * A name lookup walks outward from the innermost scope until it finds a match,
 * which is exactly what gives Vela block scoping for free. Two operations are
 * deliberately distinct:
 *
 *   - `define` always writes to *this* scope, so `let` inside a block creates a
 *     new binding that shadows any outer one.
 *   - `assign` walks the chain and writes to wherever the name was found, so `x = 1`
 *     inside a block updates the outer `x` rather than creating a new one.
 *
 * Conflating those two is the classic bug in a hand-written interpreter, so they
 * are separate methods with separate names.
 */

import type { Value } from "./values.js";

export class Environment {
  private readonly values = new Map<string, Value>();
  /** Names already bound here, kept in insertion order for stable listings. */
  readonly names: string[] = [];
  /**
   * Bindings that `clear` must not remove. The built-ins are permanent: they are
   * part of the language rather than part of a program's state, so a REPL `.reset`
   * that dropped them would leave the session permanently broken.
   */
  private readonly permanent = new Set<string>();

  constructor(readonly parent: Environment | null) {}

  /** Create a child scope whose lookups fall back to this one. */
  child(): Environment {
    return new Environment(this);
  }

  /** Bind `name` in *this* scope, shadowing any outer binding. */
  define(name: string, value: Value): void {
    if (!this.values.has(name)) this.names.push(name);
    this.values.set(name, value);
  }

  /** Look up `name` here, then outward. Returns undefined if unbound anywhere. */
  get(name: string): Value | undefined {
    for (let scope: Environment | null = this; scope; scope = scope.parent) {
      const found = scope.values.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * Update an existing binding wherever it lives, or return false if the name is
   * not bound at all. Never creates a binding: a bare assignment to an unknown
   * name is a mistake, not a declaration.
   */
  assign(name: string, value: Value): boolean {
    for (let scope: Environment | null = this; scope; scope = scope.parent) {
      if (scope.values.has(name)) {
        scope.values.set(name, value);
        return true;
      }
    }
    return false;
  }

  isDefined(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /**
   * Bind `name` permanently: it survives `clear`. Reserved for the built-ins.
   */
  definePermanent(name: string, value: Value): void {
    this.define(name, value);
    this.permanent.add(name);
  }

  /**
   * Remove every non-permanent binding in this scope, so the REPL's `.reset` can
   * start over without discarding the built-ins. Child scopes are unaffected, so
   * this is only meaningful on a global scope.
   */
  clear(): void {
    for (const name of this.names) {
      if (!this.permanent.has(name)) this.values.delete(name);
    }
    this.names.length = 0;
    for (const name of this.permanent) this.names.push(name);
  }

  /** The scope that binds `name`, or null. Useful for tracing. */
  findScope(name: string): Environment | null {
    for (let scope: Environment | null = this; scope; scope = scope.parent) {
      if (scope.values.has(name)) return scope;
    }
    return null;
  }
}
