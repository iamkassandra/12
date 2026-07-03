/**
 * AntiGravity Sovereign — Main Server
 * 
 * Production-grade Express server providing:
 *  - REST API for agent management, messaging, settings
 *  - Streaming support (SSE) for real-time responses
 *  - Ollama integration with fallback mock responses
 *  - Static file serving for the front-end
 *  - Memory persistence (file-based JSON)
 *  - Admin token authentication for config endpoints
 */

'use strict';

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Config ─────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');
const DATA_DIR = path.join(__dirname, 'data');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const WORKSPACE_DIR = path.join(__dirname, 'workspace');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');

// Ensure required directories exist
[DATA_DIR, MEMORY_DIR, WORKSPACE_DIR, OUTPUTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function loadSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

let settings = loadSettings();

// ─── Memory / Session Store ──────────────────────────────────────────────────

const conversations = new Map(); // in-memory, persisted on shutdown

function loadConversations() {
  const files = fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.json'));
  files.forEach(file => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8'));
      conversations.set(data.id, data);
    } catch (e) { /* skip corrupted files */ }
  });
  console.log(`[Memory] Loaded ${conversations.size} conversations from disk.`);
}

function persistConversation(conv) {
  const filePath = path.join(MEMORY_DIR, `${conv.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(conv, null, 2), 'utf8');
}

function deleteConversationFile(id) {
  const filePath = path.join(MEMORY_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

loadConversations();

// ─── Ollama Integration ──────────────────────────────────────────────────────

async function callOllama(agent, messages, stream, res) {
  const baseUrl = agent.ollamaBase || 'http://localhost:11434';
  const modelName = (agent.model || 'ollama/llama3').replace('ollama/', '');
  
  const payload = JSON.stringify({
    model: modelName,
    messages: messages,
    stream: stream,
    options: {
      temperature: agent.temperature ?? 0.7,
      num_predict: agent.maxTokens ?? 4096
    }
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/chat`);
    const options = {
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (ollamaRes) => {
      if (stream) {
        // Stream SSE to client
        let buffer = '';
        ollamaRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();
          lines.forEach(line => {
            if (!line.trim()) return;
            try {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) {
                res.write(`data: ${JSON.stringify({ delta: parsed.message.content, done: false })}\n\n`);
              }
              if (parsed.done) {
                res.write(`data: ${JSON.stringify({ delta: '', done: true })}\n\n`);
                res.end();
                resolve({ streaming: true });
              }
            } catch (_) {}
          });
        });
        ollamaRes.on('error', reject);
      } else {
        let data = '';
        ollamaRes.on('data', chunk => data += chunk.toString());
        ollamaRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ content: parsed.message?.content || '', done: true });
          } catch (e) {
            reject(new Error('Failed to parse Ollama response'));
          }
        });
      }
    });

    req.on('error', reject);
    req.setTimeout(settings.protocols?.timeoutMs || 120000, () => {
      req.destroy(new Error('Ollama request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

async function callAgent(agent, messages, stream, res) {
  try {
    return await callOllama(agent, messages, stream, res);
  } catch (err) {
    // Fallback mock response when Ollama is not available
    console.warn(`[Agent] Ollama unavailable for agent "${agent.id}": ${err.message}`);
    const mockContent = `[MOCK RESPONSE — Ollama not connected]\n\nAgent **${agent.name}** received your message. To enable real AI responses, make sure Ollama is running at \`${agent.ollamaBase}\` with model \`${agent.model.replace('ollama/', '')}\` loaded.\n\nStart with:\n\`\`\`\nollama serve\nollama pull ${agent.model.replace('ollama/', '')}\n\`\`\``;
    if (stream) {
      res.write(`data: ${JSON.stringify({ delta: mockContent, done: false })}\n\n`);
      res.write(`data: ${JSON.stringify({ delta: '', done: true })}\n\n`);
      res.end();
      return { streaming: true };
    }
    return { content: mockContent, done: true };
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors({ origin: settings.system?.allowedOrigins || '*' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== settings.system?.adminToken) {
    return res.status(403).json({ error: 'Forbidden: invalid admin token.' });
  }
  next();
}

// ─── API: Health ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    name: settings.system?.name,
    version: settings.system?.version,
    agents: settings.agents?.filter(a => a.enabled).length,
    conversations: conversations.size,
    timestamp: new Date().toISOString()
  });
});

// ─── API: Agents ─────────────────────────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  settings = loadSettings();
  const safeAgents = settings.agents
    .filter(a => a.enabled !== false)
    .map(({ id, name, avatar, color, description, model, tools, enabled }) => ({
      id, name, avatar, color, description, model, tools, enabled
    }));
  res.json({ agents: safeAgents });
});

app.get('/api/agents/:id', (req, res) => {
  const agent = settings.agents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  const { id, name, avatar, color, description, model, tools, enabled } = agent;
  res.json({ id, name, avatar, color, description, model, tools, enabled });
});

// ─── API: Conversations ───────────────────────────────────────────────────────

app.get('/api/conversations', (req, res) => {
  const list = Array.from(conversations.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, agentId, createdAt, updatedAt, messageCount }) => ({
      id, title, agentId, createdAt, updatedAt, messageCount
    }));
  res.json({ conversations: list });
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  res.json(conv);
});

app.post('/api/conversations', (req, res) => {
  const { agentId, title } = req.body;
  const id = uuidv4();
  const now = Date.now();
  const conv = {
    id,
    title: title || 'New Conversation',
    agentId: agentId || settings.tokenRouting?.default || 'assistant',
    messages: [],
    createdAt: now,
    updatedAt: now,
    messageCount: 0
  };
  conversations.set(id, conv);
  persistConversation(conv);
  res.status(201).json(conv);
});

