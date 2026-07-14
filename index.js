const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { NodeSSH } = require('node-ssh');
const { AcpClient } = require('./acp-client');

// Load .env without adding a dependency (KEY=VALUE lines only)
(function loadDotEnv() {
    try {
        const envPath = path.resolve(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = val;
        }
    } catch (_) { /* ignore */ }
})();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
const BIND_IP = process.env.BIND_IP || '127.0.0.1';
const HOSTS_PATH = path.resolve(__dirname, 'hosts.json');
const SHORTCUTS_PATH = path.resolve(__dirname, 'shortcuts.json');
const BATCH_SHORTCUTS_PATH = path.resolve(__dirname, 'batch_shortcuts.json');
const SESSION_TIMEOUT = 10 * 60 * 1000;
const USERS_PATH = path.resolve(__dirname, 'users.json');
const AI_CMD_WAIT_MS = Number(process.env.AI_CMD_WAIT_MS) || 2800;
const OUTPUT_BUF_MAX = 32000;
const GROK_AGENT_URL = process.env.GROK_AGENT_URL || 'ws://127.0.0.1:2419/ws';
const GROK_AGENT_SECRET = process.env.GROK_AGENT_SECRET || process.env.GROK_AGENT_SERVER_KEY || '';
const SSH_MAG_MCP_TOKEN = process.env.SSH_MAG_MCP_TOKEN || uuidv4();
const SSH_MAG_PUBLIC_BASE = process.env.SSH_MAG_PUBLIC_BASE || `http://${BIND_IP === '0.0.0.0' ? '127.0.0.1' : BIND_IP}:${PORT}`;
const AI_RULES = process.env.AI_RULES || `You are the ops assistant for SSH-Mag (web SSH manager).
Use ONLY the ssh-mag MCP tools to manage servers: list_hosts, list_sessions, open_host_session, run_in_session, batch_run.
Prefer open_host_session + run_in_session so the user sees commands live in their browser xterm.
Use batch_run for multi-host checks when live xterm is less important.
Never invent host names — call list_hosts first if unsure.
Prefer read-only diagnostics (df, free, uptime, systemctl status, docker ps, journalctl -n, ss).
Do not attempt destructive actions (rm -rf, reboot, mkfs, curl|sh, etc.).
If the user writes Traditional Chinese, reply in Traditional Chinese.`;

const DANGEROUS_CMD = [
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s--force)/i,
    /\brm\s+-rf\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bpoweroff\b/i,
    /\bhalt\b/i,
    /\binit\s+[06]\b/i,
    /\buserdel\b/i,
    /\bpasswd\b/i,
    /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i,
    />\s*\/dev\/sd/i,
    /\bmkfs\./i,
    /\bchmod\s+-R\s+777\s+\//i,
];

app.use(express.json({ limit: '1mb' }));

const userSessions = {};
let hosts = {};
let users = [];
/** @type {Record<string, { conn: import('ssh2').Client, stream: any, lastSeen: number, serverName: string, recentOutput: string, clients: Set<import('ws').WebSocket> }>} */
const activeSessions = {};

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);

    if (user) {
        const token = uuidv4();
        userSessions[token] = { username: user.username, lastSeen: Date.now() };
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    // Service token for MCP stdio bridge (Grok agent → SSH-Mag)
    if (token === SSH_MAG_MCP_TOKEN) {
        req.user = 'mcp-service';
        req.isMcp = true;
        return next();
    }

    const session = userSessions[token];
    if (!session) return res.sendStatus(440);

    session.lastSeen = Date.now();
    req.user = session.username;
    next();
}

function loadHostsConfig() {
    try {
        hosts = JSON.parse(fs.readFileSync(HOSTS_PATH, 'utf8'));
        if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) {
            throw new Error('hosts.json must be an object.');
        }
        console.log('Host configuration loaded.');
    } catch (error) {
        console.error('FATAL: Error with hosts.json:', error.message);
        if (require.main === module) process.exit(1);
    }
}
loadHostsConfig();

