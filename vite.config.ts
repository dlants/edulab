import { defineConfig } from "vite";

export default defineConfig({
  root: "packages/frontend",
  base: "/",
  build: {
    target: "esnext",
    outDir: "dist",
    minify: true,
  },
  server: {
    host: "localhost",
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api/": {
        target: process.env.API_TARGET ?? "http://localhost:3000",
        secure: false,
        ws: true,
      },
    },
  },
});
