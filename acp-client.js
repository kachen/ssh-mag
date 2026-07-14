/**
 * Minimal ACP (Agent Client Protocol) WebSocket client for `grok agent serve`.
 * URL shape: ws://127.0.0.1:2419/ws?server-key=<secret>
 */
const WebSocket = require('ws');

class AcpClient {
    /**
     * @param {object} opts
     * @param {string} opts.url  Full WebSocket URL including server-key
     * @param {string} [opts.cwd]
     * @param {object[]} [opts.mcpServers] ACP McpServer configs
     * @param {object} [opts.sessionMeta] extra _meta for session/new (e.g. rules)
     * @param {boolean} [opts.autoApprove=true]
     * @param {(msg: object) => void} [opts.onNotification]
     */
    constructor(opts) {
        this.url = opts.url;
        this.cwd = opts.cwd || process.cwd();
        this.mcpServers = opts.mcpServers || [];
        this.sessionMeta = opts.sessionMeta || {};
        this.autoApprove = opts.autoApprove !== false;
        this.onNotification = opts.onNotification || (() => {});
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.sessionId = null;
        this.agentInfo = null;
        this._openPromise = null;
        /** @type {boolean} agent session is empty / has no UI history yet */
        this.needsHistoryResync = true;
        /** fingerprint of conversation already known to the agent (excl. in-flight user turn) */
        this.syncedFingerprint = '';
        /** how session was obtained: resume | load | new */
        this.sessionMethod = null;
    }

