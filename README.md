# Nxt Lvl Platform API

This repository is now a backend-only service. It preserves the platform API foundation, authentication flow, Prisma setup, partition middleware, Community Chronicle backend module, and the Nxt Lvl Suite scaffold.

## Service scope

- Express API entrypoints live in `src/app.ts` and `src/index.ts`.
- Core platform modules live under `src/core`.
- Program backends live under `src/programs`.
- Prisma schema and generated client configuration live under `prisma/`.
- File uploads remain on disk under `uploads/`.

## Included backend modules

- Community Chronicle routes, document workflows, queue processing, and seed data.
- Platform authentication routes and middleware.
- Global partition middleware and program registry.
- Nxt Lvl Suite scaffold route.

## Local setup

Prerequisites:
- Node.js 20+
- npm 10+
- Postgres 14+

Run locally:

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma db push
npm run dev
```

The API listens on `http://localhost:4000` by default.

## Common commands

```bash
npm run dev
npm run build
npm run start
npm run test
npm run lint
npm run prisma:generate
npm run prisma:push
```

## Health check

The service exposes `GET /api/health` and verifies database reachability before returning `ok: true`.
