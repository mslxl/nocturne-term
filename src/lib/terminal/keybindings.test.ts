import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { eventMatchesBinding, parseKeybinding, readKeybindingMap } from "./keybindings";

describe("terminal keybindings", () => {
  it("parses modifiers and key", () => {
    assert.deepEqual(parseKeybinding("Meta+Shift+D"), {
      key: "D",
      meta: true,
      ctrl: false,
      alt: false,
      shift: true,
    });
  });

  it("matches keyboard events exactly", () => {
    const event = {
      key: "d",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    } as KeyboardEvent;

    assert.equal(eventMatchesBinding(event, "Meta+Shift+D"), true);
    assert.equal(eventMatchesBinding(event, "Meta+D"), false);
  });

  it("reads configured terminal keybindings over defaults", () => {
    const map = readKeybindingMap(
      {
        values: {
          keybindings: {
            kind: "Table",
            value: {
              terminal: {
                kind: "Table",
                value: {
                  find: { kind: "String", value: "Ctrl+R" },
                },
              },
            },
          },
        },
      },
      false,
    );

    assert.equal(map["terminal.find"], "Ctrl+R");
    assert.equal(map["terminal.newSession"], "Ctrl+Shift+T");
    assert.equal(map["terminal.openCommandPalette"], "Ctrl+Shift+P");
    assert.equal(map["terminal.findNext"], "Ctrl+G");
    assert.equal(map["terminal.findPrevious"], "Ctrl+Shift+G");
  });
});
