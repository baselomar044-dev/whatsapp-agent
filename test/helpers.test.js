const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const originalEnv = { ...process.env };

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_KEY = 'test-key';

const { buildConfig } = require('../src/config');
const { buildMessagePreview, renderMessageTemplate } = require('../src/message-template');
const { normalizePhoneNumber, toWhatsAppId } = require('../src/phone');

after(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
    }
});

test('buildConfig normalizes message and delay ranges', () => {
    const config = buildConfig({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_KEY: 'test-key',
        SEND_TIME: '7:05',
        MIN_MESSAGES: '50',
        MAX_MESSAGES: '20',
        MIN_DELAY_SECONDS: '60',
        MAX_DELAY_SECONDS: '15',
        DASHBOARD_HOST: '0.0.0.0',
        DASHBOARD_PORT: '4001',
        WHATSAPP_HEADLESS: 'false'
    });

    assert.equal(config.sendTime, '07:05');
    assert.equal(config.minMessages, 20);
    assert.equal(config.maxMessages, 50);
    assert.equal(config.minDelaySeconds, 15);
    assert.equal(config.maxDelaySeconds, 60);
    assert.equal(config.dashboardUrl, 'http://127.0.0.1:4001');
    assert.equal(config.headless, false);
});

test('message templates support both placeholder styles and preserve unknown tokens', () => {
    const rendered = renderMessageTemplate('Hi ${firstName}, call {{phone}}. {{unknown}}', {
        name: 'Basel Salem',
        phone: '971500000000'
    });

    assert.equal(rendered, 'Hi Basel, call 971500000000. {{unknown}}');
});

test('message preview falls back to the default template', () => {
    const preview = buildMessagePreview('', { name: 'Mira Noor', phone: '971511111111' });

    assert.match(preview.template, /Hello/);
    assert.match(preview.rendered, /Mira Noor/);
});

test('phone helpers normalize formatting and produce WhatsApp ids', () => {
    assert.equal(normalizePhoneNumber('+971 50-123 4567@c.us'), '971501234567');
    assert.equal(toWhatsAppId('+971 50-123 4567'), '971501234567@c.us');
});
