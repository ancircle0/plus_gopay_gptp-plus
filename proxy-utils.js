const http = require('http');
const net = require('net');
const tls = require('tls');
const { Buffer } = require('buffer');
const { ProxyAgent } = require('proxy-agent');
const { SocksClient } = require('socks');

function parseProxyUrl(proxyValue) {
    const value = String(proxyValue || '').trim();
    if (!value) {
        return null;
    }

    try {
        const parsed = new URL(value);
        return {
            raw: value,
            protocol: parsed.protocol.replace(':', '').toLowerCase(),
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : defaultPortForProtocol(parsed.protocol),
            username: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || '')
        };
    } catch (error) {
        return null;
    }
}

function defaultPortForProtocol(protocol) {
    const value = String(protocol || '').replace(':', '').toLowerCase();
    if (value === 'https') return 443;
    if (value.startsWith('socks')) return 1080;
    return 80;
}

function buildPlaywrightProxy(proxyValue) {
    const parsed = parseProxyUrl(proxyValue);
    if (!parsed) {
        return null;
    }

    const proxy = {
        server: `${parsed.protocol}://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
        bypass: 'localhost,127.0.0.1,::1'
    };
    if (parsed.username) {
        proxy.username = parsed.username;
    }
    if (parsed.password) {
        proxy.password = parsed.password;
    }
    return proxy;
}

function buildAxiosTransportConfig(proxyValue) {
    const value = String(proxyValue || '').trim();
    if (!value) {
        return {};
    }

    const agent = new ProxyAgent({ getProxyForUrl: () => value });
    return {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false
    };
}

async function getSystemProxy(store) {
    if (!store || typeof store.getAppConfigValue !== 'function') {
        return '';
    }
    return String(await store.getAppConfigValue('system_proxy', '') || '').trim();
}

async function prepareProxy({ systemProxy = '', taskProxy = '', label = 'proxy' } = {}) {
    const first = String(systemProxy || '').trim();
    const second = String(taskProxy || '').trim();

    if (first && second) {
        const chained = await createChainedProxy({
            firstProxyUrl: first,
            secondProxyUrl: second,
            label
        });
        return {
            proxyUrl: chained.url,
            playwrightProxy: buildPlaywrightProxy(chained.url),
            close: chained.close,
            chained: true,
            systemProxy: first,
            taskProxy: second
        };
    }

    const proxyUrl = second || first;
    return {
        proxyUrl,
        playwrightProxy: buildPlaywrightProxy(proxyUrl),
        close: async () => { },
        chained: false,
        systemProxy: first,
        taskProxy: second
    };
}

async function createChainedProxy({ firstProxyUrl, secondProxyUrl, label = 'proxy' } = {}) {
    const firstProxy = parseProxyUrl(firstProxyUrl);
    const secondProxy = parseProxyUrl(secondProxyUrl);
    if (!firstProxy || !secondProxy) {
        throw new Error(`${label} 代理链配置无效`);
    }

    const server = http.createServer();

    server.on('request', async (req, res) => {
        try {
            const targetUrl = new URL(req.url);
            const targetHost = targetUrl.hostname;
            const targetPort = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
            const upstream = await connectViaProxyChain({ firstProxy, secondProxy, targetHost, targetPort });
            const path = `${targetUrl.pathname || '/'}${targetUrl.search || ''}`;
            upstream.write(`${req.method} ${path} HTTP/${req.httpVersion}\r\n`);
            writeForwardHeaders(upstream, req.headers, targetUrl.host);
            req.pipe(upstream);
            upstream.pipe(res);
            upstream.on('error', () => res.destroy());
        } catch (error) {
            res.statusCode = 502;
            res.end(`Proxy chain failed: ${error.message}`);
        }
    });

    server.on('connect', async (req, clientSocket, head) => {
        try {
            const [targetHost, rawPort] = String(req.url || '').split(':');
            const targetPort = Number(rawPort || 443);
            const upstream = await connectViaProxyChain({ firstProxy, secondProxy, targetHost, targetPort });
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) {
                upstream.write(head);
            }
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
            upstream.on('error', () => clientSocket.destroy());
            clientSocket.on('error', () => upstream.destroy());
        } catch (error) {
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${error.message.length}\r\n\r\n${error.message}`);
            clientSocket.destroy();
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve()))
    };
}

async function connectViaProxyChain({ firstProxy, secondProxy, targetHost, targetPort }) {
    const secondSocket = await connectToProxyThroughFirst(firstProxy, secondProxy);
    await connectFromSecondProxy(secondSocket, secondProxy, targetHost, targetPort);
    return secondSocket;
}

async function connectToProxyThroughFirst(firstProxy, secondProxy) {
    if (isSocksProtocol(firstProxy.protocol)) {
        const info = await SocksClient.createConnection({
            command: 'connect',
            proxy: {
                host: firstProxy.hostname,
                port: firstProxy.port,
                type: firstProxy.protocol.includes('4') ? 4 : 5,
                userId: firstProxy.username || undefined,
                password: firstProxy.password || undefined
            },
            destination: {
                host: secondProxy.hostname,
                port: secondProxy.port
            },
            timeout: 30000
        });
        return info.socket;
    }

    const socket = await openSocketToHttpProxy(firstProxy);
    await httpConnect(socket, {
        host: secondProxy.hostname,
        port: secondProxy.port,
        proxy: firstProxy
    });
    return socket;
}

