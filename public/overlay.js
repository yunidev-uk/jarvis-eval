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
};

applyUiState();

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url =
    `${protocol}//${window.location.host}` +
    `/ws?session=${encodeURIComponent(sessionId)}`;
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

  els.statusDot.classList.toggle("on", Boolean(session.enabled));
  els.statusText.textContent = session.enabled ? "Live" : "Paused";

  els.leftName.textContent = left.name;
  els.rightName.textContent = right.name;

  els.headline.textContent =
    analysis.headline ||
    defaultHeadline(leftPct, rightPct, left.name, right.name);

  els.updated.textContent = analysis.updatedAt
    ? `Updated ${formatTime(analysis.updatedAt)}`
    : "No updates yet";

  els.rationale.textContent = analysis.rationale || "";

  els.leftMetric.textContent =
    `${leftPct.toFixed(1)}% • ${formatNumber(left.progress)} progress`;
  els.rightMetric.textContent =
    `${rightPct.toFixed(1)}% • ${formatNumber(right.progress)} progress`;

  els.leftFill.style.width = `${leftPct}%`;
  els.rightFill.style.width = `${rightPct}%`;
}

function getSides(session, analysis) {
  const scoreById = new Map(
    (analysis.participants || []).map((item) => [item.id, item]),
  );

  const sessionParticipants = (session.participants || []).slice(0, 2);
  const sides = sessionParticipants.map((participant) => {
    const score = scoreById.get(participant.id) || {};

    return {
      id: participant.id,
      name: participant.name || "Unknown",
      share: toNumber(score.share),
      progress: toNumber(score.progress),
    };
  });

  while (sides.length < 2) {
    sides.push({
      id: `placeholder-${sides.length}`,
      name: sides.length === 0 ? "Left" : "Right",
      share: 0,
      progress: 0,
    });
  }

  if (ui.flip) {
    sides.reverse();
  }

  return sides;
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

connect();