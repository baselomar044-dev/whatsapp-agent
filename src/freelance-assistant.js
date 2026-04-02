const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

const { appendChatHistory, getChatHistory, getLatestAttachmentForChat } = require('./manager-storage');
const { getFreelanceDashboardData, triggerFreelanceManualSearch, upsertFreelanceSettings } = require('./freelance-bridge');
const { appConfig } = require('./config');

function getFreelanceGroqClient() {
    const apiKey = appConfig.manager.groqApiKey || String(process.env.GROQ_API_KEY || '').trim();

    if (!apiKey) {
        return null;
    }

    return new Groq({ apiKey });
}

function buildFreelanceHelpText() {
    return [
        'Freelance agent | أوامر وكيل الفريلانس:',
        '- help | مساعدة',
        '- status | الحالة',
        '- jobs | الوظائف',
        '- sites today | مواقع اليوم',
        '- set sites linkedin, upwork, indeed',
        '- set keywords Senior QS freelance',
        '- set location Dubai',
        '- set profile ...',
        '- use this portfolio',
        '- scout now | شغّل البحث الآن',
        '- dashboard | افتح الواجهة',
        '',
        'Upload portfolio, attachments, or voice notes in this chat and tell the scout how to use them.',
        'ارفع portfolio أو ملفاً أو voice note داخل نفس المحادثة وقل للوكيل كيف يستخدمها.'
    ].join('\n');
}

function parseFreelanceCommand(text) {
    const value = String(text || '').trim();

    if (!value) {
        return { name: 'empty' };
    }

    if (/^\/?help$/i.test(value)) {
        return { name: 'help' };
    }

    if (/^\/?status$/i.test(value)) {
        return { name: 'status' };
    }

    if (/^\/?jobs$/i.test(value)) {
        return { name: 'jobs' };
    }

    if (/^\/?sites\s+today$/i.test(value)) {
        return { name: 'sites_today' };
    }

    const setSitesMatch = value.match(/^\/?set\s+sites?\s+(.+)$/i);
    if (setSitesMatch) {
        return {
            name: 'set_sites',
            sites: setSitesMatch[1].split(',').map((item) => item.trim()).filter(Boolean)
        };
    }

    const setKeywordsMatch = value.match(/^\/?set\s+keywords?\s+(.+)$/i);
    if (setKeywordsMatch) {
        return {
            name: 'set_keywords',
            keywords: setKeywordsMatch[1].trim()
        };
    }

    const setLocationMatch = value.match(/^\/?set\s+location\s+(.+)$/i);
    if (setLocationMatch) {
        return {
            name: 'set_location',
            location: setLocationMatch[1].trim()
        };
    }

    const setProfileMatch = value.match(/^\/?set\s+profile\s+([\s\S]+)$/i);
    if (setProfileMatch) {
        return {
            name: 'set_profile',
            profile: setProfileMatch[1].trim()
        };
    }

    if (/^\/?use\s+(this\s+)?portfolio$/i.test(value)) {
        return { name: 'use_portfolio' };
    }

    if (/^\/?(dashboard|open)$/i.test(value)) {
        return { name: 'dashboard' };
    }

    if (/^\/?scout(?:\s+now)?$/i.test(value)) {
        return { name: 'scout_now' };
    }

    return {
        name: 'chat',
        message: value
    };
}

function formatRecentJobs(jobs) {
    if (!jobs.length) {
        return 'No recent freelance opportunities were found. | لا توجد فرص حديثة.';
    }

    return jobs.slice(0, 5).map((job, index) => {
        const parts = [
            `${index + 1}. ${job.title || 'Untitled role'}`,
            `Company: ${job.company || 'Direct'}`,
            `Platform: ${job.platform || 'Unknown'}`
        ];

        if (job.job_url) {
            parts.push(`Link: ${job.job_url}`);
        }

        if (job.suggested_proposal) {
            parts.push(`Proposal: ${String(job.suggested_proposal).slice(0, 180)}`);
        }

        return parts.join('\n');
    }).join('\n\n');
}

async function buildFreelanceStatus() {
    const data = await getFreelanceDashboardData();

    return [
        `Freelance agent available | الوكيل متاح: ${data.available ? 'yes' : 'no'}`,
        `Total jobs | كل الوظائف: ${data.stats.totalJobs}`,
        `Unsent jobs | غير المرسلة: ${data.stats.unsentJobs}`,
        `Sent jobs | المرسلة: ${data.stats.sentJobs}`,
        `Keywords | الكلمات: ${data.keywords || 'n/a'}`,
        `Location | الموقع: ${data.location || 'n/a'}`,
        `Sites for tomorrow | مواقع الغد: ${(data.searchSites || []).join(', ') || 'default'}`,
        `Sites found today | مواقع اليوم: ${(data.searchedToday || []).join(', ') || 'none'}`,
        `Portfolio | البورتفوليو: ${data.portfolioPath || 'not set'}`,
        `Manual scout trigger | التفعيل اليدوي: ${data.manualTriggerActive ? 'active' : 'idle'}`,
        data.note ? `Note: ${data.note}` : ''
    ].filter(Boolean).join('\n');
}