function openSocketToHttpProxy(proxy) {
    return new Promise((resolve, reject) => {
        const connectOptions = {
            host: proxy.hostname,
            port: proxy.port,
            servername: proxy.hostname
        };
        const socket = proxy.protocol === 'https'
            ? tls.connect(connectOptions, () => resolve(socket))
            : net.connect(connectOptions, () => resolve(socket));
        socket.setTimeout(30000, () => {
            socket.destroy(new Error('connect timeout'));
        });
        socket.once('error', reject);
    });
}

async function connectFromSecondProxy(socket, secondProxy, targetHost, targetPort) {
    if (isSocksProtocol(secondProxy.protocol)) {
        await socksConnectOverSocket(socket, secondProxy, targetHost, targetPort);
        return;
    }

    await httpConnect(socket, {
        host: targetHost,
        port: targetPort,
        proxy: secondProxy
    });
}

function httpConnect(socket, { host, port, proxy }) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) {
                return;
            }
            cleanup();
            const header = buffer.slice(0, headerEnd).toString('latin1');
            const statusLine = header.split('\r\n')[0] || '';
            if (!/^HTTP\/\d(?:\.\d)? 2\d\d\b/.test(statusLine)) {
                reject(new Error(`代理 CONNECT 失败: ${statusLine}`));
                return;
            }
            const rest = buffer.slice(headerEnd + 4);
            if (rest.length) {
                socket.unshift(rest);
            }
            resolve();
        };

        socket.on('data', onData);
        socket.once('error', onError);
        socket.write(buildConnectRequest({ host, port, proxy }));
    });
}

function buildConnectRequest({ host, port, proxy }) {
    const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Proxy-Connection: Keep-Alive'
    ];
    const auth = buildProxyAuthorization(proxy);
    if (auth) {
        lines.push(`Proxy-Authorization: ${auth}`);
    }
    return `${lines.join('\r\n')}\r\n\r\n`;
}

function writeForwardHeaders(socket, headers, hostHeader) {
    const skip = new Set(['proxy-connection', 'connection', 'host']);
    socket.write(`Host: ${hostHeader}\r\n`);
    for (const [name, value] of Object.entries(headers || {})) {
        if (skip.has(String(name).toLowerCase())) {
            continue;
        }
        socket.write(`${name}: ${value}\r\n`);
    }
    socket.write('Connection: close\r\n\r\n');
}

function buildProxyAuthorization(proxy) {
    if (!proxy?.username && !proxy?.password) {
        return '';
    }
    return `Basic ${Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64')}`;
}

async function socksConnectOverSocket(socket, proxy, host, port) {
    if (proxy.protocol.includes('4')) {
        throw new Error('代理链第二跳暂不支持 socks4');
    }
    const authMethods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]));
    const methodResp = await readExactly(socket, 2);
    if (methodResp[0] !== 0x05 || methodResp[1] === 0xff) {
        throw new Error('SOCKS5 认证方式协商失败');
    }

    if (methodResp[1] === 0x02) {
        const user = Buffer.from(proxy.username || '');
        const pass = Buffer.from(proxy.password || '');
        socket.write(Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass
        ]));
        const authResp = await readExactly(socket, 2);
        if (authResp[1] !== 0x00) {
            throw new Error('SOCKS5 用户名密码认证失败');
        }
    }

    const hostBuf = Buffer.from(host);
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(Number(port), 0);
    socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        portBuf
    ]));

    const head = await readExactly(socket, 4);
    if (head[0] !== 0x05 || head[1] !== 0x00) {
        throw new Error(`SOCKS5 CONNECT 失败: ${head[1]}`);
    }

    const atyp = head[3];
    if (atyp === 0x01) {
        await readExactly(socket, 4 + 2);
    } else if (atyp === 0x03) {
        const len = await readExactly(socket, 1);
        await readExactly(socket, len[0] + 2);
    } else if (atyp === 0x04) {
        await readExactly(socket, 16 + 2);
    }
}

function readExactly(socket, length) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const cleanup = () => {
            socket.off('data', onData);
            socket.off('error', onError);
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < length) {
                return;
            }
            cleanup();
            const out = buffer.slice(0, length);
            const rest = buffer.slice(length);
            if (rest.length) {
                socket.unshift(rest);
            }
            resolve(out);
        };
        socket.on('data', onData);
        socket.once('error', onError);
    });
}

function isSocksProtocol(protocol) {
    return String(protocol || '').toLowerCase().startsWith('socks');
}

module.exports = {
    parseProxyUrl,
    buildPlaywrightProxy,
    buildAxiosTransportConfig,
    getSystemProxy,
    prepareProxy,
    createChainedProxy
};
