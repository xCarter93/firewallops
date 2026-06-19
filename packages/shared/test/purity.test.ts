import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Belt-and-suspenders for SIM-04: assert no source file under packages/shared/src
// imports a banned engine/network module. ESLint no-restricted-imports is the
// primary gate; this is a runtime backstop.
//
// The banned module specifiers are assembled from fragments at runtime so the
// literal strings never appear verbatim in this source file (which the
// negative-grep purity gate would otherwise flag).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

/** Build banned tokens from fragments so they never appear verbatim here. */
function bannedTokens(): string[] {
  const engine = "phas" + "er";
  const net = "coly" + "seus";
  const netScope = "@" + net + "/";
  const engineSub = engine + "/";
  return [engine, net, netScope, engineSub];
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("purity backstop (SIM-04)", () => {
  it("no source file under packages/shared/src references a banned engine/network module", () => {
    const tokens = bannedTokens();
    const files = tsFiles(SRC_DIR);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const token of tokens) {
        expect(
          content.includes(token),
          `${file} must not reference "${token}"`,
        ).toBe(false);
      }
    }
  });
});
