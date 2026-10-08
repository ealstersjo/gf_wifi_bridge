/* global document, location, fetch, WebSocket, GatewayWebSocketClient, console, setTimeout, clearTimeout, setInterval, window, DOMParser */
(() => {
  "use strict";

  const byId = id => document.getElementById(id);
  const elements = Object.fromEntries([
    "gateway-status", "g30-status", "message", "temperature-alert", "temperature-alert-text", "temperature-alert-dismiss", "alert-enable", "freshness", "connect", "connect-inline", "disconnect",
    "actual", "target", "rssi", "target-down", "target-up", "target-form",
    "target-input", "target-apply", "heater-state",
    "heater-power", "heat-on", "heat-off", "pump-state", "pump-on", "pump-off",
    "heater-mode-temperature", "heater-mode-manual", "advanced-heater-output", "advanced-heater-note",
    "timer-state", "timer-remaining", "timer-total", "timer-hours", "timer-minutes",
    "timer-start", "timer-pause", "timer-resume", "timer-cancel", "delay-state",
    "delay-remaining", "delay-target", "delay-hours", "delay-minutes", "delay-start",
    "delay-pause", "delay-resume", "delay-cancel", "gateway-detail",
    "heating-rate", "eta", "heater-power-bar", "session-status", "session-idle",
    "session-active", "session-name", "session-start", "session-title",
    "session-runtime", "session-end", "graph-session-label", "temperature-graph",
    "graph-empty", "graph-grid", "graph-section", "actual-line", "target-line", "session-history", "event-list",
    "session-recipe", "session-phase", "session-plan", "session-summary", "phase-marker", "phase-mark", "recipe-list", "recipe-import", "recipe-preview", "performance-refresh", "performance-summary",
    "live-unavailable", "live-instruments", "unavailable-title", "process-unavailable", "process-live",
    "timer-panel", "timer-configure", "timer-config", "timer-active-actions",
    "delay-panel", "delay-configure", "delay-config", "delay-active-actions",
  ].map(id => [id, byId(id)]));

  let snapshot = null;
  let socketClient = null;
  let socketOnline = false;
  let targetEditing = false;
  let targetInputDirty = false;
  let targetRequestPending = false;
  let telemetry = [];
  let events = [];
  let sessions = [];
  let recipes = [];
  let selectedSummary = null;
  let selectedSessionId = null;
  let lastActiveSessionId = null;
  let graphRange = "15";
  let timerConfigOpen = false;
  let delayConfigOpen = false;
  let messageTimer = null;
  let pendingRecipeImport = null;
  let previousActualTemperature = null;
  let alertedTargetKey = null;
  let alertAudioContext = null;

  const formatTemperature = value => Number.isFinite(value) ? `${value.toFixed(1)} °C` : "--.- °C";
  const formatDuration = value => {
    if (!Number.isInteger(value) || value < 0) return "--:--";
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  };
  const booleanState = value => value === true ? "ON" : value === false ? "OFF" : "UNKNOWN";
  const setPill = (element, text, style) => {
    element.textContent = text;
    element.className = `status-mark ${style || ""}`.trim();
  };
  const showMessage = (text, isError = false, transient = !isError) => {
    clearTimeout(messageTimer);
    elements.message.textContent = text;
    elements.message.className = `message${isError ? " error" : ""}`;
    if (transient) messageTimer = setTimeout(clearMessage, 3500);
  };
  const clearMessage = () => {
    clearTimeout(messageTimer);
    elements.message.className = "message hidden";
  };

  function updateAlertPermissionControl() {
    const supported = typeof window.Notification !== "undefined";
    elements["alert-enable"].classList.toggle("hidden", !supported || window.Notification.permission === "granted");
  }

  function enableAlerts() {
    if (typeof window.Notification === "undefined") {
      showMessage("This browser does not support system notifications.", true);
      return;
    }
    window.Notification.requestPermission().then(permission => {
      updateAlertPermissionControl();
      if (permission === "granted") showMessage("Temperature alerts enabled.");
    }).catch(() => showMessage("Could not enable browser notifications.", true));
  }

  function playTemperatureAlert() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      alertAudioContext ||= new AudioContextClass();
      const now = alertAudioContext.currentTime;
      [0, 0.22, 0.44].forEach(offset => {
        const oscillator = alertAudioContext.createOscillator();
        const gain = alertAudioContext.createGain();
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
        oscillator.connect(gain).connect(alertAudioContext.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.18);
      });
    } catch (_) { /* Browser autoplay policy may block sound. */ }
  }

  function announceTemperatureReached(temperatureC) {
    const text = `Target temperature reached: ${temperatureC.toFixed(1)} °C`;
    elements["temperature-alert-text"].textContent = text;
    elements["temperature-alert"].classList.remove("hidden");
    playTemperatureAlert();
    if (typeof window.Notification !== "undefined" && window.Notification.permission === "granted") {
      new window.Notification("G30 target reached", {body: text, tag: "g30-target-reached"});
    }
  }

  function checkTemperatureAlert(g) {
    const actual = g && g.actualTemperatureC;
    const target = g && g.targetTemperatureC;
    if (!Number.isFinite(actual) || !Number.isFinite(target) || g.connectionState !== "CONNECTED" || g.stale) return;
    const targetKey = String(target);
    if (alertedTargetKey !== targetKey) {
      alertedTargetKey = null;
      previousActualTemperature = null;
    }
    if (previousActualTemperature !== null && previousActualTemperature < target && actual >= target && alertedTargetKey !== targetKey) {
      alertedTargetKey = targetKey;
      announceTemperatureReached(target);
    }
    if (actual < target - 0.3) alertedTargetKey = null;
    previousActualTemperature = actual;
  }

  function durationFromInputs(prefix) {
    const hours = Number(elements[`${prefix}-hours`].value);
    const minutes = Number(elements[`${prefix}-minutes`].value);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || minutes < 0) return null;
    const seconds = (hours * 60 + minutes) * 60;
    return seconds >= 60 ? seconds : null;
  }

  async function apiRequest(path, body, method = "POST") {
    clearMessage();
    const response = await fetch(path, {
      method,
      headers: {"Content-Type": "application/json"},
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({error: "invalid_gateway_response"}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    showMessage(payload.status === "confirmed" ? "✓ Confirmed by G30" : (payload.status || "Request completed."));
    return payload;
  }

  const request = (path, body) => apiRequest(path, body, "POST");

  async function get(path) {
    const response = await fetch(path);
    const payload = await response.json().catch(() => ({error: "invalid_gateway_response"}));
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function run(path, body) {
    request(path, body).catch(error => showMessage(error.message, true));
  }

  function targetInputValue() {
    const raw = elements["target-input"].value.trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  async function submitTarget() {
    const temperatureC = targetInputValue();
    if (temperatureC === null) {
      showMessage("Enter a valid numeric target temperature.", true);
      elements["target-input"].focus();
      return;
    }
    targetRequestPending = true;
    targetInputDirty = false;
    let failed = false;
    render();
    try {
      await request("/api/v1/target", {temperatureC});
    } catch (error) {
      failed = true;
      targetInputDirty = true;
      showMessage(error.message, true);
    } finally {
      targetRequestPending = false;
      render();
      if (failed) elements["target-input"].focus();
    }
  }

  const formatSessionDuration = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = Math.floor(seconds % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${minutes}:${String(rest).padStart(2, "0")}`;
  };

  function eventLabel(event) {
    const labels = {
      SESSION_STARTED: "Session started", SESSION_ENDED: "Session ended",
      G30_CONNECTED: "G30 connected", G30_DISCONNECTED: "G30 disconnected",
      HEATER_ON: "Heater on", HEATER_OFF: "Heater off", PUMP_ON: "Pump on", PUMP_OFF: "Pump off",
      TIMER_STARTED: "Timer started", TIMER_PAUSED: "Timer paused", TIMER_RESUMED: "Timer resumed",
      TIMER_COMPLETED: "Timer completed", TIMER_CANCELLED: "Timer cancelled",
      DELAYED_HEAT_STARTED: "Delayed heat started", DELAYED_HEAT_PAUSED: "Delayed heat paused",
      DELAYED_HEAT_RESUMED: "Delayed heat resumed", DELAYED_HEAT_CANCELLED: "Delayed heat cancelled",
      TARGET_REACHED: `Target reached ${event.payload?.targetTemperatureC ?? ""} °C`,
      TARGET_CHANGED: `Target ${event.payload?.old ?? "—"} → ${event.payload?.new ?? "—"} °C`,
    };
    return labels[event.type] || event.type.replaceAll("_", " ").toLowerCase();
  }

  function appendLiveSessionData(sessionState) {
    const sample = sessionState?.latestTelemetry;
    if (sample && sample.sessionId === selectedSessionId && !telemetry.some(item => item.id === sample.id)) {
      telemetry.push(sample);
    }
    const event = sessionState?.latestEvent;
    if (event && event.sessionId === selectedSessionId && !events.some(item => item.id === event.id)) {
      events.unshift(event);
    }
  }

  async function loadSessions() {
    const payload = await get("/api/v1/sessions");
    sessions = payload.sessions || [];
    renderHistory();
  }

  function renderRecipeOptions() {
    const manual = document.createElement("option"); manual.textContent = "Manual / no recipe"; manual.value = "";
    elements["session-recipe"].replaceChildren(manual);
    recipes.forEach(recipe => { const option = document.createElement("option"); option.textContent = `${recipe.name}${recipe.plannedBatchVolumeL ? ` · ${recipe.plannedBatchVolumeL} L` : ""}`; option.value = recipe.id; elements["session-recipe"].append(option); });
  }

  function renderRecipes() {
    elements["recipe-list"].replaceChildren();
    if (!recipes.length) {
      const empty = document.createElement("p"); empty.className = "compact-empty"; empty.textContent = "No recipes yet."; elements["recipe-list"].append(empty); return;
    }
    recipes.forEach(recipe => {
      const row = document.createElement("div"); row.className = "history-item";
      const main = document.createElement("div"); main.className = "recipe-main";
      const text = document.createElement("strong"); text.className = "recipe-title"; text.textContent = recipe.name;
      const style = document.createElement("span"); style.className = "recipe-style"; style.textContent = recipe.style || "Imported from Brewfather";
      const meta = document.createElement("span"); meta.className = "recipe-meta"; meta.textContent = `${recipe.plannedBatchVolumeL ?? "—"} L · ${recipe.abvPercent ?? "—"}% · ${recipe.ibu ?? "—"} IBU`;
      const mash = document.createElement("span"); mash.className = "recipe-mash"; mash.textContent = recipe.mashSteps?.length ? `Mash: ${recipe.mashSteps.map(step => `${step.targetTemperatureC}°C`).join(" → ")}` : "";
      main.append(text, style, meta, mash);
      const buttons = document.createElement("span"); buttons.className = "recipe-buttons";
      const action = (label, handler) => { const button = document.createElement("button"); button.type = "button"; button.className = "button-quiet"; button.textContent = label; button.onclick = handler; buttons.append(button); };
      action("View", () => { get(`/api/v1/recipes/${encodeURIComponent(recipe.id)}`).then(payload => { const detail = payload.recipe; const sections = [`${detail.name}\n${detail.style || ""}`, `PROCESS\nBatch ${detail.plannedBatchVolumeL ?? "—"} L · Boil ${detail.boilDurationMinutes ?? "—"} min`, detail.fermentables?.length ? `FERMENTABLES\n${detail.fermentables.map(item => `${item.name} · ${item.amountKg ?? "—"} kg`).join("\n")}` : "", detail.mashSteps?.length ? `MASH\n${detail.mashSteps.map((step, index) => `${index + 1}. ${step.name} · ${step.targetTemperatureC} °C · ${step.durationMinutes} min`).join("\n")}` : "", detail.hops?.length ? `HOPS\n${detail.hops.map(item => `${item.name} · ${item.amountG ?? "—"} g · ${item.use || ""} · ${item.timeMinutes ?? "—"} min`).join("\n")}` : "", detail.miscs?.length ? `WATER / ADDITIONS\n${detail.miscs.map(item => `${item.name} · ${item.amountG ?? "—"} g`).join("\n")}` : "", detail.yeasts?.length ? `YEAST\n${detail.yeasts.map(item => `${item.name}${item.laboratory ? ` · ${item.laboratory}` : ""}`).join("\n")}` : "", detail.notes ? `NOTES\n${detail.notes}` : ""].filter(Boolean); elements["recipe-preview"].classList.remove("hidden"); elements["recipe-preview"].textContent = sections.join("\n\n"); }).catch(error => showMessage(`Could not load recipe: ${error.message}`, true)); });
      action("Remove", () => { if (window.confirm(`Remove ${recipe.name}?`)) apiRequest(`/api/v1/recipes/${encodeURIComponent(recipe.id)}`, null, "DELETE").then(loadRecipes).catch(error => showMessage(error.message, true)); });
      row.append(main, buttons); elements["recipe-list"].append(row);
    });
  }

  async function loadRecipes() { const payload = await get("/api/v1/recipes"); recipes = payload.recipes || []; renderRecipes(); renderRecipeOptions(); }

  function importRecipeText(text, filename) {
    if (!/\.xml$/i.test(filename) && !text.trim().startsWith("<")) throw new Error("Unsupported recipe format. Select a Brewfather BeerXML file.");
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Unsafe XML declarations are not supported");
    const documentXml = new DOMParser().parseFromString(text, "application/xml");
    if (documentXml.querySelector("parsererror")) throw new Error("The selected file is not valid BeerXML");
    const direct = (node, name) => node ? Array.from(node.children).find(child => child.tagName.toUpperCase() === name) : null;
    const value = (node, name) => direct(node, name)?.textContent?.trim() || null;
    const recipeNodes = Array.from(documentXml.querySelectorAll("RECIPES > RECIPE"));
    if (recipeNodes.length > 1) throw new Error("This file contains multiple recipes; import one BeerXML recipe at a time");
    const root = recipeNodes[0] || direct(documentXml.documentElement, "RECIPE") || documentXml.documentElement;
    const name = value(root, "NAME"); if (!name) throw new Error("No direct RECIPE/NAME value found in BeerXML");
    const n = raw => { const parsed = Number.parseFloat(String(raw ?? "").replace(",", ".")); return Number.isFinite(parsed) ? parsed : null; };
    const style = direct(root, "STYLE"); const fermentables = Array.from(direct(direct(root, "FERMENTABLES"), "FERMENTABLE") || []).map(item => ({name: value(item, "NAME") || "Unnamed fermentable", amountKg: n(value(item, "AMOUNT"))}));
    const hops = Array.from(direct(direct(root, "HOPS"), "HOP") || []).map(item => ({name: value(item, "NAME") || "Unnamed hop", amountG: n(value(item, "AMOUNT")) === null ? null : n(value(item, "AMOUNT")) * 1000, use: value(item, "USE"), timeMinutes: n(value(item, "TIME"))}));
    const yeasts = Array.from(direct(direct(root, "YEASTS"), "YEAST") || []).map(item => ({name: value(item, "NAME") || "Unnamed yeast", laboratory: value(item, "LABORATORY"), form: value(item, "FORM")}));
    const mash = direct(direct(root, "MASH"), "MASH_STEPS"); const steps = Array.from(direct(mash, "MASH_STEP") || []).map((step, index) => ({name: value(step, "NAME") || `Step ${index + 1}`, targetTemperatureC: n(value(step, "STEP_TEMP")), durationMinutes: n(value(step, "STEP_TIME"))}));
    const recipe = {id: value(root, "ID") || name, name, style: value(style, "NAME"), notes: value(root, "NOTES"), plannedBatchVolumeL: n(value(root, "BATCH_SIZE")), plannedPreBoilVolumeL: n(value(root, "BOIL_SIZE")), mashWaterVolumeL: null, spargeWaterVolumeL: null, grainWeightKg: fermentables.reduce((sum, item) => sum + (item.amountKg || 0), 0) || null, mashSteps: steps, boilDurationMinutes: n(value(root, "BOIL_TIME")), source: "BREWFATHER", sourceRecipeId: value(root, "ID") || name, sourceFormat: "BeerXML", originalImport: text, originalRecipeData: {format: "BeerXML", xml: text}, fermentables, hops, yeasts, og: n(value(root, "OG")), fg: n(value(root, "FG")), abvPercent: n(value(root, "ABV")), ibu: n(value(root, "IBU"))};
    if (steps.some(step => step.targetTemperatureC === null || step.durationMinutes === null)) throw new Error("A mash step contains an invalid temperature or duration");
    pendingRecipeImport = recipe;
    const preview = elements["recipe-preview"]; preview.classList.remove("hidden"); preview.innerHTML = `<strong>Import Brewfather recipe</strong><br>${recipe.name}<br>${recipe.style || ""}<br>Batch: ${recipe.plannedBatchVolumeL ?? "—"} L · Grain: ${recipe.grainWeightKg ?? "—"} kg<br>Mash: ${steps.map((step, index) => `${index + 1}. ${step.targetTemperatureC} °C · ${step.durationMinutes} min`).join(" · ")}<br>Boil: ${recipe.boilDurationMinutes ?? "—"} min<br><button type="button" class="button-quiet" data-import-cancel>Cancel</button> <button type="button" class="button-amber" data-import-confirm>Import</button>`;
    preview.querySelector("[data-import-cancel]").onclick = () => { pendingRecipeImport = null; preview.classList.add("hidden"); };
    preview.querySelector("[data-import-confirm]").onclick = () => { const selected = pendingRecipeImport; pendingRecipeImport = null; preview.classList.add("hidden"); request("/api/v1/recipes", selected).then(loadRecipes).catch(error => showMessage(`Could not save recipe: ${error.message}`, true)); };
  }

  function renderPerformance(performance) {
    const rows = [...(performance?.heatToMash || []).map(item => ({label: "Heat to mash", item})), ...(performance?.mashToBoil || []).map(item => ({label: "Mash → boil", item}))];
    elements["performance-summary"].replaceChildren();
    if (!rows.length) { elements["performance-summary"].textContent = "Complete comparable brews to see your G30's measured performance."; return; }
    rows.forEach(({label, item}) => { const row = document.createElement("div"); row.className = "stat-row"; row.innerHTML = `<span>${label} · ${item.volumeL === null ? "unknown volume" : `${item.volumeL}–${item.volumeL + 4} L`}</span><strong>${item.averageRateCPerMinute.toFixed(2)} °C/min · n=${item.sampleCount}</strong>`; elements["performance-summary"].append(row); });
  }
  async function loadPerformance() { const payload = await get("/api/v1/performance"); renderPerformance(payload.performance); }

  async function selectSession(sessionId) {
    selectedSessionId = sessionId;
    const [telemetryPayload, eventPayload, summaryPayload] = await Promise.all([
      get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/telemetry?limit=20000`),
      get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`),
      get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/summary`).catch(() => ({summary: null})),
    ]);
    telemetry = telemetryPayload.telemetry || [];
    events = eventPayload.events || [];
    selectedSummary = summaryPayload.summary;
    renderHistory();
    renderGraph();
    renderEvents();
  }

  function renderSession() {
    const live = snapshot?.session;
    const active = live?.active;
    elements["session-status"].textContent = active ? "ACTIVE" : "IDLE";
    elements["session-idle"].classList.toggle("hidden", Boolean(active));
    elements["session-active"].classList.toggle("hidden", !active);
    elements["heating-rate"].textContent = Number.isFinite(live?.heatingRateCPerMinute)
      ? `${live.heatingRateCPerMinute >= 0 ? "+" : ""}${live.heatingRateCPerMinute.toFixed(1)} °C/min`
      : "—";
    elements.eta.textContent = Number.isInteger(live?.etaSeconds)
      ? `~${Math.max(1, Math.ceil(live.etaSeconds / 60))} min`
      : "—";
    if (active) {
      elements["session-title"].textContent = active.name || "Unnamed brew session";
      const seconds = (Date.now() - Date.parse(active.startedAt)) / 1000;
      elements["session-runtime"].textContent = `Running ${formatSessionDuration(seconds)} · started ${new Date(active.startedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`;
      elements["session-phase"].textContent = `Phase: ${live.currentPhase || active.currentPhase || "UNKNOWN"}`;
      const recipe = active.recipeSnapshot;
      elements["session-plan"].textContent = recipe ? `${recipe.name} · ${recipe.plannedBatchVolumeL ?? "—"} L planned · ${recipe.mashSteps.length} mash step${recipe.mashSteps.length === 1 ? "" : "s"}` : "Manual session · no recipe context";
      const heat = selectedSummary?.heatToFirstMashTarget;
      elements["session-summary"].textContent = heat ? `Heat to mash: ${formatSessionDuration(heat.elapsedSeconds)} · ${heat.averageRateCPerMinute.toFixed(2)} °C/min · coverage ${heat.coveragePercent.toFixed(0)}%` : "Statistics will appear as sufficient telemetry is recorded.";
      if (lastActiveSessionId !== active.id) {
        lastActiveSessionId = active.id;
        selectSession(active.id).catch(error => showMessage(error.message, true));
        loadSessions().catch(() => {});
      }
    } else if (lastActiveSessionId) {
      lastActiveSessionId = null;
      loadSessions().catch(() => {});
    }
    appendLiveSessionData(live);
    renderGraph();
    renderEvents();
  }

  function renderGraph() {
    const selected = sessions.find(item => item.id === selectedSessionId) || snapshot?.session?.active;
    elements["graph-session-label"].textContent = selected ? (selected.name || "Unnamed session") : "No session selected";
    const now = Date.now();
    const cutoff = graphRange === "session" ? -Infinity : now - Number(graphRange) * 60_000;
    const points = telemetry.filter(item => Date.parse(item.timestamp) >= cutoff);
    elements["graph-empty"].classList.toggle("hidden", points.length > 0);
    elements["graph-section"].classList.toggle("empty", points.length === 0);
    elements["graph-grid"].replaceChildren();
    if (points.length === 0) {
      elements["actual-line"].setAttribute("points", "");
      elements["target-line"].setAttribute("points", "");
      return;
    }
    const times = points.map(item => Date.parse(item.timestamp));
    const temperatures = points.flatMap(item => [item.actualTemperatureC, item.targetTemperatureC]).filter(Number.isFinite);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times, minTime + 1);
    const minTemp = Math.min(...temperatures) - 1;
    const maxTemp = Math.max(...temperatures) + 1;
    const coordinate = (item, value) => {
      const x = 52 + (Date.parse(item.timestamp) - minTime) / (maxTime - minTime) * 724;
      const y = 220 - (value - minTemp) / Math.max(1, maxTemp - minTemp) * 190;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };
    const svgNode = (name, attributes, text) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", name);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
      if (text) node.textContent = text;
      return node;
    };
    for (let index = 0; index <= 4; index += 1) {
      const y = 30 + index * 47.5;
      const value = maxTemp - index / 4 * (maxTemp - minTemp);
      elements["graph-grid"].append(
        svgNode("line", {x1: "52", y1: String(y), x2: "776", y2: String(y), class: "grid-line"}),
        svgNode("text", {x: "44", y: String(y + 4), "text-anchor": "end", class: "axis-label"}, `${value.toFixed(0)}°`),
      );
    }
    for (let index = 0; index <= 4; index += 1) {
      const x = 52 + index * 181;
      const time = new Date(minTime + index / 4 * (maxTime - minTime));
      elements["graph-grid"].append(svgNode("text", {x: String(x), y: "246", "text-anchor": index === 0 ? "start" : index === 4 ? "end" : "middle", class: "axis-label"}, time.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})));
    }
    elements["actual-line"].setAttribute("points", points.map(item => coordinate(item, item.actualTemperatureC)).join(" "));
    elements["target-line"].setAttribute("points", points.filter(item => Number.isFinite(item.targetTemperatureC)).map(item => coordinate(item, item.targetTemperatureC)).join(" "));
  }

  function renderEvents() {
    elements["event-list"].replaceChildren();
    if (events.length === 0) {
      const empty = document.createElement("p"); empty.className = "secondary"; empty.textContent = "No session events yet."; elements["event-list"].append(empty); return;
    }
    events.forEach(event => {
      const row = document.createElement("div"); row.className = "event-item";
      const time = document.createElement("time"); time.textContent = new Date(event.timestamp).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const label = document.createElement("span"); label.textContent = eventLabel(event);
      const source = document.createElement("span"); source.className = "event-source"; source.textContent = event.source;
      row.append(time, label, source); elements["event-list"].append(row);
    });
  }

  function renderHistory() {
    elements["session-history"].replaceChildren();
    const completed = sessions.filter(item => item.status === "COMPLETED");
    if (completed.length === 0) {
      const empty = document.createElement("p"); empty.className = "secondary"; empty.textContent = "No completed sessions yet."; elements["session-history"].append(empty); return;
    }
    completed.forEach(session => {
      const button = document.createElement("div");
      button.className = `history-item${session.id === selectedSessionId ? " active" : ""}`;
      const duration = (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000;
      const date = document.createElement("span"); date.className = "history-date"; date.textContent = new Date(session.startedAt).toLocaleDateString([], {day: "2-digit", month: "short"});
      const name = document.createElement("span"); name.className = "history-name"; name.textContent = session.name || "Unnamed session";
      const elapsed = document.createElement("span"); elapsed.className = "history-duration"; elapsed.textContent = formatSessionDuration(duration);
      const actions = document.createElement("span"); actions.className = "history-actions";
      const view = document.createElement("button"); view.type = "button"; view.className = "button-quiet"; view.textContent = "View"; view.onclick = () => selectSession(session.id).catch(error => showMessage(error.message, true));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "button-danger"; remove.textContent = "Delete"; remove.onclick = () => { if (!window.confirm(`Delete brew session?\n${session.name || "Unnamed session"}\nTelemetry and events will be removed.`)) return; apiRequest(`/api/v1/sessions/${encodeURIComponent(session.id)}`, null, "DELETE").then(() => loadSessions()).catch(error => showMessage(`Could not delete brew session: ${error.message}`, true)); };
      actions.append(view, remove); button.append(date, name, elapsed, actions);
      elements["session-history"].append(button);
    });
  }

  function render() {
    const g = snapshot?.grainfather;
    setPill(elements["gateway-status"], socketOnline ? "Gateway online" : "Gateway reconnecting", socketOnline ? "" : "pending");
    if (!g) {
      document.body.classList.remove("is-connected");
      document.body.classList.add("is-disconnected");
      elements.freshness.textContent = "Gateway unavailable";
      elements.connect.disabled = true;
      elements.connect.classList.remove("hidden");
      elements.disconnect.disabled = true;
      elements.disconnect.classList.add("hidden");
      elements["connect-inline"].disabled = true;
      elements["graph-section"].classList.add("empty");
      return;
    }

    const connected = g.connectionState === "CONNECTED";
    checkTemperatureAlert(g);
    const pending = g.command?.state === "PENDING";
    const busy = !socketOnline || pending || !connected;
    const connectionStyle = connected ? "" : g.connectionState === "ERROR" || g.connectionState === "NOT_FOUND" ? "error" : "muted";
    setPill(elements["g30-status"], `G30 ${g.connectionState}`, connectionStyle);
    document.body.classList.toggle("is-connected", connected);
    document.body.classList.toggle("is-disconnected", !connected);
    elements["unavailable-title"].textContent = `G30 ${g.connectionState.replaceAll("_", " ").toLowerCase()}`;
    elements.actual.textContent = formatTemperature(g.actualTemperatureC);
    elements.target.textContent = formatTemperature(g.targetTemperatureC);
    if (!targetEditing && !targetInputDirty && !targetRequestPending) {
      elements["target-input"].value = Number.isFinite(g.targetTemperatureC)
        ? String(g.targetTemperatureC)
        : "";
    }
    elements.rssi.textContent = `${g.rssi ?? "--"} dBm`;
    elements["heater-state"].textContent = booleanState(g.heater?.enabled);
    elements["heater-state"].classList.toggle("on", g.heater?.enabled === true);
    elements["heater-power"].textContent = `${g.heater?.powerPercent ?? "Unknown"}${g.heater?.powerPercent == null ? "" : "%"}`;
    elements["heater-power-bar"].style.width = `${Math.max(0, Math.min(100, g.heater?.powerPercent || 0))}%`;
    elements["heater-power-bar"].parentElement.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, g.heater?.powerPercent || 0))));
    elements["pump-state"].textContent = booleanState(g.pump?.enabled);
    elements["pump-state"].classList.toggle("on", g.pump?.enabled === true);
    const controlMode = g.heater?.controlMode || (g.heater?.manualPowerMode === true ? "MANUAL_POWER" : g.heater?.manualPowerMode === false ? "TEMPERATURE" : "UNKNOWN");
    elements["heater-mode-temperature"].checked = controlMode === "TEMPERATURE";
    elements["heater-mode-manual"].checked = controlMode === "MANUAL_POWER";
    elements["advanced-heater-output"].textContent = g.heater?.powerPercent == null ? "Unknown" : `${g.heater.powerPercent}%`;
    elements["advanced-heater-note"].textContent = controlMode === "MANUAL_POWER"
      ? "Manual mode is active. Power writing is not enabled until its payload is independently verified."
      : controlMode === "TEMPERATURE" ? "Temperature control remains active." : "Waiting for controller mode status.";
    elements["timer-state"].textContent = g.timer?.state || "UNKNOWN";
    elements["timer-remaining"].textContent = formatDuration(g.timer?.remainingSeconds);
    elements["timer-total"].textContent = `Total: ${formatDuration(g.timer?.durationSeconds)}`;
    elements["delay-state"].textContent = g.delayedHeat?.state || "UNKNOWN";
    elements["delay-remaining"].textContent = formatDuration(g.delayedHeat?.remainingSeconds);
    elements["delay-target"].textContent = `Controller target: ${formatTemperature(g.delayedHeat?.targetTemperatureC)}`;
    elements["gateway-detail"].textContent = `${snapshot.gateway?.localIp || "Local network"}:${snapshot.gateway?.port || 8080} · ${snapshot.gateway?.webSocketClients || 0} client(s)`;

    if (g.lastUpdate) {
      const age = Math.max(0, (Date.now() - Date.parse(g.lastUpdate)) / 1000);
      elements.freshness.textContent = connected
        ? (g.stale ? `DATA STALE ${age.toFixed(0)}s` : `${age.toFixed(1)}s`)
        : "No live G30 data";
    } else {
      elements.freshness.textContent = connected ? "Waiting for G30 data" : "No live G30 data";
    }

    elements.connect.disabled = !socketOnline || !["DISCONNECTED", "NOT_FOUND", "ERROR"].includes(g.connectionState) || pending;
    elements["connect-inline"].disabled = elements.connect.disabled;
    elements["connect-inline"].classList.toggle("hidden", !["DISCONNECTED", "NOT_FOUND", "ERROR"].includes(g.connectionState));
    elements.disconnect.disabled = !socketOnline || !["CONNECTED", "CONNECTING", "SCANNING"].includes(g.connectionState);
    elements.connect.classList.toggle("hidden", !["DISCONNECTED", "NOT_FOUND", "ERROR"].includes(g.connectionState));
    elements.disconnect.classList.toggle("hidden", !["CONNECTED", "CONNECTING", "SCANNING"].includes(g.connectionState));
    elements.freshness.classList.toggle("stale", connected && g.stale === true);
    elements["target-down"].disabled = busy || g.stale || !Number.isFinite(g.targetTemperatureC);
    elements["target-up"].disabled = busy || g.stale || !Number.isFinite(g.targetTemperatureC);
    elements["target-input"].disabled = busy || g.stale || targetRequestPending;
    elements["target-apply"].disabled = busy || g.stale || targetRequestPending || targetInputValue() === null;
    elements["heat-on"].disabled = busy || g.heater?.enabled === true;
    elements["heat-off"].disabled = busy || g.heater?.enabled === false;
    elements["pump-on"].disabled = busy || g.pump?.enabled === true;
    elements["pump-off"].disabled = busy || g.pump?.enabled === false;
    elements["heater-mode-temperature"].disabled = busy || controlMode === "TEMPERATURE";
    elements["heater-mode-manual"].disabled = busy || controlMode === "MANUAL_POWER";
    elements["heat-on"].classList.toggle("hidden", g.heater?.enabled === true);
    elements["heat-off"].classList.toggle("hidden", g.heater?.enabled !== true);
    elements["pump-on"].classList.toggle("hidden", g.pump?.enabled === true);
    elements["pump-off"].classList.toggle("hidden", g.pump?.enabled !== true);

    const delayed = g.delayedHeat?.active === true;
    const idle = g.timer?.state === "IDLE" && g.delayedHeat?.active === false;
    elements["timer-start"].disabled = busy || !idle || durationFromInputs("timer") === null;
    elements["timer-pause"].disabled = busy || delayed || g.timer?.state !== "RUNNING";
    elements["timer-resume"].disabled = busy || delayed || g.timer?.state !== "PAUSED";
    elements["timer-cancel"].disabled = busy || delayed || !["RUNNING", "PAUSED", "FINISHED"].includes(g.timer?.state);
    elements["delay-start"].disabled = busy || !idle || g.stale || !Number.isFinite(g.targetTemperatureC) || durationFromInputs("delay") === null;
    elements["delay-pause"].disabled = busy || g.delayedHeat?.state !== "ARMED";
    elements["delay-resume"].disabled = busy || g.delayedHeat?.state !== "PAUSED";
    elements["delay-cancel"].disabled = busy || !delayed;

    const timerActive = ["RUNNING", "PAUSED", "FINISHED"].includes(g.timer?.state);
    elements["timer-panel"].classList.toggle("active-process", timerActive);
    elements["timer-configure"].classList.toggle("hidden", timerActive);
    elements["timer-config"].classList.toggle("hidden", timerActive || !timerConfigOpen);
    elements["timer-active-actions"].classList.toggle("hidden", !timerActive);
    elements["timer-configure"].setAttribute("aria-expanded", String(timerConfigOpen && !timerActive));
    elements["delay-panel"].classList.toggle("active-process", delayed);
    elements["delay-configure"].classList.toggle("hidden", delayed);
    elements["delay-config"].classList.toggle("hidden", delayed || !delayConfigOpen);
    elements["delay-active-actions"].classList.toggle("hidden", !delayed);
    elements["delay-configure"].setAttribute("aria-expanded", String(delayConfigOpen && !delayed));

    if (pending) showMessage(`Pending · ${g.command.description || "Grainfather command"}`, false, false);
    if (g.command?.state === "FAILED") showMessage(`Command failed: ${g.command.detail || "unknown error"}`, true);
    renderSession();
  }

  function connectSocket() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socketClient = new GatewayWebSocketClient({
      url: `${scheme}://${location.host}/api/v1/ws`,
      createSocket: url => new WebSocket(url),
      log: (level, message) => {
        if (level === "error") console.error(message);
        else if (level === "warn") console.warn(message);
        else console.info(message);
      },
      onOpen: () => {
        socketOnline = true;
        loadSessions().catch(error => showMessage(error.message, true));
        render();
      },
      onMessage: data => {
        try { snapshot = JSON.parse(data); render(); } catch (_) { showMessage("Invalid state from gateway", true); }
      },
      onClose: () => {
        socketOnline = false;
        render();
      },
    });
    socketClient.start();
  }

  elements.connect.onclick = () => run("/api/v1/grainfather/connect");
  elements["alert-enable"].onclick = enableAlerts;
  elements["temperature-alert-dismiss"].onclick = () => elements["temperature-alert"].classList.add("hidden");
  elements["connect-inline"].onclick = () => elements.connect.click();
  elements.disconnect.onclick = () => run("/api/v1/grainfather/disconnect");
  elements["target-down"].onclick = () => run("/api/v1/target", {temperatureC: snapshot.grainfather.targetTemperatureC - 0.5});
  elements["target-up"].onclick = () => run("/api/v1/target", {temperatureC: snapshot.grainfather.targetTemperatureC + 0.5});
  elements["target-form"].onsubmit = event => {
    event.preventDefault();
    submitTarget();
  };
  elements["target-input"].onfocus = () => { targetEditing = true; };
  elements["target-input"].oninput = () => {
    targetInputDirty = true;
    render();
  };
  elements["target-input"].onblur = () => {
    targetEditing = false;
    setTimeout(() => {
      if (!targetEditing && !targetRequestPending) {
        targetInputDirty = false;
        render();
      }
    }, 0);
  };
  elements["heat-on"].onclick = () => run("/api/v1/heater", {enabled: true});
  elements["heat-off"].onclick = () => run("/api/v1/heater", {enabled: false});
  elements["pump-on"].onclick = () => run("/api/v1/pump", {enabled: true});
  elements["pump-off"].onclick = () => run("/api/v1/pump", {enabled: false});
  const changeHeaterMode = event => {
    const mode = event.target.value;
    request("/api/v1/heater/mode", {mode}).catch(error => { showMessage(error.message, true); render(); });
  };
  elements["heater-mode-temperature"].onchange = changeHeaterMode;
  elements["heater-mode-manual"].onchange = changeHeaterMode;
  elements["timer-start"].onclick = () => { timerConfigOpen = false; run("/api/v1/timer/start", {durationSeconds: durationFromInputs("timer")}); };
  elements["timer-pause"].onclick = () => run("/api/v1/timer/pause");
  elements["timer-resume"].onclick = () => run("/api/v1/timer/resume");
  elements["timer-cancel"].onclick = () => run("/api/v1/timer/cancel");
  elements["delay-start"].onclick = () => { delayConfigOpen = false; run("/api/v1/delayed-heat/start", {durationSeconds: durationFromInputs("delay")}); };
  elements["delay-pause"].onclick = () => run("/api/v1/delayed-heat/pause");
  elements["delay-resume"].onclick = () => run("/api/v1/delayed-heat/resume");
  elements["delay-cancel"].onclick = () => run("/api/v1/delayed-heat/cancel");
  elements["timer-configure"].onclick = () => { timerConfigOpen = !timerConfigOpen; render(); };
  elements["delay-configure"].onclick = () => { delayConfigOpen = !delayConfigOpen; render(); };
  elements["session-start"].onclick = () => {
    request("/api/v1/sessions", {name: elements["session-name"].value.trim() || null, recipeId: elements["session-recipe"].value || null})
      .then(payload => {
        elements["session-name"].value = "";
        if (payload.session?.id) return selectSession(payload.session.id);
      })
      .catch(error => showMessage(error.message, true));
  };
  elements["phase-mark"].onclick = () => {
    const id = snapshot?.session?.active?.id;
    if (id) request(`/api/v1/sessions/${encodeURIComponent(id)}/phase-marker`, {phase: elements["phase-marker"].value}).then(() => selectSession(id)).catch(error => showMessage(error.message, true));
  };
  elements["recipe-import"].onchange = event => { const file = event.target.files?.[0]; if (!file) return; file.text().then(text => importRecipeText(text, file.name)).catch(error => showMessage(error.message, true)); event.target.value = ""; };
  elements["performance-refresh"].onclick = () => loadPerformance().catch(error => showMessage(error.message, true));
  elements["session-end"].onclick = () => {
    const id = snapshot?.session?.active?.id;
    if (id) request(`/api/v1/sessions/${encodeURIComponent(id)}/end`).then(() => loadSessions()).catch(error => showMessage(error.message, true));
  };
  document.querySelectorAll("[data-range]").forEach(button => {
    button.onclick = () => {
      graphRange = button.dataset.range;
      document.querySelectorAll("[data-range]").forEach(item => item.classList.toggle("active", item === button));
      renderGraph();
    };
  });
  ["timer-hours", "timer-minutes", "delay-hours", "delay-minutes"].forEach(id => {
    elements[id].oninput = render;
  });

  setInterval(render, 1000);
  updateAlertPermissionControl();
  connectSocket();
  loadRecipes().catch(error => showMessage(error.message, true));
  loadPerformance().catch(() => {});
})();
