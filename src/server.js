import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import {
  buildEvenScoreState,
  createInitialParticipants,
  mergeScores,
  participantColor,
} from "./scoring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.warn(`Failed to load .env: ${error.message}`);
  }
}

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";

const sessions = new Map();
const webSocketClients = new Set();

function createSession(id = "default") {
  const participants = createInitialParticipants(2);
  const evenScore = buildEvenScoreState(participants, "No screenshots yet.");
  return {
    id,
    enabled: false,
    problemStatement: "",
    model: DEFAULT_MODEL,
    analysisIntervalMs: 12000,
    lastAnalyzedAt: 0,
    inFlight: false,
    apiKeyOverride: "",
    captureHints: "Pop each Discord stream into its own window, then assign that window to a participant card.",
    participants,
    latestAnalysis: {
      headline: evenScore.headline,
      rationale: evenScore.rationale,
      participants: evenScore.participants,
      updatedAt: null,
      model: DEFAULT_MODEL,
      error: "",
    },
  };
}

function getSession(id = "default") {
  if (!sessions.has(id)) {
    sessions.set(id, createSession(id));
  }
  return sessions.get(id);
}

function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function getMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function serveStaticFile(response, filePath) {
  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": getMimeType(filePath) });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function publicSessionState(session) {
  return {
    id: session.id,
    enabled: session.enabled,
    problemStatement: session.problemStatement,
    model: session.model,
    analysisIntervalMs: session.analysisIntervalMs,
    captureHints: session.captureHints,
    participants: session.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      color: participant.color,
      sourceLabel: participant.sourceLabel,
      hasFrame: Boolean(participant.lastFrameDataUrl),
      lastFrameAt: participant.lastFrameAt,
    })),
    latestAnalysis: session.latestAnalysis,
    overlayUrl: `/overlay.html?session=${encodeURIComponent(session.id)}`,
  };
}

function broadcastState(sessionId) {
  const session = getSession(sessionId);
  const payload = JSON.stringify({
    type: "state",
    session: publicSessionState(session),
  });

  for (const client of webSocketClients) {
    if (client.readyState !== 1 || client.sessionId !== sessionId) {
      continue;
    }
    client.send(payload);
  }
}

function assertControlAccess(request) {
  if (!CONTROL_TOKEN) {
    return true;
  }

  return request.headers["x-control-token"] === CONTROL_TOKEN;
}

function dataUrlToInlinePart(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Invalid frame payload.");
  }

  return {
    inline_data: {
      mime_type: match[1],
      data: match[2],
    },
  };
}

