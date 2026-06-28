#!/usr/bin/env node
/*
 * Test content:
 *
 * Feature:
 * Verifies the Windows/Linux decorum integrated titlebar layout in the real
 * Tauri WebView, including both the default Zotero-style two-row titlebar and
 * the optional single-row compact layout.
 *
 * Operation:
 * Starts the Vite dev server, starts tauri-driver for an isolated app
 * configuration, launches the Tauri application provided by the
 * TAURI_TEST_APPLICATION environment variable, and measures the rendered
 * Workspace titlebar DOM. The first scenario leaves
 * `ui.integrated_titlebar_single_row` unset and checks the default two-row
 * layout. The second scenario writes the setting as true and checks the
 * single-row layout.
 *
 * Expected:
 * With the default setting, app menu roots render on the first titlebar row,
 * Workspace tabs and the New Workspace split button render on the second row,
 * decorum controls remain mounted on the first row at the far right, and the
 * Workspace content starts below the complete two-row titlebar. The decorum
 * control buttons are mounted inside the Workspace titlebar slot and each
 * button has a visible, clickable rectangle with a CSS-drawn control glyph
 * that does not depend on private icon-font characters. With the single-row
 * setting enabled, app menu roots, Workspace tabs, Workspace actions, drag
 * region, and decorum controls share one row without overlap. In both layouts,
 * the New Workspace split button has a stable gap from the Workspace tab strip,
 * is visually quiet while not hovered, and matches inactive Workspace tab
 * button background color.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createIsolatedAppConfigEnv } from "./isolated-app-config.mjs";
import { test } from "vitest";

test("integrated titlebar decorum layout", { timeout: 180_000 }, async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const appPath = requiredEnvPath("TAURI_TEST_APPLICATION");
  const nativeDriverPath = optionalEnvPath("TAURI_TEST_NATIVE_DRIVER");
  const baseDriverPort = Number(process.env.TAURI_TEST_DRIVER_PORT ?? "4444");
  const baseNativeDriverPort = Number(process.env.TAURI_TEST_NATIVE_DRIVER_PORT ?? "9515");
  const devUrl = process.env.TAURI_TEST_DEV_URL ?? "http://127.0.0.1:1420/";
  const devPort = Number(new URL(devUrl).port);
  const nativeDriverArgs = nativeDriverPath ? ["--native-driver", nativeDriverPath] : [];

  process.chdir(repoRoot);
  process.env.NOCTURNE_DEV_PORT = String(devPort);

  const devServer = await createServer({
    server: {
      host: "127.0.0.1",
      port: devPort,
      strictPort: true,
    },
    envDir: repoRoot,
    logLevel: "silent",
  });

  try {
    await devServer.listen();
    await waitForDevServer();

    await runScenario({
      name: "default-two-row",
      driverPort: baseDriverPort,
      nativeDriverPort: baseNativeDriverPort,
      configText: "",
      expectedLayout: "two-row",
      expectedTheme: "light",
    });
    await runScenario({
      name: "enabled-single-row",
      driverPort: baseDriverPort + 1,
      nativeDriverPort: baseNativeDriverPort + 1,
      configText: "[ui]\nintegrated_titlebar = true\nintegrated_titlebar_single_row = true\n",
      expectedLayout: "single-row",
      expectedTheme: "light",
    });
    await runScenario({
      name: "dark-two-row",
      driverPort: baseDriverPort + 2,
      nativeDriverPort: baseNativeDriverPort + 2,
      configText: "[ui]\ntheme = \"dark\"\nintegrated_titlebar = true\nintegrated_titlebar_single_row = false\n",
      expectedLayout: "two-row",
      expectedTheme: "dark",
    });

    console.log("tauri integrated titlebar decorum layout unit test passed");
  } finally {
    await devServer.close();
  }

  async function runScenario({ name, driverPort, nativeDriverPort, configText, expectedLayout, expectedTheme }) {
    const isolatedAppConfig = await createIsolatedAppConfigEnv(`integrated-titlebar-decorum-layout-${name}`);
    if (configText) {
      await writeFile(resolve(isolatedAppConfig.env.NOCTURNE_CONFIG_ROOT, "config.toml"), configText);
    }
    isolatedAppConfig.env.NOCTURNE_DEV_PORT = String(devPort);

    const driverUrl = `http://127.0.0.1:${driverPort}`;
    const tauriDriver = spawn("tauri-driver", ["--port", String(driverPort), "--native-port", String(nativeDriverPort), ...nativeDriverArgs], {
      cwd: repoRoot,
      env: isolatedAppConfig.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let driverOutput = "";
    let sessionId = "";
    tauriDriver.stdout.on("data", (chunk) => {
      driverOutput += chunk.toString();
    });
    tauriDriver.stderr.on("data", (chunk) => {
      driverOutput += chunk.toString();
    });

    try {
      await waitForDriver(driverUrl, tauriDriver, () => driverOutput);
      sessionId = await createSession(driverUrl);

      await waitUntil(
        async () => {
          const state = await titlebarState(driverUrl, sessionId);
          return state.workspaceTabCount === 1 && state.decorumButtonCount >= 3 && state.appMenuRootCount === 4;
        },
        async () => `decorum integrated titlebar did not mount for ${name}\n${await pageSummary(driverUrl, sessionId)}`,
        tauriDriver,
        () => driverOutput,
      );

      const state = await titlebarState(driverUrl, sessionId);
      assertCommonTitlebarState(state, name, expectedTheme);
      if (expectedLayout === "two-row") {
        assertTwoRowTitlebarState(state, name);
      } else {
        assertSingleRowTitlebarState(state, name);
      }
      assertNoRepeatedDecorumBootstrapLogs(driverOutput, name);
    } finally {
      if (sessionId) {
        await webdriver(driverUrl, "DELETE", `/session/${sessionId}`).catch(() => undefined);
      }
      await stopProcess(tauriDriver);
      await isolatedAppConfig.cleanup();
    }
  }

  function assertCommonTitlebarState(state, name, expectedTheme) {
    if (state.resolvedTheme !== expectedTheme) {
      throw new Error(`${name}: expected ${expectedTheme} theme, found ${state.resolvedTheme}\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.decorumHostCount !== 1) {
      throw new Error(`${name}: expected one decorum host, found ${state.decorumHostCount}\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.decorumHostMountedInSlot) {
      throw new Error(`${name}: decorum host was not mounted in the Workspace titlebar slot\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.decorumHostHiddenStyleCleared) {
      throw new Error(`${name}: decorum host stayed hidden after mounting\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.decorumButtonsVisible) {
      throw new Error(`${name}: decorum control buttons were not visibly mounted and clickable\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.decorumButtonsHaveCssGlyphs) {
      throw new Error(`${name}: decorum control buttons did not expose CSS-drawn visible glyphs\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.appMenuRootIds.join(",") !== "file,edit,view,window") {
      throw new Error(`${name}: app menu roots were not rendered in File/Edit/View/Window order\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuRootsVisible) {
      throw new Error(`${name}: app menu roots were not visible\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuRootsClickable) {
      throw new Error(`${name}: app menu roots were not clickable at their centers\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.actionGapFromWorkspaceTab < 5 || state.actionGapFromWorkspaceTab > 16) {
      throw new Error(`${name}: New Workspace split button was not positioned next to Workspace tabs\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.splitButtonWrapsSegments) {
      throw new Error(`${name}: New Workspace controls were not rendered as one split button\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.segmentGap < 0 || state.segmentGap > 1) {
      throw new Error(`${name}: split button segments were not directly adjacent\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.segmentIconsCentered || state.segmentTextVisible) {
      throw new Error(`${name}: split button segments did not use centered icons only\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.decorumLeft < state.splitButtonRight) {
      throw new Error(`${name}: decorum controls overlapped Workspace action buttons\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.decorumRight > state.tabbarRight + 1) {
      throw new Error(`${name}: decorum controls overflowed the titlebar\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.workspaceBodyStartsBelowTitlebarContent) {
      throw new Error(`${name}: Workspace content overlapped the integrated titlebar\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.newWorkspaceMatchesInactiveTabBackground) {
      throw new Error(`${name}: New Workspace button background did not match inactive tab button background\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.decorumButtonsHaveCssGlyphs || state.buttonStates?.some((button) => !button.glyphColorReadable)) {
      throw new Error(`${name}: decorum glyph colors were not readable in the rendered theme\n${JSON.stringify(state, null, 2)}`);
    }
    if (expectedTheme === "dark" && state.buttonStates?.some((button) => button.glyphColorLooksBlack)) {
      throw new Error(`${name}: decorum glyph colors were still black in dark mode\n${JSON.stringify(state, null, 2)}`);
    }
  }

  function assertNoRepeatedDecorumBootstrapLogs(driverOutput, name) {
    if (/DECORUM:\s*Controls already exist\. Skipping creation\./.test(driverOutput)) {
      throw new Error(`${name}: decorum repeatedly attempted to create controls after they already existed\n${driverOutput}`);
    }
  }

  function assertTwoRowTitlebarState(state, name) {
    if (!state.isTwoRow || state.isSingleRow) {
      throw new Error(`${name}: expected default titlebar-two-row class\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.menuRowExists || !state.tabRowExists) {
      throw new Error(`${name}: expected both menu and tab rows\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.menuRowAboveTabRow) {
      throw new Error(`${name}: menu row was not above the Workspace tab row\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuInMenuRow || !state.decorumInMenuRow || !state.workspaceTabsInTabRow || !state.workspaceActionsInTabRow) {
      throw new Error(`${name}: two-row titlebar content was not assigned to the expected rows\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuRootsCenteredInMenuRow || !state.decorumButtonsCenteredInMenuRow) {
      throw new Error(`${name}: first-row menu or decorum controls were not vertically centered\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.workspaceActionsCenteredInTabRow) {
      throw new Error(`${name}: second-row Workspace actions were not vertically centered\n${JSON.stringify(state, null, 2)}`);
    }
  }

  function assertSingleRowTitlebarState(state, name) {
    if (!state.isSingleRow || state.isTwoRow) {
      throw new Error(`${name}: expected titlebar-single-row class\n${JSON.stringify(state, null, 2)}`);
    }
    if (state.menuRowExists || !state.tabRowExists) {
      throw new Error(`${name}: single-row titlebar should render only the shared tab row\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuSeparatedFromWorkspaceTabs) {
      throw new Error(`${name}: app menu roots were not visibly separated from Workspace tabs in single-row mode\n${JSON.stringify(state, null, 2)}`);
    }
    if (!state.appMenuRootsCenteredInTabRow || !state.decorumButtonsCenteredInTabRow || !state.workspaceActionsCenteredInTabRow) {
      throw new Error(`${name}: single-row titlebar controls were not vertically centered\n${JSON.stringify(state, null, 2)}`);
    }
  }

  async function titlebarState(driverUrl, sessionId) {
    return await execute(driverUrl, sessionId, `
      const rectOf = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect ? {
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerY: Math.round(rect.top + rect.height / 2),
        } : null;
      };
      const containsRect = (outer, inner) => Boolean(
        outer &&
        inner &&
        inner.left >= outer.left - 1 &&
        inner.right <= outer.right + 1 &&
        inner.top >= outer.top - 1 &&
        inner.bottom <= outer.bottom + 1
      );
      const centeredIn = (outer, rects) => Boolean(
        outer &&
        rects.length > 0 &&
        rects.every((rect) => Math.abs(rect.centerY - outer.centerY) <= 1)
      );
      const tabbar = document.querySelector('.workspace-tabbar');
      const resolvedTheme = document.documentElement.dataset.theme ?? '';
      const menuRow = document.querySelector('.workspace-titlebar-menu-row');
      const tabRow = document.querySelector('.workspace-titlebar-tab-row');
      const workspaceTab = document.querySelector('.workspace-tab');
      const workspaceBody = document.querySelector('.workspace-body');
      const appMenu = document.querySelector('.workspace-app-menu');
      const appMenuRoots = [...document.querySelectorAll('.workspace-app-menu-root')];
      const splitButton = document.querySelector('.workspace-action-split-button');
      const newWorkspace = document.querySelector('.new-workspace');
      const inactiveWorkspaceActivate = document.querySelector('.workspace-tab:not(.active) .workspace-activate') ??
        document.querySelector('.workspace-tab .workspace-activate');
      const hostPicker = document.querySelector('.host-picker');
      const newWorkspaceIcon = document.querySelector('.new-workspace svg');
      const hostPickerIcon = document.querySelector('.host-picker svg');
      const decorumHosts = [...document.querySelectorAll('[data-tauri-decorum-tb]')];
      const decorumHost = document.querySelector('#decorum-titlebar-host');
      const decorumSlot = document.querySelector('.workspace-decorum-slot');
      const decorumButtons = [...document.querySelectorAll('#decorum-titlebar-host .decorum-tb-btn')];
      const tabbarRect = rectOf(tabbar);
      const workspaceBodyRect = rectOf(workspaceBody);
      const menuRowRect = rectOf(menuRow);
      const tabRowRect = rectOf(tabRow);
      const workspaceTabRect = rectOf(workspaceTab);
      const appMenuRect = rectOf(appMenu);
      const appMenuRootRects = appMenuRoots.map(rectOf).filter(Boolean);
      const appMenuRootHitStates = appMenuRoots.map((root) => {
        const rect = rectOf(root);
        const centerElement = rect
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null;
        return {
          id: root.getAttribute('data-app-menu-root'),
          rect,
          receivesPointerAtCenter: centerElement === root || root.contains(centerElement),
          centerElementClassName: centerElement?.className ?? '',
          centerElementTagName: centerElement?.tagName ?? '',
        };
      });
      const splitButtonRect = rectOf(splitButton);
      const newWorkspaceRect = rectOf(newWorkspace);
      const inactiveWorkspaceActivateStyle = inactiveWorkspaceActivate ? getComputedStyle(inactiveWorkspaceActivate) : null;
      const newWorkspaceStyle = newWorkspace ? getComputedStyle(newWorkspace) : null;
      const hostPickerRect = rectOf(hostPicker);
      const newWorkspaceIconRect = rectOf(newWorkspaceIcon);
      const hostPickerIconRect = rectOf(hostPickerIcon);
      const decorumRect = rectOf(decorumHost);
      const buttonRects = decorumButtons.map(rectOf).filter(Boolean);
      const buttonStates = decorumButtons.map((button) => {
        const style = getComputedStyle(button);
        const beforeStyle = getComputedStyle(button, '::before');
        const afterStyle = getComputedStyle(button, '::after');
        const rect = rectOf(button);
        const centerElement = rect
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null;
        const cssGlyphVisible = (pseudo) =>
          pseudo.content !== 'none' &&
          pseudo.display !== 'none' &&
          pseudo.visibility !== 'hidden' &&
          (
            Number.parseFloat(pseudo.width) >= 1 ||
            Number.parseFloat(pseudo.height) >= 1 ||
            pseudo.borderTopWidth !== '0px' ||
            pseudo.backgroundColor !== 'rgba(0, 0, 0, 0)'
          );
        const parseColor = (value) => {
          const rgb = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/i);
          if (rgb) {
            return {
              red: Number(rgb[1]),
              green: Number(rgb[2]),
              blue: Number(rgb[3]),
              alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
            };
          }
          const srgb = value.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/i);
          if (srgb) {
            return {
              red: Number(srgb[1]) * 255,
              green: Number(srgb[2]) * 255,
              blue: Number(srgb[3]) * 255,
              alpha: srgb[4] === undefined ? 1 : Number(srgb[4]),
            };
          }
          return null;
        };
        const glyphColors = [beforeStyle.color, afterStyle.color].map(parseColor).filter(Boolean);
        const glyphColorLooksBlack = glyphColors.some((color) =>
          color.alpha > 0.5 &&
          color.red < 80 &&
          color.green < 80 &&
          color.blue < 80
        );
        return {
          text: button.textContent,
          id: button.id,
          windowControl: button.getAttribute('data-window-control') ?? '',
          ariaLabel: button.getAttribute('aria-label') ?? '',
          className: button.className,
          display: style.display,
          visibility: style.visibility,
          opacity: Number(style.opacity),
          pointerEvents: style.pointerEvents,
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
          before: {
            content: beforeStyle.content,
            display: beforeStyle.display,
            visibility: beforeStyle.visibility,
            color: beforeStyle.color,
            backgroundColor: beforeStyle.backgroundColor,
            width: beforeStyle.width,
            height: beforeStyle.height,
            borderTopWidth: beforeStyle.borderTopWidth,
            borderRightWidth: beforeStyle.borderRightWidth,
            borderBottomWidth: beforeStyle.borderBottomWidth,
            borderLeftWidth: beforeStyle.borderLeftWidth,
          },
          after: {
            content: afterStyle.content,
            display: afterStyle.display,
            visibility: afterStyle.visibility,
            color: afterStyle.color,
            backgroundColor: afterStyle.backgroundColor,
            width: afterStyle.width,
            height: afterStyle.height,
          },
          cssGlyphVisible: cssGlyphVisible(beforeStyle) || cssGlyphVisible(afterStyle),
          glyphColorReadable: [beforeStyle.color, afterStyle.color].some((color) =>
            color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent'
          ),
          glyphColorLooksBlack,
          rect,
          receivesPointerAtCenter: centerElement === button || button.contains(centerElement),
        };
      });
      return {
        resolvedTheme,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? '',
        tabbarClassName: tabbar?.className ?? '',
        isTwoRow: tabbar?.classList.contains('titlebar-two-row') ?? false,
        isSingleRow: tabbar?.classList.contains('titlebar-single-row') ?? false,
        menuRowExists: Boolean(menuRow),
        tabRowExists: Boolean(tabRow),
        workspaceTabCount: document.querySelectorAll('.workspace-tab').length,
        appMenuRootCount: appMenuRoots.length,
        appMenuRootIds: appMenuRoots.map((root) => root.getAttribute('data-app-menu-root')),
        appMenuRootsVisible: appMenuRootRects.length === 4 && appMenuRootRects.every((rect) => rect.width > 20 && rect.height >= 24),
        appMenuRootsClickable: appMenuRootHitStates.length === 4 && appMenuRootHitStates.every((root) => root.receivesPointerAtCenter),
        appMenuSeparatedFromWorkspaceTabs: Boolean(
          appMenuRect &&
          workspaceTabRect &&
          appMenuRect.right <= workspaceTabRect.left &&
          workspaceTabRect.left - appMenuRect.right >= 2 &&
          workspaceTabRect.left - appMenuRect.right <= 18 &&
          getComputedStyle(appMenu).borderRightStyle !== 'none'
        ),
        menuRowAboveTabRow: Boolean(menuRowRect && tabRowRect && menuRowRect.bottom <= tabRowRect.top + 1),
        appMenuInMenuRow: containsRect(menuRowRect, appMenuRect),
        decorumInMenuRow: containsRect(menuRowRect, decorumRect),
        workspaceTabsInTabRow: containsRect(tabRowRect, workspaceTabRect),
        workspaceActionsInTabRow: containsRect(tabRowRect, splitButtonRect),
        appMenuRootsCenteredInMenuRow: centeredIn(menuRowRect, appMenuRootRects),
        decorumButtonsCenteredInMenuRow: centeredIn(menuRowRect, buttonRects),
        appMenuRootsCenteredInTabRow: centeredIn(tabRowRect, appMenuRootRects),
        decorumButtonsCenteredInTabRow: centeredIn(tabRowRect, buttonRects),
        workspaceActionsCenteredInTabRow: centeredIn(tabRowRect, [newWorkspaceRect, hostPickerRect].filter(Boolean)),
        workspaceBodyStartsBelowTitlebarContent: Boolean(
          workspaceBodyRect &&
          Math.max(
            tabbarRect?.bottom ?? 0,
            menuRowRect?.bottom ?? 0,
            tabRowRect?.bottom ?? 0,
            workspaceTabRect?.bottom ?? 0,
            splitButtonRect?.bottom ?? 0,
          ) <= workspaceBodyRect.top + 1
        ),
        newWorkspaceMatchesInactiveTabBackground: Boolean(
          inactiveWorkspaceActivateStyle &&
          newWorkspaceStyle &&
          splitButton &&
          getComputedStyle(splitButton).backgroundColor === inactiveWorkspaceActivateStyle.backgroundColor &&
          newWorkspaceStyle.backgroundColor === inactiveWorkspaceActivateStyle.backgroundColor
        ),
        decorumHostCount: decorumHosts.length,
        decorumButtonCount: decorumButtons.length,
        decorumHostMountedInSlot: decorumHost?.parentElement === decorumSlot,
        decorumHostHiddenStyleCleared: decorumHost ? getComputedStyle(decorumHost).display !== 'none' : false,
        decorumButtonsVisible: buttonStates.length >= 3 && buttonStates.every((button) =>
          button.display !== 'none' &&
          button.visibility !== 'hidden' &&
          button.opacity > 0.95 &&
          button.pointerEvents !== 'none' &&
          button.rect &&
          button.rect.width >= 36 &&
          button.rect.height >= 24 &&
          button.receivesPointerAtCenter
        ),
        decorumButtonsHaveCssGlyphs: buttonStates.length >= 3 &&
          ['minimize', 'maximize', 'close'].every((control) =>
            buttonStates.some((button) =>
              button.windowControl === control &&
              button.ariaLabel.toLowerCase().includes(control === 'close' ? 'close' : control) &&
              button.color === 'rgba(0, 0, 0, 0)' &&
              button.fontSize === '0px' &&
              button.cssGlyphVisible
            )
          ),
        actionGapFromWorkspaceTab: workspaceTabRect && splitButtonRect ? splitButtonRect.left - workspaceTabRect.right : -1,
        splitButtonWrapsSegments: Boolean(
          splitButtonRect &&
          newWorkspaceRect &&
          hostPickerRect &&
          splitButtonRect.left <= newWorkspaceRect.left &&
          splitButtonRect.right >= hostPickerRect.right &&
          Math.abs(splitButtonRect.centerY - newWorkspaceRect.centerY) <= 1 &&
          Math.abs(splitButtonRect.centerY - hostPickerRect.centerY) <= 1
        ),
        segmentGap: newWorkspaceRect && hostPickerRect ? hostPickerRect.left - newWorkspaceRect.right : -1,
        segmentTextVisible: Boolean(
          (newWorkspace?.textContent ?? '').trim() ||
          (hostPicker?.textContent ?? '').trim()
        ),
        segmentIconsCentered: Boolean(
          newWorkspaceRect &&
          hostPickerRect &&
          newWorkspaceIconRect &&
          hostPickerIconRect &&
          Math.abs(newWorkspaceIconRect.centerY - newWorkspaceRect.centerY) <= 1 &&
          Math.abs(hostPickerIconRect.centerY - hostPickerRect.centerY) <= 1 &&
          Math.abs(newWorkspaceIconRect.left + newWorkspaceIconRect.width / 2 - (newWorkspaceRect.left + newWorkspaceRect.width / 2)) <= 1 &&
          Math.abs(hostPickerIconRect.left + hostPickerIconRect.width / 2 - (hostPickerRect.left + hostPickerRect.width / 2)) <= 1
        ),
        splitButtonRight: splitButtonRect?.right ?? -1,
        decorumLeft: decorumRect?.left ?? -1,
        decorumRight: decorumRect?.right ?? -1,
        tabbarRight: tabbarRect?.right ?? -1,
        rects: {
          tabbar: tabbarRect,
          workspaceBody: workspaceBodyRect,
          menuRow: menuRowRect,
          tabRow: tabRowRect,
          appMenu: appMenuRect,
          appMenuRoots: appMenuRootRects,
          workspaceTab: workspaceTabRect,
          splitButton: splitButtonRect,
          newWorkspace: newWorkspaceRect,
          hostPicker: hostPickerRect,
          newWorkspaceIcon: newWorkspaceIconRect,
          hostPickerIcon: hostPickerIconRect,
          decorum: decorumRect,
          buttons: buttonRects,
        },
        buttonStates,
        appMenuRootHitStates,
      };
    `);
  }

  async function createSession(driverUrl) {
    const response = await webdriver(driverUrl, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "wry",
          "tauri:options": {
            application: appPath,
          },
        },
      },
    });
    const id = response.value?.sessionId ?? response.sessionId;
    if (!id) throw new Error(`WebDriver did not return a session id: ${JSON.stringify(response)}`);
    return id;
  }

  async function execute(driverUrl, sessionId, script, args = []) {
    const response = await webdriver(driverUrl, "POST", `/session/${sessionId}/execute/sync`, {
      script,
      args,
    });
    return response.value;
  }

  async function webdriver(driverUrl, method, path, body) {
    const response = await fetch(`${driverUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`WebDriver ${method} ${path} failed: ${response.status} ${text}`);
    }
    return json;
  }

  async function waitForDriver(driverUrl, tauriDriver, driverOutput) {
    await waitUntil(
      async () => {
        try {
          const response = await fetch(`${driverUrl}/status`);
          return response.ok;
        } catch {
          return false;
        }
      },
      () => `tauri-driver did not start\n${driverOutput()}`,
      tauriDriver,
      driverOutput,
    );
  }

  async function waitForDevServer() {
    await waitUntilWithoutDriver(async () => {
      try {
        const response = await fetch(devUrl);
        return response.ok;
      } catch {
        return false;
      }
    }, "Vite dev server did not start");
  }

  async function waitUntil(check, errorMessage, tauriDriver, driverOutput, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (tauriDriver.exitCode !== null) {
        throw new Error(`tauri-driver exited early with code ${tauriDriver.exitCode}\n${driverOutput()}`);
      }
      if (await check()) return;
      await delay(250);
    }
    throw new Error(typeof errorMessage === "function" ? await errorMessage() : errorMessage);
  }

  async function waitUntilWithoutDriver(check, errorMessage, timeoutMs = 30_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await check()) return;
      await delay(250);
    }
    throw new Error(typeof errorMessage === "function" ? await errorMessage() : errorMessage);
  }

  function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  }

  function requiredEnvPath(name) {
    const value = process.env[name];
    if (!value) {
      throw new Error(`${name} must point to the Tauri application binary for this Tauri unit test.`);
    }
    const path = resolve(value);
    if (!existsSync(path)) {
      throw new Error(`${name} points to a missing file: ${path}`);
    }
    return path;
  }

  function optionalEnvPath(name) {
    const value = process.env[name];
    if (!value) return "";
    const path = resolve(value);
    if (!existsSync(path)) {
      throw new Error(`${name} points to a missing file: ${path}`);
    }
    return path;
  }

  async function pageSummary(driverUrl, sessionId) {
    if (!sessionId) return "no WebDriver session";
    return JSON.stringify(await titlebarState(driverUrl, sessionId), null, 2);
  }

  async function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    await new Promise((resolveStop) => {
      const timeout = setTimeout(resolveStop, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
      child.kill();
    });
  }

});
