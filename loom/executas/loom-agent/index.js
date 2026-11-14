'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');

// Keep stdin open — Anna sends more requests after describe
process.stdin.resume();

// ─── Load tool manifest (returned by describe) ─────────────────────────────
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
);

// ─── JSON-RPC over stdio ───────────────────────────────────────────────────
// stdout = protocol messages only (single line JSON + \n, flushed immediately)
// stderr = all logs and debug output
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Pending reverse calls we made to Anna host — keyed by id
const pendingHostCalls = new Map();
let hostCallId = 1;

function send(obj) {
  // Single-line JSON terminated with \n — Anna reads one line at a time
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── Reverse call to Anna host ─────────────────────────────────────────────
// Write a JSON-RPC request to stdout. Anna intercepts it, executes it,
// and writes the response back to our stdin.
function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = `host-${hostCallId++}`;

    const timer = setTimeout(() => {
      if (pendingHostCalls.has(id)) {
        pendingHostCalls.delete(id);
        reject(new Error(`Host call timed out: ${method}`));
      }
    }, 15000);

    pendingHostCalls.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });

    // Send AFTER registering pending — avoid race condition
    send({ jsonrpc: '2.0', id, method, params });
  });
}

// ─── Anna storage helpers ──────────────────────────────────────────────────
async function storageGet(key) {
  try {
    const res = await callHost('storage/get', { key });
    return (res && res.value !== undefined) ? res.value : null;
  } catch {
    return null;
  }
}

async function storageSet(key, value) {
  try {
    await callHost('storage/set', { key, value });
  } catch (e) {
    process.stderr.write(`[loom] storage/set failed: ${e.message}\n`);
  }
}

// ─── Anna credentials helper ───────────────────────────────────────────────
async function getCredential(id) {
  try {
    const res = await callHost('credentials/get', { id });
    return (res && res.value) ? res.value : null;
  } catch {
    return null;
  }
}

// ─── Anna sampling helper ──────────────────────────────────────────────────
async function askLLM(systemPrompt, userMessage) {
  const res = await callHost('sampling/createMessage', {
    messages: [{ role: 'user', content: userMessage }],
    system: systemPrompt,
    maxTokens: 1500,
  });
  if (!res || !res.content) return '';
  if (Array.isArray(res.content)) {
    const block = res.content.find(b => b.type === 'text');
    return block ? block.text : '';
  }
  return typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
}

// ─── FlowDev bridge ────────────────────────────────────────────────────────
let fdSocket = null;
let fdToken = null;
const fdPending = new Map();

function connectFlowDev(token) {
  // Already connected with this token — nothing to do
  if (fdSocket && fdSocket.connected && fdToken === token) return;

  fdToken = token;
  if (fdSocket) fdSocket.disconnect();

  // Lazy-load socket.io-client so the process starts and responds to
  // describe immediately, before the user has provided a token
  const { io } = require('socket.io-client');

  fdSocket = io('https://flowdev.onrender.com', {
    query: { userId: token },
    reconnection: true,
    reconnectionDelay: 2000,
    timeout: 20000,
  });

  fdSocket.on('connect', () => {
    process.stderr.write('[loom] FlowDev socket connected\n');
  });

  fdSocket.on('disconnect', () => {
    process.stderr.write('[loom] FlowDev socket disconnected\n');
  });

  fdSocket.on('tool_result', ({ requestId, success, data, error }) => {
    const pending = fdPending.get(requestId);
    if (!pending) return;
    fdPending.delete(requestId);
    if (success) pending.resolve(data);
    else pending.reject(new Error(error));
  });
}

function callFlowDev(tool, params) {
  return new Promise((resolve, reject) => {
    if (!fdSocket || !fdSocket.connected) {
      reject(new Error(
        'FlowDev extension is not connected. ' +
        'Open VS Code, install the FlowDev MCP extension, paste your token, and make sure it shows Connected ✅.'
      ));
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
      fdPending.delete(requestId);
      reject(new Error('FlowDev timed out after 30s. Is VS Code still open?'));
    }, 30000);

    fdPending.set(requestId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });

    fdSocket.emit('execute_tool', { requestId, tool, params });
  });
}

