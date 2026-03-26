import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEvenScoreState,
  createInitialParticipants,
  mergeScores,
  normalizeShares,
} from "../src/scoring.js";

test("normalizeShares returns equal bars for zero progress", () => {
  assert.deepEqual(normalizeShares([0, 0]), [50, 50]);
});

test("mergeScores uses direct scores without smoothing", () => {
  const participants = createInitialParticipants(2);
  const merged = mergeScores(participants, [
    { id: participants[1].id, progress: 80, summary: "Ahead" },
    { id: participants[0].id, progress: 20, summary: "Behind" },
  ]);

  assert.equal(merged[0].id, participants[0].id);
  assert.equal(merged[1].id, participants[1].id);
  assert.equal(merged[0].progress, 20);
  assert.equal(merged[1].progress, 80);
  assert.ok(merged[1].share > merged[0].share);
});

test("buildEvenScoreState stays even when waiting", () => {
  const participants = createInitialParticipants(3);
  const state = buildEvenScoreState(participants, "Waiting.");
  const total = state.participants.reduce((sum, participant) => sum + participant.share, 0);
  assert.equal(state.participants.length, 3);
  assert.ok(Math.abs(total - 100) < 0.001);
});
