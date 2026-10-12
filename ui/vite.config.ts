import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev proxy target: local compose daemon by default; the real server only via .env.local
// (TM_RPC_TARGET=http://host:9091, TM_RPC_AUTH=user:pass). Never commit a host.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "TM_");
  const target = env.TM_RPC_TARGET || "http://localhost:9091";
  const auth = env.TM_RPC_AUTH;
  return {
    plugins: [react()],
    base: "./",
    server: {
      port: 5173,
      proxy: {
        "/transmission/rpc": {
          target,
          changeOrigin: true,
          ...(auth ? { auth } : {}),
        },
      },
    },
    // Built straight into the Go embed directory, which also holds a tracked
    // .gitkeep so `//go:embed all:dist` always has something to embed.
    // emptyOutDir:true would delete it; the Makefile's fe-build clears the rest.
    build: { outDir: "../backend/dist", emptyOutDir: false, sourcemap: false },
    // Component tests render views and fire DOM events via @testing-library/react, so jsdom.
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      // ui/sim/ is the standalone fake daemon; its tests run here, but it stays out of the coverage
      // include below so the project floor keeps measuring the app itself.
      include: ["src/**/*.test.{ts,tsx}", "sim/**/*.test.ts"],
      coverage: {
        provider: "v8",
        // lcov is what ship reads (UI floor and patch gate, ship.yaml ui.lcov); text-summary for humans
        // reading the log.
        reporter: ["text-summary", "lcov"],
        reportsDirectory: "../coverage/ui",
        // Without an explicit include, v8 only instruments files some test imports, so an untested
        // module would be invisible and inflate the ratio.
        include: ["src/**/*.{ts,tsx}"],
        // Pure type declarations, app bootstrap and test scaffolding.
        exclude: [
          "src/main.tsx",
          "src/rpc/types.ts",
          "src/test/**",
          "**/*.test.{ts,tsx}",
        ],
      },
    },
  };
});
