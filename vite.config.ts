import { defineConfig, type Plugin } from "vite";

// Prototype routes are real paths, so a deep link or a reload has to land on
// index.html rather than a 404.
function spaFallback(): Plugin {
  return {
    name: "spa-fallback",
    configureServer(server) {
      return () => {
        server.middlewares.use((req, _res, next) => {
          if (req.headers.accept?.includes("text/html") && req.url) {
            req.url = "/index.html";
          }
          next();
        });
      };
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [spaFallback()],
  root: "packages/frontend",  base: "/",
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
