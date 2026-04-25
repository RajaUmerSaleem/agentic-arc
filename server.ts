import path from "path";
import fs from "fs";
import express from "express";
import { fileURLToPath } from "url";
import { createApiApp } from "./api/app";

export { createApiApp };

async function startServer() {
  const app = createApiApp();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (process.env.NODE_ENV === "production" && !fs.existsSync(path.join(process.cwd(), "dist"))) {
      console.warn("WARNING: Server started in PRODUCTION mode but 'dist' directory is missing!");
    }
  });
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === path.resolve(currentFilePath);
})();

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
