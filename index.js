const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
const HOSTS_PATH = path.resolve(__dirname, 'hosts.json');
const SHORTCUTS_PATH = path.resolve(__dirname, 'shortcuts.json');
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const USERS_PATH = path.resolve(__dirname, 'users.json');

app.use(express.json());

// In-memory store for active user sessions
const userSessions = {};

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

// Middleware to authenticate token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401); // No token

    const session = userSessions[token];
    if (!session) return res.sendStatus(440); // Session expired or invalid

    session.lastSeen = Date.now(); // Update last seen
    req.user = session.username; // Attach user info to request
    next();
}

let hosts = {};
let users = [];
const activeSessions = {};

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

// --- API Endpoints ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/servers', authenticateToken, (req, res) => res.json(Object.keys(hosts).map(name => ({ name }))));
app.get('/api/hosts-config', authenticateToken, (req, res) => { fs.readFile(HOSTS_PATH, 'utf8', (err, data) => { if (err) { if (err.code === 'ENOENT') return res.json({ config: '{}\n' }); return res.status(500).json({ error: 'Could not read hosts file.' }); } res.json({ config: data }); }); });
app.post('/api/hosts-config', authenticateToken, (req, res) => { const { config } = req.body; try { JSON.parse(config); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); } fs.writeFile(HOSTS_PATH, config, 'utf8', (err) => { if (err) return res.status(500).json({error: 'Could not write to hosts file.'}); loadHostsConfig(); res.json({success: true}); }); });
app.get('/api/shortcuts', authenticateToken, (req, res) => { fs.readFile(SHORTCUTS_PATH, 'utf8', (err, data) => { if (err) { if (err.code === 'ENOENT') return res.json([]); return res.status(500).json({ error: 'Could not read shortcuts file.' }); } try { res.json(JSON.parse(data)); } catch (e) { res.status(500).json({ error: 'Error parsing shortcuts.json.' }); } }); });
app.get('/api/shortcuts-config', authenticateToken, (req, res) => { fs.readFile(SHORTCUTS_PATH, 'utf8', (err, data) => { if (err) { if (err.code === 'ENOENT') return res.json({ config: '[]' }); return res.status(500).json({ error: 'Could not read shortcuts file.' }); } res.json({ config: data }); }); });
app.post('/api/shortcuts-config', authenticateToken, (req, res) => { const { config } = req.body; try { JSON.parse(config); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); } fs.writeFile(SHORTCUTS_PATH, config, 'utf8', (err) => { if (err) return res.status(500).json({error: 'Could not write to shortcuts file.'}); res.json({success: true}); }); });

// --- Session Management & WebSocket Handling ---
setInterval(() => {
    const now = Date.now();
    for (const sessionId in activeSessions) {
        if (now - activeSessions[sessionId].lastSeen > SESSION_TIMEOUT) {
            activeSessions[sessionId].conn.end();
            delete activeSessions[sessionId];
        }
    }
}, 10 * 1000);

