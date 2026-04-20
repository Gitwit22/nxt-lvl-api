import fs from "fs";
import express from "express";
import cors from "cors";
import { API_PREFIX, UPLOAD_DIR, getCorsOrigins } from "./config.js";
import { partitionMiddleware } from "./core/middleware/partition.middleware.js";
import { requireProgramSubscription } from "./core/middleware/subscriptionGate.middleware.js";
import { logger } from "./logger.js";
import { authRouter } from "./core/routes/auth.routes.js";
import { healthRouter } from "./core/routes/health.routes.js";
import { organizationRouter } from "./core/routes/organization.routes.js";
import { programRouter } from "./core/routes/program.routes.js";
import { adminRouter } from "./core/routes/admin.routes.js";
import { shellRouter } from "./core/routes/shell.routes.js";
import { portalRouter } from "./core/routes/portal.routes.js";
import { communityChronicleRouter } from "./programs/community-chronicle/routes/index.js";
import { nxtLvlSuiteRouter } from "./programs/nxt-lvl-suite/routes/index.js";
import { timeflowRouter } from "./programs/timeflow/routes/index.js";
import { missionHubRouter } from "./programs/mission-hub/routes/index.js";
import { metricsRouter } from "./core/routes/metrics.routes.js";

const app = express();

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.use(
  cors({
    origin: getCorsOrigins(),
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));

// Routers
app.use(`${API_PREFIX}/auth`, authRouter);
app.use(`${API_PREFIX}`, healthRouter);
app.use(`${API_PREFIX}/metrics`, metricsRouter);

// Partition middleware is global for program modules, but auth remains platform-wide.
app.use(partitionMiddleware);

app.use(`${API_PREFIX}`, programRouter);
app.use(`${API_PREFIX}/orgs`, organizationRouter);
app.use(`${API_PREFIX}/admin`, adminRouter);
app.use(`${API_PREFIX}`, shellRouter);
// LEGACY COMPAT SHIM: keep /api/portal/* aliases temporarily for older clients.
// TODO(compat-removal): remove this mount after all clients use /api/orgs/* endpoints.
app.use(`${API_PREFIX}/portal`, portalRouter);

app.use("/api/community-chronicle", communityChronicleRouter);
app.use("/api/nxt-lvl-suite", nxtLvlSuiteRouter);
app.use("/api/timeflow", timeflowRouter);
app.use("/api/mission-hub", requireProgramSubscription, missionHubRouter);

// Compatibility mount to preserve existing Community Chronicle endpoints.
app.use(`${API_PREFIX}`, communityChronicleRouter);

// Multer-specific error handler (file size / type rejections)
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && typeof err === "object" && "code" in err) {
    const multerErr = err as { code: string; message: string; status?: number };
    if (multerErr.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File exceeds maximum allowed size" });
      return;
    }
    if (multerErr.status === 415 || multerErr.code === "LIMIT_UNEXPECTED_FILE") {
      res.status(415).json({ error: multerErr.message || "Unsupported file type" });
      return;
    }
  }
  next(err);
});

// General error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown server error";
  logger.error("Unhandled route error", { error: message });
  res.status(500).json({ error: message });
});

export { app };




