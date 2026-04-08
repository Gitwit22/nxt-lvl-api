#!/usr/bin/env node

/**
 * Real end-to-end smoke test for Community Chronicle
 *
 * What it verifies:
 * - Login/auth endpoint is real
 * - Upload endpoint accepts a real file
 * - Returned document is persisted with a unique test marker
 * - Document can be fetched back from API
 * - Processing status changes from uploaded/processing to completed/reviewable (or at least exists and is not mock)
 * - Extracted text / metadata includes the unique marker
 *
 * Usage:
 *   BASE_URL=http://localhost:4000 \
 *   TEST_EMAIL=admin@example.com \
 *   TEST_PASSWORD=yourpassword \
 *   node scripts/smoke-test-document-chain.mjs
 *
 * Optional:
 *   DOCUMENTS_ROUTE=/api/documents
 *   LOGIN_ROUTE=/api/auth/login
 *   POLL_SECONDS=60
 */

import fs from "fs";
import os from "os";
import path from "path";

const BASE_URL = process.env.BASE_URL || "http://localhost:4000";
const LOGIN_ROUTE = process.env.LOGIN_ROUTE || "/api/auth/login";
const DOCUMENTS_ROUTE = process.env.DOCUMENTS_ROUTE || "/api/documents";
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);

if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Missing TEST_EMAIL or TEST_PASSWORD");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function logStep(message) {
  console.log(`\n=== ${message} ===`);
}

function fail(message, extra) {
  console.error(`\n❌ ${message}`);
  if (extra) {
    console.error(extra);
  }
  process.exit(1);
}

function pass(message) {
  console.log(`✅ ${message}`);
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function getAuthToken(payload) {
  return (
    payload?.token ||
    payload?.accessToken ||
    payload?.jwt ||
    payload?.data?.token ||
    payload?.data?.accessToken ||
    null
  );
}

function getDocumentId(payload) {
  return (
    payload?.id ||
    payload?.document?.id ||
    payload?.data?.id ||
    payload?.data?.document?.id ||
    null
  );
}

function getDocumentStatus(payload) {
  return (
    payload?.status ||
    payload?.document?.status ||
    payload?.data?.status ||
    payload?.data?.document?.status ||
    null
  );
}

function extractDocumentList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.documents)) return payload.data.documents;
  return [];
}

