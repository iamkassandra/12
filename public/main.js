/**
 * AntiGravity Sovereign — Main Application
 * 
 * ES6 Module — Single-page chat application
 * Features:
 *   - Multi-agent chat with streaming SSE
 *   - Conversation persistence & management
 *   - Settings panel with live save
 *   - Token routing based on keywords
 *   - Markdown rendering with syntax highlighting
 *   - Keyboard shortcuts
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  agents: [],
  conversations: [],
  activeConversationId: null,
  activeAgentId: null,
  settings: {},
  adminToken: sessionStorage.getItem('ag_admin_token') || '',
  isStreaming: false,
  streamEnabled: true,
  markdownEnabled: true,
  tokenCountEnabled: true,
};

// ─── API Client ───────────────────────────────────────────────────────────────

const API_BASE = '';

async function api(method, path, body = null, headers = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.adminToken ? { 'x-admin-token': state.adminToken } : {}),
      ...headers,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── SSE Streaming ────────────────────────────────────────────────────────────

async function streamMessage(conversationId, content, onDelta, onDone, onError) {
  const res = await fetch(`${API_BASE}/api/conversations/${conversationId}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.adminToken ? { 'x-admin-token': state.adminToken } : {}),
    },
    body: JSON.stringify({ content, stream: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    onError(new Error(err.error || `HTTP ${res.status}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const agentId = res.headers.get('X-Agent-Id') || state.activeAgentId;
  const agentName = res.headers.get('X-Agent-Name') || 'AI';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.error) { onError(new Error(parsed.error)); return; }
          if (parsed.delta) onDelta(parsed.delta);
          if (parsed.done) { onDone(agentId, agentName); return; }
        } catch (_) {}
      }
    }
    onDone(agentId, agentName);
  } catch (err) {
    onError(err);
  }
}

// ─── Utility Functions ────────────────────────────────────────────────────────

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function estimateTokens(text) {
  return Math.ceil(text.length / 3.8);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  if (!state.markdownEnabled || typeof marked === 'undefined') {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
  try {
    const rendered = marked.parse(text, {
      gfm: true,
      breaks: true,
    });
    return rendered;
  } catch (_) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

function processCodeBlocks(html) {
  // Add copy buttons and language labels to rendered code blocks
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('pre').forEach(pre => {
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const lang = [...codeEl.classList].find(c => c.startsWith('language-'))?.replace('language-', '') || 'code';
    
    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML = `<span>${lang}</span><button class="code-copy-btn" data-copy>Copy</button>`;
    
    header.querySelector('[data-copy]').addEventListener('click', () => {
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        showToast('Code copied!', 'success');
      });
    });

    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
    }

    pre.insertBefore(header, codeEl);
  });
  return div.innerHTML;
}

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 3500) {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || 'ℹ'}</span>
    <span>${escapeHtml(message)}</span>
    <button class="toast-dismiss" aria-label="Dismiss notification">✕</button>
  `;
  toast.querySelector('.toast-dismiss').addEventListener('click', () => toast.remove());
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ─── Conversation UI ──────────────────────────────────────────────────────────

function renderConversationList() {
  const list = document.getElementById('conv-list');
  list.innerHTML = '';
  
  if (state.conversations.length === 0) {
    list.innerHTML = `<div style="text-align:center; padding: var(--space-4); color: var(--text-muted); font-size:0.78rem;">No conversations yet</div>`;
    return;
  }

  state.conversations.forEach(conv => {
    const agent = state.agents.find(a => a.id === conv.agentId);
    const item = document.createElement('div');
    item.className = `conv-item${conv.id === state.activeConversationId ? ' active' : ''}`;
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', conv.title);
    item.dataset.id = conv.id;
    item.innerHTML = `
      <div class="conv-agent-avatar">${agent?.avatar || '💬'}</div>
      <div class="conv-meta">
        <div class="conv-title">${escapeHtml(conv.title || 'New Conversation')}</div>
        <div class="conv-time">${formatTime(conv.updatedAt)}</div>
      </div>
      <button class="conv-delete" data-delete="${conv.id}" aria-label="Delete conversation" title="Delete">✕</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.dataset.delete) return;
      loadConversation(conv.id);
    });
    item.querySelector('[data-delete]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    list.appendChild(item);
  });
}

function renderAgentBar() {
  const container = document.getElementById('agent-cards');
  const sidebarList = document.getElementById('sidebar-agents-list');
  container.innerHTML = '';
  sidebarList.innerHTML = '';

  state.agents.forEach(agent => {
    // Card in agent bar
    const card = document.createElement('button');
    card.className = `agent-card${agent.id === state.activeAgentId ? ' active' : ''}`;
    card.style.setProperty('--agent-color', agent.color || 'var(--accent)');
    card.dataset.agentId = agent.id;
    card.setAttribute('aria-label', `Select ${agent.name} agent`);
    card.title = agent.description || agent.name;
    card.innerHTML = `
      <span class="agent-card-emoji">${agent.avatar || '🤖'}</span>
      <span class="agent-card-name">${escapeHtml(agent.name)}</span>
    `;
    card.addEventListener('click', () => selectAgent(agent.id));
    container.appendChild(card);

    // Chip in sidebar
    const chip = document.createElement('div');
    chip.className = `agent-chip${agent.id === state.activeAgentId ? ' selected' : ''}`;
    chip.dataset.agentId = agent.id;
    chip.innerHTML = `
      <div class="agent-avatar-chip">${agent.avatar || '🤖'}</div>
      <span class="agent-chip-name">${escapeHtml(agent.name)}</span>
    `;
    chip.addEventListener('click', () => selectAgent(agent.id));
    sidebarList.appendChild(chip);
  });
}

function selectAgent(agentId) {
  state.activeAgentId = agentId;
  renderAgentBar();
  
  // Update current conversation's agent
  if (state.activeConversationId) {
    api('PATCH', `/api/conversations/${state.activeConversationId}`, { agentId })
      .catch(err => console.warn('Could not update conversation agent:', err.message));
  }
}

// ─── Chat Rendering ───────────────────────────────────────────────────────────

function renderMessages(messages) {
  const container = document.getElementById('messages-container');
  const emptyState = document.getElementById('empty-state');
  container.innerHTML = '';

  if (!messages || messages.length === 0) {
    emptyState.style.display = 'flex';
    renderSuggestions();
    return;
  }

  emptyState.style.display = 'none';

  messages.forEach(msg => {
    const el = createMessageElement(msg);
    container.appendChild(el);
  });

  scrollToBottom();
}

function createMessageElement(msg) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${msg.role}`;
  wrapper.dataset.messageId = msg.id;

  const isUser = msg.role === 'user';
  const agent = state.agents.find(a => a.id === msg.agentId);
  const avatarContent = isUser ? '👤' : (agent?.avatar || '🤖');
  const authorName = isUser ? 'You' : (msg.agentName || agent?.name || 'AI');

  const rawHtml = renderMarkdown(msg.content || '');
  const processedHtml = processCodeBlocks(rawHtml);

  wrapper.innerHTML = `
    <div class="message-avatar" aria-hidden="true">${avatarContent}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="message-author">${escapeHtml(authorName)}</span>
        <span class="message-timestamp">${formatTime(msg.timestamp || Date.now())}</span>
      </div>
      <div class="message-bubble">${processedHtml}</div>
    </div>
  `;

  return wrapper;
}

function appendUserMessage(content) {
  const emptyState = document.getElementById('empty-state');
  emptyState.style.display = 'none';

  const container = document.getElementById('messages-container');
  const msg = {
    id: `temp-${Date.now()}`,
    role: 'user',
    content,
    timestamp: Date.now(),
  };
  const el = createMessageElement(msg);
  container.appendChild(el);
  scrollToBottom();
}

function appendThinkingIndicator() {
  const container = document.getElementById('messages-container');
  const agent = state.agents.find(a => a.id === state.activeAgentId);
  
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant';
  wrapper.id = 'thinking-indicator';

  const avatarContent = agent?.avatar || '🤖';
  const authorName = agent?.name || 'AI';

  wrapper.innerHTML = `
    <div class="message-avatar" aria-hidden="true">${avatarContent}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="message-author">${escapeHtml(authorName)}</span>
      </div>
      <div class="message-bubble" id="stream-bubble">
        <div class="thinking-indicator">
          <div class="thinking-dot"></div>
          <div class="thinking-dot"></div>
          <div class="thinking-dot"></div>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);
  scrollToBottom();
}

function updateStreamBubble(delta) {
  const bubble = document.getElementById('stream-bubble');
  if (!bubble) return;

  // Initialize accumulator
  if (!bubble._accumulated) bubble._accumulated = '';
  bubble._accumulated += delta;

  const rawHtml = renderMarkdown(bubble._accumulated);
  bubble.innerHTML = processCodeBlocks(rawHtml);
  scrollToBottom();
}

function finalizeStreamBubble(agentId, agentName) {
  const indicator = document.getElementById('thinking-indicator');
  if (!indicator) return;
  
  const bubble = document.getElementById('stream-bubble');
  const accumulated = bubble?._accumulated || '';
  
  // Replace temp indicator with final message
  const agent = state.agents.find(a => a.id === agentId);
  const finalMsg = {
    id: `msg-${Date.now()}`,
    role: 'assistant',
    content: accumulated,
    agentId,
    agentName: agentName || agent?.name || 'AI',
    timestamp: Date.now(),
  };
  
  const finalEl = createMessageElement(finalMsg);
  indicator.replaceWith(finalEl);
  scrollToBottom();
}

function scrollToBottom() {
  const chatWindow = document.getElementById('chat-window');
  requestAnimationFrame(() => {
    chatWindow.scrollTop = chatWindow.scrollHeight;
  });
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  { icon: '✍️', text: 'Help me write a professional email' },
  { icon: '⚡', text: 'Write a Python script to process CSV files' },
  { icon: '🔍', text: 'Analyze this data and find patterns' },
  { icon: '🧠', text: 'Explain how neural networks work' },
  { icon: '🛡️', text: 'Review this code for security issues' },
  { icon: '📋', text: 'Create a project plan for building a web app' },
];

function renderSuggestions() {
  const grid = document.getElementById('suggestion-grid');
  grid.innerHTML = '';
  const shown = SUGGESTIONS.slice(0, 4);
  shown.forEach(s => {
    const card = document.createElement('div');
    card.className = 'suggestion-card';
    card.innerHTML = `
      <span class="suggestion-icon" aria-hidden="true">${s.icon}</span>
      <span class="suggestion-text">${escapeHtml(s.text)}</span>
    `;
    card.addEventListener('click', () => {
      const input = document.getElementById('message-input');
      input.value = s.text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
    grid.appendChild(card);
  });
}

// ─── Send Message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || state.isStreaming) return;

  // Ensure a conversation exists
  if (!state.activeConversationId) {
    await createNewConversation();
  }

  state.isStreaming = true;
  setSendDisabled(true);
  input.value = '';
  input.style.height = 'auto';
  updateTokenCounter();

  appendUserMessage(content);
  appendThinkingIndicator();

  if (state.streamEnabled) {
    streamMessage(
      state.activeConversationId,
      content,
      (delta) => updateStreamBubble(delta),
      (agentId, agentName) => {
        finalizeStreamBubble(agentId, agentName);
        state.isStreaming = false;
        setSendDisabled(false);
        refreshConversationList();
      },
      (err) => {
        const indicator = document.getElementById('thinking-indicator');
        if (indicator) {
          const bubble = indicator.querySelector('.message-bubble');
          if (bubble) bubble.innerHTML = `<span style="color:var(--error)">Error: ${escapeHtml(err.message)}</span>`;
        }
        state.isStreaming = false;
        setSendDisabled(false);
        showToast(err.message, 'error');
      }
    );
  } else {
    try {
      const result = await api('POST', `/api/conversations/${state.activeConversationId}/message`, {
        content, stream: false
      });
      finalizeStreamBubble(result.message.agentId, result.message.agentName);
      refreshConversationList();
    } catch (err) {
      const indicator = document.getElementById('thinking-indicator');
      if (indicator) indicator.remove();
      showToast(err.message, 'error');
    } finally {
      state.isStreaming = false;
      setSendDisabled(false);
    }
  }
}

function setSendDisabled(disabled) {
  const btn = document.getElementById('send-btn');
  btn.disabled = disabled;
}

function updateTokenCounter() {
  const input = document.getElementById('message-input');
  const counter = document.getElementById('token-counter');
  const tokens = estimateTokens(input.value);
  counter.textContent = `${tokens.toLocaleString()} tokens`;
}

// ─── Conversation Management ──────────────────────────────────────────────────

async function createNewConversation() {
  const conv = await api('POST', '/api/conversations', {
    agentId: state.activeAgentId || 'assistant',
    title: 'New Conversation',
  });
  state.activeConversationId = conv.id;
  state.conversations.unshift(conv);
  renderConversationList();
  renderMessages([]);
}

async function loadConversation(id) {
  const conv = await api('GET', `/api/conversations/${id}`);
  state.activeConversationId = id;
  state.activeAgentId = conv.agentId;
  renderConversationList();
  renderAgentBar();
  renderMessages(conv.messages || []);
}

async function deleteConversation(id) {
  await api('DELETE', `/api/conversations/${id}`).catch(err => showToast(err.message, 'error'));
  if (state.activeConversationId === id) {
    state.activeConversationId = null;
    renderMessages([]);
  }
  state.conversations = state.conversations.filter(c => c.id !== id);
  renderConversationList();
  showToast('Conversation deleted', 'success');
}

async function refreshConversationList() {
  const { conversations } = await api('GET', '/api/conversations').catch(() => ({ conversations: state.conversations }));
  state.conversations = conversations;
  renderConversationList();
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  overlay.classList.add('open');
  document.getElementById('admin-token-input').value = state.adminToken;
  renderSettingsAgents();
  renderSettingsTools();
  renderSystemInfo();
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
}

function renderSettingsAgents() {
  const list = document.getElementById('agent-settings-list');
  list.innerHTML = '';
  state.agents.forEach(agent => {
    const card = document.createElement('div');
    card.className = 'agent-settings-card';
    card.innerHTML = `
      <div style="font-size:1.5rem; flex-shrink:0;">${agent.avatar || '🤖'}</div>
      <div class="agent-settings-info">
        <div class="agent-settings-header">
          <span class="agent-settings-name">${escapeHtml(agent.name)}</span>
          <span class="agent-settings-model">${escapeHtml(agent.model || 'unknown')}</span>
        </div>
        <div class="agent-settings-desc">${escapeHtml(agent.description || '')}</div>
      </div>
    `;
    list.appendChild(card);
  });
}

function renderSettingsTools() {
  const list = document.getElementById('tools-list');
  const tools = state.settings.tools || {};
  list.innerHTML = '';
  Object.entries(tools).forEach(([toolId, tool]) => {
    const row = document.createElement('div');
    row.className = 'toggle-wrapper';
    row.innerHTML = `
      <div>
        <div class="toggle-label">${escapeHtml(toolId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</div>
        <div class="form-hint" style="margin:0;">${escapeHtml(tool.description || '')}</div>
      </div>
      <label class="toggle" aria-label="Toggle ${toolId}">
        <input type="checkbox" ${tool.enabled ? 'checked' : ''} data-tool="${toolId}" />
        <span class="toggle-track"></span>
        <span class="toggle-thumb"></span>
      </label>
    `;
    list.appendChild(row);
  });
}

function renderSystemInfo() {
  const container = document.getElementById('system-info');
  const sys = state.settings.system || {};
  container.innerHTML = `
    <div class="agent-settings-card" style="flex-direction:column; gap: var(--space-2);">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap: var(--space-3); width:100%;">
        <div>
          <div class="form-hint">Name</div>
          <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${escapeHtml(sys.name || 'AntiGravity Sovereign')}</div>
        </div>
        <div>
          <div class="form-hint">Version</div>
          <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${escapeHtml(sys.version || '1.0.0')}</div>
        </div>
        <div>
          <div class="form-hint">Port</div>
          <div style="font-size:0.85rem; font-family:var(--font-mono); color:var(--text-accent);">${sys.port || 3000}</div>
        </div>
        <div>
          <div class="form-hint">Active Agents</div>
          <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${state.agents.length}</div>
        </div>
      </div>
    </div>
  `;

  // Set Ollama URL from first agent
  const firstAgent = state.settings.agents?.[0];
  if (firstAgent?.ollamaBase) {
    document.getElementById('ollama-url-input').value = firstAgent.ollamaBase;
  }
}

async function saveSettings() {
  const adminToken = document.getElementById('admin-token-input').value.trim();
  state.adminToken = adminToken;
  sessionStorage.setItem('ag_admin_token', adminToken);

  const streamEnabled = document.getElementById('toggle-stream').checked;
  const markdownEnabled = document.getElementById('toggle-markdown').checked;
  const tokenCountEnabled = document.getElementById('toggle-tokens').checked;

  state.streamEnabled = streamEnabled;
  state.markdownEnabled = markdownEnabled;
  state.tokenCountEnabled = tokenCountEnabled;

  document.getElementById('token-counter').style.display = tokenCountEnabled ? '' : 'none';

  showToast('Settings saved locally', 'success');
  closeSettings();
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function checkHealth() {
  try {
    const health = await api('GET', '/api/health');
    document.getElementById('status-dot').style.background = 'var(--success)';
    document.getElementById('status-text').textContent = 'ONLINE';
    document.getElementById('status-badge').title = `${health.name} v${health.version} · ${health.agents} agents · ${health.conversations} sessions`;
  } catch {
    document.getElementById('status-dot').style.background = 'var(--error)';
    document.getElementById('status-text').textContent = 'ERROR';
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  // Load agents and settings
  try {
    const [agentsRes, settingsRes, convsRes] = await Promise.all([
      api('GET', '/api/agents'),
      api('GET', '/api/settings'),
      api('GET', '/api/conversations'),
    ]);

    state.agents = agentsRes.agents || [];
    state.settings = settingsRes;
    state.conversations = convsRes.conversations || [];

    const defaultAgent = state.settings.tokenRouting?.default || state.agents[0]?.id;
    state.activeAgentId = defaultAgent;
  } catch (err) {
    showToast(`Failed to load configuration: ${err.message}`, 'error');
  }

  renderAgentBar();
  renderConversationList();
  renderMessages([]);
  renderSuggestions();
  await checkHealth();

  // Health check every 30s
  setInterval(checkHealth, 30000);

  // ─── Event Listeners ────────────────────────────────────────

  // Send button
  document.getElementById('send-btn').addEventListener('click', sendMessage);

  // Textarea input
  const input = document.getElementById('message-input');
  input.addEventListener('input', () => {
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';

    // Enable/disable send
    document.getElementById('send-btn').disabled = !input.value.trim() || state.isStreaming;

    // Token counter
    updateTokenCounter();
  });

  // Keyboard shortcuts
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!document.getElementById('send-btn').disabled) {
        sendMessage();
      }
    }
  });

  // New chat
  document.getElementById('new-chat-btn').addEventListener('click', createNewConversation);

  // Clear conversation
  document.getElementById('clear-btn').addEventListener('click', () => {
    if (!state.activeConversationId) return;
    if (confirm('Clear all messages in this conversation?')) {
      deleteConversation(state.activeConversationId).then(() => createNewConversation());
    }
  });

  // Sidebar toggle
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const app = document.getElementById('app');
    const sidebar = document.getElementById('sidebar');
    app.classList.toggle('sidebar-collapsed');
    sidebar.classList.toggle('open');
  });

  // Settings toggle
  document.getElementById('settings-toggle').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveSettings);

  // Close settings overlay on backdrop click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });

  // Settings tabs
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.settings-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.querySelector(`[data-section="${tab.dataset.tab}"]`).classList.add('active');
    });
  });

  // Keyboard: Escape to close settings
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  // Keyboard: Ctrl/Cmd+K for new chat
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      createNewConversation();
    }
  });

  // Dark mode toggle (currently always dark — placeholder for future light mode)
  document.getElementById('toggle-dark').addEventListener('change', (e) => {
    if (!e.target.checked) showToast('Light mode coming soon!', 'info');
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