function loadUsersConfig() {
    try {
        users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
        if (!Array.isArray(users)) {
            throw new Error('users.json must be an array.');
        }
        console.log('User configuration loaded.');
    } catch (error) {
        console.error('FATAL: Error with users.json:', error.message);
        if (require.main === module) process.exit(1);
    }
}
loadUsersConfig();

function publicHostInfo(name) {
    const h = hosts[name] || {};
    return {
        name,
        host: h.host,
        username: h.username,
        port: h.port || 22,
        role: h.role || null,
        tags: h.tags || [],
        notes: h.notes || null,
    };
}

function isDangerousCommand(command) {
    const c = String(command || '');
    return DANGEROUS_CMD.some((re) => re.test(c));
}

function appendSessionOutput(session, data) {
    const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    session.recentOutput = (session.recentOutput + chunk).slice(-OUTPUT_BUF_MAX);
    session.lastSeen = Date.now();
    for (const client of session.clients) {
        if (client.readyState === 1) {
            try {
                client.send(data);
            } catch (_) { /* ignore */ }
        }
    }
}

function buildSshConnectOpts(sshConfig) {
    const opts = {
        host: sshConfig.host,
        username: sshConfig.username,
        port: sshConfig.port || 22,
        keepaliveInterval: 10000,
    };
    if (sshConfig.password) opts.password = sshConfig.password;
    else if (sshConfig.privateKeyPath) {
        opts.privateKey = fs.readFileSync(path.resolve(__dirname, sshConfig.privateKeyPath), 'utf8');
    } else {
        throw new Error('Authentication method (password or privateKeyPath) not provided.');
    }
    return opts;
}

const AI_CONTROL_HOLD_MS = Number(process.env.AI_CONTROL_HOLD_MS) || 5000;

function markAiActivity(session, info = {}) {
    if (!session) return;
    const holdMs = info.holdMs != null ? info.holdMs : AI_CONTROL_HOLD_MS;
    const now = Date.now();
    const prev = session.ai || {};
    session.ai = {
        openedByAi: Boolean(prev.openedByAi || info.openedByAi),
        lastAction: info.action || prev.lastAction || 'activity',
        lastCommand: info.command != null ? String(info.command).slice(0, 200) : (prev.lastCommand || null),
        lastAiAt: now,
        until: Math.max(now + holdMs, prev.until || 0),
    };
    session.lastSeen = now;
}

function publicAiState(session) {
    const ai = (session && session.ai) || {};
    const now = Date.now();
    return {
        openedByAi: Boolean(ai.openedByAi),
        aiActive: Boolean(ai.until && ai.until > now),
        lastAction: ai.lastAction || null,
        lastCommand: ai.lastCommand || null,
        lastAiAt: ai.lastAiAt || null,
        until: ai.until || null,
    };
}

function createSshSession(serverName, options = {}) {
    return new Promise((resolve, reject) => {
        if (!serverName || !hosts[serverName]) {
            return reject(new Error(`Host '${serverName}' not found in hosts.json.`));
        }
        const sshConfig = hosts[serverName];
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
        };
        const conn = new Client();
        conn.on('ready', () => {
            conn.shell({ modes: { echo: true } }, (err, stream) => {
                if (err) {
                    conn.end();
                    return fail(new Error(`Shell failed: ${err.message}`));
                }
                const sessionId = uuidv4();
                const session = {
                    conn,
                    stream,
                    lastSeen: Date.now(),
                    serverName,
                    recentOutput: '',
                    clients: new Set(),
                    ai: null,
                };
                if (options.openedByAi) {
                    markAiActivity(session, { openedByAi: true, action: 'open', holdMs: AI_CONTROL_HOLD_MS * 2 });
                }
                stream.on('data', (data) => appendSessionOutput(session, data));
                stream.on('close', () => {
                    for (const c of session.clients) {
                        try { c.close(); } catch (_) { /* ignore */ }
                    }
                    delete activeSessions[sessionId];
                });
                activeSessions[sessionId] = session;
                settled = true;
                resolve({ sessionId, serverName });
            });
        }).on('error', (err) => fail(new Error(`SSH connection error: ${err.message}`)));

        try {
            conn.connect(buildSshConnectOpts(sshConfig));
        } catch (error) {
            fail(error);
        }
    });
}

