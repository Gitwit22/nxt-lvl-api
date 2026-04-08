import type { NextFunction, Request, Response } from "express";
import { CURRENT_PROGRAM_DOMAIN } from "../config/env.js";
import { getProgramDefinition, programs, type ProgramDefinition } from "../config/programs.js";

export interface RequestProgramContext {
  key: string;
  definition: ProgramDefinition;
}

export function getRequestProgram(req: Request): RequestProgramContext | undefined {
  return (req as unknown as { _program?: RequestProgramContext })._program;
}

function setRequestProgram(req: Request, program: RequestProgramContext): void {
  (req as unknown as { _program: RequestProgramContext })._program = program;
}

export function resolveProgramKey(headerValue?: string): string {
  if (!headerValue) return CURRENT_PROGRAM_DOMAIN;
  return headerValue.trim().toLowerCase();
}

export function partitionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue =
    typeof req.headers["x-app-partition"] === "string"
      ? req.headers["x-app-partition"]
      : undefined;

  const programKey = resolveProgramKey(headerValue);
  const definition = getProgramDefinition(programKey);

  if (!definition) {
    res.status(400).json({
      error: "Invalid X-App-Partition",
      supportedPrograms: Object.keys(programs),
    });
    return;
  }

  setRequestProgram(req, {
    key: programKey,
    definition,
  });
  next();
}
