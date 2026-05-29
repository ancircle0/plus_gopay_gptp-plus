const axios = require('axios');
const { simpleParser } = require('mailparser');
const { buildAxiosTransportConfig } = require('./proxy-utils');

const DEFAULT_API_BASE = 'https://temp-email-api.jzqkwl.com';
const PROVIDER_CLOUDFLARE = 'cloudflare_temp_email';
const PROVIDER_FREEMAIL = 'freemail';

function trimBaseUrl(raw) {
    return String(raw || DEFAULT_API_BASE).trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
}

function normalizeProvider(provider) {
    const value = String(provider || process.env.INBOX_PROVIDER || PROVIDER_CLOUDFLARE).trim().toLowerCase();
    if (['freemail', 'idinging/freemail', 'idinging_freemail'].includes(value)) {
        return PROVIDER_FREEMAIL;
    }
    return PROVIDER_CLOUDFLARE;
}

function buildFreemailHeaders(token = '') {
    const value = String(token || process.env.INBOX_TOKEN || '').trim();
    if (!value) {
        return {};
    }
    return {
        Authorization: `Bearer ${value}`,
        'X-Admin-Token': value
    };
}

function normalizeLocalPart(raw = '') {
    const cleaned = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._+-]/g, '')
        .replace(/^[._+-]+|[._+-]+$/g, '');
    return cleaned || `gpt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeDomain(raw = '') {
    return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

function getFreemailMessageText(message = {}) {
    return [
        message.subject || '',
        message.verification_code || '',
        message.preview || '',
        message.content || '',
        message.text || '',
        message.text_content || '',
        stripHtml(message.html_content || message.html || '')
    ].join('\n');
}

async function getFreemailDomainIndex(baseUrl, domain, token, proxyUrl = '') {
    const target = normalizeDomain(domain);
    if (!target) {
        return 0;
    }

    const resp = await axios.get(`${trimBaseUrl(baseUrl)}/api/domains`, {
        headers: buildFreemailHeaders(token),
        ...buildAxiosTransportConfig(proxyUrl),
        timeout: 15000,
        validateStatus: () => true
    });

    if (resp.status !== 200 || !Array.isArray(resp.data)) {
        const err = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
        throw new Error(`freemail 获取域名列表失败: HTTP ${resp.status} body=${err}`);
    }

    const domains = resp.data.map((item) => normalizeDomain(item));
    const index = domains.indexOf(target);
    if (index < 0) {
        throw new Error(`Invalid domain: ${target}`);
    }

    return index;
}

async function createFreemailAddress({ baseUrl, name = '', domain = '', token = '', proxyUrl = '' } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...buildFreemailHeaders(token)
    };

    if (domain || name) {
        const domainIndex = await getFreemailDomainIndex(baseUrl, domain, token, proxyUrl);
        const resp = await axios.post(
            `${trimBaseUrl(baseUrl)}/api/create`,
            {
                local: normalizeLocalPart(name),
                domainIndex
            },
            { headers, ...buildAxiosTransportConfig(proxyUrl), timeout: 20000, validateStatus: () => true }
        );

        if (resp.status !== 200 || !resp.data?.email) {
            const err = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
            throw new Error(`freemail 创建临时邮箱失败: HTTP ${resp.status} body=${err}`);
        }

        return {
            jwt: String(token || ''),
            address: String(resp.data.email).toLowerCase(),
            password: null,
            provider: PROVIDER_FREEMAIL
        };
    }

    const resp = await axios.get(`${trimBaseUrl(baseUrl)}/api/generate`, {
        headers: buildFreemailHeaders(token),
        ...buildAxiosTransportConfig(proxyUrl),
        timeout: 20000,
        validateStatus: () => true
    });

    if (resp.status !== 200 || !resp.data?.email) {
        const err = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
        throw new Error(`freemail 生成临时邮箱失败: HTTP ${resp.status} body=${err}`);
    }

    return {
        jwt: String(token || ''),
        address: String(resp.data.email).toLowerCase(),
        password: null,
        provider: PROVIDER_FREEMAIL
    };
}

/**
 * 在 inbox.jzqkwl.com (cloudflare_temp_email) 上新建一个临时邮箱地址
 * 返回 { jwt, address, password }
 */
async function createAddress({ provider, baseUrl, name = '', domain = '', enablePrefix, token = '', proxyUrl = '' } = {}) {
    if (normalizeProvider(provider) === PROVIDER_FREEMAIL) {
        return createFreemailAddress({ baseUrl, name, domain, token, proxyUrl });
    }

    const url = `${trimBaseUrl(baseUrl)}/api/new_address`;
    const body = {};
    if (name) body.name = String(name);
    if (domain) body.domain = String(domain);
    if (typeof enablePrefix === 'boolean') body.enablePrefix = enablePrefix;

    const resp = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        ...buildAxiosTransportConfig(proxyUrl),
        timeout: 20000,
        validateStatus: () => true
    });

    if (resp.status !== 200 || !resp.data || !resp.data.address || !resp.data.jwt) {
        const err = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {});
        throw new Error(`创建临时邮箱失败: HTTP ${resp.status} body=${err}`);
    }

    return {
        jwt: String(resp.data.jwt),
        address: String(resp.data.address).toLowerCase(),
        password: resp.data.password || null,
        provider: PROVIDER_CLOUDFLARE
    };
}

function looksLikeOpenAiVerification(subject, bodyText, fromAddr) {
    const haystack = `${subject || ''}\n${bodyText || ''}\n${fromAddr || ''}`.toLowerCase();
    return /openai|chatgpt|verification|verify|验证码/.test(haystack);
}

function extractSixDigitCodes(text) {
    const out = [];
    const re = /\b(\d{6})\b/g;
    let m = re.exec(text);
    while (m) { out.push(m[1]); m = re.exec(text); }
    return out;
}

function stripHtml(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 在临时邮箱里轮询 OpenAI 验证码
 * @param {Object} opts
 * @param {string} opts.baseUrl - API base
 * @param {string} opts.jwt - 用户 JWT
 * @param {string} [opts.address] - 邮箱地址（仅用于日志）
 * @param {number} [opts.maxRetries=24]
 * @param {string} [opts.excludeCode] - 上一次拿到的旧验证码，用于排除
 * @param {Function} [opts.onNoNewCodeFor30Seconds]
 * @param {Function} [opts.onBeforePoll]
 */
async function fetchLatestOpenAiOtp({
    provider,
    baseUrl,
    jwt,
    token = '',
    address = '',
    maxRetries = 24,
    excludeCode = '',
    onNoNewCodeFor30Seconds = null,
    onBeforePoll = null,
    proxyUrl = ''
} = {}) {
    const selectedProvider = normalizeProvider(provider);
    const authToken = token || jwt;

    if (selectedProvider !== PROVIDER_FREEMAIL && !jwt) {
        throw new Error('缺少邮箱 JWT，无法拉取邮件');
    }

    if (selectedProvider === PROVIDER_FREEMAIL) {
        return fetchLatestOpenAiOtpFreemail({
            baseUrl,
            token: authToken,
            address,
            maxRetries,
            excludeCode,
            onNoNewCodeFor30Seconds,
            onBeforePoll,
            proxyUrl
        });
    }

    const url = `${trimBaseUrl(baseUrl)}/api/mails?limit=10&offset=0`;
    const headers = { Authorization: `Bearer ${jwt}` };
    let lastResendAt = 0;

    console.log(`📨 [Inbox] 正在为 ${address || '(未知地址)'} 通过 ${baseUrl || DEFAULT_API_BASE} 获取验证码...`);

    for (let i = 0; i < maxRetries; i += 1) {
        // 每 5 轮打印一次进度，避免刷屏
        if (i === 0 || (i + 1) % 5 === 0 || i + 1 === maxRetries) {
            console.log(`📨 [Inbox] 轮询中 ${i + 1}/${maxRetries}...`);
        }
        if (onBeforePoll) {
            const recovered = await onBeforePoll(i + 1);
            if (recovered) {
                console.log('📨 [Inbox] 页面已恢复，继续等待新验证码...');
            }
        }

        try {
            const resp = await axios.get(url, {
                headers,
                ...buildAxiosTransportConfig(proxyUrl),
                timeout: 15000,
                validateStatus: () => true
            });
            if (resp.status !== 200) {
                console.warn(`⚠️  [Inbox] 拉取邮件 HTTP ${resp.status}: ${typeof resp.data === 'string' ? resp.data : ''}`);
            } else {
                const messages = Array.isArray(resp.data?.results) ? resp.data.results : [];
                if (messages.length === 0) {
                    // (静默) 邮件列表为空
                } else {
                    // 按 id 倒序：cloudflare_temp_email 的 id 是自增主键，越大越新
                    messages.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
                    for (const msg of messages) {
                        const fromAddr = String(msg.source || msg.from || '');
                        const raw = String(msg.raw || '');
                        if (!raw) continue;

                        let parsed;
                        try {
                            parsed = await simpleParser(raw);
                        } catch (_) {
                            continue;
                        }

                        const subject = parsed.subject || msg.subject || '';
                        const bodyText = [parsed.text || '', stripHtml(parsed.html || '')].join('\n');

                        if (!looksLikeOpenAiVerification(subject, bodyText, fromAddr)) {
                            continue;
                        }

                        const codes = extractSixDigitCodes(`${subject}\n${bodyText}`);
                        for (const code of codes) {
                            if (code && code !== excludeCode) {
                                console.log(`📨 [IMAP] 成功获取验证码: ${code}`);
                                return code;
                            }
                        }
                    }
                    // (静默) 暂未读取到符合条件的新验证码
                }
            }
        } catch (err) {
            console.error(`⚠️  [Inbox] 本次轮询失败: ${err.message}`);
        }

        if (excludeCode && onNoNewCodeFor30Seconds && (i + 1) % 6 === 0) {
            const now = Date.now();
            if (now - lastResendAt >= 28000) {
                lastResendAt = now;
                await onNoNewCodeFor30Seconds();
            }
        }

        for (let waitTick = 0; waitTick < 10; waitTick += 1) {
            if (onBeforePoll) {
                const recovered = await onBeforePoll(i + 1);
                if (recovered) {
                    console.log('📨 [Inbox] 页面恢复完成，继续等待...');
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    throw new Error('获取验证码超时');
}

async function fetchLatestOpenAiOtpFreemail({
    baseUrl,
    token = '',
    address = '',
    maxRetries = 24,
    excludeCode = '',
    onNoNewCodeFor30Seconds = null,
    onBeforePoll = null,
    proxyUrl = ''
} = {}) {
    if (!address) {
        throw new Error('缺少 freemail 邮箱地址，无法拉取邮件');
    }

    const headers = buildFreemailHeaders(token);
    let lastResendAt = 0;

    console.log(`📨 [Inbox/freemail] 正在为 ${address} 通过 ${baseUrl} 获取验证码...`);

    for (let i = 0; i < maxRetries; i += 1) {
        if (i === 0 || (i + 1) % 5 === 0 || i + 1 === maxRetries) {
            console.log(`📨 [Inbox/freemail] 轮询中 ${i + 1}/${maxRetries}...`);
        }
        if (onBeforePoll) {
            const recovered = await onBeforePoll(i + 1);
            if (recovered) {
                console.log('📨 [Inbox/freemail] 页面已恢复，继续等待新验证码...');
            }
        }

        try {
            const listResp = await axios.get(`${trimBaseUrl(baseUrl)}/api/emails`, {
                headers,
                params: { mailbox: address, limit: 10 },
                ...buildAxiosTransportConfig(proxyUrl),
                timeout: 15000,
                validateStatus: () => true
            });

            if (listResp.status !== 200) {
                console.warn(`⚠️  [Inbox/freemail] 拉取邮件 HTTP ${listResp.status}: ${typeof listResp.data === 'string' ? listResp.data : ''}`);
            } else {
                const messages = Array.isArray(listResp.data) ? listResp.data : [];
                messages.sort((a, b) => {
                    const bTime = new Date(b.received_at || b.created_at || 0).getTime() || Number(b.id || 0);
                    const aTime = new Date(a.received_at || a.created_at || 0).getTime() || Number(a.id || 0);
                    return bTime - aTime;
                });

                for (const msg of messages) {
                    let detail = msg;
                    if (msg.id) {
                        const detailResp = await axios.get(`${trimBaseUrl(baseUrl)}/api/email/${encodeURIComponent(msg.id)}`, {
                            headers,
                            ...buildAxiosTransportConfig(proxyUrl),
                            timeout: 15000,
                            validateStatus: () => true
                        });
                        if (detailResp.status === 200 && detailResp.data) {
                            detail = { ...msg, ...detailResp.data };
                        }
                    }

                    const fromAddr = String(detail.sender || detail.from || '');
                    const subject = String(detail.subject || '');
                    const bodyText = getFreemailMessageText(detail);
                    if (!looksLikeOpenAiVerification(subject, bodyText, fromAddr)) {
                        continue;
                    }

                    const codes = extractSixDigitCodes(`${subject}\n${bodyText}`);
                    for (const code of codes) {
                        if (code && code !== excludeCode) {
                            console.log(`📨 [Inbox/freemail] 成功获取验证码: ${code}`);
                            return code;
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`⚠️  [Inbox/freemail] 本次轮询失败: ${err.message}`);
        }

        if (excludeCode && onNoNewCodeFor30Seconds && (i + 1) % 6 === 0) {
            const now = Date.now();
            if (now - lastResendAt >= 28000) {
                lastResendAt = now;
                await onNoNewCodeFor30Seconds();
            }
        }

        for (let waitTick = 0; waitTick < 10; waitTick += 1) {
            if (onBeforePoll) {
                const recovered = await onBeforePoll(i + 1);
                if (recovered) {
                    console.log('📨 [Inbox/freemail] 页面恢复完成，继续等待...');
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    throw new Error('获取验证码超时');
}

module.exports = {
    DEFAULT_API_BASE,
    PROVIDER_CLOUDFLARE,
    PROVIDER_FREEMAIL,
    normalizeProvider,
    createAddress,
    fetchLatestOpenAiOtp
};