// ─── Tool: check_connection ────────────────────────────────────────────────
async function checkConnection(args) {
  const token = await getCredential('flowdev_token');

  if (!token) {
    return {
      connected: false,
      message: 'No FlowDev token found. Visit flowdev.onrender.com/request to get your free token, then add it in Loom\'s credential settings in Anna.'
    };
  }

  connectFlowDev(token);
  await new Promise(r => setTimeout(r, 2000));

  const connected = !!(fdSocket && fdSocket.connected);
  return {
    connected,
    message: connected
      ? 'VS Code workspace connected ✅. Ready to start a session.'
      : 'Token found but the FlowDev extension is not responding. Open VS Code, install the FlowDev MCP extension, paste your token, and confirm it shows Connected.'
  };
}

// ─── Tool: get_memory ─────────────────────────────────────────────────────
async function getMemory(args) {
  const raw = await storageGet('loom:memory');
  if (!raw) {
    return {
      exists: false,
      memory: null,
      message: 'No project memory yet. Start a session to build it.'
    };
  }
  let memory;
  try {
    memory = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    memory = { raw };
  }
  return { exists: true, memory };
}

// ─── Tool: start_session ──────────────────────────────────────────────────
async function startSession(args) {
  // 1 — Get token
  const token = await getCredential('flowdev_token');
  if (!token) {
    return {
      success: false,
      error: 'No FlowDev token. Visit flowdev.onrender.com/request to get your free access token, then add it in Loom\'s credential settings.'
    };
  }

  // 2 — Connect to FlowDev relay
  connectFlowDev(token);
  await new Promise(r => setTimeout(r, 2500));

  if (!fdSocket || !fdSocket.connected) {
    return {
      success: false,
      error: 'FlowDev extension not connected. Open VS Code, install the FlowDev MCP extension, paste your token, and confirm it shows Connected ✅.'
    };
  }

  // 3 — Scan workspace
  let structure = '';
  let gitStatus = '';

  try {
    const res = await callFlowDev('get_project_structure', {});
    structure = res.output || '';
  } catch (e) {
    structure = `Could not read project structure: ${e.message}`;
  }

  try {
    const res = await callFlowDev('git_status', {});
    gitStatus = res.stdout || '';
  } catch {
    gitStatus = 'No git repository or git not available.';
  }

  // 4 — Load existing memory
  const raw = await storageGet('loom:memory');
  let existingMemory = null;
  if (raw) {
    try {
      existingMemory = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      existingMemory = null;
    }
  }

  // 5 — Ask LLM to build/update memory
  const systemPrompt = `You are Loom's memory engine. Analyze a developer's workspace and produce a concise, useful project context summary.
If existing memory is provided, incorporate it and update with any new observations.
Output ONLY a valid JSON object with these exact fields — no markdown fences, no explanation:
{
  "project_name": "name of the project",
  "stack": ["list", "of", "technologies"],
  "purpose": "one sentence describing what this project does",
  "current_focus": "what the developer is actively working on based on git status and recent changes",
  "key_decisions": ["important architectural or technical decisions"],
  "tried_and_abandoned": ["things that appear to have been tried and removed"],
  "where_left_off": "a sentence about the current state and what needs to happen next",
  "last_updated": "${new Date().toISOString()}"
}`;

  const userMessage = `Project structure:\n${structure}\n\nGit status:\n${gitStatus}\n\nExisting memory:\n${
    existingMemory ? JSON.stringify(existingMemory, null, 2) : 'None — this is the first session.'
  }`;

  let summary;
  try {
    const llmRaw = await askLLM(systemPrompt, userMessage);
    summary = JSON.parse(llmRaw.replace(/```json|```/g, '').trim());
  } catch (e) {
    process.stderr.write(`[loom] LLM memory parse failed: ${e.message}\n`);
    summary = {
      project_name: 'Unknown',
      stack: [],
      purpose: 'Could not analyze project automatically.',
      current_focus: gitStatus.slice(0, 200),
      key_decisions: [],
      tried_and_abandoned: [],
      where_left_off: 'Review your project manually.',
      last_updated: new Date().toISOString()
    };
  }

  // 6 — Persist updated memory
  await storageSet('loom:memory', JSON.stringify(summary));

  return {
    success: true,
    summary,
    isFirstSession: !existingMemory,
    message: existingMemory
      ? 'Welcome back. Loom remembers your project.'
      : 'First session recorded. Loom will remember this project from now on.'
  };
}

