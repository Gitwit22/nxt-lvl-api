import express from "express";

const router = express.Router();

router.get("/run", (_req, res) => {
  res.json({ ok: true });
});

export { router as shellRouter };