    connect() {
        if (this._openPromise) return this._openPromise;
        this._openPromise = new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            const timer = setTimeout(() => {
                reject(new Error('ACP WebSocket connect timeout'));
                try { ws.terminate(); } catch (_) { /* ignore */ }
            }, 15000);

            ws.on('open', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            ws.on('close', () => {
                this._openPromise = null;
                this.ws = null;
                for (const [, p] of this.pending) {
                    p.reject(new Error('ACP connection closed'));
                }
                this.pending.clear();
            });
            ws.on('message', (data) => this._onMessage(data.toString()));
        });
        return this._openPromise;
    }

    _onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }

        if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
            const p = this.pending.get(msg.id);
            if (p) {
                this.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else p.resolve(msg.result);
            }
            return;
        }

        if (msg.id != null && msg.method) {
            this._handleAgentRequest(msg).catch((err) => {
                this._send({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32000, message: err.message || String(err) },
                });
            });
            return;
        }

        if (msg.method) {
            this.onNotification(msg);
        }
    }

    async _handleAgentRequest(msg) {
        if (msg.method === 'session/request_permission') {
            const options = (msg.params && msg.params.options) || [];
            let optionId = 'allow-once';
            const prefer = ['allow-always', 'allow-once', 'allow', 'approve'];
            for (const id of prefer) {
                const hit = options.find((o) => o.optionId === id || o.id === id);
                if (hit) {
                    optionId = hit.optionId || id;
                    break;
                }
            }
            if (options[0] && options[0].optionId) optionId = options[0].optionId;
            if (!this.autoApprove) {
                this._send({
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: { outcome: { outcome: 'cancelled' } },
                });
                return;
            }
            this._send({
                jsonrpc: '2.0',
                id: msg.id,
                result: { outcome: { outcome: 'selected', optionId } },
            });
            return;
        }

        this._send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `Unsupported client method: ${msg.method}` },
        });
    }

    _send(obj) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('ACP WebSocket is not open');
        }
        this.ws.send(JSON.stringify(obj));
    }

    request(method, params, timeoutMs = 120000) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP request timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            try {
                this._send({ jsonrpc: '2.0', id, method, params });
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    async handshake() {
        await this.connect();
        this.agentInfo = await this.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'ssh-mag', version: '1.0.0' },
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
        });
        try {
            await this.request('authenticate', { methodId: 'cached_token' }, 30000);
        } catch (_) {
            // session/new will fail if auth is truly required
        }
        return this.agentInfo;
    }

    async createSession() {
        const sess = await this.request('session/new', {
            cwd: this.cwd,
            mcpServers: this.mcpServers,
            _meta: this.sessionMeta,
        });
        this.sessionId = sess.sessionId;
        this.sessionMethod = 'new';
        this.needsHistoryResync = true;
        this.syncedFingerprint = '';
        return sess;
    }

    async resumeSession(sessionId) {
        await this.request('session/resume', {
            sessionId,
            cwd: this.cwd,
            mcpServers: this.mcpServers,
        }, 60000);
        this.sessionId = sessionId;
        this.sessionMethod = 'resume';
        this.needsHistoryResync = false;
        return { sessionId };
    }

    async loadSession(sessionId) {
        // History may stream via session/update; we ignore it (UI uses localStorage).
        await this.request('session/load', {
            sessionId,
            cwd: this.cwd,
            mcpServers: this.mcpServers,
        }, 120000);
        this.sessionId = sessionId;
        this.sessionMethod = 'load';
        this.needsHistoryResync = false;
        return { sessionId };
    }

    /**
     * Connect and attach to preferredSessionId (resume → load → new).
     * @param {string|null} preferredSessionId
     */
    async initialize(preferredSessionId = null) {
        await this.handshake();

        if (preferredSessionId) {
            try {
                await this.resumeSession(preferredSessionId);
                return {
                    agentInfo: this.agentInfo,
                    sessionId: this.sessionId,
                    sessionMethod: this.sessionMethod,
                    restored: true,
                };
            } catch (resumeErr) {
                try {
                    await this.loadSession(preferredSessionId);
                    return {
                        agentInfo: this.agentInfo,
                        sessionId: this.sessionId,
                        sessionMethod: this.sessionMethod,
                        restored: true,
                    };
                } catch (loadErr) {
                    // fall through to new
                }
            }
        }

        const sess = await this.createSession();
        return {
            agentInfo: this.agentInfo,
            sessionId: this.sessionId,
            session: sess,
            sessionMethod: 'new',
            restored: false,
        };
    }

    /**
     * Force a brand-new agent conversation (e.g. UI Clear chat).
     */
    async resetSession() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.handshake();
        }
        const sess = await this.createSession();
        return { sessionId: this.sessionId, session: sess };
    }

    /**
     * @param {string} text
     * @param {(update: object) => void} [onUpdate]
     */
    async prompt(text, onUpdate) {
        if (!this.sessionId) throw new Error('ACP session not initialized');

        let reply = '';
        const toolTrace = [];
        const handler = (msg) => {
            if (msg.method !== 'session/update') return;
            const update = msg.params && msg.params.update;
            if (!update) return;
            if (typeof onUpdate === 'function') onUpdate(update);

            const kind = update.sessionUpdate;
            if (kind === 'agent_message_chunk') {
                const t = update.content && (update.content.text || update.content);
                if (typeof t === 'string') reply += t;
            } else if (kind === 'tool_call') {
                toolTrace.push({
                    name: update.title || update.toolName || update.kind || 'tool',
                    status: update.status,
                });
            } else if (kind === 'tool_call_update' && update.title) {
                toolTrace.push({ name: update.title, status: update.status });
            }
        };

        const prev = this.onNotification;
        this.onNotification = (msg) => {
            try { prev(msg); } catch (_) { /* ignore */ }
            handler(msg);
        };

        try {
            const result = await this.request('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text }],
            }, 300000);
            return {
                reply: reply.trim(),
                stopReason: result && result.stopReason,
                toolTrace,
                raw: result,
            };
        } finally {
            this.onNotification = prev;
        }
    }

    markHistorySynced(fingerprint) {
        this.needsHistoryResync = false;
        this.syncedFingerprint = fingerprint || '';
    }

    close() {
        try {
            if (this.ws) this.ws.close();
        } catch (_) { /* ignore */ }
        this.ws = null;
        this._openPromise = null;
        // keep sessionId for persistence file; caller may read it before close
    }
}

module.exports = { AcpClient };
