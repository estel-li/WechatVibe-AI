/* The chat UI keeps the Electron desktopHost contract; Tauri owns native work. */
(() => {
  "use strict";
  const tauri = window.__TAURI__;
  if (window.top !== window || typeof tauri?.core?.invoke !== "function" ||
      typeof tauri?.event?.listen !== "function") return;

  const config = window.__WECHATVIBE_DESKTOP__ || {};
  const updateValidationMode = config.updateValidationMode === true;
  const updateFinalReadyMode = !updateValidationMode && config.updateFinalReadyMode === true;
  const isTop = () => window.top === window;
  const isActive = () => navigator.userActivation?.isActive === true;
  const invoke = (command, args = {}) => tauri.core.invoke(command, args);
  const warn = error => console.error("WechatVibe desktop bridge", error);
  const blocked = phase => Promise.resolve({ [phase]: "blocked" });
  const cleanup = [];
  let disposed = false;

  function windowState(state) {
    if (!state || typeof state.maximized !== "boolean") return;
    const button = document.getElementById("desktopMaximize");
    if (!button) return;
    button.setAttribute("aria-label", state.maximized ? "还原" : "最大化");
    button.title = state.maximized ? "还原" : "最大化";
    button.classList.toggle("is-maximized", state.maximized);
  }

  const subscriptions = [
    ["wechatvibe-service-restored", () => window.dispatchEvent(new Event("wechatvibe-service-restored"))],
    ["wechatvibe-update-state", event => {
      if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload))
        window.dispatchEvent(new CustomEvent("wechatvibe-update-state", { detail: event.payload }));
    }],
    ["wechatvibe-model-download-state", event => {
      if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload))
        window.dispatchEvent(new CustomEvent("wechatvibe-model-download-state", { detail: event.payload }));
    }],
    ["wechatvibe-window-state", event => windowState(event.payload)],
    ["wechatvibe-error", event => {
      if (typeof event.payload?.message === "string")
        window.dispatchEvent(new CustomEvent("wechatvibe-error", { detail: { message: event.payload.message } }));
    }],
  ];
  const bridgeReady = Promise.all(subscriptions.map(([name, callback]) =>
    Promise.resolve(tauri.event.listen(name, event => {
      if (!disposed && isTop()) callback(event);
    })).then(unlisten => {
      if (disposed) unlisten();
      else cleanup.push(unlisten);
    })
  ));
  // Normal startup does not await the bridge; retain an explicit failure handler.
  void bridgeReady.catch(warn);

  Object.defineProperty(window, "desktopHost", {
    value: Object.freeze({
      platform: "win32",
      updateValidationMode,
      updateFinalReadyMode,
      reportUiReady() {
        if ((!updateValidationMode && !updateFinalReadyMode) || !isTop()) return Promise.resolve(false);
        return bridgeReady.then(() => invoke("desktop_report_ui_ready"));
      },
      setTheme(theme) {
        if (!isTop() || (theme !== "dark" && theme !== "light")) return false;
        void invoke("desktop_set_theme", { theme }).catch(warn);
        return true;
      },
      copyDraft(value) {
        if (typeof value !== "string" || !value.trim() || value.length > 1_000_000 || !isActive() || !isTop())
          return Promise.resolve(false);
        return invoke("desktop_copy_draft", { value });
      },
      exitApp() {
        return isTop() ? invoke("desktop_exit_app") : Promise.resolve(false);
      },
      getAppVersion() {
        return isTop() ? invoke("desktop_get_app_version") : Promise.resolve(null);
      },
      getModelDownloadState() {
        return isTop() ? invoke("desktop_get_model_download_state") : blocked("phase");
      },
      downloadLayaModel() {
        return isTop() && isActive() ? invoke("desktop_download_laya_model") : blocked("phase");
      },
      chooseModelDirectory() {
        return isTop() && isActive() ? invoke("desktop_choose_model_directory") : Promise.resolve(null);
      },
      chooseDataRoot() {
        return isTop() && isActive() ? invoke("desktop_choose_data_root") : Promise.resolve(null);
      },
      checkForUpdates() {
        return isTop() ? invoke("desktop_check_for_updates") : blocked("status");
      },
      getUpdateState() {
        return isTop() ? invoke("desktop_get_update_state") : blocked("phase");
      },
      beginUpdate() {
        return isTop() && isActive() ? invoke("desktop_begin_update") : blocked("phase");
      },
      rollbackUpdate() {
        return isTop() && isActive() ? invoke("desktop_rollback_update") : blocked("phase");
      },
    }),
    enumerable: true,
    writable: false,
    configurable: false,
  });

  const docs = new Set([
    "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
    "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
    "https://github.com/tswawa",
    "https://github.com/tswawa/WechatVibe",
    "https://github.com/tswawa/WechatVibe/releases",
    "https://github.com/fanyuantaier/wechatauto-replica",
  ]);
  document.addEventListener("click", event => {
    if (!event.isTrusted || event.button !== 0 || !isActive() || !isTop()) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    let target;
    try { target = new URL(anchor.href); } catch { return; }
    if (!docs.has(target.href) || target.username || target.password) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void invoke("desktop_open_doc", { target: target.href, trusted: true, active: true }).catch(warn);
  }, true);

  document.documentElement.classList.add("desktop-host", "tauri-desktop-host");
  const controls = document.getElementById("desktopWindowControls");
  const dragArea = document.getElementById("desktopDragArea");
  const action = value => invoke("desktop_window_action", { action: value }).then(windowState).catch(warn);
  if (controls) {
    controls.hidden = false;
    controls.addEventListener("click", event => {
      if (!event.isTrusted || event.button !== 0 || !isTop()) return;
      const button = event.target instanceof Element ? event.target.closest("button[data-window-action]") : null;
      if (!button || !controls.contains(button)) return;
      void action(button.dataset.windowAction);
    });
  }
  if (dragArea) {
    dragArea.addEventListener("mousedown", event => {
      if (event.isTrusted && event.button === 0 && event.detail !== 2 && isTop())
        void action("start-dragging");
    });
    dragArea.addEventListener("dblclick", event => {
      if (event.isTrusted && event.button === 0 && isTop()) void action("toggle-maximize");
    });
  }
  void action("get-state");
  // A navigation that Tauri cancels can still fire beforeunload. Release native
  // listeners only after an actual page departure, so denied links do not
  // silently disconnect download progress, recovery, and window-state events.
  window.addEventListener("pagehide", () => {
    disposed = true;
    cleanup.splice(0).forEach(unlisten => unlisten());
  }, { once: true });
})();
