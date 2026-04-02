const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { appConfig } = require('./config');
const { logMessage, updateLastSent } = require('./database');
const { normalizePhoneNumber, toWhatsAppId } = require('./phone');
const {
    markWhatsAppAuthenticated,
    markWhatsAppAuthFailure,
    markWhatsAppDisconnected,
    markWhatsAppReady,
    recordMessageResult,
    setPairingCode,
    setWhatsAppQr
} = require('./runtime-state');

const puppeteerConfig = {
    headless: appConfig.headless,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-first-run',
        '--no-default-browser-check'
    ]
};

// Use system Chrome if available, otherwise use what's in PATH
if (appConfig.chromeExecutablePath) {
    puppeteerConfig.executablePath = appConfig.chromeExecutablePath;
} else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: appConfig.whatsappSessionPath
    }),
    puppeteer: puppeteerConfig
});

client.on('qr', (qr) => {
    console.log('--- WHATSAPP LOGIN REQUIRED ---');
    const qrUrl = setWhatsAppQr(qr);
    
    console.log('QR CODE DATA RECEIVED.');
    console.log('OPEN THE LOCAL DASHBOARD TO SCAN:');
    console.log(appConfig.dashboardUrl);
    console.log('OR USE THIS DIRECT IMAGE LINK:');
    console.log(qrUrl);
    
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Scan WhatsApp QR Code</title>
        <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f0f2f5; }
            .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; }
            img { border: 1px solid #ddd; border-radius: 4px; padding: 10px; background: white; }
            h1 { color: #128c7e; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Scan WhatsApp QR Code</h1>
            <p>Open WhatsApp on your phone and scan this code to connect.</p>
            <img src="${qrUrl}" alt="WhatsApp QR Code" />
            <p><small>Created at: ${new Date().toLocaleString()}</small></p>
        </div>
    </body>
    </html>
    `;
    
    const htmlPath = path.join(process.cwd(), 'whatsapp_qr.html');
    fs.writeFileSync(htmlPath, htmlContent);
    
    console.log(`\nQR Code saved to: ${htmlPath}`);
    console.log('Dashboard QR preview is ready.');
    
    // Still display in terminal as backup
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    markWhatsAppReady();
    console.log('WhatsApp Client is ready!');
});

client.on('authenticated', () => {
    markWhatsAppAuthenticated();
    console.log('WhatsApp authenticated!');
});

client.on('auth_failure', (msg) => {
    markWhatsAppAuthFailure(msg);
    console.error('WhatsApp Auth failure:', msg);
});

client.on('disconnected', (reason) => {
    markWhatsAppDisconnected(reason);
    console.warn('WhatsApp disconnected:', reason);
});

// Pairing code event (emitted when requestPairingCode is used)
client.on('code', (code) => {
    setPairingCode(code);
    console.log(`--- PAIRING CODE: ${code} ---`);
    console.log('Enter this code on your phone: WhatsApp > Linked Devices > Link a Device > Link with Phone Number');
});

// ── Incoming messages from contacts ──────────────────────────────────
// CRITICAL: Agent reads messages WITHOUT sending read receipt to sender
// Read Receipts:
//   - You (Basel): Normal - blue checkmark appears (your WhatsApp setting)
//   - Sender: Sees message as UNREAD (bot doesn't ack)
client.on('message', async (msg) => {
    try {
        // Only log messages from individual chats (not groups, not from ourselves)
        if (msg.isStatus) return;
        if (msg.fromMe) return;
        if (msg.from && msg.from.endsWith('@g.us')) return; // skip groups

        const rawPhone = String(msg.from || '').replace('@c.us', '').replace(/[^\d]/g, '');
        if (!rawPhone) return;

        // 🔇 SILENT MODE: Read message data WITHOUT sending acknowledgment
        // We extract: text, media, timestamps, etc
        // But we NEVER call msg.ack() - this prevents blue checkmark being sent to sender
        
        const messageId = msg.id?._serialized || 'unknown';
        let body = msg.body || '[message]';
        let mediaInfo = '';

        // Detect media type (voice, image, video, document, etc)
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                const mimeType = media.mimetype || 'unknown';
                const isVoice = mimeType.includes('audio') || mimeType.includes('ogg');
                const isImage = mimeType.includes('image');
                const isVideo = mimeType.includes('video');
                const isDocument = mimeType.includes('application') || mimeType.includes('pdf');

                if (isVoice) {
                    mediaInfo = `🎙️ VOICE MESSAGE (${mimeType})`;
                    body = `[🎙️ VOICE] ${msg.body || '(no caption)'}`;
                } else if (isImage) {
                    mediaInfo = `🖼️ IMAGE (${mimeType})`;
                    body = `[🖼️ IMAGE] ${msg.body || '(no caption)'}`;
                } else if (isVideo) {
                    mediaInfo = `🎬 VIDEO (${mimeType})`;
                    body = `[🎬 VIDEO] ${msg.body || '(no caption)'}`;
                } else if (isDocument) {
                    mediaInfo = `📄 DOCUMENT (${mimeType})`;
                    body = `[📄 DOC] ${msg.body || '(no caption)'}`;
                } else {
                    mediaInfo = `📎 ATTACHMENT (${mimeType})`;
                    body = `[📎 FILE] ${msg.body || '(no caption)'}`;
                }
            } catch (mediaErr) {
                mediaInfo = `📎 ATTACHMENT (couldn't extract details)`;
                body = `[📎 FILE] ${msg.body || '(no caption)'}`;
            }
        }

        // Log to database (your logs only)
        await logMessage(rawPhone, 'received', body.slice(0, 500), new Date().toISOString());
        
        // Console output for your monitoring - detailed report
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`🔇 [SILENT READ] ${messageId}`);
        console.log(`   From: ${rawPhone}`);
        if (mediaInfo) {
            console.log(`   Type: ${mediaInfo}`);
        }
        console.log(`   Content: ${body.slice(0, 100)}`);
        console.log(`   ✓ UNREAD for sender (no blue checkmark sent)`);
        console.log(`${'═'.repeat(70)}\n`);
    } catch (err) {
        console.error('Failed to log incoming message:', err.message);
    }
});

