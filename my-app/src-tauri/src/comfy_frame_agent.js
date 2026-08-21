// Lunery ComfyUI frame agent.
//
// Injected by Tauri into the dedicated ComfyUI canvas window
// (`initialization_script` on the comfy-canvas WebviewWindow). Inside that
// window this script shares the page origin, so it can drive the official
// frontend directly (`window.app`) — the same integration surface SwarmUI
// uses. Everywhere else it stays dormant.
//
// Two modes:
//   - Standalone canvas window (top-level): exposes `window.__luneryComfyHost`
//     as a command sink. The Studio drives it through bridge webview eval
//     (`/comfy-canvas-load`) to load API-format workflows into the editor.
//   - Embedded frame (kept for embed integrations): relays execution events to
//     the parent via postMessage and accepts the same load command from it.
//
// Frame contract (embedded mode only):
//   agent -> host: { __luneryComfy: true, type: "ready" | "event" | "ack", ... }
//   host  -> agent: { __luneryComfy: true, type: "load-api-json", jobId, workflow }
(function () {
  "use strict";
  if (window.__luneryComfyAgent) return;
  window.__luneryComfyAgent = true;

  var STANDALONE = window.self === window.top;

  // Execution-relevant events dispatched by the frontend's ComfyApi
  // (EventTarget). Names are stable public surface used by every extension.
  var EVENTS = [
    "status",
    "execution_start",
    "executing",
    "progress",
    "executed",
    "execution_error",
    "execution_interrupted",
    "execution_cached",
    "execution_success",
    "promptQueued",
  ];

  function send(payload) {
    payload.__luneryComfy = true;
    try {
      window.parent.postMessage(payload, "*");
    } catch {
      /* parent gone during teardown */
    }
  }

  function findApp() {
    // Current frontends expose the ComfyApp instance as `window.app`; older
    // builds expose it under `comfyAPI.app.app`. Both are load-bearing for
    // third-party integrations (SwarmUI, official browser extensions).
    var app = window.app || (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app);
    return app && app.api ? app : null;
  }

  function loadApiJson(workflowText) {
    var target = findApp();
    if (!target) {
      return Promise.reject(new Error("frontend-not-ready"));
    }
    var workflow;
    try {
      workflow = JSON.parse(workflowText);
    } catch {
      return Promise.reject(new Error("invalid-workflow"));
    }
    // loadApiJson validates node types against object_info.
    return Promise.resolve().then(function () {
      return target.loadApiJson(workflow);
    });
  }

  var attached = false;
  function attach(app) {
    if (attached) return;
    attached = true;

    if (STANDALONE) {
      // Command sink for the desktop shell; no parent to relay events to.
      window.__luneryComfyHost = {
        ready: true,
        loadApiJson: loadApiJson,
      };
      return;
    }

    for (var i = 0; i < EVENTS.length; i++) {
      (function (name) {
        try {
          app.api.addEventListener(name, function (event) {
            send({
              type: "event",
              event: name,
              // CustomEvent.detail may be null (simple events) or arbitrary
              // server JSON; postMessage clones it structurally.
              data: event && event.detail !== undefined ? event.detail : null,
            });
          });
        } catch {
          /* unknown event name on older frontends */
        }
      })(EVENTS[i]);
    }

    send({
      type: "ready",
      origin: window.location.origin,
      frontendVersion: window.__COMFYUI_FRONTEND_VERSION__ || null,
    });
  }

  if (STANDALONE) {
    // The Vue frontend defines `app` late in its bundle. Poll briefly so the
    // command sink exists as soon as the frontend is drivable, then go
    // dormant — a page without the frontend must not spin forever.
    var standaloneTries = 0;
    var standaloneTimer = setInterval(function () {
      if (findApp()) {
        clearInterval(standaloneTimer);
        attach(findApp());
        return;
      }
      standaloneTries += 1;
      if (standaloneTries > 240) clearInterval(standaloneTimer); // ~60s at 250ms
    }, 250);
    return;
  }

  attachPendingEvents();

  function attachPendingEvents() {
    var tries = 0;
    var timer = setInterval(function () {
      var app = findApp();
      if (app) {
        clearInterval(timer);
        attach(app);
        return;
      }
      tries += 1;
      if (tries > 240) clearInterval(timer); // ~60s at 250ms
    }, 250);
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.__luneryComfy !== true) return;
    var ack = function (ok, error) {
      send({ type: "ack", jobId: data.jobId || null, ok: ok, error: error || null });
    };
    if (data.type === "load-api-json") {
      var app = findApp();
      if (!app) {
        ack(false, "frontend-not-ready");
        return;
      }
      try {
        JSON.parse(JSON.stringify(data.workflow));
      } catch {
        ack(false, "invalid-workflow");
        return;
      }
      loadApiJson(JSON.stringify(data.workflow)).then(
        function () {
          ack(true);
        },
        function (error) {
          ack(false, error && error.message ? String(error.message) : "load-failed");
        },
      );
    }
  });
})();
