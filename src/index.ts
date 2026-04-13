import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { PORT, NODE_ENV, UPLOAD_DIR, CORS_ORIGIN, BACKEND_URL, PLATFORM_DISPLAY_NAME } from "./config.js";
import { STORAGE_BACKEND } from "./core/config/env.js";
import { startProcessingWorker, stopProcessingWorker } from "./processingQueue.js";
import { logger } from "./logger.js";

async function canStartProcessingWorker(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM "ProcessingJob" LIMIT 1');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ProcessingJob") && message.includes("does not exist")) {
      logger.warn("Processing worker disabled because queue tables are not migrated yet");
      return false;
    }
    throw err;
  }
}

async function bootstrap() {
  await prisma.$connect();
  logger.info("Database connected");

  if (await canStartProcessingWorker()) {
    startProcessingWorker();
  }

  app.listen(PORT, () => {
    logger.info(`${PLATFORM_DISPLAY_NAME} started`, {
      port: PORT,
      env: NODE_ENV,
      storage: STORAGE_BACKEND,
      uploadDir: STORAGE_BACKEND === "local" ? UPLOAD_DIR : undefined,
      backendUrl: BACKEND_URL,
      corsOrigin: CORS_ORIGIN,
    });
  });
}

void bootstrap().catch((err) => {
  logger.error("Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

process.on("SIGINT", async () => {
  stopProcessingWorker();
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  stopProcessingWorker();
  await prisma.$disconnect();
  process.exit(0);
});