async function requestPairing(phoneNumber) {
    try {
        const code = await client.requestPairingCode(phoneNumber, true);
        setPairingCode(code);
        console.log(`Pairing code for ${phoneNumber}: ${code}`);
        return { success: true, code };
    } catch (error) {
        console.error('Failed to request pairing code:', error);
        return { success: false, error: error.message };
    }
}

async function sendToPhone(phoneNumber, content, options = {}) {
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const sentAt = new Date().toISOString();
    const logContent = options.logContent
        || (typeof content === 'string'
            ? content
            : `[media] ${options.caption || path.basename(options.filePath || 'attachment')}`);

    try {
        const formattedPhone = toWhatsAppId(normalizedPhone);
        const sentMessage = typeof content === 'string'
            ? await client.sendMessage(formattedPhone, content)
            : await client.sendMessage(formattedPhone, content, {
                caption: options.caption || undefined
            });

        if (options.updateLastSent !== false) {
            await updateLastSent(normalizedPhone, sentAt);
        }

        if (options.logMessage !== false) {
            await logMessage(normalizedPhone, 'sent', logContent, sentAt);
        }

        if (options.recordBlastActivity) {
            recordMessageResult(normalizedPhone, 'sent');
        }

        console.log(`Message sent to ${normalizedPhone}`);
        return sentMessage;
    } catch (error) {
        const phoneForLogs = normalizedPhone || String(phoneNumber || 'unknown');
        console.error(`Failed to send message to ${phoneForLogs}:`, error);

        if (options.logMessage !== false) {
            await logMessage(phoneForLogs, 'failed', error.message, sentAt);
        }

        if (options.recordBlastActivity) {
            recordMessageResult(phoneForLogs, 'failed', error.message);
            return false;
        }

        throw error;
    }
}

async function sendMessage(phoneNumber, message) {
    const result = await sendToPhone(phoneNumber, message, {
        recordBlastActivity: true
    });

    return Boolean(result);
}

async function sendManagedMessage(phoneNumber, message) {
    return sendToPhone(phoneNumber, message, {
        recordBlastActivity: false
    });
}

async function sendManagedMedia(phoneNumber, filePath, caption = '') {
    const media = MessageMedia.fromFilePath(filePath);

    return sendToPhone(phoneNumber, media, {
        caption,
        filePath,
        recordBlastActivity: false,
        logContent: `[media] ${path.basename(filePath)}${caption ? ` | ${caption}` : ''}`
    });
}

module.exports = {
    client,
    requestPairing,
    sendManagedMedia,
    sendManagedMessage,
    sendMessage
};
