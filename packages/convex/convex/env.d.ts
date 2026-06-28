/**
 * Convex exposes `process.env` at runtime for reading environment variables
 * (https://docs.convex.dev/production/environment-variables). The Convex V8
 * runtime is NOT Node, so we declare ONLY `process.env` here rather than pulling
 * in `@types/node` — which would falsely surface `fs`/`path`/etc. that do not
 * exist in the Convex runtime and invite code that fails at deploy time.
 *
 * Consumed by `auth.config.ts` (`CLERK_JWT_ISSUER_DOMAIN`). `.d.ts` files are not
 * registered as Convex functions, so this is type-only and never deployed.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
