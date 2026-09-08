import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHighEntropyPng, withExifOrientation } from "../../src/test/high-entropy-png";

test("compresses the actual browser upload body and serves a bounded image", async ({ page }) => {
  await openFixtureTask(page);
  const original = createHighEntropyPng();
  expect(original.byteLength).toBeGreaterThan(1_000_000);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/images") && response.request().method() === "POST");
  await page.getByLabel("添加图片").setInputFiles({ name: "browser-noise.png", mimeType: "image/png", buffer: original });
  await expect(page.getByText(/大于 1 MB.*静态传输副本/)).toBeVisible();
  await page.getByRole("button", { name: "Send" }).click();

  const uploadResponse = await responsePromise;
  expect(uploadResponse.status()).toBe(201);
  const uploaded = await uploadResponse.json() as { id: string; size: number };
  expect(uploaded.size).toBeLessThanOrEqual(1_000_000);
  const downloaded = await page.request.get(`/api/images/${uploaded.id}`);
  expect(downloaded.status()).toBe(200);
  expect((await downloaded.body()).byteLength).toBeLessThanOrEqual(1_000_000);
});

test("keeps an EXIF-rotated camera JPEG portrait through the browser codec", async ({ page }) => {
  await openFixtureTask(page);
  const original = orientedCameraJpeg();
  expect(original.byteLength).toBeGreaterThan(1_000_000);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/images") && response.request().method() === "POST");
  await page.getByLabel("添加图片").setInputFiles({ name: "camera.jpg", mimeType: "image/jpeg", buffer: original });
  await page.getByRole("button", { name: "Send" }).click();

  const uploadResponse = await responsePromise;
  const uploaded = await uploadResponse.json() as { id: string; size: number };
  expect(uploaded.size).toBeLessThanOrEqual(1_000_000);
  const downloaded = await page.request.get(`/api/images/${uploaded.id}`);
  expect(downloaded.status()).toBe(200);
  const output = temporaryDirectory();
  try {
    const jpeg = join(output, "browser-transfer.jpg");
    const bitmap = join(output, "browser-transfer.bmp");
    writeFileSync(jpeg, await downloaded.body());
    execFileSync("/usr/bin/sips", ["-s", "format", "bmp", jpeg, "--out", bitmap]);
    const bytes = readFileSync(bitmap);
    const width = Math.abs(bytes.readInt32LE(18));
    const height = Math.abs(bytes.readInt32LE(22));
    expect(width).toBeLessThan(height);
    expect(height / width).toBeCloseTo(2_200 / 1_400, 2);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

async function openFixtureTask(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /codex-fixture.*\d+ 个对话/ }).click();
  await page.getByRole("button", { name: /^Fixture task，/ }).click();
  await page.getByRole("textbox", { name: "Instruction" }).click();
}

function orientedCameraJpeg() {
  const root = temporaryDirectory();
  try {
    const png = join(root, "camera.png");
    const jpeg = join(root, "camera.jpg");
    writeFileSync(png, createHighEntropyPng());
    execFileSync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", png, "--out", jpeg]);
    return withExifOrientation(readFileSync(jpeg), 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "codex-image-e2e-"));
}