// ─── Tool: chat ───────────────────────────────────────────────────────────
async function chat(args) {
  const { message, conversationHistory = [] } = args;

  // Connect FlowDev if token available
  const token = await getCredential('flowdev_token');
  if (token) {
    connectFlowDev(token);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Load project memory
  const raw = await storageGet('loom:memory');
  let memory = null;
  if (raw) {
    try {
      memory = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}
  }

  const memoryContext = memory
    ? `PROJECT MEMORY:
Project: ${memory.project_name}
Stack: ${(memory.stack || []).join(', ')}
Purpose: ${memory.purpose}
Current focus: ${memory.current_focus}
Key decisions: ${(memory.key_decisions || []).join('; ')}
Where left off: ${memory.where_left_off}
Last updated: ${memory.last_updated}`
    : 'No project memory yet. The user should start a session first.';

  const workspaceConnected = !!(fdSocket && fdSocket.connected);

  const systemPrompt = `You are Loom, an AI coding assistant that remembers developer projects across sessions.

${memoryContext}

Workspace status: ${workspaceConnected ? 'Connected — you can use workspace tools when genuinely needed.' : 'Not connected — answer from memory only.'}

When you need to inspect a file or run a command, include exactly one tool call on its own line:
TOOL_CALL: tool_name {"param": "value"}

Available workspace tools: read_file, write_file, get_project_structure, git_status, git_diff, run_command, search_in_files

Be specific and context-aware. You know this project — act like it.`;

  const historyText = conversationHistory
    .slice(-6)
    .map(m => `${m.role === 'user' ? 'Developer' : 'Loom'}: ${m.content}`)
    .join('\n');

  const fullMessage = historyText ? `${historyText}\nDeveloper: ${message}` : message;

  try {
    let response = await askLLM(systemPrompt, fullMessage);

    // Parse and execute optional tool call
    const toolMatch = response.match(/TOOL_CALL:\s*(\w+)\s*(\{[^}]*\})?/);
    if (toolMatch && workspaceConnected) {
      const toolName = toolMatch[1];
      let toolParams = {};
      try { toolParams = toolMatch[2] ? JSON.parse(toolMatch[2]) : {}; } catch {}

      try {
        const toolResult = await callFlowDev(toolName, toolParams);
        response = response.replace(/TOOL_CALL:.*$/m, '').trim();
        const toolContext = typeof toolResult === 'object'
          ? (toolResult.content || toolResult.output || toolResult.stdout || JSON.stringify(toolResult))
          : String(toolResult);
        // Ask LLM to give final answer with tool result in context
        response = await askLLM(
          systemPrompt,
          `${fullMessage}\n\n[${toolName} result]:\n${toolContext.slice(0, 2000)}\n\nNow give your final helpful answer using this information.`
        );
      } catch (e) {
        response = response.replace(/TOOL_CALL:.*$/m, '').trim();
        response += `\n\n*(Could not run ${toolName}: ${e.message})*`;
      }
    }

    // Auto-update memory every 4 exchanges (best-effort)
    if (memory && conversationHistory.length > 0 && conversationHistory.length % 4 === 0) {
      const recentChat = conversationHistory.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
      try {
        const updatedRaw = await askLLM(
          'Update the project memory JSON based on the recent conversation. Keep all fields, refine if new info was revealed. Output only the JSON object, no explanation.',
          `Current memory:\n${JSON.stringify(memory)}\n\nRecent conversation:\n${recentChat}`
        );
        const parsed = JSON.parse(updatedRaw.replace(/```json|```/g, '').trim());
        parsed.last_updated = new Date().toISOString();
        await storageSet('loom:memory', JSON.stringify(parsed));
      } catch { /* memory update is best-effort, never block the response */ }
    }

    return { success: true, response };
  } catch (e) {
    return { success: false, error: e.message, response: `Error: ${e.message}` };
  }
}

