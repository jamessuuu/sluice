/**
 * The platform contract — the ONLY ambient globals @jamessuuu/sluice core
 * relies on. All are available in Node >= 22, browsers, and Web Workers.
 * The package tsconfig sets `types: []` and lib ES2023, so anything not
 * declared here fails typecheck: this file IS the list, enforced.
 *
 * (Node-builtin imports are additionally banned by an ESLint rule; tests
 * typecheck under tsconfig.test.json with full node types and may use them.)
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle: number | undefined): void;
