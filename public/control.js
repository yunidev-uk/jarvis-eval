const state = {
  sessionId: "default",
  session: null,
  captureTimer: null,
  captureLoopMs: null,
  captures: new Map(),
};

const els = {
  sessionId: document.getElementById("session-id"),
  model: document.getElementById("model"),
  analysisInterval: document.getElementById("analysis-interval"),
  apiKey: document.getElementById("api-key"),
  problemStatement: document.getElementById("problem-statement"),
  saveSettings: document.getElementById("save-settings"),
  toggleScoring: document.getElementById("toggle-scoring"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  overlayLink: document.getElementById("overlay-link"),
  captureHints: document.getElementById("capture-hints"),
  headline: document.getElementById("headline"),
  rationale: document.getElementById("rationale"),
  updatedAt: document.getElementById("updated-at"),
  modelReadout: document.getElementById("model-readout"),
  addParticipant: document.getElementById("add-participant"),
  saveParticipants: document.getElementById("save-participants"),
  participantList: document.getElementById("participant-list"),
};

function createParticipantDraft(participant = {}, index = 0) {
  return {
    id: participant.id || `p_${crypto.randomUUID().slice(0, 8)}`,
    name: participant.name || "New Participant",
    color: participant.color || fallbackColor(index),
    sourceLabel: participant.sourceLabel || "",
    hasFrame: Boolean(participant.hasFrame),
    lastFrameAt: participant.lastFrameAt || null,
  };
}

function getParticipantDraftMap() {
  return new Map(
    Array.from(els.participantList.querySelectorAll("[data-participant-id]"))
      .map((card, index) => {
        const name = card.querySelector(".participant-name")?.value.trim();
        const color = card.querySelector(".participant-color")?.value || fallbackColor(index);
        return [card.dataset.participantId, { name, color }];
      })
      .filter((entry) => entry[1].name || entry[1].color),
  );
}

function getDraftParticipants() {
  return Array.from(els.participantList.querySelectorAll("[data-participant-id]"))
    .map((card, index) => ({
      id: card.dataset.participantId,
      name: card.querySelector(".participant-name").value.trim() || "Participant",
      color: card.querySelector(".participant-color")?.value || fallbackColor(index),
    }));
}

function currentLoopMs() {
  return Math.max(3000, Number(state.session?.analysisIntervalMs) || 12000);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

async function loadSession() {
  state.sessionId = els.sessionId.value.trim() || "default";
  const payload = await jsonFetch(`/api/session?id=${encodeURIComponent(state.sessionId)}`);
  state.session = payload.session;
  populateForm(true);
  renderParticipants(true);
  ensureSocket();
  startCaptureLoop();
}

function populateForm(force = false) {
  const session = state.session;
  els.overlayLink.innerHTML = `Overlay URL: <span class="inline-code">${window.location.origin}${session.overlayUrl}</span>`;
  els.captureHints.textContent = session.captureHints;
  renderAnalysis(session.latestAnalysis);
  renderStatus();

  if (!force) {
    return;
  }

  els.sessionId.value = session.id;
  els.model.value = session.model;
  els.analysisInterval.value = session.analysisIntervalMs;
  els.problemStatement.value = session.problemStatement;
}

function renderStatus() {
  const enabled = Boolean(state.session?.enabled);
  els.statusDot.classList.toggle("on", enabled);
  els.statusText.textContent = enabled ? "Scoring enabled" : "Scoring disabled";
  els.toggleScoring.textContent = enabled ? "Disable Scoring" : "Enable Scoring";
  els.toggleScoring.classList.toggle("danger", enabled);
  els.toggleScoring.classList.toggle("secondary", !enabled);
}

function renderAnalysis(analysis) {
  els.headline.textContent = analysis?.headline || "Scores are even";
  els.rationale.textContent = analysis?.rationale || "Waiting for the next update.";
  els.updatedAt.textContent = analysis?.updatedAt
    ? new Date(analysis.updatedAt).toLocaleString()
    : "Never";
  els.modelReadout.textContent = analysis?.model || state.session?.model || "Unknown";
}

function shouldRebuildParticipants(participants) {
  const cards = Array.from(els.participantList.querySelectorAll("[data-participant-id]"));
  if (cards.length !== participants.length) {
    return true;
  }

  return cards.some((card, index) => card.dataset.participantId !== participants[index]?.id);
}

function renderParticipants(forceRebuild = false) {
  const participants = state.session?.participants ?? [];
  if (forceRebuild || shouldRebuildParticipants(participants)) {
    rebuildParticipantCards(participants);
  }
  syncParticipantCards(participants);
}

function rebuildParticipantCards(participants) {
  const draftById = getParticipantDraftMap();
  els.participantList.innerHTML = "";

  for (const [index, participant] of participants.entries()) {
    const draft = draftById.get(participant.id) || {};
    const displayName = draft.name || participant.name;
    const displayColor = draft.color || participant.color || fallbackColor(index);
    const card = document.createElement("article");
    card.className = "participant-card";
    card.dataset.participantId = participant.id;
    card.innerHTML = `
      <div class="participant-header">
        <div class="participant-header-main">
          <input class="participant-name" value="${escapeHtml(displayName)}" aria-label="Participant name">
          <input class="participant-color" type="color" value="${escapeHtml(displayColor)}" aria-label="Participant color">
        </div>
        <div class="button-row">
          <button type="button" class="secondary connect-source">Connect Source</button>
          <button type="button" class="secondary disconnect-source">Disconnect</button>
          <button type="button" class="danger remove-participant">Remove</button>
        </div>
      </div>
      <div class="participant-meta">
        <div>Source: <span class="source-label">Not connected</span></div>
        <div>Last frame: <span class="last-frame">Never</span></div>
        <div>Current score: <span class="current-score">No score yet</span></div>
      </div>
      <video class="preview" autoplay muted playsinline></video>
      <p class="tiny participant-summary">Connect a capture source to start sending screenshots.</p>
    `;

    card.querySelector(".connect-source").addEventListener("click", () => connectSource(participant.id).catch(showError));
    card.querySelector(".disconnect-source").addEventListener("click", () => disconnectSource(participant.id).catch(showError));
    card.querySelector(".remove-participant").addEventListener("click", () => removeParticipant(participant.id));
    els.participantList.append(card);
  }
}

function syncParticipantCards(participants) {
  for (const participant of participants) {
    const card = els.participantList.querySelector(`[data-participant-id="${participant.id}"]`);
    if (!card) {
      continue;
    }

    const analysisEntry = state.session.latestAnalysis.participants.find((item) => item.id === participant.id);
    const capture = state.captures.get(participant.id);
    const video = card.querySelector("video");
    const sourceLabel = capture?.sourceLabel || participant.sourceLabel || "Not connected";
    const scoreText = analysisEntry
      ? `${analysisEntry.share.toFixed(1)}% bar / ${analysisEntry.progress.toFixed(1)} progress`
      : "No score yet";
    const summaryText = analysisEntry?.summary || "Connect a capture source to start sending screenshots.";

    card.querySelector(".participant-name").value = participant.name;
    card.querySelector(".source-label").textContent = sourceLabel;
    card.querySelector(".last-frame").textContent = participant.lastFrameAt
      ? new Date(participant.lastFrameAt).toLocaleTimeString()
      : "Never";
    card.querySelector(".current-score").textContent = scoreText;
    card.querySelector(".participant-summary").textContent = summaryText;

    if (capture?.videoStream && video.srcObject !== capture.videoStream) {
      video.srcObject = capture.videoStream;
    }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function saveSettings() {
  const body = {
    id: els.sessionId.value.trim() || "default",
    model: els.model.value.trim() || "gemini-2.0-flash",
    analysisIntervalMs: Number(els.analysisInterval.value) || 12000,
    apiKey: els.apiKey.value.trim(),
    problemStatement: els.problemStatement.value,
    participants: getDraftParticipants(),
  };

  const payload = await jsonFetch("/api/session/config", {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.sessionId = payload.session.id;
  state.session = payload.session;
  state.captureLoopMs = null;
  populateForm(true);
  renderParticipants(true);
  startCaptureLoop();
}

async function toggleScoring() {
  const payload = await jsonFetch("/api/session/toggle", {
    method: "POST",
    body: JSON.stringify({
      id: state.sessionId,
      enabled: !state.session.enabled,
    }),
  });
  state.session = payload.session;
  populateForm(false);
  startCaptureLoop();
  if (state.session.enabled) {
    await uploadAllFrames();
  }
}

function addParticipant() {
  const participant = createParticipantDraft({}, state.session.participants.length);
  state.session.participants.push(participant);
  if (!state.session.latestAnalysis.participants.find((item) => item.id === participant.id)) {
    state.session.latestAnalysis.participants.push({
      id: participant.id,
      progress: 0,
      share: 0,
      color: participant.color,
      summary: "Waiting for screenshots.",
      evidence: "",
      confidence: 0,
    });
  }
  renderParticipants(true);
}

function removeParticipant(participantId) {
  disconnectSource(participantId).catch(showError);
  state.session.participants = state.session.participants.filter((participant) => participant.id !== participantId);
  state.session.latestAnalysis.participants = state.session.latestAnalysis.participants.filter((participant) => participant.id !== participantId);
  renderParticipants(true);
}

async function connectSource(participantId) {
  const participant = state.session.participants.find((item) => item.id === participantId);
  if (!participant) {
    return;
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: 1,
    },
    audio: false,
  });

  await disconnectSource(participantId);

  const track = stream.getVideoTracks()[0];
  const capture = {
    participantId,
    videoStream: stream,
    sourceLabel: track.label || "Shared window",
    videoEl: document.createElement("video"),
    canvasEl: document.createElement("canvas"),
  };

  capture.videoEl.srcObject = stream;
  capture.videoEl.muted = true;
  capture.videoEl.playsInline = true;
  await capture.videoEl.play();
  state.captures.set(participantId, capture);

  track.addEventListener("ended", () => {
    disconnectSource(participantId).catch(showError);
  });

  participant.sourceLabel = capture.sourceLabel;
  renderParticipants(false);
  if (state.session?.enabled) {
    await uploadFrame(participantId, capture);
  }
}

async function disconnectSource(participantId) {
  const capture = state.captures.get(participantId);
  if (capture) {
    for (const track of capture.videoStream.getTracks()) {
      track.stop();
    }
    state.captures.delete(participantId);
  }

  const participant = state.session?.participants.find((item) => item.id === participantId);
  if (participant) {
    participant.sourceLabel = "";
    participant.lastFrameAt = null;
    participant.hasFrame = false;
  }

  renderParticipants(false);

  try {
    await jsonFetch("/api/session/clear-frame", {
      method: "POST",
      body: JSON.stringify({
        id: state.sessionId,
        participantId,
      }),
    });
  } catch (error) {
    console.error("Failed to clear frame", error);
  }
}

function startCaptureLoop() {
  const loopMs = currentLoopMs();
  if (state.captureTimer && state.captureLoopMs === loopMs) {
    return;
  }

  if (state.captureTimer) {
    clearInterval(state.captureTimer);
  }

  state.captureLoopMs = loopMs;
  state.captureTimer = setInterval(async () => {
    if (!state.session?.enabled) {
      return;
    }

    await uploadAllFrames();
  }, loopMs);
}

async function uploadAllFrames() {
  for (const [participantId, capture] of state.captures.entries()) {
    try {
      await uploadFrame(participantId, capture);
    } catch (error) {
      console.error("Failed to upload frame", error);
    }
  }
}

async function uploadFrame(participantId, capture) {
  const width = capture.videoEl.videoWidth;
  const height = capture.videoEl.videoHeight;
  if (!width || !height) {
    return;
  }

  const targetWidth = Math.min(width, 1280);
  const targetHeight = Math.round((height / width) * targetWidth);
  capture.canvasEl.width = targetWidth;
  capture.canvasEl.height = targetHeight;

  const context = capture.canvasEl.getContext("2d", { alpha: false });
  context.drawImage(capture.videoEl, 0, 0, targetWidth, targetHeight);

  const image = capture.canvasEl.toDataURL("image/jpeg", 0.72);
  await jsonFetch("/api/session/frame", {
    method: "POST",
    body: JSON.stringify({
      id: state.sessionId,
      participantId,
      sourceLabel: capture.sourceLabel,
      image,
    }),
  });
}

let socket;

function ensureSocket() {
  if (socket) {
    socket.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws?session=${encodeURIComponent(state.sessionId)}`);

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type !== "state") {
      return;
    }
    state.session = payload.session;
    populateForm(false);
    renderParticipants(false);
    startCaptureLoop();
  });
}

els.saveSettings.addEventListener("click", () => saveSettings().catch(showError));
els.saveParticipants.addEventListener("click", () => saveSettings().catch(showError));
els.toggleScoring.addEventListener("click", () => toggleScoring().catch(showError));
els.addParticipant.addEventListener("click", addParticipant);
els.sessionId.addEventListener("change", () => loadSession().catch(showError));

function fallbackColor(index) {
  const colors = ["#ff8c42", "#4f8cff", "#52d273", "#f55b7a", "#ffd166", "#8bd3ff"];
  return colors[index % colors.length];
}

function showError(error) {
  els.headline.textContent = "Action failed";
  els.rationale.textContent = error.message;
}

loadSession().catch(showError);