function findSessionsByHost(serverName) {
    return Object.entries(activeSessions)
        .filter(([, s]) => s.serverName === serverName)
        .map(([sessionId, s]) => ({
            sessionId,
            serverName: s.serverName,
            lastSeen: s.lastSeen,
            ...publicAiState(s),
        }));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function runCommandInSession(sessionId, command, waitMs = AI_CMD_WAIT_MS) {
    const session = activeSessions[sessionId];
    if (!session) throw new Error('Invalid or expired session ID.');
    if (!command || typeof command !== 'string') throw new Error('Command is required.');
    if (isDangerousCommand(command)) {
        return {
            ok: false,
            blocked: true,
            message: 'Command blocked by safety filter. Ask the user to run it manually if intentional.',
            command,
        };
    }

    const hold = Math.max(AI_CONTROL_HOLD_MS, (Number(waitMs) || 0) + 1500);
    markAiActivity(session, {
        openedByAi: true,
        action: 'command',
        command,
        holdMs: hold,
    });

    const marker = session.recentOutput.length;
    session.stream.write(command.endsWith('\n') ? command : command + '\n');
    session.lastSeen = Date.now();
    await sleep(waitMs);
    // Keep badge a bit after capture so UI can show "AI just ran …"
    markAiActivity(session, {
        action: 'command',
        command,
        holdMs: AI_CONTROL_HOLD_MS,
    });
    const captured = session.recentOutput.slice(marker).slice(-16000);
    return {
        ok: true,
        sessionId,
        serverName: session.serverName,
        command,
        output: captured,
        note: 'Command was written into the interactive SSH session (visible in xterm).',
    };
}

async function batchExecuteHosts(hostNames, command) {
    if (!hostNames || !Array.isArray(hostNames) || hostNames.length === 0) {
        throw new Error('Invalid or empty hostNames array.');
    }
    if (!command) throw new Error('Command is required.');
    if (isDangerousCommand(command)) {
        return [{ error: 'Command blocked by safety filter.', command }];
    }

    const results = [];
    await Promise.all(hostNames.map(async (serverName) => {
        const sshConfig = hosts[serverName];
        if (!sshConfig) {
            results.push({ server: serverName, error: 'Host not found in configuration.' });
            return;
        }
        const ssh = new NodeSSH();
        try {
            const opts = {
                host: sshConfig.host,
                username: sshConfig.username,
                port: sshConfig.port || 22,
            };
            if (sshConfig.password) opts.password = sshConfig.password;
            else if (sshConfig.privateKeyPath) {
                opts.privateKey = fs.readFileSync(path.resolve(__dirname, sshConfig.privateKeyPath), 'utf8');
            } else throw new Error('Authentication method not provided.');

            await ssh.connect(opts);
            let execCommand = command
                .replace(/\{host\}/g, sshConfig.host || '')
                .replace(/\{username\}/g, sshConfig.username || '')
                .replace(/\{port\}/g, String(sshConfig.port || 22));

            const result = await ssh.execCommand(execCommand);
            results.push({
                server: serverName,
                output: (result.stdout || '').slice(0, 8000),
                error: (result.stderr || '').slice(0, 2000),
                code: result.code,
            });
            ssh.dispose();
        } catch (error) {
            results.push({ server: serverName, error: error.message });
        }
    }));
    return results;
}

// --- API Endpoints ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/servers', authenticateToken, (req, res) => res.json(Object.keys(hosts).map(name => ({ name }))));
app.get('/api/hosts-config', authenticateToken, (req, res) => {
    fs.readFile(HOSTS_PATH, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.json({ config: '{}\n' });
            return res.status(500).json({ error: 'Could not read hosts file.' });
        }
        res.json({ config: data });
    });
});
app.post('/api/hosts-config', authenticateToken, (req, res) => {
    const { config } = req.body;
    try { JSON.parse(config); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    fs.writeFile(HOSTS_PATH, config, 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Could not write to hosts file.' });
        loadHostsConfig();
        res.json({ success: true });
    });
});
app.get('/api/shortcuts', authenticateToken, (req, res) => {
    fs.readFile(SHORTCUTS_PATH, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.json([]);
            return res.status(500).json({ error: 'Could not read shortcuts file.' });
        }
        try { res.json(JSON.parse(data)); } catch (e) { res.status(500).json({ error: 'Error parsing shortcuts.json.' }); }
    });
});
app.get('/api/shortcuts-config', authenticateToken, (req, res) => {
    fs.readFile(SHORTCUTS_PATH, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.json({ config: '[]' });
            return res.status(500).json({ error: 'Could not read shortcuts file.' });
        }
        res.json({ config: data });
    });
});
app.post('/api/shortcuts-config', authenticateToken, (req, res) => {
    const { config } = req.body;
    try { JSON.parse(config); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    fs.writeFile(SHORTCUTS_PATH, config, 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Could not write to shortcuts file.' });
        res.json({ success: true });
    });
});
app.get('/api/batch-shortcuts', authenticateToken, (req, res) => {
    fs.readFile(BATCH_SHORTCUTS_PATH, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.json([]);
            return res.status(500).json({ error: 'Could not read batch shortcuts file.' });
        }
        try { res.json(JSON.parse(data)); } catch (e) { res.status(500).json({ error: 'Error parsing batch_shortcuts.json.' }); }
    });
});
app.get('/api/batch-shortcuts-config', authenticateToken, (req, res) => {
    fs.readFile(BATCH_SHORTCUTS_PATH, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') return res.json({ config: '[]' });
            return res.status(500).json({ error: 'Could not read batch shortcuts file.' });
        }
        res.json({ config: data });
    });
});
app.post('/api/batch-shortcuts-config', authenticateToken, (req, res) => {
    const { config } = req.body;
    try { JSON.parse(config); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    fs.writeFile(BATCH_SHORTCUTS_PATH, config, 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Could not write to batch shortcuts file.' });
        res.json({ success: true });
    });
});

