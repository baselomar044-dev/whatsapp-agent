const fs = require('fs');
const http = require('http');
const path = require('path');

const { appConfig, toPublicDashboardConfig } = require('./config');
const {
    getAutomationSettings,
    getContactStats,
    getContacts,
    getDailyLogStats,
    getMessageTemplate,
    getRecentLogs,
    upsertAppSetting,
    upsertContacts,
    deleteContact,
    deleteContacts,
    updateContact,
    MAX_CONTACTS
} = require('./database');
const { normalizePhoneNumber, toWhatsAppId } = require('./phone');
const { getAttachmentStats, getChatHistory, clearChatHistory, listRecentAttachments, saveUploadedAttachment } = require('./manager-storage');
const { buildMessagePreview } = require('./message-template');
const { getFreelanceDashboardData, setFreelanceJobAction, triggerFreelanceManualSearch, upsertFreelanceSettings } = require('./freelance-bridge');
const { runFreelanceConversation } = require('./freelance-assistant');
const { runLocalManagerCommand } = require('./manager-agent');
const { isBlastRunning, reconfigureScheduler, runDailyBlast } = require('./scheduler');
const { getRuntimeSnapshot, pushEvent, recordRuntimeError } = require('./runtime-state');

let dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const dashboardClientJs = fs.readFileSync(path.join(__dirname, 'dashboard-client.js'), 'utf8');
const xlsxLibJs = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'), 'utf8');

function getDashboardConfig() {
    return toPublicDashboardConfig(appConfig);
}

function isLocalRequest(request) {
    const remoteAddress = String(request.socket.remoteAddress || '').toLowerCase();
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
}

function buildHealthSummary(runtime, dataErrors) {
    const issues = [];

    if (runtime.appStatus === 'error') {
        issues.push('The application reported an error state.');
    }

    if (runtime.whatsapp.status === 'auth_failure') {
        issues.push('WhatsApp authentication failed and needs attention.');
    } else if (runtime.whatsapp.status === 'disconnected') {
        issues.push('WhatsApp is disconnected.');
    } else if (runtime.whatsapp.status === 'qr_required') {
        issues.push('WhatsApp needs a fresh QR scan.');
    } else if (!['ready', 'authenticated'].includes(runtime.whatsapp.status)) {
        issues.push('WhatsApp is still starting up.');
    }

    if (!runtime.scheduler.cronSchedule) {
        issues.push('Automatic schedule is currently disabled.');
    }

    if (runtime.manager.enabled && !runtime.manager.aiConfigured) {
        issues.push('Manager AI chat is disabled until GROQ_API_KEY is configured.');
    }

    if (dataErrors.length) {
        issues.push(`${dataErrors.length} dashboard data source(s) failed to load.`);
    }

    return {
        status: issues.length === 0 ? 'healthy' : runtime.appStatus === 'error' || runtime.whatsapp.status === 'auth_failure' ? 'error' : 'warning',
        issues
    };
}

function deriveSentNumbers(logs) {
    const seen = new Set();

    return logs.filter((log) => {
        const phone = String(log.phone || '').trim();

        if (!phone || String(log.status || '').toLowerCase() !== 'sent' || seen.has(phone)) {
            return false;
        }

        seen.add(phone);
        return true;
    });
}

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(payload));
}

function sendHtml(response, statusCode, html) {
    response.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    response.end(html);
}