app.delete('/api/conversations/:id', (req, res) => {
  if (!conversations.has(req.params.id)) {
    return res.status(404).json({ error: 'Conversation not found.' });
  }
  conversations.delete(req.params.id);
  deleteConversationFile(req.params.id);
  res.json({ success: true });
});

app.patch('/api/conversations/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  if (req.body.title) conv.title = req.body.title;
  if (req.body.agentId) conv.agentId = req.body.agentId;
  conv.updatedAt = Date.now();
  conversations.set(conv.id, conv);
  persistConversation(conv);
  res.json(conv);
});

// ─── API: Messages / Chat ─────────────────────────────────────────────────────

app.post('/api/conversations/:id/message', async (req, res) => {
  const { content, stream: streamParam } = req.body;
  const stream = streamParam !== false; // default to streaming

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Message content is required.' });
  }

  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

  settings = loadSettings();

  // Auto-route based on keywords if using default agent
  let agentId = conv.agentId;
  const routes = settings.tokenRouting?.routes || {};
  for (const [keyword, targetAgentId] of Object.entries(routes)) {
    if (content.toLowerCase().includes(keyword)) {
      agentId = targetAgentId;
      break;
    }
  }

  const agent = settings.agents.find(a => a.id === agentId && a.enabled !== false)
    || settings.agents.find(a => a.enabled !== false);

  if (!agent) return res.status(500).json({ error: 'No enabled agents available.' });

  // Build message history
  const userMessage = {
    id: uuidv4(),
    role: 'user',
    content: content.trim(),
    timestamp: Date.now()
  };

  conv.messages.push(userMessage);

  // Construct OpenAI-compatible messages array for Ollama
  const ollamaMessages = [
    { role: 'system', content: agent.systemPrompt }
  ];
  
  // Include last N messages for context
  const historyLimit = settings.memory?.maxHistoryLength || 100;
  const recentMessages = conv.messages.slice(-historyLimit);
  recentMessages.forEach(m => {
    ollamaMessages.push({ role: m.role, content: m.content });
  });

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Agent-Id', agent.id);
    res.setHeader('X-Agent-Name', agent.name);
    res.flushHeaders();

    // Collect streamed content for persistence
    let fullContent = '';
    const originalWrite = res.write.bind(res);
    res.write = (chunk, ...args) => {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString();
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        lines.forEach(line => {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.delta) fullContent += parsed.delta;
        });
      } catch (_) {}
      return originalWrite(chunk, ...args);
    };

    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      // Persist assistant message after streaming
      const assistantMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: fullContent,
        agentId: agent.id,
        agentName: agent.name,
        timestamp: Date.now()
      };
      conv.messages.push(assistantMessage);
      conv.updatedAt = Date.now();
      conv.messageCount = conv.messages.length;
      if (!conv.title || conv.title === 'New Conversation') {
        conv.title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
      }
      conversations.set(conv.id, conv);
      persistConversation(conv);
      return originalEnd(...args);
    };

    try {
      await callAgent(agent, ollamaMessages, true, res);
    } catch (err) {
      console.error('[Message] Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message, done: true })}\n\n`);
      res.end();
    }
  } else {
    try {
      const result = await callAgent(agent, ollamaMessages, false, res);
      const assistantMessage = {
        id: uuidv4(),
        role: 'assistant',
        content: result.content,
        agentId: agent.id,
        agentName: agent.name,
        timestamp: Date.now()
      };
      conv.messages.push(assistantMessage);
      conv.updatedAt = Date.now();
      conv.messageCount = conv.messages.length;
      if (!conv.title || conv.title === 'New Conversation') {
        conv.title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
      }
      conversations.set(conv.id, conv);
      persistConversation(conv);
      res.json({ message: assistantMessage, agentId: agent.id });
    } catch (err) {
      console.error('[Message] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── API: Settings ────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  settings = loadSettings();
  // Return safe subset (no secrets)
  const { ui, agents, tokenRouting, tools, memory, protocols } = settings;
  const safeAgents = agents.map(({ id, name, avatar, color, description, model, tools: agentTools, enabled, temperature, maxTokens }) => ({
    id, name, avatar, color, description, model, tools: agentTools, enabled, temperature, maxTokens
  }));
  res.json({ ui, agents: safeAgents, tokenRouting, tools, memory, protocols });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  try {
    const current = loadSettings();
    const updated = { ...current, ...req.body };
    // Never allow system secrets to be overridden via API
    updated.system = current.system;
    saveSettings(updated);
    settings = updated;
    res.json({ success: true, message: 'Settings updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/agents/:id', requireAdmin, (req, res) => {
  settings = loadSettings();
  const idx = settings.agents.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Agent not found.' });
  settings.agents[idx] = { ...settings.agents[idx], ...req.body, id: settings.agents[idx].id };
  saveSettings(settings);
  res.json(settings.agents[idx]);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Persisting conversations...`);
  conversations.forEach(conv => persistConversation(conv));
  console.log('[Server] Shutdown complete.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = settings.system?.port || 3000;
const HOST = settings.system?.host || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║   ${settings.system?.name || 'AntiGravity Sovereign'} v${settings.system?.version || '1.0.0'}           ║`);
  console.log('  ║   Sovereign AI Platform — 100% Local             ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Interface:  http://localhost:${PORT}`);
  console.log(`  📡 API:        http://localhost:${PORT}/api`);
  console.log(`  📊 Health:     http://localhost:${PORT}/api/health`);
  console.log('');
  console.log(`  Agents loaded: ${settings.agents.filter(a => a.enabled !== false).length}`);
  console.log(`  Conversations: ${conversations.size} in memory`);
  console.log('');
  console.log('  Ready. Power to the sovereign. ⚡');
  console.log('');
});