function extractTextFromGeminiResponse(result) {
  const parts = result?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function extractJson(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  const fenced = text.match(/```json\s*([\s\S]+?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Could not find JSON in response: ${text.slice(0, 240)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function buildGeminiPrompt(session) {
  const previousScores = session.latestAnalysis.participants.map((participant) => ({
    id: participant.id,
    name: session.participants.find((item) => item.id === participant.id)?.name ?? participant.id,
    progress: participant.progress ?? 0,
    share: participant.share ?? 0,
    summary: participant.summary ?? "",
  }));

  const instructions = [
    "You are scoring a live coding competition from periodic screenshots.",
    "These are easy competitive-programming tasks.",
    "Code is often incomplete and mid-edit. Reward strong direction and partial logic that is moving toward a correct solution.",
    "Do not punish temporary syntax errors too hard when someone is clearly still typing.",
    "If everyone is roughly blank or only has boilerplate, keep the scores even.",
    "If a correct solution is reached, the progress should be 100%.",
    "Only award 100% progress if the solution has been demonstrated by running in a terminal with a correct example - if a running example is not shown, it is not considered solved",
    "Return strict JSON only.",
  ].join("\n");

  const schema = {
    headline: "short summary",
    rationale: "one to three sentences",
    participants: session.participants.map((participant) => ({
      id: participant.id,
      progress: "number 0-100",
      summary: "short sentence",
      evidence: "brief evidence from screenshot",
      confidence: "number 0-1",
    })),
  };

  const participantList = session.participants
    .map((participant, index) => `${index + 1}. ${participant.name} (${participant.id})`)
    .join("\n");

  return [
    instructions,
    "",
    "Problem statement:",
    session.problemStatement.trim() || "(missing)",
    "",
    "Participants:",
    participantList,
    "",
    "Previous scores:",
    JSON.stringify(previousScores, null, 2),
    "",
    "Output schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

async function scoreSession(session) {
  if (session.inFlight || !session.enabled) {
    return;
  }

  if (!session.problemStatement.trim()) {
    session.latestAnalysis = {
      ...session.latestAnalysis,
      headline: "Waiting for a problem statement",
      rationale: "Paste the round prompt before enabling scoring.",
      error: "",
      updatedAt: new Date().toISOString(),
    };
    session.lastAnalyzedAt = Date.now();
    broadcastState(session.id);
    return;
  }

  const missingFrames = session.participants.filter((participant) => !participant.lastFrameDataUrl);
  if (missingFrames.length) {
    const evenState = buildEvenScoreState(
      session.participants,
      `Waiting for screenshots from ${missingFrames.map((item) => item.name).join(", ")}.`,
    );
    session.latestAnalysis = {
      ...session.latestAnalysis,
      ...evenState,
      updatedAt: new Date().toISOString(),
      error: "",
    };
    session.lastAnalyzedAt = Date.now();
    broadcastState(session.id);
    return;
  }

  const apiKey = session.apiKeyOverride || process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    session.latestAnalysis = {
      ...session.latestAnalysis,
      headline: "Gemini API key missing",
      rationale: "Set GEMINI_API_KEY or enter a temporary key in the control page.",
      error: "Missing Gemini API key.",
      updatedAt: new Date().toISOString(),
    };
    session.lastAnalyzedAt = Date.now();
    broadcastState(session.id);
    return;
  }

  session.inFlight = true;
  broadcastState(session.id);

  try {
    const contents = [
      {
        parts: [{ text: buildGeminiPrompt(session) }],
      },
    ];

    for (const participant of session.participants) {
      contents[0].parts.push({ text: `Screenshot for ${participant.name} (${participant.id}).` });
      contents[0].parts.push(dataUrlToInlinePart(participant.lastFrameDataUrl));
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(session.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            thinkingConfig: {
              thinkingLevel: "low"
            },
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status}): ${await response.text()}`);
    }

    const result = await response.json();
    const parsed = extractJson(extractTextFromGeminiResponse(result));
    const mergedParticipants = mergeScores(
      session.participants,
      parsed.participants,
    );

    session.latestAnalysis = {
      headline: parsed.headline || "Leaderboard updated",
      rationale: parsed.rationale || "",
      participants: mergedParticipants,
      updatedAt: new Date().toISOString(),
      model: session.model,
      error: "",
    };
    session.lastAnalyzedAt = Date.now();
  } catch (error) {
    session.latestAnalysis = {
      ...session.latestAnalysis,
      headline: "Gemini scoring failed",
      rationale: error.message,
      error: error.message,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    session.inFlight = false;
    broadcastState(session.id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.enabled || session.inFlight) {
      continue;
    }
    if (now - session.lastAnalyzedAt < session.analysisIntervalMs) {
      continue;
    }
    scoreSession(session);
  }
}, 1000);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(302, { location: "/control.html" });
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    const session = getSession(url.searchParams.get("id") || "default");
    sendJson(response, 200, { session: publicSessionState(session) });
    return;
  }

  if (url.pathname.startsWith("/api/") && !assertControlAccess(request) && request.method !== "GET") {
    sendJson(response, 401, { error: "Control token rejected." });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session/config") {
    try {
      const body = await readBody(request);
      const session = getSession(body.id || "default");
      session.problemStatement = String(body.problemStatement || "");
      session.model = String(body.model || DEFAULT_MODEL);
      session.analysisIntervalMs = Math.max(3000, Number(body.analysisIntervalMs) || 12000);
      session.apiKeyOverride = String(body.apiKey || "");

      const nextParticipants = Array.isArray(body.participants) ? body.participants : [];
      session.participants = nextParticipants.length
        ? nextParticipants.map((participant, index) => {
            const current = session.participants.find((item) => item.id === participant.id);
            return {
              id: participant.id || current?.id || randomId(`p${index + 1}`),
              name: String(participant.name || current?.name || `Participant ${index + 1}`),
              color: participant.color || current?.color || participantColor(index),
              lastFrameAt: current?.lastFrameAt || null,
              lastFrameDataUrl: current?.lastFrameDataUrl || null,
              sourceLabel: current?.sourceLabel || null,
            };
          })
        : createInitialParticipants(2);

      if (session.latestAnalysis.participants.length !== session.participants.length) {
        const evenState = buildEvenScoreState(session.participants, "Waiting for useful code.");
        session.latestAnalysis = {
          ...session.latestAnalysis,
          ...evenState,
          updatedAt: new Date().toISOString(),
        };
      }

      broadcastState(session.id);
      sendJson(response, 200, { ok: true, session: publicSessionState(session) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session/toggle") {
    try {
      const body = await readBody(request);
      const session = getSession(body.id || "default");
      session.enabled = Boolean(body.enabled);
      session.lastAnalyzedAt = 0;
      if (!session.enabled) {
        session.inFlight = false;
      }
      broadcastState(session.id);
      sendJson(response, 200, { ok: true, session: publicSessionState(session) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session/frame") {
    try {
      const body = await readBody(request);
      const session = getSession(body.id || "default");
      const participant = session.participants.find((item) => item.id === body.participantId);
      if (!participant) {
        sendJson(response, 404, { error: "Participant not found." });
        return;
      }

      participant.lastFrameDataUrl = String(body.image || "");
      participant.lastFrameAt = new Date().toISOString();
      participant.sourceLabel = typeof body.sourceLabel === "string" ? body.sourceLabel : participant.sourceLabel;
      if (session.enabled) {
        session.lastAnalyzedAt = 0;
      }
      broadcastState(session.id);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/session/clear-frame") {
    try {
      const body = await readBody(request);
      const session = getSession(body.id || "default");
      const participant = session.participants.find((item) => item.id === body.participantId);
      if (!participant) {
        sendJson(response, 404, { error: "Participant not found." });
        return;
      }

      participant.lastFrameDataUrl = null;
      participant.lastFrameAt = null;
      participant.sourceLabel = "";
      broadcastState(session.id);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }

  const requestedPath = url.pathname === "/" ? "/control.html" : url.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  await serveStaticFile(response, filePath);
});

const websocketServer = new WebSocketServer({ noServer: true });

websocketServer.on("connection", (socket, request, sessionId) => {
  socket.sessionId = sessionId;
  webSocketClients.add(socket);
  socket.send(
    JSON.stringify({
      type: "state",
      session: publicSessionState(getSession(sessionId)),
    }),
  );

  socket.on("close", () => {
    webSocketClients.delete(socket);
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const sessionId = url.searchParams.get("session") || "default";
  websocketServer.handleUpgrade(request, socket, head, (wsSocket) => {
    websocketServer.emit("connection", wsSocket, request, sessionId);
  });
});

server.listen(PORT, HOST, () => {
  getSession("default");
  console.log(`Jarvis live reviewer listening on http://${HOST}:${PORT}`);
});