function setupWebSocketListeners(ws, stream, sshConfig, sessionId) {
    const messageHandlers = {
        'data': (msg) => stream.write(msg.data),
        'resize': (msg) => stream.setWindow(msg.rows, msg.cols),
        'shortcut': (msg) => {
            const match = msg.command.match(/\{([\w.-]+)\.([\w]+)\}/);
            if (match) {
                const requiredHostKey = match[1];
                const paramKey = match[2];

                if (!hosts[requiredHostKey]) {
                    const possibleHosts = Object.keys(hosts).filter(hostName =>
                        hosts[hostName].hasOwnProperty(paramKey)
                    );

                    if (possibleHosts.length > 0) {
                        ws.send(JSON.stringify({
                            type: 'request_host_selection',
                            command: msg.command,
                            hosts: possibleHosts,
                            requiredHostKey: requiredHostKey
                        }));
                        return;
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Shortcut error: No host found with the parameter '${paramKey}'.`
                        }));
                        return;
                    }
                }
            }

            let command = msg.command;
            command = command.replace(/\{host\}/g, sshConfig.host || '');
            command = command.replace(/\{username\}/g, sshConfig.username || '');
            command = command.replace(/\{port\}/g, sshConfig.port || '22');
            command = command.replace(/\{servername\}/g, sshConfig.servername || '');
            command = command.replace(/\{wg_interface\}/g, sshConfig.wg_interface || 'wg1');
            command = command.replace(/\{wg_subnet\}/g, sshConfig.wg_subnet || '10.21.12.1/24');
            command = command.replace(/\{([\w.-]+)\.([\w]+)\}/g, (match, hostKey, paramKey) => {
                const hostInfo = hosts[hostKey];
                if (!hostInfo) return match;
                return hostInfo[paramKey] || '';
            });
            stream.write(command + '\n');
        },
        'shortcut_execute': (msg) => {
            let command = msg.command;
            command = command.replace(/\{host\}/g, sshConfig.host || '');
            command = command.replace(/\{username\}/g, sshConfig.username || '');
            command = command.replace(/\{port\}/g, sshConfig.port || '22');
            command = command.replace(/\{servername\}/g, sshConfig.servername || '');
            command = command.replace(/\{wg_interface\}/g, sshConfig.wg_interface || 'wg1');
            command = command.replace(/\{wg_subnet\}/g, sshConfig.wg_subnet || '10.21.12.1/24');
            const selectedHost = msg.selectedHost;
            const originalHostKey = msg.originalHostKey;
            command = command.replace(new RegExp(`\\{${originalHostKey}\\.([\\w]+)\\}`, 'g'), (match, paramKey) => {
                const hostInfo = hosts[selectedHost];
                if (!hostInfo) return match;
                return hostInfo[paramKey] || '';
            });
            stream.write(command + '\n');
        }
    };

    function onMessage(raw) {
        if (activeSessions[sessionId]) {
            activeSessions[sessionId].lastSeen = Date.now();
        }
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'data') stream.write(msg.data);
            else if (msg.type === 'resize') stream.setWindow(msg.rows, msg.cols);
            else if (msg.type === 'shortcut') {
                const match = msg.command.match(/\{([\w.-]+)\.([\w]+)\}/);
                if (match) {
                    const requiredHostKey = match[1];
                    const paramKey = match[2];

                    if (!hosts[requiredHostKey]) {
                        const possibleHosts = Object.keys(hosts).filter(hostName => 
                            hosts[hostName].hasOwnProperty(paramKey)
                        );

                        if (possibleHosts.length > 0) {
                            ws.send(JSON.stringify({
                                type: 'request_host_selection',
                                command: msg.command,
                                hosts: possibleHosts,
                                requiredHostKey: requiredHostKey
                            }));
                            return;
                        } else {
                            ws.send(JSON.stringify({
                                type: 'error',
                                message: `Shortcut error: No host found with the parameter '${paramKey}'.`
                            }));
                            return;
                        }
                    }
                }

                let command = msg.command;
                command = command.replace(/\{host\}/g, sshConfig.host || '');
                command = command.replace(/\{username\}/g, sshConfig.username || '');
                command = command.replace(/\{port\}/g, sshConfig.port || '22');
                command = command.replace(/\{servername\}/g, sshConfig.servername || '');
                command = command.replace(/\{wg_interface\}/g, sshConfig.wg_interface || 'wg1');
                command = command.replace(/\{wg_subnet\}/g, sshConfig.wg_subnet || '10.21.12.1/24');
                command = command.replace(/\{([\w.-]+)\.([\w]+)\}/g, (match, hostKey, paramKey) => {
                    const hostInfo = hosts[hostKey];
                    if (!hostInfo) return match; 
                    return hostInfo[paramKey] || '';
                });
                stream.write(command + '\n');
            }
            else if (msg.type === 'shortcut_execute') {
                let command = msg.command;
                command = command.replace(/\{host\}/g, sshConfig.host || '');
                command = command.replace(/\{username\}/g, sshConfig.username || '');
                command = command.replace(/\{port\}/g, sshConfig.port || '22');
                command = command.replace(/\{servername\}/g, sshConfig.servername || '');
                command = command.replace(/\{wg_interface\}/g, sshConfig.wg_interface || 'wg1');
                command = command.replace(/\{wg_subnet\}/g, sshConfig.wg_subnet || '10.21.12.1/24');
                const selectedHost = msg.selectedHost;
                const originalHostKey = msg.originalHostKey;
                command = command.replace(new RegExp(`\\{${originalHostKey}\\.([\\w]+)\\}`, 'g'), (match, paramKey) => {
                    const hostInfo = hosts[selectedHost];
                    if (!hostInfo) return match;
                    return hostInfo[paramKey] || '';
                });
                stream.write(command + '\n');
            }
            if (messageHandlers[msg.type]) messageHandlersmsg.type;
        } catch (e) {}
    }
    function onData(data) {
        if (activeSessions[sessionId]) {
            activeSessions[sessionId].lastSeen = Date.now();
        }
        // Send the raw buffer directly. xterm.js on the client-side
        // is designed to handle binary data (ArrayBuffer/Blob) which it
        // receives when the server sends a Buffer. Sending a string can
        // cause subtle rendering issues with certain character sequences.
        ws.send(data);
    }
    stream.on('data', onData);
    ws.on('message', onMessage);
    ws.on('close', () => stream.removeListener('data', onData));
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

    userSession.lastSeen = Date.now(); // Update last seen

    if (query.sessionId) {
        const session = activeSessions[query.sessionId];
        if (session) {
            if (upgradeHandled) return;
            upgradeHandled = true;
            wss.handleUpgrade(request, socket, head, (ws) => {
                session.lastSeen = Date.now();
                setupWebSocketListeners(ws, session.stream, hosts[session.serverName], query.sessionId);
            });
        } else { rejectConnection('Invalid session ID. The server may have restarted.'); }
        return;
    }

    const serverName = query.server;
    if (!serverName || !hosts[serverName]) return rejectConnection(`Host \'${serverName}\' not found in hosts.json.`);
    
    const sshConfig = hosts[serverName];
    const conn = new Client();
    conn.on('ready', () => {
        // Explicitly enable echo in the pseudo-terminal (PTY) modes.
        // This ensures the remote shell echoes back typed characters,
        // which is the standard behavior terminals rely on.
        conn.shell({
            modes: { echo: true }
        }, (err, stream) => {
            if (err) { conn.end(); return rejectConnection(`Shell failed: ${err.message}`); }
            const sessionId = uuidv4();
            if (upgradeHandled) return; // Connection might have been rejected already
            upgradeHandled = true;
            activeSessions[sessionId] = { conn, stream, lastSeen: Date.now(), serverName };
            wss.handleUpgrade(request, socket, head, (ws) => {
                // This is the successful upgrade path
                ws.send(JSON.stringify({ type: 'session', sessionId }));
                ws.send(`\r\n*** SSH to ${serverName} Established ***\r\n`);
                setupWebSocketListeners(ws, stream, sshConfig, sessionId);
                stream.on('close', () => { delete activeSessions[sessionId]; ws.close(); });
            });
        });
    }).on('error', (err) => rejectConnection(`SSH connection error: ${err.message}`));
    try {
        const opts = {
            host: sshConfig.host,
            username: sshConfig.username,
            port: sshConfig.port || 22,
            keepaliveInterval: 10000 // Send a keepalive packet every 10 seconds
        };
        if (sshConfig.password) opts.password = sshConfig.password;
        else if (sshConfig.privateKeyPath) opts.privateKey = fs.readFileSync(path.resolve(__dirname, sshConfig.privateKeyPath), 'utf8');
        else throw new Error('Authentication method (password or privateKeyPath) not provided.');
        conn.connect(opts);
    } catch (error) { rejectConnection(`SSH setup error: ${error.message}`); }
});

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));