app.post('/api/batch-execute', authenticateToken, async (req, res) => {
    try {
        const { hostNames, command } = req.body;
        const results = await batchExecuteHosts(hostNames, command);
        res.json(results);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/sessions', authenticateToken, (req, res) => {
    const list = Object.entries(activeSessions).map(([sessionId, s]) => ({
        sessionId,
        serverName: s.serverName,
        lastSeen: s.lastSeen,
        clients: s.clients.size,
        ...publicAiState(s),
    }));
    res.json(list);
});

app.post('/api/sessions/open', authenticateToken, async (req, res) => {
    try {
        const { hostName, reuse = true } = req.body || {};
        if (!hostName) return res.status(400).json({ error: 'hostName is required' });
        const byAi = Boolean(req.isMcp);
        if (reuse) {
            const existing = findSessionsByHost(hostName);
            if (existing.length > 0) {
                const session = activeSessions[existing[0].sessionId];
                if (byAi && session) {
                    markAiActivity(session, { openedByAi: true, action: 'reuse', holdMs: AI_CONTROL_HOLD_MS });
                }
                return res.json({
                    sessionId: existing[0].sessionId,
                    serverName: existing[0].serverName,
                    lastSeen: existing[0].lastSeen,
                    ...publicAiState(session),
                    reused: true,
                    clientAction: 'attach_session',
                });
            }
        }
        const created = await createSshSession(hostName, { openedByAi: byAi });
        const session = activeSessions[created.sessionId];
        res.json({
            ...created,
            ...publicAiState(session),
            reused: false,
            clientAction: 'attach_session',
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sessions/:sessionId/input', authenticateToken, async (req, res) => {
    try {
        const { command, waitMs } = req.body || {};
        const result = await runCommandInSession(req.params.sessionId, command, waitMs);
        res.json(result);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/mcp/hosts', authenticateToken, (req, res) => {
    res.json(Object.keys(hosts).map(publicHostInfo));
});

function buildAgentWsUrl() {
    if (!GROK_AGENT_SECRET) return null;
    const base = GROK_AGENT_URL.includes('?') ? GROK_AGENT_URL : `${GROK_AGENT_URL}${GROK_AGENT_URL.endsWith('/ws') ? '' : ''}`;
    const url = new URL(base.startsWith('ws') ? base : `ws://${base}`);
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    url.searchParams.set('server-key', GROK_AGENT_SECRET);
    return url.toString();
}

function buildMcpServersForAgent() {
    return [{
        name: 'ssh-mag',
        command: process.execPath,
        args: [path.join(__dirname, 'mcp-ssh-mag.js')],
        env: [
            { name: 'SSH_MAG_BASE', value: SSH_MAG_PUBLIC_BASE },
            { name: 'SSH_MAG_MCP_TOKEN', value: SSH_MAG_MCP_TOKEN },
        ],
    }];
}

const ACP_STATE_PATH = path.resolve(__dirname, '.acp-session.json');
const MAX_RESYNC_CHARS = Number(process.env.AI_RESYNC_MAX_CHARS) || 24000;

function loadPersistedAcpState() {
    try {
        if (!fs.existsSync(ACP_STATE_PATH)) return {};
        return JSON.parse(fs.readFileSync(ACP_STATE_PATH, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function savePersistedAcpState(partial) {
    try {
        const prev = loadPersistedAcpState();
        const next = {
            ...prev,
            ...partial,
            updatedAt: Date.now(),
        };
        fs.writeFileSync(ACP_STATE_PATH, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
        console.warn('Could not persist ACP state:', e.message);
    }
}

function normalizeChatMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role, content: String(m.content) }));
}

/** Fingerprint of prior turns (everything before the latest user message). */
function historyFingerprint(messages) {
    const norm = normalizeChatMessages(messages);
    if (norm.length === 0) return '';
    let end = norm.length;
    if (norm[end - 1].role === 'user') end -= 1;
    const prior = norm.slice(0, end);
    return crypto.createHash('sha256').update(JSON.stringify(prior)).digest('hex').slice(0, 24);
}

function truncateForResync(text, maxEach = 4000) {
    const s = String(text || '');
    if (s.length <= maxEach) return s;
    return s.slice(0, maxEach) + `\n…[truncated ${s.length - maxEach} chars]`;
}

/**
 * Build prompt text. If agent needs UI history, embed prior turns so Grok context matches the frontend.
 * Resync only when reconnect/new session/explicit force — not on every normal turn.
 */
function buildAgentPrompt(messages, { forceResync = false, acp } = {}) {
    const norm = normalizeChatMessages(messages);
    if (norm.length === 0) throw new Error('No messages');
    const last = norm[norm.length - 1];
    if (last.role !== 'user') throw new Error('Last message must be from user');

    const prior = norm.slice(0, -1);
    const fp = historyFingerprint(messages);
    const mustResync = Boolean(forceResync)
        || (acp && acp.needsHistoryResync && prior.length > 0)
        || (acp && prior.length > 0 && acp.sessionMethod === 'new' && !acp.syncedFingerprint);

    if (!mustResync || prior.length === 0) {
        return {
            text: last.content,
            resynced: false,
            fingerprint: fp,
        };
    }

    const blocks = [];
    let used = 0;
    for (let i = prior.length - 1; i >= 0; i--) {
        const m = prior[i];
        const piece = `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncateForResync(m.content)}`;
        if (used + piece.length > MAX_RESYNC_CHARS) break;
        blocks.unshift(piece);
        used += piece.length + 2;
    }

    const text = [
        '[SSH-Mag UI context sync]',
        'The browser reconnected or the agent session was recreated.',
        'Below is the conversation the user already sees. Do NOT re-answer old messages.',
        'Only respond to the NEW user message at the end.',
        '',
        '=== Conversation so far ===',
        blocks.join('\n\n'),
        '=== End of history ===',
        '',
        'NEW user message (respond only to this):',
        last.content,
    ].join('\n');

    return { text, resynced: true, fingerprint: fp };
}

/** One long-lived ACP session shared by the web UI (single-user personal tool). */
let sharedAcp = null;
let sharedAcpInit = null;

/**
 * @param {string|null} preferredSessionId from browser localStorage
 */
async function getSharedAcp(preferredSessionId = null) {
    if (sharedAcp && sharedAcp.sessionId && sharedAcp.ws && sharedAcp.ws.readyState === 1) {
        return sharedAcp;
    }
    if (sharedAcpInit) return sharedAcpInit;

    sharedAcpInit = (async () => {
        const wsUrl = buildAgentWsUrl();
        if (!wsUrl) throw new Error('GROK_AGENT_SECRET not set');

        if (sharedAcp) {
            try { sharedAcp.close(); } catch (_) { /* ignore */ }
            sharedAcp = null;
        }

        const persisted = loadPersistedAcpState();
        const tryId = preferredSessionId || persisted.sessionId || null;

        const client = new AcpClient({
            url: wsUrl,
            cwd: __dirname,
            mcpServers: buildMcpServersForAgent(),
            sessionMeta: { rules: AI_RULES },
            autoApprove: true,
        });
        const init = await client.initialize(tryId);
        if (persisted.syncedFingerprint && init.restored) {
            client.markHistorySynced(persisted.syncedFingerprint);
        }
        savePersistedAcpState({
            sessionId: client.sessionId,
            sessionMethod: client.sessionMethod,
            syncedFingerprint: client.syncedFingerprint || persisted.syncedFingerprint || '',
        });
        sharedAcp = client;
        return client;
    })();

    try {
        return await sharedAcpInit;
    } finally {
        sharedAcpInit = null;
    }
}

function sessionsAsClientActions() {
    return Object.entries(activeSessions).map(([sessionId, s]) => ({
        type: 'attach_session',
        sessionId,
        hostName: s.serverName,
    }));
}

function collectClientActions(beforeIds) {
    const clientActions = [];
    for (const [sessionId, s] of Object.entries(activeSessions)) {
        if (!beforeIds.has(sessionId) || s.clients.size === 0) {
            clientActions.push({
                type: 'attach_session',
                sessionId,
                hostName: s.serverName,
            });
        }
    }
    if (clientActions.length === 0) {
        for (const a of sessionsAsClientActions()) {
            if (activeSessions[a.sessionId] && activeSessions[a.sessionId].clients.size === 0) {
                clientActions.push(a);
            }
        }
    }
    return clientActions;
}

app.get('/api/ai/status', authenticateToken, async (req, res) => {
    const secretOk = Boolean(GROK_AGENT_SECRET);
    let agentReachable = false;
    let agentError = null;
    let model = null;
    let acpSessionId = null;
    let sessionMethod = null;
    let needsHistoryResync = null;
    const preferred = (req.query && req.query.acpSessionId) || null;

    if (secretOk) {
        try {
            const acp = await getSharedAcp(preferred);
            agentReachable = true;
            acpSessionId = acp.sessionId;
            sessionMethod = acp.sessionMethod;
            needsHistoryResync = acp.needsHistoryResync;
            const models = acp.agentInfo && acp.agentInfo._meta && acp.agentInfo._meta.modelState;
            model = (models && models.currentModelId) || 'grok-agent';
        } catch (e) {
            agentError = e.message;
            acpSessionId = loadPersistedAcpState().sessionId || null;
        }
    }

    res.json({
        mode: 'grok-agent-serve',
        configured: secretOk && agentReachable,
        secretConfigured: secretOk,
        agentReachable,
        agentError,
        agentUrl: GROK_AGENT_URL,
        model,
        acpSessionId,
        sessionMethod,
        needsHistoryResync,
        sessions: Object.keys(activeSessions).length,
        hosts: Object.keys(hosts).length,
    });
});

app.post('/api/ai/reset', authenticateToken, async (req, res) => {
    if (req.isMcp) return res.status(403).json({ error: 'MCP token cannot reset chat' });
    if (!GROK_AGENT_SECRET) {
        return res.status(503).json({ error: 'AI not configured' });
    }
    try {
        let acp = sharedAcp;
        if (!acp || !acp.ws || acp.ws.readyState !== 1) {
            acp = await getSharedAcp(null);
        }
        await acp.resetSession();
        savePersistedAcpState({
            sessionId: acp.sessionId,
            sessionMethod: 'new',
            syncedFingerprint: '',
        });
        res.json({ success: true, acpSessionId: acp.sessionId });
    } catch (e) {
        try { if (sharedAcp) sharedAcp.close(); } catch (_) { /* ignore */ }
        sharedAcp = null;
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ai/chat', authenticateToken, async (req, res) => {
    if (req.isMcp) return res.status(403).json({ error: 'MCP token cannot use chat' });
    if (!GROK_AGENT_SECRET) {
        return res.status(503).json({
            error: 'AI not configured. Set GROK_AGENT_SECRET and run: grok agent --always-approve serve --secret <same>',
        });
    }

    const { messages, acpSessionId: clientSessionId, forceResync } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
    }

    const norm = normalizeChatMessages(messages);
    const lastUser = [...norm].reverse().find((m) => m.role === 'user');
    if (!lastUser) return res.status(400).json({ error: 'No user message found' });

    const before = new Set(Object.keys(activeSessions));

    try {
        let acp;
        try {
            acp = await getSharedAcp(clientSessionId || null);
        } catch (e) {
            sharedAcp = null;
            acp = await getSharedAcp(clientSessionId || null);
        }

        // Browser has a different session id than live agent → treat as reconnect, resync history
        const sessionMismatch = Boolean(clientSessionId && acp.sessionId && clientSessionId !== acp.sessionId);
        if (sessionMismatch) {
            acp.needsHistoryResync = true;
        }

        const built = buildAgentPrompt(norm, {
            forceResync: Boolean(forceResync) || sessionMismatch,
            acp,
        });

        const result = await acp.prompt(built.text);

        // After a successful turn, agent knows prior + this exchange (fingerprint of prior before last user)
        // Next turn's prior will include this assistant reply — fingerprint updates on client next request.
        // Mark prior as synced so we don't re-inject the same prior again.
        acp.markHistorySynced(built.fingerprint);
        savePersistedAcpState({
            sessionId: acp.sessionId,
            sessionMethod: acp.sessionMethod,
            syncedFingerprint: built.fingerprint,
        });

        const clientActions = collectClientActions(before);

        res.json({
            reply: result.reply || '(No text response)',
            clientActions,
            toolTrace: result.toolTrace || [],
            stopReason: result.stopReason,
            mode: 'grok-agent-serve',
            acpSessionId: acp.sessionId,
            contextResynced: built.resynced,
            sessionMethod: acp.sessionMethod,
        });
    } catch (e) {
        console.error('AI chat (ACP) error:', e);
        try { if (sharedAcp) sharedAcp.close(); } catch (_) { /* ignore */ }
        sharedAcp = null;
        res.status(500).json({
            error: e.message || 'Agent request failed',
            hint: 'Is grok agent serve running? Example: grok agent --always-approve serve --bind 127.0.0.1:2419 --secret YOUR_SECRET',
            acpSessionId: loadPersistedAcpState().sessionId || null,
        });
    }
});

// --- Session cleanup ---
setInterval(() => {
    const now = Date.now();
    for (const sessionId in activeSessions) {
        if (now - activeSessions[sessionId].lastSeen > SESSION_TIMEOUT) {
            try { activeSessions[sessionId].conn.end(); } catch (_) { /* ignore */ }
            delete activeSessions[sessionId];
        }
    }
}, 10 * 1000);

function setupWebSocketListeners(ws, sessionId) {
    const session = activeSessions[sessionId];
    if (!session) return;
    const stream = session.stream;
    const sshConfig = hosts[session.serverName] || {};

    session.clients.add(ws);
    session.lastSeen = Date.now();

    // Replay recent buffer so AI-driven output is visible if the tab attaches late
    if (session.recentOutput) {
        try {
            ws.send(Buffer.from(session.recentOutput, 'utf8'));
        } catch (_) { /* ignore */ }
    }

    const messageHandlers = {
        data: (msg) => stream.write(msg.data),
        resize: (msg) => {
            try { stream.setWindow(msg.rows, msg.cols); } catch (_) { /* ignore */ }
        },
        shortcut: (msg) => {
            const match = msg.command.match(/\{([\w.-]+)\.([\w]+)\}/);
            if (match) {
                const requiredHostKey = match[1];
                const paramKey = match[2];

                if (!hosts[requiredHostKey]) {
                    const possibleHosts = Object.keys(hosts).filter(hostName =>
                        Object.prototype.hasOwnProperty.call(hosts[hostName], paramKey)
                    );

                    if (possibleHosts.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'request_host_selection',
                            command: msg.command,
                            hosts: possibleHosts,
                            requiredHostKey: requiredHostKey,
                        }));
                        return;
                    }
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Shortcut error: No host found with the parameter '${paramKey}'.`,
                    }));
                    return;
                }
            }

            let command = msg.command;
            command = command.replace(/\{host\}/g, sshConfig.host || '');
            command = command.replace(/\{username\}/g, sshConfig.username || '');
            command = command.replace(/\{port\}/g, sshConfig.port || '22');
            command = command.replace(/\{servername\}/g, sshConfig.servername || '');
            command = command.replace(/\{([\w.-]+)\.([\w]+)\}/g, (match, hostKey, paramKey) => {
                const hostInfo = hosts[hostKey];
                if (!hostInfo) return match;
                return hostInfo[paramKey] || '';
            });
            stream.write(command + '\n');
        },
        shortcut_execute: (msg) => {
            let command = msg.command;
            command = command.replace(/\{host\}/g, sshConfig.host || '');
            command = command.replace(/\{username\}/g, sshConfig.username || '');
            command = command.replace(/\{port\}/g, sshConfig.port || '22');
            command = command.replace(/\{servername\}/g, sshConfig.servername || '');
            const selectedHost = msg.selectedHost;
            const originalHostKey = msg.originalHostKey;
            command = command.replace(new RegExp(`\\{${originalHostKey}\\.([\\w]+)\\}`, 'g'), (match, paramKey) => {
                const hostInfo = hosts[selectedHost];
                if (!hostInfo) return match;
                return hostInfo[paramKey] || '';
            });
            stream.write(command + '\n');
        },
    };

    function onMessage(raw, isBinary) {
        if (activeSessions[sessionId]) activeSessions[sessionId].lastSeen = Date.now();
        if (isBinary) {
            stream.write(raw);
            return;
        }
        try {
            const msg = JSON.parse(raw);
            if (msg.type && messageHandlers[msg.type]) messageHandlers[msg.type](msg);
        } catch (_) { /* ignore non-json */ }
    }

    ws.on('message', onMessage);
    ws.on('close', () => {
        session.clients.delete(ws);
        ws.removeListener('message', onMessage);
    });
}

server.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);
    if (pathname !== '/ssh') return socket.destroy();

    let upgradeHandled = false;
    const rejectConnection = (message) => {
        if (upgradeHandled) return;
        upgradeHandled = true;
        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.send(JSON.stringify({ type: 'error', message }));
            ws.terminate();
        });
    };

    const token = query.token;
    if (!token) return rejectConnection('Authentication token required.');

    const userSession = userSessions[token];
    if (!userSession) return rejectConnection('Invalid or expired authentication token.');

    userSession.lastSeen = Date.now();

    if (query.sessionId) {
        const session = activeSessions[query.sessionId];
        if (session) {
            if (upgradeHandled) return;
            upgradeHandled = true;
            wss.handleUpgrade(request, socket, head, (ws) => {
                setupWebSocketListeners(ws, query.sessionId);
            });
        } else {
            rejectConnection('Invalid session ID. The server may have restarted.');
        }
        return;
    }

    const serverName = query.server;
    if (!serverName || !hosts[serverName]) {
        return rejectConnection(`Host '${serverName}' not found in hosts.json.`);
    }

    createSshSession(serverName)
        .then(({ sessionId }) => {
            if (upgradeHandled) return;
            upgradeHandled = true;
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.send(JSON.stringify({ type: 'session', sessionId }));
                setupWebSocketListeners(ws, sessionId);
            });
        })
        .catch((err) => rejectConnection(err.message));
});

server.listen(PORT, BIND_IP, () => {
    console.log(`Server on http://${BIND_IP === '0.0.0.0' ? 'localhost' : BIND_IP}:${PORT}`);
    if (GROK_AGENT_SECRET) {
        console.log(`AI: grok agent serve mode → ${GROK_AGENT_URL} (secret set)`);
        console.log(`MCP token for agent child: use SSH_MAG_MCP_TOKEN env (auto-generated if unset)`);
    } else {
        console.log('AI disabled — set GROK_AGENT_SECRET and run grok agent serve');
    }
});
