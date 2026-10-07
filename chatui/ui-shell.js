/* Keyboard and focus behavior shared by the settings and update dialogs. */
(() => {
  "use strict";
  const dialogs = [document.getElementById("settingsModal"), document.getElementById("updateModal")].filter(Boolean);
  const returnFocus = new Map();
  let active = null;
  const assistant = document.getElementById("assistantModal");
  const assistantOpen = () => !!assistant && !assistant.hidden;
  const visible = node => !node.disabled && node.tabIndex >= 0 && node.getAttribute("aria-disabled") !== "true" &&
    !node.closest("[hidden]") && node.getClientRects().length > 0;
  const controls = dialog => [...dialog.querySelectorAll('button, a[href], summary, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(visible);
  const focusFirst = dialog => (controls(dialog)[0] || dialog).focus();

  function sync() {
    if (assistantOpen()) return;
    const next = dialogs.filter(dialog => dialog.classList.contains("show")).at(-1) || null;
    if (next === active) return;
    const previous = active;
    active = next;
    if (previous && !previous.classList.contains("show")) {
      const target = returnFocus.get(previous);
      returnFocus.delete(previous);
      if (target?.isConnected && (!next || next.contains(target))) target.focus({ preventScroll: true });
    }
    if (next && !next.contains(document.activeElement)) {
      if (!returnFocus.has(next)) returnFocus.set(next, document.activeElement);
      focusFirst(next);
    }
  }
  document.addEventListener("focusin", event => {
    if (assistantOpen()) return;
    const dialog = dialogs.find(node => node.contains(event.target) && node.classList.contains("show"));
    if (dialog && event.relatedTarget && !dialog.contains(event.relatedTarget) && !returnFocus.has(dialog))
      returnFocus.set(dialog, event.relatedTarget);
    const top = dialogs.filter(node => node.classList.contains("show")).at(-1);
    if (top && !top.contains(event.target)) focusFirst(top);
  });
  document.addEventListener("keydown", event => {
    if (assistantOpen()) return;
    if (!active || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById(active.id === "updateModal" ? "btnCloseUpdate" : "btnCloseSettings").click();
      sync();
    } else if (event.key === "Tab") {
      const nodes = controls(active);
      const index = nodes.indexOf(document.activeElement);
      if (!nodes.length || index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === nodes.length - 1) {
        event.preventDefault();
        (nodes[event.shiftKey ? nodes.length - 1 : 0] || active).focus();
      }
    }
  }, true);
  for (const dialog of dialogs) {
    dialog.tabIndex = -1;
    new MutationObserver(sync).observe(dialog, { attributes: true, attributeFilter: ["class"] });
  }
  if (assistant) new MutationObserver(sync).observe(assistant, { attributes: true, attributeFilter: ["hidden"] });
  const tabs = [...document.querySelectorAll(".settings-tab-btn")];
  function syncTabs() {
    for (const tab of tabs) {
      const selected = tab.classList.contains("active");
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
  }
  for (const tab of tabs) {
    tab.addEventListener("keydown", event => {
      if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
      syncTabs();
      tabs[next].focus();
    });
    tab.addEventListener("click", () => queueMicrotask(syncTabs));
  }
  syncTabs();
  sync();

  const sessionList = document.getElementById("sessionList");
  const search = document.getElementById("searchInput");
  const rows = () => [...sessionList.querySelectorAll(".session-item")];
  function focusRow(row) {
    if (!row) return;
    for (const item of rows()) item.tabIndex = item === row ? 0 : -1;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }
  sessionList.addEventListener("keydown", event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = rows(), row = event.target.closest(".session-item");
    if (!row || !items.length) return;
    event.preventDefault();
    const index = items.indexOf(row);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    focusRow(items[next]);
  });
  search.addEventListener("keydown", event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "Enter") {
      const row = rows()[0];
      if (!row) return;
      event.preventDefault();
      focusRow(row);
      if (event.key === "Enter") row.click();
    } else if (event.key === "Escape" && search.value) {
      event.preventDefault();
      event.stopPropagation();
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.isComposing || assistantOpen() || active ||
        document.getElementById("appWindow").hasAttribute("inert")) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "k") {
      event.preventDefault();
      search.focus();
      search.select();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && key === "f") {
      const history = document.getElementById("btnChatHistory");
      if (history.disabled) return;
      event.preventDefault();
      if (!document.getElementById("chatView").classList.contains("active")) document.getElementById("navChat").click();
      if (document.getElementById("historySearchPanel").hidden) history.click();
      else document.getElementById("historyKeyword").focus();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
        ["ArrowUp", "ArrowDown"].includes(event.key)) {
      const items = rows(), index = items.findIndex(row => row.classList.contains("active"));
      const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      event.preventDefault();
      focusRow(next);
      next.click();
    } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === "End") {
      const latest = document.getElementById("btnReturnLatest"), scroll = document.getElementById("btnScrollLatest");
      const button = !latest.hidden ? latest : !scroll.hidden ? scroll : null;
      if (!button) return;
      event.preventDefault();
      if (!document.getElementById("chatView").classList.contains("active")) document.getElementById("navChat").click();
      button.click();
    }
  });
  const emoji = document.getElementById("emojiPopover");
  new MutationObserver(() => document.getElementById("btnEmoji").setAttribute("aria-expanded", String(emoji.classList.contains("show"))))
    .observe(emoji, { attributes: true, attributeFilter: ["class"] });
})();
