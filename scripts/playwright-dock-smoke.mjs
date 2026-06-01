#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const port = 1420;
const baseUrl = `http://localhost:${port}/`;
const screenshotPath = resolve(repoRoot, "output/playwright/dock-smoke.png");

const server = spawn("pnpm", ["dev"], {
  cwd: repoRoot,
  env: { ...process.env, NOCTURNE_DEV_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

async function main() {
  await waitForServer(baseUrl, 30_000);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      throw new Error(`browser console error: ${message.text()}`);
    }
  });

  await page.goto(baseUrl);
  await page.getByTestId("tool-slot-slot-files-demo").waitFor();
  await page.getByTestId("tool-slot-slot-terminal-demo").waitFor();
  await page.getByTestId("tool-slot-slot-transfers-demo").waitFor();
  await page.getByTestId("files-demo-placeholder").waitFor();
  await page.getByTestId("transfers-demo-placeholder").waitFor();

  await dragCenterToCenter(page, "tool-slot-slot-terminal-demo", "dock-group-group-files-demo");
  await expectSlotInsideGroup(page, "slot-terminal-demo", "group-files-demo");
  await expectSlotCount(page, "slot-terminal-demo", 1);

  await dragCenterToCenter(page, "tool-slot-slot-files-demo", "workspace-tab-workspace-remote-demo");
  await page.getByTestId("workspace-tab-workspace-remote-demo").click();
  await page.waitForFunction(() => {
    const remoteGroup = document.querySelector('[data-dock-group-id="group-files-remote-demo"]');
    return Boolean(remoteGroup?.querySelector('[data-tool-slot-id^="slot-mirror-"]'));
  });
  await expectMirrorBadge(page, "Local Shell");

  await page.getByTestId("workspace-tab-workspace-demo").click();
  await page.getByTestId("tool-slot-slot-transfers-demo").waitFor();
  await dragToPoint(page, "tool-slot-slot-transfers-demo", 8, 8);
  await expectSlotText(page, "slot-transfers-demo", "Floating");

  mkdirSync(resolve(repoRoot, "output/playwright"), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
  console.log(`dock smoke passed: ${screenshotPath}`);
}

async function waitForServer(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`dev server exited early with code ${server.exitCode}\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`dev server did not become ready at ${url}\n${serverOutput}`);
}

async function dragCenterToCenter(page, sourceTestId, targetTestId) {
  const target = await centerOfTestId(page, targetTestId);
  await dragToPoint(page, sourceTestId, target.x, target.y);
}

async function dragToPoint(page, sourceTestId, x, y) {
  const source = await centerOfTestId(page, sourceTestId);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x + 12, source.y + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

async function centerOfTestId(page, testId) {
  const locator = page.getByTestId(testId);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`element ${testId} has no bounding box`);
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

async function expectSlotInsideGroup(page, slotId, groupId) {
  await page.waitForFunction(
    ({ slotId, groupId }) => {
      const group = document.querySelector(`[data-dock-group-id="${groupId}"]`);
      return Boolean(group?.querySelector(`[data-tool-slot-id="${slotId}"]`));
    },
    { slotId, groupId },
  );
}

async function expectSlotCount(page, slotId, count) {
  await page.waitForFunction(
    ({ slotId, count }) => document.querySelectorAll(`[data-tool-slot-id="${slotId}"]`).length === count,
    { slotId, count },
  );
}

async function expectMirrorBadge(page, ownerTitle) {
  await page.waitForFunction((ownerTitle) => {
    const mirrors = [...document.querySelectorAll('[data-tool-slot-id^="slot-mirror-"]')];
    return mirrors.some((element) => element.textContent?.includes(ownerTitle));
  }, ownerTitle);
}

async function expectSlotText(page, slotId, text) {
  await page.waitForFunction(
    ({ slotId, text }) => document.querySelector(`[data-tool-slot-id="${slotId}"]`)?.textContent?.includes(text) === true,
    { slotId, text },
  );
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

try {
  await main();
} finally {
  server.kill("SIGTERM");
}
