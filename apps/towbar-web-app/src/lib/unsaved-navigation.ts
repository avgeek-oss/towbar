const drafts = new Set<symbol>();
let approving = false;
let documentNavigationApproved = false;

export function registerDraft(id: symbol, dirty: boolean) {
  if (dirty) drafts.add(id);
  else drafts.delete(id);
}
export function hasUnsavedChanges() {
  return drafts.size > 0;
}
export function shouldWarnOnUnload() {
  return hasUnsavedChanges() && !documentNavigationApproved;
}
export function assignPage(href: string) {
  requestNavigation(() => {
    documentNavigationApproved = true;
    window.location.assign(href);
  });
}
export function requestNavigation(action: () => void) {
  if (approving || !hasUnsavedChanges()) action();
  else
    window.dispatchEvent(
      new CustomEvent("towbar:confirm-navigation", { detail: action }),
    );
}
export function approveNavigation(action: () => void) {
  approving = true;
  try {
    action();
  } finally {
    approving = false;
  }
}
export function pushPage(href: string) {
  requestNavigation(() => window.history.pushState(null, "", href));
}
