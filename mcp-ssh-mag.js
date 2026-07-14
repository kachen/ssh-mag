#!/usr/bin/env node
/**
 * Stdio MCP server for Grok agent serve.
 * Proxies ops tools to the local SSH-Mag HTTP API.
 *
 * Env:
 *   SSH_MAG_BASE       default http://127.0.0.1:3000
 *   SSH_MAG_MCP_TOKEN  required service token (Authorization: Bearer …)
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const BASE = (process.env.SSH_MAG_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.SSH_MAG_MCP_TOKEN || '';

async function api(method, path, body) {
    if (!TOKEN) throw new Error('SSH_MAG_MCP_TOKEN is not set');
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'X-SSH-Mag-MCP': '1',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
        const msg = data.error || data.message || text || res.statusText;
        throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
    }
    return data;
}

const tools = [
    {
        name: 'list_hosts',
        description: 'List configured SSH hosts (name, host, username, port, role, tags, notes). Never includes passwords or keys.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'list_sessions',
        description: 'List active interactive SSH sessions in SSH-Mag (sessionId + host). Prefer run_in_session so the user sees output in xterm.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'open_host_session',
        description: 'Open (or reuse) an interactive SSH session. The browser attaches an xterm tab. Call before run_in_session if no session exists.',
        inputSchema: {
            type: 'object',
            properties: {
                hostName: { type: 'string', description: 'Exact host key from list_hosts' },
                reuse: { type: 'boolean', description: 'Reuse existing session if any (default true)' },
            },
            required: ['hostName'],
            additionalProperties: false,
        },
    },
    {
        name: 'run_in_session',
        description: 'Run a shell command in an interactive session (visible in the user\'s xterm). Prefer short non-interactive diagnostics.',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' },
                command: { type: 'string' },
                waitMs: { type: 'integer', description: 'Wait for output in ms (default ~2800)' },
            },
            required: ['sessionId', 'command'],
            additionalProperties: false,
        },
    },
    {
        name: 'batch_run',
        description: 'Run a non-interactive command on multiple hosts via exec (results return here; not shown in xterm).',
        inputSchema: {
            type: 'object',
            properties: {
                hostNames: { type: 'array', items: { type: 'string' } },
                command: { type: 'string' },
            },
            required: ['hostNames', 'command'],
            additionalProperties: false,
        },
    },
];

async function runTool(name, args) {
    switch (name) {
        case 'list_hosts':
            return api('GET', '/api/mcp/hosts');
        case 'list_sessions':
            return api('GET', '/api/sessions');
        case 'open_host_session':
            return api('POST', '/api/sessions/open', {
                hostName: args.hostName,
                reuse: args.reuse !== false,
            });
        case 'run_in_session':
            return api('POST', `/api/sessions/${encodeURIComponent(args.sessionId)}/input`, {
                command: args.command,
                waitMs: args.waitMs,
            });
        case 'batch_run':
            return api('POST', '/api/batch-execute', {
                hostNames: args.hostNames,
                command: args.command,
            });
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

async function main() {
    const server = new Server(
        { name: 'ssh-mag', version: '1.0.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments || {};
        try {
            const result = await runTool(name, args);
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        } catch (e) {
            return {
                isError: true,
                content: [{ type: 'text', text: e.message || String(e) }],
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