// ─── Tool: update_memory ──────────────────────────────────────────────────
async function updateMemory(args) {
  const { updates } = args;
  const raw = await storageGet('loom:memory');
  let memory = {};
  if (raw) {
    try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch {}
  }
  const updated = { ...memory, ...updates, last_updated: new Date().toISOString() };
  await storageSet('loom:memory', JSON.stringify(updated));
  return { success: true, memory: updated };
}

// ─── Tool: end_session ────────────────────────────────────────────────────
async function endSession(args) {
  const { sessionNote } = args;
  const raw = await storageGet('loom:memory');
  let memory = {};
  if (raw) {
    try { memory = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch {}
  }
  if (sessionNote) {
    memory.where_left_off = sessionNote;
    memory.last_updated = new Date().toISOString();
    await storageSet('loom:memory', JSON.stringify(memory));
  }
  if (fdSocket) fdSocket.disconnect();
  return { success: true, message: 'Session ended. Memory saved.' };
}

// ─── Dispatch table ────────────────────────────────────────────────────────
const HANDLERS = {
  check_connection: checkConnection,
  get_memory:       getMemory,
  start_session:    startSession,
  chat:             chat,
  update_memory:    updateMemory,
  end_session:      endSession
};

// ─── RPC dispatch ──────────────────────────────────────────────────────────
async function dispatch(msg) {
  const { method, params = {}, id } = msg;

  switch (method) {

    // Anna handshake — respond with our capabilities
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'loom-agent', version: '1.0.0' }
      });
      return;

    // Anna asks what tools we provide — return manifest directly in result
    case 'describe':
      respond(id, MANIFEST);
      return;

    // Anna invokes a tool — params.tool is the tool name, params.arguments are the args
    case 'invoke': {
      const toolName = params.tool;
      const toolArgs = params.arguments || {};
      const handler = HANDLERS[toolName];

      if (!handler) {
        respond(id, { success: false, error: `Unknown tool: ${toolName}` });
        return;
      }

      try {
        const result = await handler(toolArgs);
        respond(id, result);
      } catch (e) {
        process.stderr.write(`[loom] Tool error (${toolName}): ${e.message}\n`);
        respond(id, { success: false, error: e.message });
      }
      return;
    }

    default:
      respondError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Main stdin loop ───────────────────────────────────────────────────────
rl.on('line', (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write(`[loom] Invalid JSON on stdin: ${line}\n`);
    return;
  }

  // Is this a response to a reverse call we made to Anna host?
  if (msg.id && pendingHostCalls.has(msg.id)) {
    const pending = pendingHostCalls.get(msg.id);
    pendingHostCalls.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }

  // Otherwise it is a call from Anna host to us
  if (msg.method) {
    dispatch(msg).catch(e => {
      process.stderr.write(`[loom] Unhandled dispatch error: ${e.message}\n`);
      if (msg.id) respondError(msg.id, -32603, `Internal error: ${e.message}`);
    });
  }
});

// Clean exit when Anna closes stdin
rl.on('close', () => {
  process.stderr.write('[loom] stdin closed — exiting cleanly\n');
  if (fdSocket) fdSocket.disconnect();
  process.exit(0);
});

process.stderr.write('[loom] Loom agent v1.0.0 started\n');
