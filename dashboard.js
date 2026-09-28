"use strict";

const TELEMETRY_FILTER = "smartbin/+/telemetry";
const LOCATION_FILTER = "smartbin/+/location";
const ALERT_THRESHOLD = 85;
const HISTORY_LIMIT = 120;

const $ = id => document.getElementById(id);

let client = null;
let historyChart = null;
let mapFitted = false;

const bins = new Map();
const locations = new Map();
const markers = new Map();

const map = L.map("map").setView([-28.0167, 153.4000], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

function setStatus(text, kind = "") {
  const el = $("mqttStatus");
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function topicDeviceId(topic) {
  const parts = topic.split("/");
  return parts.length >= 3 ? parts[1] : "BIN";
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureBin(id) {
  if (!bins.has(id)) {
    bins.set(id, {
      id,
      capacities: {
        recycled: 0,
        organic: 0,
        landfill: 0
      },
      cpuTemperature: null,
      uptime: null,
      health: "unknown",
      lastTelemetry: null,
      history: []
    });
  }

  return bins.get(id);
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function handleTelemetry(topic, payload) {
  const id = String(payload.bin_id || payload.device_id || topicDeviceId(topic));
  const bin = ensureBin(id);

  const capacities = payload.capacities || {};

  bin.capacities.recycled = clampPercent(capacities.recycled);
  bin.capacities.organic = clampPercent(capacities.organic);
  bin.capacities.landfill = clampPercent(capacities.landfill);

  bin.cpuTemperature = Number.isFinite(Number(payload.cpu_temperature))
    ? Number(payload.cpu_temperature)
    : null;

  bin.uptime = Number.isFinite(Number(payload.uptime))
    ? Number(payload.uptime)
    : null;

  bin.health = String(payload.system_health || "unknown");
  bin.lastTelemetry = Date.now();

  bin.history.push({
    time: Date.now(),
    recycled: bin.capacities.recycled,
    organic: bin.capacities.organic,
    landfill: bin.capacities.landfill
  });

  if (bin.history.length > HISTORY_LIMIT) bin.history.shift();
}

function handleLocation(topic, payload) {
  const id = String(payload.device_id || payload.bin_id || topicDeviceId(topic));
  const loc = payload.location || payload;

  const latitude = Number(loc.latitude);
  const longitude = Number(loc.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;

  locations.set(id, {
    latitude,
    longitude,
    accuracy: Number.isFinite(Number(loc.accuracy_m)) ? Number(loc.accuracy_m) : null,
    timestamp: loc.timestamp || null,
    receivedAt: Date.now()
  });
}

function logRaw(topic, text) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} · ${topic} · ${text.slice(0, 400)}`;
  $("rawLog").prepend(li);

  while ($("rawLog").children.length > 40) {
    $("rawLog").lastChild.remove();
  }
}

function handleMessage(topic, message) {
  const text = message.toString();
  logRaw(topic, text);

  const payload = safeJson(text);
  if (!payload) return;

  $("lastMessage").textContent = new Date().toLocaleTimeString();

  if (topic.endsWith("/telemetry")) {
    handleTelemetry(topic, payload);
  } else if (topic.endsWith("/location")) {
    handleLocation(topic, payload);
  }

  renderAll();
}

function connect() {
  if (client) {
    client.removeAllListeners();
    client.end(true);
    client = null;
    $("connectButton").textContent = "Connect";
    setStatus("Disconnected");
    return;
  }

  const brokerUrl = $("brokerUrl").value.trim();
  const username = $("mqttUsername").value.trim();
  const password = $("mqttPassword").value;

  if (!brokerUrl) {
    setStatus("Broker URL required", "bad");
    return;
  }

  setStatus("Connecting...", "warn");
  $("connectButton").textContent = "Disconnect";

  const options = {
    clientId: "dashboard-" + Math.random().toString(16).slice(2, 10),
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    keepalive: 30
  };

  if (username) options.username = username;
  if (password) options.password = password;

  try {
    client = mqtt.connect(brokerUrl, options);
  } catch (error) {
    client = null;
    $("connectButton").textContent = "Connect";
    setStatus("Connection failed", "bad");
    return;
  }

  client.on("connect", () => {
    setStatus("Connected", "ok");

    client.subscribe(
      [TELEMETRY_FILTER, LOCATION_FILTER],
      { qos: 1 },
      error => {
        if (error) {
          setStatus("Subscribe failed", "bad");
        }
      }
    );
  });

  client.on("message", handleMessage);
  client.on("reconnect", () => setStatus("Reconnecting...", "warn"));
  client.on("offline", () => setStatus("Offline", "warn"));
  client.on("close", () => {
    if (client) setStatus("Disconnected", "warn");
  });
  client.on("error", error => {
    setStatus("MQTT error", "bad");
    console.error(error);
  });
}

function latestBin() {
  const list = [...bins.values()];
  if (!list.length) return null;

  return list.sort(
    (a, b) => (b.lastTelemetry || 0) - (a.lastTelemetry || 0)
  )[0];
}

function levelState(value) {
  if (value > ALERT_THRESHOLD) {
    return { text: "Needs emptying", colour: "#cf2e2e", alert: true };
  }

  if (value >= 60) {
    return { text: "Filling up", colour: "#d99600", alert: false };
  }

  return { text: "OK", colour: "#169c4d", alert: false };
}

function renderCompartment(name, value) {
  const state = levelState(value);

  $(name + "Value").textContent = Math.round(value) + "%";
  $(name + "Bar").style.width = value + "%";
  $(name + "Bar").style.background = state.colour;
  $(name + "Alert").textContent = state.text;
  $(name + "Alert").className = "alert-text" + (state.alert ? " bad" : "");
  $(name + "Card").className = "bin-card" + (state.alert ? " alert" : "");
}

function renderTelemetry() {
  const bin = latestBin();

  if (!bin) {
    renderCompartment("recycled", 0);
    renderCompartment("organic", 0);
    renderCompartment("landfill", 0);

    $("binId").textContent = "—";
    $("health").textContent = "—";
    $("cpuTemp").textContent = "—";
    $("uptime").textContent = "—";
    $("lastTelemetry").textContent = "—";
    return;
  }

  renderCompartment("recycled", bin.capacities.recycled);
  renderCompartment("organic", bin.capacities.organic);
  renderCompartment("landfill", bin.capacities.landfill);

  $("binId").textContent = bin.id;
  $("health").textContent = bin.health;
  $("cpuTemp").textContent =
    bin.cpuTemperature === null ? "—" : bin.cpuTemperature.toFixed(1) + " °C";
  $("uptime").textContent =
    bin.uptime === null ? "—" : Math.round(bin.uptime) + " s";
  $("lastTelemetry").textContent =
    bin.lastTelemetry ? new Date(bin.lastTelemetry).toLocaleTimeString() : "—";
}

function renderKpis() {
  $("deviceCount").textContent = bins.size;
  $("gpsCount").textContent = locations.size;

  let alerts = 0;

  for (const bin of bins.values()) {
    for (const value of Object.values(bin.capacities)) {
      if (value > ALERT_THRESHOLD) alerts += 1;
    }
  }

  $("alertCount").textContent = alerts;
}

function renderGpsTable() {
  const tbody = $("gpsRows");

  if (!locations.size) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "muted";
    cell.textContent = "No GPS received yet.";
    row.append(cell);
    tbody.replaceChildren(row);
    $("lastGps").textContent = "—";
    return;
  }

  const rows = [];

  for (const [id, loc] of locations) {
    const row = document.createElement("tr");

    const values = [
      id,
      loc.latitude.toFixed(5),
      loc.longitude.toFixed(5),
      loc.accuracy === null ? "—" : "±" + Math.round(loc.accuracy) + " m"
    ];

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }

    rows.push(row);
  }

  tbody.replaceChildren(...rows);

  const latest = [...locations.values()].sort(
    (a, b) => b.receivedAt - a.receivedAt
  )[0];

  $("lastGps").textContent = new Date(latest.receivedAt).toLocaleTimeString();
}

function renderMap() {
  if (!locations.size) {
    $("mapNote").textContent =
      "Waiting for a GPS message from the smartphone on smartbin/+/location.";
    return;
  }

  $("mapNote").textContent =
    "Marker position comes from the smartphone GPS published through MQTT.";

  for (const [id, loc] of locations) {
    const point = [loc.latitude, loc.longitude];
    let marker = markers.get(id);

    if (!marker) {
      marker = L.marker(point).addTo(map);
      markers.set(id, marker);
    }

    marker.setLatLng(point);

    const bin = bins.get(id);
    const details = bin
      ? `Recycled ${Math.round(bin.capacities.recycled)}% · Organic ${Math.round(bin.capacities.organic)}% · Landfill ${Math.round(bin.capacities.landfill)}%`
      : "No matching telemetry received yet.";

    const popup = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = id;
    const br = document.createElement("br");
    const text = document.createTextNode(details);

    popup.append(strong, br, text);
    marker.bindPopup(popup);
  }

  if (!mapFitted) {
    const bounds = L.latLngBounds(
      [...locations.values()].map(loc => [loc.latitude, loc.longitude])
    );

    map.fitBounds(bounds.pad(0.25), { maxZoom: 17 });
    mapFitted = true;
  }
}

function initChart() {
  historyChart = new Chart($("historyChart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Recycled", data: [], tension: 0.25 },
        { label: "Organic", data: [], tension: 0.25 },
        { label: "Landfill", data: [], tension: 0.25 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        y: {
          min: 0,
          max: 100,
          title: {
            display: true,
            text: "Fill level (%)"
          }
        }
      }
    }
  });
}

function renderHistory() {
  const bin = latestBin();
  const history = bin ? bin.history : [];

  historyChart.data.labels = history.map(
    sample => new Date(sample.time).toLocaleTimeString()
  );

  historyChart.data.datasets[0].data =
    history.map(sample => sample.recycled);

  historyChart.data.datasets[1].data =
    history.map(sample => sample.organic);

  historyChart.data.datasets[2].data =
    history.map(sample => sample.landfill);

  historyChart.update();
}

function renderAll() {
  renderKpis();
  renderTelemetry();
  renderGpsTable();
  renderMap();
  renderHistory();
}

$("connectButton").addEventListener("click", connect);

window.addEventListener("pagehide", () => {
  if (client) client.end(true);
});

initChart();
renderAll();
