import assert from "node:assert/strict";
import test from "node:test";
import {
  approveNavigation,
  hasUnsavedChanges,
  registerDraft,
  requestNavigation,
} from "./unsaved-navigation";

test("dirty forms defer navigation until approved and release independently", () => {
  const original = globalThis.window;
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  const one = Symbol(),
    two = Symbol();
  let navigated = 0;
  let pending: (() => void) | undefined;
  target.addEventListener("towbar:confirm-navigation", (event) => {
    pending = (event as CustomEvent<() => void>).detail;
  });
  try {
    registerDraft(one, true);
    registerDraft(two, true);
    requestNavigation(() => navigated++);
    assert.equal(navigated, 0);
    assert.ok(pending);
    approveNavigation(pending);
    assert.equal(navigated, 1);
    assert.equal(hasUnsavedChanges(), true);
    registerDraft(one, false);
    assert.equal(hasUnsavedChanges(), true);
    registerDraft(two, false);
    requestNavigation(() => navigated++);
    assert.equal(navigated, 2);
  } finally {
    registerDraft(one, false);
    registerDraft(two, false);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: original,
    });
  }
});