function sendText(response, statusCode, body, contentType) {
    response.writeHead(statusCode, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function sendMethodNotAllowed(response) {
    sendJson(response, 405, { error: 'Method not allowed' });
}

function checkAuth(request, response) {
    if (!appConfig.dashboardPassword) {
        return true;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        response.writeHead(401, {
            'Content-Type': 'application/json; charset=utf-8',
            'WWW-Authenticate': 'Basic realm="WhatsApp Agent Dashboard"',
            'Cache-Control': 'no-store'
        });
        response.end(JSON.stringify({ error: 'Unauthorized' }));
        return false;
    }

    try {
        const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
        const [, password] = credentials.split(':');

        if (password === appConfig.dashboardPassword) {
            return true;
        }
    } catch (error) {
        // Fall through to 401.
    }

    response.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="WhatsApp Agent Dashboard"',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
}

async function readJsonBody(request) {
    const chunks = [];

    for await (const chunk of request) {
        chunks.push(chunk);
    }

    if (!chunks.length) {
        return {};
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    return rawBody ? JSON.parse(rawBody) : {};
}

function normalizeBase64AttachmentData(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        return '';
    }

    const markerIndex = raw.indexOf('base64,');
    return markerIndex >= 0 ? raw.slice(markerIndex + 7) : raw;
}

function createUploadedAttachment(chatId, attachment) {
    if (!attachment || !attachment.data) {
        return null;
    }

    return saveUploadedAttachment({
        chatId,
        filename: String(attachment.filename || 'attachment').trim() || 'attachment',
        mimetype: String(attachment.mimetype || 'application/octet-stream').trim() || 'application/octet-stream',
        dataBase64: normalizeBase64AttachmentData(attachment.data),
        caption: String(attachment.caption || '').trim(),
        category: String(attachment.category || 'dashboard-upload').trim() || 'dashboard-upload'
    });
}

async function buildStatusPayload() {
    const [
        contactStatsResult,
        contactsResult,
        dailyLogStatsResult,
        recentLogsResult,
        messageTemplateResult,
        automationResult,
        attachmentStatsResult,
        recentAttachmentsResult,
        freelanceResult
    ] = await Promise.allSettled([
        getContactStats(),
        getContacts(250),
        getDailyLogStats(),
        getRecentLogs(80),
        getMessageTemplate(),
        getAutomationSettings(),
        Promise.resolve(getAttachmentStats()),
        Promise.resolve(listRecentAttachments(appConfig.manager.recentAttachmentLimit)),
        getFreelanceDashboardData()
    ]);

    const dataErrors = [];

    if (contactStatsResult.status === 'rejected') {
        dataErrors.push(`Contact stats unavailable: ${contactStatsResult.reason.message}`);
    }

    if (contactsResult.status === 'rejected') {
        dataErrors.push(`Contacts list unavailable: ${contactsResult.reason.message}`);
    }

    if (dailyLogStatsResult.status === 'rejected') {
        dataErrors.push(`Daily log stats unavailable: ${dailyLogStatsResult.reason.message}`);
    }

    if (recentLogsResult.status === 'rejected') {
        dataErrors.push(`Recent logs unavailable: ${recentLogsResult.reason.message}`);
    }

    if (messageTemplateResult.status === 'rejected') {
        dataErrors.push(`Message template unavailable: ${messageTemplateResult.reason.message}`);
    }

    if (automationResult.status === 'rejected') {
        dataErrors.push(`Automation settings unavailable: ${automationResult.reason.message}`);
    }

    if (attachmentStatsResult.status === 'rejected') {
        dataErrors.push(`Attachment stats unavailable: ${attachmentStatsResult.reason.message}`);
    }

    if (freelanceResult.status === 'rejected') {
        dataErrors.push(`Freelance data unavailable: ${freelanceResult.reason.message}`);
    }

    const runtime = getRuntimeSnapshot();
    const messageTemplate = messageTemplateResult.status === 'fulfilled' ? messageTemplateResult.value : null;
    const recentLogs = recentLogsResult.status === 'fulfilled' ? recentLogsResult.value : [];

    return {
        generatedAt: new Date().toISOString(),
        dashboard: getDashboardConfig(),
        runtime,
        health: buildHealthSummary(runtime, dataErrors),
        stats: {
            contacts: contactStatsResult.status === 'fulfilled'
                ? contactStatsResult.value
                : { total: 0, active: 0, inactive: 0 },
            logsToday: dailyLogStatsResult.status === 'fulfilled'
                ? dailyLogStatsResult.value
                : { total: 0, sent: 0, failed: 0, other: 0 }
        },
        contactsList: contactsResult.status === 'fulfilled' ? contactsResult.value : [],
        recentLogs,
        sentNumbers: deriveSentNumbers(recentLogs),
        attachments: {
            stats: attachmentStatsResult.status === 'fulfilled'
                ? attachmentStatsResult.value
                : { total: 0, latest: null },
            recent: recentAttachmentsResult.status === 'fulfilled'
                ? recentAttachmentsResult.value
                : []
        },
        messagePreview: buildMessagePreview(messageTemplate, appConfig.previewContact),
        automation: automationResult.status === 'fulfilled'
            ? automationResult.value
            : {
                messageTemplate: messageTemplate || '',
                sendTime: appConfig.sendTime,
                minMessages: appConfig.minMessages,
                maxMessages: appConfig.maxMessages,
                scheduleEnabled: Boolean(runtime.scheduler.cronSchedule)
            },
        conversations: {
            whatsapp: getChatHistory('dashboard-whatsapp', 40),
            freelance: getChatHistory('dashboard-freelance', 40)
        },
        freelance: freelanceResult.status === 'fulfilled'
            ? freelanceResult.value
            : {
                available: false,
                stats: { totalJobs: 0, unsentJobs: 0, sentJobs: 0 },
                recentJobs: [],
                keywords: '',
                location: '',
                frontendUrl: '',
                manualTriggerActive: false,
                note: ''
            },
        capabilities: {
            canTriggerBlast: true,
            canTriggerFreelanceScout: true,
            localOnlyMutations: true,
            isLocalRequestRequired: true
        },
        dataErrors
    };
}

function startDashboardServer(deps = {}) {
    const { client, requestPairing, sendManagedMessage, sendManagedMedia } = deps;

    const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${appConfig.dashboardHost}:${appConfig.dashboardPort}`}`);
        const pathname = requestUrl.pathname;

        try {
            // Health check endpoint (no auth required, for Docker)
            if (pathname === '/health') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }
                sendJson(response, 200, { status: 'ok' });
                return;
            }

            if (!checkAuth(request, response)) {
                return;
            }

            if (pathname === '/' || pathname === '/index.html') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const authToken = appConfig.dashboardPassword
                    ? Buffer.from(`admin:${appConfig.dashboardPassword}`).toString('base64')
                    : '';
                const authScript = `<script>window.__authHeader = ${JSON.stringify(authToken ? `Basic ${authToken}` : '')};</script>`;
                const injectedHtml = dashboardHtml.replace('</head>', `${authScript}\n</head>`);
                sendHtml(response, 200, injectedHtml);
                return;
            }

            if (pathname === '/dashboard.css') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                sendText(response, 200, dashboardCss, 'text/css; charset=utf-8');
                return;
            }

            if (pathname === '/dashboard.js') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                sendText(response, 200, dashboardClientJs, 'application/javascript; charset=utf-8');
                return;
            }

            if (pathname === '/xlsx.js') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                sendText(response, 200, xlsxLibJs, 'application/javascript; charset=utf-8');
                return;
            }

            if (pathname === '/api/status') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                sendJson(response, 200, await buildStatusPayload());
                return;
            }

            if (pathname === '/api/health') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const payload = await buildStatusPayload();
                sendJson(response, 200, payload.health);
                return;
            }

            if (pathname === '/api/whatsapp/pair') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const phoneNumber = (body.phoneNumber || '').replace(/[^0-9]/g, '');
                if (!phoneNumber || phoneNumber.length < 7) {
                    sendJson(response, 400, { error: 'A valid phone number is required (digits only, with country code).' });
                    return;
                }

                if (!requestPairing) {
                    sendJson(response, 500, { error: 'Pairing not available.' });
                    return;
                }

                const result = await requestPairing(phoneNumber);
                sendJson(response, result.success ? 200 : 500, result);
                return;
            }

            if (pathname === '/api/blast/run') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                if (isBlastRunning()) {
                    sendJson(response, 409, { error: 'A blast is already running.' });
                    return;
                }

                pushEvent('dashboard', 'Manual blast requested from dashboard.');
                runDailyBlast('dashboard').catch((error) => {
                    if (error.code === 'BLAST_ALREADY_RUNNING') {
                        return;
                    }

                    recordRuntimeError('blast', error);
                });

                sendJson(response, 202, { accepted: true, message: 'Manual blast started.' });
                return;
            }

            if (pathname === '/api/contacts/import') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const imported = await upsertContacts(body.contacts || []);
                sendJson(response, 200, { imported, message: `Imported ${imported} contacts.` });
                return;
            }

            if (pathname === '/api/contacts/delete') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                if (Array.isArray(body.phones)) {
                    const count = await deleteContacts(body.phones);
                    sendJson(response, 200, { deleted: count });
                } else if (body.phone) {
                    await deleteContact(body.phone);
                    sendJson(response, 200, { deleted: 1 });
                } else {
                    sendJson(response, 400, { error: 'phone or phones required' });
                }
                return;
            }

            if (pathname === '/api/contacts/update') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                if (!body.phone) {
                    sendJson(response, 400, { error: 'phone required' });
                    return;
                }

                await updateContact(body.phone, body.updates || {});
                sendJson(response, 200, { saved: true });
                return;
            }

            if (pathname === '/api/contacts/export') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const fmt = requestUrl.searchParams.get('format') || 'json';
                const contacts = await getContacts(MAX_CONTACTS);

                if (fmt === 'csv') {
                    const header = 'name,phone,is_active,last_sent_at';
                    const rows = contacts.map((c) =>
                        [
                            `"${String(c.name || '').replace(/"/g, '""')}"`,
                            `"${String(c.phone || '').replace(/"/g, '""')}"`,
                            c.is_active === false ? 'false' : 'true',
                            c.last_sent_at || ''
                        ].join(',')
                    );
                    const csv = [header, ...rows].join('\r\n');
                    response.writeHead(200, {
                        'Content-Type': 'text/csv; charset=utf-8',
                        'Content-Disposition': 'attachment; filename="contacts.csv"',
                        'Cache-Control': 'no-store'
                    });
                    response.end(csv);
                } else {
                    response.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Disposition': 'attachment; filename="contacts.json"',
                        'Cache-Control': 'no-store'
                    });
                    response.end(JSON.stringify(contacts, null, 2));
                }
                return;
            }

            if (pathname === '/api/send/direct') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                if (!sendManagedMessage) {
                    sendJson(response, 503, { error: 'WhatsApp client not available.' });
                    return;
                }

                const body = await readJsonBody(request);
                const rawPhone = String(body.phone || '').trim();
                const message = String(body.message || '').trim();

                if (!rawPhone || !message) {
                    sendJson(response, 400, { error: 'phone and message required' });
                    return;
                }

                const phone = normalizePhoneNumber(rawPhone);
                if (!phone) {
                    sendJson(response, 400, { error: 'Invalid phone number' });
                    return;
                }

                const whatsappId = toWhatsAppId(phone);
                const attachmentRecord = createUploadedAttachment(`direct-${phone}`, body.attachment);
                await sendManagedMessage(whatsappId, message, { attachmentRecord });
                sendJson(response, 200, { sent: true, phone });
                return;
            }

            if (pathname === '/api/settings/automation') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                await Promise.all([
                    upsertAppSetting('blaster_message', String(body.messageTemplate || '').trim()),
                    upsertAppSetting('automation_send_time', String(body.sendTime || appConfig.sendTime).trim()),
                    upsertAppSetting('automation_min_messages', String(body.minMessages || appConfig.minMessages)),
                    upsertAppSetting('automation_max_messages', String(body.maxMessages || appConfig.maxMessages)),
                    upsertAppSetting('automation_schedule_enabled', body.scheduleEnabled === false ? 'false' : 'true')
                ]);

                await reconfigureScheduler();
                sendJson(response, 200, { saved: true, message: 'Automation settings updated.' });
                return;
            }

            if (pathname === '/api/manager/clear') {
                if (request.method !== 'POST') { sendMethodNotAllowed(response); return; }
                clearChatHistory('dashboard-whatsapp');
                sendJson(response, 200, { cleared: true });
                return;
            }

            if (pathname === '/api/freelance/clear') {
                if (request.method !== 'POST') { sendMethodNotAllowed(response); return; }
                clearChatHistory('dashboard-freelance');
                sendJson(response, 200, { cleared: true });
                return;
            }

            if (pathname === '/api/manager/chat') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const attachmentRecord = createUploadedAttachment('dashboard-whatsapp', body.attachment);
                const result = await runLocalManagerCommand({
                    chatId: 'dashboard-whatsapp',
                    text: String(body.message || '').trim(),
                    attachmentRecord,
                    client,
                    sendManagedMessage,
                    sendManagedMedia
                });

                sendJson(response, 200, {
                    reply: result.reply,
                    history: getChatHistory('dashboard-whatsapp', 40)
                });
                return;
            }

            if (pathname === '/api/freelance/chat') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const attachmentRecord = createUploadedAttachment('dashboard-freelance', body.attachment);
                const result = await runFreelanceConversation('dashboard-freelance', String(body.message || '').trim(), attachmentRecord);
                sendJson(response, 200, {
                    reply: result.reply,
                    history: getChatHistory('dashboard-freelance', 40)
                });
                return;
            }

            if (pathname === '/api/freelance/scout') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const result = await triggerFreelanceManualSearch();
                sendJson(response, 200, result);
                return;
            }

            if (pathname === '/api/freelance/jobs/action') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const result = await setFreelanceJobAction(body.jobId, body.action);
                sendJson(response, 200, { saved: true, result });
                return;
            }

            if (pathname === '/api/freelance/settings') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                const settings = {};
                if (body.search_sites !== undefined) settings.search_sites = String(body.search_sites || '').trim();
                if (body.search_keywords !== undefined) settings.search_keywords = String(body.search_keywords || '').trim();
                if (body.search_location !== undefined) settings.search_location = String(body.search_location || '').trim();
                if (body.search_profile !== undefined) settings.search_profile = String(body.search_profile || '').trim();
                if (body.portfolio_path !== undefined) settings.portfolio_path = String(body.portfolio_path || '').trim();
                await upsertFreelanceSettings(settings);
                sendJson(response, 200, { saved: true, message: 'Freelance settings updated.' });
                return;
            }

            if (pathname === '/api/freelance/portfolio-upload') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const body = await readJsonBody(request);
                if (!body.attachment || !body.attachment.data) {
                    sendJson(response, 400, { error: 'No file data provided.' });
                    return;
                }

                const attachmentRecord = createUploadedAttachment('portfolio', body.attachment);
                if (!attachmentRecord) {
                    sendJson(response, 400, { error: 'Failed to save attachment.' });
                    return;
                }

                await upsertFreelanceSettings({ portfolio_path: attachmentRecord.absolutePath });
                sendJson(response, 200, { saved: true, filename: attachmentRecord.filename, path: attachmentRecord.absolutePath });
                return;
            }

            sendJson(response, 404, { error: 'Not found' });
        } catch (error) {
            recordRuntimeError('dashboard', error);
            sendJson(response, 500, { error: 'Dashboard request failed', detail: error.message });
        }
    });

    server.on('error', (error) => {
        recordRuntimeError('dashboard', error);
        console.error('Dashboard server error:', error);
    });

    server.listen(appConfig.dashboardPort, appConfig.dashboardHost, () => {
        pushEvent('dashboard', `Dashboard ready at ${appConfig.dashboardUrl}`);
        console.log(`Dashboard available at ${appConfig.dashboardUrl}`);
    });

    return server;
}

module.exports = {
    buildStatusPayload,
    startDashboardServer
};