function makeTestFile(marker) {
  const content = `
COMMUNITY CHRONICLE REAL SMOKE TEST
Marker: ${marker}

This file exists to prove the upload, persistence, and retrieval chain is real.
If this marker comes back from the API later, the system is not serving mock data.
`.trim();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-vault-smoke-"));
  const filePath = path.join(tmpDir, `smoke-test-${marker}.txt`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function main() {
  const marker = `REAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testFilePath = makeTestFile(marker);
  const filename = path.basename(testFilePath);

  logStep("1. Logging in");
  const loginRes = await fetch(`${BASE_URL}${LOGIN_ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }),
  });

  if (!loginRes.ok) {
    fail(`Login failed with status ${loginRes.status}`, await loginRes.text());
  }

  const loginPayload = await safeJson(loginRes);
  const token = getAuthToken(loginPayload);

  if (!token) {
    fail("Login succeeded but no auth token was returned", loginPayload);
  }
  pass("Real auth login succeeded");

  logStep("2. Uploading a real file");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(testFilePath)]), filename);
  form.append("title", `Smoke Test ${marker}`);
  form.append("description", `End-to-end verification ${marker}`);

  const uploadRes = await fetch(`${BASE_URL}${DOCUMENTS_ROUTE}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  if (!uploadRes.ok) {
    fail(
      `Upload failed with status ${uploadRes.status}`,
      await uploadRes.text()
    );
  }

  const uploadPayload = await safeJson(uploadRes);
  const documentId = getDocumentId(uploadPayload);
  const initialStatus = getDocumentStatus(uploadPayload);

  if (!documentId) {
    fail("Upload response did not return a real document id", uploadPayload);
  }

  pass(`Upload created real document id: ${documentId}`);
  console.log(`Initial status: ${initialStatus ?? "unknown"}`);

  logStep("3. Fetching uploaded document directly");
  const getDocRes = await fetch(
    `${BASE_URL}${DOCUMENTS_ROUTE}/${documentId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!getDocRes.ok) {
    fail(
      `Fetch-by-id failed with status ${getDocRes.status}`,
      await getDocRes.text()
    );
  }

  const getDocPayload = await safeJson(getDocRes);
  const fetchedId =
    getDocPayload?.id ||
    getDocPayload?.document?.id ||
    getDocPayload?.data?.id ||
    getDocPayload?.data?.document?.id;

  if (!fetchedId || String(fetchedId) !== String(documentId)) {
    fail("Fetched document did not match uploaded document id", getDocPayload);
  }

  pass("Uploaded document was fetched back from API");

  logStep("4. Verifying it exists in list results too");
  const listRes = await fetch(`${BASE_URL}${DOCUMENTS_ROUTE}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!listRes.ok) {
    fail(
      `List documents failed with status ${listRes.status}`,
      await listRes.text()
    );
  }

  const listPayload = await safeJson(listRes);
  const docs = extractDocumentList(listPayload);
  const listedDoc = docs.find((d) => String(d.id) === String(documentId));

  if (!listedDoc) {
    fail(
      "Uploaded document is not present in document list response",
      listPayload
    );
  }

  pass("Uploaded document is present in real list response");

  logStep("5. Polling for processing completion / extraction");
  const deadline = Date.now() + POLL_SECONDS * 1000;
  let lastDoc = null;

  while (Date.now() < deadline) {
    const pollRes = await fetch(
      `${BASE_URL}${DOCUMENTS_ROUTE}/${documentId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!pollRes.ok) {
      fail(
        `Polling failed with status ${pollRes.status}`,
        await pollRes.text()
      );
    }

    const pollPayload = await safeJson(pollRes);
    lastDoc =
      pollPayload?.document ||
      pollPayload?.data?.document ||
      pollPayload?.data ||
      pollPayload;

    const status = lastDoc?.status || "unknown";
    const extractedText =
      lastDoc?.extractedText ||
      lastDoc?.text ||
      lastDoc?.content ||
      lastDoc?.ocrText ||
      "";

    console.log(`Polling status: ${status}`);

    if (
      ["completed", "processed", "reviewable", "ready"].includes(
        String(status).toLowerCase()
      )
    ) {
      pass(`Document reached final-ish status: ${status}`);

      if (typeof extractedText === "string" && extractedText.includes(marker)) {
        pass("Unique marker found in extracted text/content");
      } else {
        console.warn(
          "⚠️ Final status reached, but unique marker was not found in extracted text/content fields."
        );
        console.warn(
          "That may mean extraction is not wired yet, or the API is not returning extracted text."
        );
      }

      break;
    }

    if (["failed", "error"].includes(String(status).toLowerCase())) {
      fail("Processing ended in failed/error state", lastDoc);
    }

    await sleep(3000);
  }

  if (!lastDoc) {
    fail("Polling never retrieved document details");
  }

  logStep("6. Final anti-mock checks");
  const title = lastDoc?.title || lastDoc?.name || "";
  const description = lastDoc?.description || "";
  const combined = JSON.stringify(lastDoc);

  if (
    !title.includes(marker) &&
    !description.includes(marker) &&
    !combined.includes(marker)
  ) {
    fail(
      "Uploaded marker did not come back anywhere in the returned document data. This smells like mock or disconnected persistence.",
      lastDoc
    );
  }

  pass("Marker came back from stored data");
  pass(
    "Smoke test passed: auth, upload, fetch, list, and persistence are all real"
  );

  console.log("\n🔥 REAL CHAIN VERIFIED");
  console.log(`Document ID: ${documentId}`);
  console.log(`Marker: ${marker}`);
}

main().catch((err) => {
  fail("Unhandled script error", err?.stack || err);
});
