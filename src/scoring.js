const SCORE_FLOOR = 10;

export const PARTICIPANT_COLORS = [
  "#ff8c42",
  "#4f8cff",
  "#52d273",
  "#f55b7a",
  "#ffd166",
  "#8bd3ff",
];

export function participantColor(index) {
  return PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length];
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round1(value) {
  return Math.round(value * 10) / 10;
}

export function equalShare(count) {
  if (count <= 0) {
    return [];
  }

  const even = 100 / count;
  const shares = Array.from({ length: count }, () => round1(even));
  return rebalancePercentages(shares);
}

export function normalizeShares(progressScores) {
  if (!progressScores.length) {
    return [];
  }

  const safeScores = progressScores.map((value) => round1(clamp(value, 0, 100)));
  const hasMeaningfulProgress = safeScores.some((value) => value > 0.5);
  if (!hasMeaningfulProgress) {
    return equalShare(safeScores.length);
  }

  const padded = safeScores.map((value) => value + SCORE_FLOOR);
  const total = padded.reduce((sum, value) => sum + value, 0);
  if (!total) {
    return equalShare(safeScores.length);
  }

  const shares = padded.map((value) => round1((value / total) * 100));
  return rebalancePercentages(shares);
}

export function sanitizeModelScores(participants, candidateScores) {
  const byId = new Map();
  for (const item of candidateScores ?? []) {
    if (!item || typeof item.id !== "string") {
      continue;
    }

    byId.set(item.id, {
      id: item.id,
      progress: round1(clamp(Number(item.progress) || 0, 0, 100)),
      summary: typeof item.summary === "string" ? item.summary.trim() : "",
      evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
      confidence: round1(clamp(Number(item.confidence) || 0, 0, 1)),
    });
  }

  return participants.map((participant) => {
    const existing = byId.get(participant.id);
    if (existing) {
      return existing;
    }

    return {
      id: participant.id,
      progress: 0,
      summary: "No score returned for this participant.",
      evidence: "",
      confidence: 0,
    };
  });
}

export function buildEvenScoreState(participants, reason = "Waiting for useful code.") {
  const share = equalShare(participants.length);
  return {
    headline: "Scores are even",
    rationale: reason,
    participants: participants.map((participant, index) => ({
      id: participant.id,
      progress: 0,
      share: share[index] ?? 0,
      color: participant.color ?? participantColor(index),
      summary: reason,
      evidence: "",
      confidence: 0,
    })),
  };
}

export function mergeScores(participants, rawScores) {
  const sanitized = sanitizeModelScores(participants, rawScores);
  const progress = sanitized.map((item) => item.progress);
  const shares = normalizeShares(progress);

  return sanitized.map((item, index) => ({
    ...item,
    progress: progress[index] ?? item.progress,
    share: shares[index] ?? 0,
  }));
}

export function rebalancePercentages(values) {
  if (!values.length) {
    return [];
  }

  const rounded = values.map((value) => round1(value));
  const total = rounded.reduce((sum, value) => sum + value, 0);
  const delta = round1(100 - total);

  if (Math.abs(delta) < 0.1) {
    return rounded;
  }

  const sorted = rounded
    .map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value);
  const target = sorted[0]?.index ?? 0;
  rounded[target] = round1(rounded[target] + delta);
  return rounded;
}

export function createInitialParticipants(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Participant ${index + 1}`,
    color: participantColor(index),
    lastFrameAt: null,
    lastFrameDataUrl: null,
    sourceLabel: null,
  }));
}
