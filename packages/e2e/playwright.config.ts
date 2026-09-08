import { defineConfig } from "@playwright/test";

const backendPort = Number(process.env.TEST_BACKEND_PORT ?? 3100);
const frontendPort = Number(process.env.TEST_FRONTEND_PORT ?? 5174);
const backendUrl = `http://127.0.0.1:${backendPort}`;

// The smoke spec is the only one that reaches the real API, so the backend is
// only booted when a key is available.
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    actionTimeout: 5_000,
  },
  webServer: [
    ...(hasApiKey
      ? [
          {
            command: "node app.ts",
            cwd: "../backend",
            env: {
              PORT: String(backendPort),
              APP_PASSWORD: process.env.APP_PASSWORD ?? "test-password",
            },
            port: backendPort,
            reuseExistingServer: false,
            timeout: 60_000,
          },
        ]
      : []),
    {
      command: "vite",
      cwd: "../..",
      env: { VITE_PORT: String(frontendPort), API_TARGET: backendUrl },
      port: frontendPort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
