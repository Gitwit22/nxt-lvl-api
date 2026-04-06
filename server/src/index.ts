import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { PORT, NODE_ENV, UPLOAD_DIR, CORS_ORIGIN, BACKEND_URL } from "./config.js";
import { startProcessingWorker, stopProcessingWorker } from "./processingQueue.js";
import { logger } from "./logger.js";

async function bootstrap() {
  await prisma.$connect();
  logger.info("Database connected");

  startProcessingWorker();

  app.listen(PORT, () => {
    logger.info("Community Chronicle API started", {
      port: PORT,
      env: NODE_ENV,
      uploadDir: UPLOAD_DIR,
      backendUrl: BACKEND_URL,
      corsOrigin: CORS_ORIGIN,
    });
  });
}

void bootstrap();

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