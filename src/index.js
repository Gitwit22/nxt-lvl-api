import "dotenv/config";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { PORT } from "./config.js";
import { startProcessingWorker, stopProcessingWorker } from "./processingQueue.js";
import { logger } from "./logger.js";
async function bootstrap() {
    await prisma.$connect();
    startProcessingWorker();
    app.listen(PORT, () => {
        logger.info(`Community Chronicle API running on http://localhost:${PORT}`);
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
