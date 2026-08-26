import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const adapter = (name: string): string =>
  fileURLToPath(new URL(`./adapters/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against source, so a clean checkout needs no build step.
    // Production resolution goes through each package's own `exports`.
    alias: {
      "@kairos/domain": pkg("domain"),
      "@kairos/detect": pkg("detect"),
      "@kairos/ledger": pkg("ledger"),
      "@kairos/policy": pkg("policy"),
      "@kairos/proof": pkg("proof"),
      "@kairos/reason": pkg("reason"),
      "@kairos/recover": pkg("recover"),
      "@kairos/terminus": pkg("terminus"),
      "@kairos/razorpay": adapter("razorpay"),
      "@kairos/simulator": adapter("simulator"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "adapters/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "adapters/*/src/**"],
      exclude: ["**/index.ts", "**/*.test.ts", "**/testing.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
