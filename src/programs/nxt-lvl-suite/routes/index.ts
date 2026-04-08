import express from "express";

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    program: "Nxt Lvl Suite",
    status: "scaffolded",
  });
});

export { router as nxtLvlSuiteRouter };
