const fs = require('fs');
const http = require('http');
const path = require('path');

const { appConfig, toPublicDashboardConfig } = require('./config');
const { getContactStats, getDailyLogStats, getRecentLogs, getMessageTemplate } = require('./database');
const { getAttachmentStats, listRecentAttachments } = require('./manager-storage');
const { buildMessagePreview } = require('./message-template');
const { isBlastRunning, runDailyBlast } = require('./scheduler');
const { getRuntimeSnapshot, pushEvent, recordRuntimeError } = require('./runtime-state');

const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const dashboardClientJs = fs.readFileSync(path.join(__dirname, 'dashboard-client.js'), 'utf8');

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
        issues.push('The daily scheduler is not configured.');
    }

    if (runtime.manager.enabled && !runtime.manager.aiConfigured) {
        issues.push('Manager AI chat is disabled until GEMINI_API_KEY is configured.');
    }

    if (dataErrors.length) {
        issues.push(`${dataErrors.length} dashboard data source(s) failed to load.`);
    }

    return {
        status: issues.length === 0 ? 'healthy' : runtime.appStatus === 'error' || runtime.whatsapp.status === 'auth_failure' ? 'error' : 'warning',
        issues
    };
}

async function buildStatusPayload() {
    const [contactStatsResult, dailyLogStatsResult, recentLogsResult, messageTemplateResult, attachmentStatsResult, recentAttachmentsResult] = await Promise.allSettled([
        getContactStats(),
        getDailyLogStats(),
        getRecentLogs(appConfig.recentLogLimit),
        getMessageTemplate(),
        Promise.resolve(getAttachmentStats()),
        Promise.resolve(listRecentAttachments(appConfig.manager.recentAttachmentLimit))
    ]);

    const dataErrors = [];

    if (contactStatsResult.status === 'rejected') {
        dataErrors.push(`Contact stats unavailable: ${contactStatsResult.reason.message}`);
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

    if (attachmentStatsResult.status === 'rejected') {
        dataErrors.push(`Attachment stats unavailable: ${attachmentStatsResult.reason.message}`);
    }

    const runtime = getRuntimeSnapshot();
    const messagePreview = buildMessagePreview(
        messageTemplateResult.status === 'fulfilled' ? messageTemplateResult.value : null,
        appConfig.previewContact
    );

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
        recentLogs: recentLogsResult.status === 'fulfilled' ? recentLogsResult.value : [],
        attachments: {
            stats: attachmentStatsResult.status === 'fulfilled'
                ? attachmentStatsResult.value
                : { total: 0, latest: null },
            recent: recentAttachmentsResult.status === 'fulfilled'
                ? recentAttachmentsResult.value
                : []
        },
        messagePreview,
        capabilities: {
            canTriggerBlast: true,
            localOnlyMutations: true,
            isLocalRequestRequired: true
        },
        dataErrors
    };
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
        const [username, password] = credentials.split(':');
        
        if (password === appConfig.dashboardPassword) {
            return true;
        }
    } catch (e) {
        // Fallthrough to 401
    }

    response.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="WhatsApp Agent Dashboard"',
        'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
}

function startDashboardServer() {
    const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${appConfig.dashboardHost}:${appConfig.dashboardPort}`}`);
        const pathname = requestUrl.pathname;

        try {
            if (!checkAuth(request, response)) {
                return;
            }

            if (pathname === '/' || pathname === '/index.html') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                sendHtml(response, 200, dashboardHtml);
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

            if (pathname === '/api/status') {
                if (request.method !== 'GET') {
                    sendMethodNotAllowed(response);
                    return;
                }

                const payload = await buildStatusPayload();
                sendJson(response, 200, payload);
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

            if (pathname === '/api/blast/run') {
                if (request.method !== 'POST') {
                    sendMethodNotAllowed(response);
                    return;
                }

                if (!isLocalRequest(request)) {
                    sendJson(response, 403, { error: 'Manual blast control is limited to local requests.' });
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
                    console.error('Dashboard-triggered blast failed:', error);
                });

                sendJson(response, 202, { accepted: true, message: 'Manual blast started.' });
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
