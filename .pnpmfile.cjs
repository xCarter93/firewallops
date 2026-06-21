// pnpm dependency-resolution hook.
//
// Why this exists:
// pnpm 11's `blockExoticSubdeps` (default ON) refuses to install git/tarball-
// resolved *transitive* deps. The `colyseus` meta-package hard-depends on
// `@colyseus/uwebsockets-transport`, which in turn depends on `uWebSockets.js`
// — a native lib distributed ONLY via a GitHub tarball (uNetworking). Any time
// the lockfile is re-resolved (e.g. adding a dependency) pnpm tries to fetch
// that git tarball and aborts with ERR_PNPM_EXOTIC_SUBDEP.
//
// We never use the uWebSockets transport — the server runs @colyseus/ws-transport,
// and colyseus loads the uWS transport lazily, only if explicitly instantiated.
// In fact uWebSockets.js has never been materialized in node_modules and the
// deployed server works fine without it. So we surgically drop just that one
// git dep from the unused transport. This keeps the supply-chain policy ON for
// everything else and avoids pulling an unused native package into the image.
function readPackage(pkg) {
  if (
    pkg.name === '@colyseus/uwebsockets-transport' &&
    pkg.dependencies &&
    pkg.dependencies['uWebSockets.js']
  ) {
    delete pkg.dependencies['uWebSockets.js'];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
