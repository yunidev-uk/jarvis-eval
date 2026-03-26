const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session") || "default";
const mode = normalizeMode(params.get("mode"));

const modeDefaults = {
  bar: {
    showTitle: false,
    showLabels: false,
    showDetails: false,
    showRationale: false,
    showStatus: false,
    showUpdated: false,
  },
  compact: {
    showTitle: false,
    showLabels: true,
    showDetails: false,
    showRationale: false,
    showStatus: false,
    showUpdated: false,
  },
  full: {
    showTitle: true,
    showLabels: true,
    showDetails: true,
    showRationale: true,
    showStatus: true,
    showUpdated: true,
  },
};

const defaults = modeDefaults[mode];

const ui = {
  showTitle: readBool("title", defaults.showTitle),
  showLabels: readBool("labels", defaults.showLabels),
  showDetails: readBool("details", defaults.showDetails),
  showRationale: readBool("rationale", defaults.showRationale),
  showStatus: readBool("status", defaults.showStatus),
  showUpdated: readBool("updated", defaults.showUpdated),
  flip: readBool("flip", false),
};

const els = {
  title: document.getElementById("overlay-title"),
  statusDot: document.getElementById("overlay-status-dot"),
  statusText: document.getElementById("overlay-status-text"),
  headline: document.getElementById("overlay-headline"),
  updated: document.getElementById("overlay-updated"),
  rationale: document.getElementById("overlay-rationale"),
  leftName: document.getElementById("left-name"),
  rightName: document.getElementById("right-name"),
  leftMetric: document.getElementById("left-metric"),
  rightMetric: document.getElementById("right-metric"),
  leftFill: document.getElementById("eval-left"),
  rightFill: document.getElementById("eval-right"),
  bar: document.getElementById("eval-bar"),
  doneLabel: document.getElementById("eval-done-label"),
};

applyUiState();

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?session=${encodeURIComponent(sessionId)}`;
  const socket = new WebSocket(url);

  socket.addEventListener("message", (event) => {
    let payload;

    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type !== "state") {
      return;
    }

    render(payload.session || {});
  });

  socket.addEventListener("close", () => {
    setTimeout(connect, 1000);
  });
}

function render(session) {
  const analysis = session.latestAnalysis || {};
  const sides = getSides(session, analysis);
  const left = sides[0];
  const right = sides[1];
  const [leftPct, rightPct] = normalizeShares(
    left.share,
    right.share,
    (session.participants || []).length,
  );
  const doneSide = getDoneSide(sides);

  els.statusDot.classList.toggle("on", Boolean(session.enabled));
  els.statusText.textContent = session.enabled ? "Live" : "Paused";

  els.leftName.textContent = left.name;
  els.rightName.textContent = right.name;

  els.headline.textContent = doneSide
    ? `${doneSide.name} is done`
    : analysis.headline || defaultHeadline(leftPct, rightPct, left.name, right.name);

  els.updated.textContent = analysis.updatedAt
    ? `Updated ${formatTime(analysis.updatedAt)}`
    : "No updates yet";

  els.rationale.textContent = analysis.rationale || "";

  els.leftMetric.textContent = `${leftPct.toFixed(1)}% • ${formatNumber(left.progress)} progress`;
  els.rightMetric.textContent = `${rightPct.toFixed(1)}% • ${formatNumber(right.progress)} progress`;

  renderBar(left, right, leftPct, rightPct, doneSide);
}

function renderBar(left, right, leftPct, rightPct, doneSide) {
  els.leftFill.style.background = left.color;
  els.rightFill.style.background = right.color;

  if (doneSide) {
    els.bar.classList.add("is-done");
    els.bar.style.setProperty("--done-color", doneSide.color);
    els.bar.style.setProperty("--done-text-color", getReadableTextColor(doneSide.color));
    els.doneLabel.hidden = false;
    els.doneLabel.textContent = `${doneSide.name} is done`;

    if (doneSide.id === left.id) {
      els.leftFill.style.width = "100%";
      els.rightFill.style.width = "0%";
    } else {
      els.leftFill.style.width = "0%";
      els.rightFill.style.width = "100%";
    }
    return;
  }

  els.bar.classList.remove("is-done");
  els.bar.style.removeProperty("--done-color");
  els.bar.style.removeProperty("--done-text-color");
  els.doneLabel.hidden = true;
  els.doneLabel.textContent = "";
  els.leftFill.style.width = `${leftPct}%`;
  els.rightFill.style.width = `${rightPct}%`;
}

function getSides(session, analysis) {
  const scoreById = new Map((analysis.participants || []).map((item) => [item.id, item]));

  const sessionParticipants = (session.participants || []).slice(0, 2);
  const sides = sessionParticipants.map((participant, index) => {
    const score = scoreById.get(participant.id) || {};

    return {
      id: participant.id,
      name: participant.name || "Unknown",
      share: toNumber(score.share),
      progress: toNumber(score.progress),
      color: participant.color || fallbackColor(index),
    };
  });

  while (sides.length < 2) {
    const index = sides.length;
    sides.push({
      id: `placeholder-${index}`,
      name: index === 0 ? "Left" : "Right",
      share: 0,
      progress: 0,
      color: fallbackColor(index),
    });
  }

  if (ui.flip) {
    sides.reverse();
  }

  return sides;
}

function getDoneSide(sides) {
  return (
    sides
      .filter((side) => side.progress >= 100)
      .sort((left, right) => right.progress - left.progress)[0] || null
  );
}

function normalizeShares(leftShare, rightShare, participantCount) {
  const left = Math.max(0, toNumber(leftShare));
  const right = Math.max(0, toNumber(rightShare));
  const total = left + right;

  if (total > 0) {
    return [(left / total) * 100, (right / total) * 100];
  }

  if (participantCount === 1) {
    return [100, 0];
  }

  return [50, 50];
}

function defaultHeadline(leftPct, rightPct, leftName, rightName) {
  const gap = leftPct - rightPct;

  if (Math.abs(gap) < 1) {
    return "Scores are even";
  }

  return gap > 0 ? `${leftName} is ahead` : `${rightName} is ahead`;
}

function applyUiState() {
  document.body.dataset.mode = mode;
  document.body.dataset.showTitle = flag(ui.showTitle);
  document.body.dataset.showLabels = flag(ui.showLabels);
  document.body.dataset.showDetails = flag(ui.showDetails);
  document.body.dataset.showRationale = flag(ui.showRationale);
  document.body.dataset.showStatus = flag(ui.showStatus);
  document.body.dataset.showUpdated = flag(ui.showUpdated);
  document.body.dataset.showFooter = flag(ui.showStatus || ui.showUpdated);
}

function normalizeMode(value) {
  if (value === "bar" || value === "compact" || value === "full") {
    return value;
  }

  return "compact";
}

function readBool(key, fallback) {
  const value = params.get(key);

  if (value == null) {
    return fallback;
  }

  return value === "1" || value === "true";
}

function flag(value) {
  return value ? "1" : "0";
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
  return toNumber(value).toFixed(1);
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fallbackColor(index) {
  return index === 0 ? "#ff8c42" : "#4f8cff";
}

function getReadableTextColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#071018" : "#f8fbff";
}

function hexToRgb(hex) {
  const normalized = String(hex || "").trim().replace(/^#/, "");
  const value = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized.padEnd(6, "0").slice(0, 6);
  const int = Number.parseInt(value, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

connect();