async function buildFreelanceAiReply(chatId, messageText) {
    const client = getFreelanceGroqClient();
    const data = await getFreelanceDashboardData();
    const history = getChatHistory(chatId, 12);

    if (!client) {
        return [
            'Freelance AI is not configured.',
            'You can still use these commands:',
            buildFreelanceHelpText()
        ].join('\n\n');
    }

    const systemPrompt = [
        'You are Basel\'s professional freelance scout assistant.',
        'You are fluent in both Arabic and English. Match the language the user writes in \u2014 if they write Arabic, respond in Arabic; if English, respond in English. If mixed, prefer the dominant language.',
        'Write in a polished, organized manner: use proper punctuation (\u060c and \u061f for Arabic), clear paragraphs, and bullet points when listing items.',
        'Keep responses concise, direct, and actionable \u2014 no filler or repetition.',
        'Focus on: job search strategy, proposal drafting, lead prioritization, outreach guidance, and platform-specific tips.',
        'When discussing jobs, highlight key details: title, company, platform, relevance score, and suggested next steps.',
        'Never expose internal system details, API keys, or technical errors to the user.'
    ].join(' ');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: [
            'Current freelance workspace snapshot:',
            JSON.stringify({
                available: data.available,
                stats: data.stats,
                keywords: data.keywords,
                location: data.location,
                searchSites: data.searchSites,
                searchedToday: data.searchedToday,
                portfolioPath: data.portfolioPath,
                recentJobs: data.recentJobs.slice(0, 5).map((job) => ({
                    title: job.title,
                    company: job.company,
                    platform: job.platform,
                    job_url: job.job_url,
                    suggested_proposal: job.suggested_proposal
                }))
            }, null, 2)
        ].join('\n\n') }
    ];

    for (const entry of history) {
        messages.push({
            role: entry.role === 'user' ? 'user' : 'assistant',
            content: entry.text
        });
    }

    messages.push({ role: 'user', content: messageText });

    const response = await client.chat.completions.create({
        model: appConfig.manager.model || 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 2048,
        temperature: 0.7
    });

    return String(response.choices?.[0]?.message?.content || '').trim() || 'No reply was generated.';
}

async function runFreelanceConversation(chatId, text, currentAttachmentRecord = null) {
    const command = parseFreelanceCommand(text);
    const attachmentRecord = currentAttachmentRecord || getLatestAttachmentForChat(chatId);

    if (command.name === 'empty' && attachmentRecord) {
        const reply = `Attachment or voice note saved: ${attachmentRecord.relativePath} | تم حفظ المرفق أو الصوت.`;
        appendChatHistory(chatId, {
            role: 'assistant',
            text: reply,
            timestamp: new Date().toISOString()
        });
        return { reply };
    }

    if (command.name !== 'empty') {
        appendChatHistory(chatId, {
            role: 'user',
            text,
            timestamp: new Date().toISOString()
        });
    }

    let reply = '';

    switch (command.name) {
    case 'help':
        reply = buildFreelanceHelpText();
        break;
    case 'status':
        reply = await buildFreelanceStatus();
        break;
    case 'jobs': {
        const data = await getFreelanceDashboardData();
        reply = formatRecentJobs(data.recentJobs);
        break;
    }
    case 'sites_today': {
        const data = await getFreelanceDashboardData();
        reply = data.searchedToday && data.searchedToday.length
            ? `Sites searched today | مواقع اليوم:\n${data.searchedToday.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
            : 'No searchable platforms were detected in today\'s jobs yet. | لا توجد مواقع مرصودة اليوم.';
        break;
    }
    case 'set_sites':
        await upsertFreelanceSettings({ search_sites: command.sites.join(', ') });
        reply = `Tomorrow search sites saved: ${command.sites.join(', ') || 'default'}. | تم حفظ مواقع الغد.`;
        break;
    case 'set_keywords':
        await upsertFreelanceSettings({ search_keywords: command.keywords });
        reply = `Search keywords updated to: ${command.keywords} | تم تحديث الكلمات المفتاحية.`;
        break;
    case 'set_location':
        await upsertFreelanceSettings({ search_location: command.location });
        reply = `Search location updated to: ${command.location} | تم تحديث الموقع.`;
        break;
    case 'set_profile':
        await upsertFreelanceSettings({ search_profile: command.profile });
        reply = 'Freelance profile context updated. | تم تحديث سياق الملف الشخصي.';
        break;
    case 'use_portfolio':
        if (!attachmentRecord) {
            reply = 'Upload a portfolio/attachment first, then say use this portfolio. | ارفع البورتفوليو أولاً ثم اطلب استخدامه.';
            break;
        }

        await upsertFreelanceSettings({ portfolio_path: attachmentRecord.absolutePath });
        reply = `Portfolio set to ${attachmentRecord.relativePath} | تم تعيين البورتفوليو.`;
        break;
    case 'dashboard': {
        const data = await getFreelanceDashboardData();
        reply = data.frontendUrl || 'Freelance dashboard URL is not configured.';
        break;
    }
    case 'scout_now':
        await triggerFreelanceManualSearch();
        reply = 'Freelance scout triggered in the background. | تم تشغيل البحث في الخلفية.';
        break;
    case 'chat':
        reply = await buildFreelanceAiReply(chatId, command.message);
        break;
    case 'empty':
    default:
        reply = 'Type a freelance command or ask the scout assistant something. | اكتب أمراً أو اسأل وكيل الفريلانس.';
        break;
    }

    appendChatHistory(chatId, {
        role: 'assistant',
        text: reply,
        timestamp: new Date().toISOString()
    });

    return { reply };
}

module.exports = {
    buildFreelanceHelpText,
    parseFreelanceCommand,
    runFreelanceConversation
};
