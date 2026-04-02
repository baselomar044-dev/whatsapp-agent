const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const freelanceRoot = path.resolve(process.cwd(), '..', 'freelance-agent');
const freelanceEnvPath = path.join(freelanceRoot, '.env');
const freelanceFrontendUrl = 'http://127.0.0.1:5173';
const localStorageRoot = path.resolve(process.cwd(), 'storage', 'local-dashboard');
const freelanceActionStatePath = path.join(localStorageRoot, 'freelance-job-actions.json');

const DEFAULT_QS_KEYWORDS = [
    'QS',
    '"Quantity Surveyor"',
    '"Quantity Surveying"',
    'Construction',
    '"Project Estimation"',
    '"Project Estimation Engineer"',
    '"Quantity Takeoff"',
    '"QTY Takeoff"',
    '"Tender Preparation"',
    'BOQ',
    '"Bill of Quantities"',
    '"Bill of Quantity"'
].join(' OR ');

const DEFAULT_SEARCH_LOCATION = 'United Arab Emirates';
const DEFAULT_SEARCH_SITES = [
    'upwork.com',
    'peopleperhour.com',
    'freelancer.com',
    'fiverr.com',
    'guru.com',
    'truelancer.com',
    'workana.com',
    'malt.com',
    'ureed.com',
    'linkedin.com',
    'indeed.com',
    'worksome.com',
    'yunojuno.com',
    'fieldengineer.com',
    'bark.com',
    'designhill.com',
    'kolabtree.com'
];

let cachedClient = null;
let cachedConfig = null;

function ensureLocalStorageRoot() {
    fs.mkdirSync(localStorageRoot, { recursive: true });
}

function readFreelanceJobActions() {
    ensureLocalStorageRoot();

    try {
        if (!fs.existsSync(freelanceActionStatePath)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(freelanceActionStatePath, 'utf8')) || {};
    } catch (error) {
        return {};
    }
}

function writeFreelanceJobActions(actions) {
    ensureLocalStorageRoot();
    fs.writeFileSync(freelanceActionStatePath, JSON.stringify(actions, null, 2));
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractOpportunitySummary(job) {
    const description = cleanText(job.description);

    if (!description || description.toLowerCase() === 'no description provided.') {
        return 'QS / construction opportunity. Review the title, platform, and proposal draft for fit.';
    }

    return description.length > 220 ? `${description.slice(0, 217)}...` : description;
}

function extractOpportunityFee(job) {
    const explicitSalary = cleanText(job.salary);

    if (explicitSalary && explicitSalary.toLowerCase() !== 'not specified') {
        return explicitSalary;
    }

    const description = cleanText(job.description);
    const moneyMatch = description.match(/(?:AED|USD|EUR|GBP|\$|€|£)\s?[\d,.]+(?:\s?(?:per\s?(?:hour|day|month)|\/\s?(?:hour|day|month)))?/i);
    return moneyMatch ? moneyMatch[0] : 'Not specified';
}

function enrichJob(job, actions) {
    const actionState = String(actions[job.id] || 'new').trim() || 'new';

    return {
        ...job,
        actionState,
        summary: extractOpportunitySummary(job),
        feePreview: extractOpportunityFee(job),
        proposalReady: Boolean(String(job.suggested_proposal || '').trim())
    };
}

function loadFreelanceEnv() {
    if (cachedConfig) {
        return cachedConfig;
    }

    if (!fs.existsSync(freelanceEnvPath)) {
        cachedConfig = null;
        return null;
    }

    const parsed = dotenv.parse(fs.readFileSync(freelanceEnvPath, 'utf8'));
    const url = String(parsed.SUPABASE_URL || '').trim();
    const key = String(parsed.SUPABASE_KEY || '').trim();

    if (!url || !key) {
        cachedConfig = null;
        return null;
    }

    cachedConfig = {
        supabaseUrl: url,
        supabaseKey: key,
        keywords: String(parsed.KEYWORDS || '').trim(),
        location: String(parsed.LOCATION || '').trim(),
        frontendUrl: freelanceFrontendUrl,
        rootPath: freelanceRoot
    };

    return cachedConfig;
}

function getFreelanceClient() {
    const config = loadFreelanceEnv();

    if (!config) {
        return null;
    }

    if (!cachedClient) {
        cachedClient = createClient(config.supabaseUrl, config.supabaseKey);
    }

    return cachedClient;
}

async function getFreelanceDashboardData() {
    const config = loadFreelanceEnv();
    const supabase = getFreelanceClient();

    if (!config || !supabase) {
        return {
            available: false,
            stats: {
                totalJobs: 0,
                unsentJobs: 0,
                sentJobs: 0
            },
            recentJobs: [],
            keywords: '',
            location: '',
            frontendUrl: freelanceFrontendUrl,
            note: 'Freelance agent configuration was not found.'
        };
    }

    const [jobsResult, totalResult, unsentResult, triggerResult, settingsResult] = await Promise.allSettled([
        supabase
            .from('freelance_jobs')
            .select('id, title, company, platform, job_url, description, salary, suggested_proposal, created_at, is_sent')
            .order('created_at', { ascending: false })
            .limit(12),
        supabase
            .from('freelance_jobs')
            .select('*', { count: 'exact', head: true }),
        supabase
            .from('freelance_jobs')
            .select('*', { count: 'exact', head: true })
            .eq('is_sent', false),
        supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'manual_search_trigger')
            .maybeSingle(),
        supabase
            .from('app_settings')
            .select('key, value')
            .in('key', ['search_sites', 'search_keywords', 'search_location', 'search_profile', 'portfolio_path'])
    ]);

    const recentJobs = jobsResult.status === 'fulfilled' ? jobsResult.value.data || [] : [];
    const totalJobs = totalResult.status === 'fulfilled' ? totalResult.value.count || 0 : 0;
    const unsentJobs = unsentResult.status === 'fulfilled' ? unsentResult.value.count || 0 : 0;
    const manualTriggerActive = triggerResult.status === 'fulfilled'
        ? String(triggerResult.value.data?.value || '').toLowerCase() === 'true'
        : false;
    const settingsMap = new Map((settingsResult.status === 'fulfilled' ? settingsResult.value.data || [] : []).map((item) => [item.key, item.value]));
    const configuredSites = String(settingsMap.get('search_sites') || '').split(',').map((item) => item.trim()).filter(Boolean);
    const searchSites = configuredSites.length ? configuredSites : DEFAULT_SEARCH_SITES;
    const searchedToday = [...new Set(recentJobs.map((job) => String(job.platform || '').trim()).filter(Boolean))];
    const jobActions = readFreelanceJobActions();
    const enrichedJobs = recentJobs.map((job) => enrichJob(job, jobActions));
    const visibleJobs = enrichedJobs.filter((job) => job.actionState !== 'ignored');
    const ignoredJobs = enrichedJobs.filter((job) => job.actionState === 'ignored').length;
    const readyJobs = enrichedJobs.filter((job) => job.actionState === 'ready').length;

    return {
        available: true,
        stats: {
            totalJobs,
            unsentJobs,
            sentJobs: Math.max(totalJobs - unsentJobs, 0),
            ignoredJobs,
            readyJobs
        },
        recentJobs: visibleJobs,
        keywords: String(settingsMap.get('search_keywords') || DEFAULT_QS_KEYWORDS).trim(),
        location: String(settingsMap.get('search_location') || DEFAULT_SEARCH_LOCATION).trim(),
        searchSites,
        searchedToday,
        searchProfile: String(settingsMap.get('search_profile') || '').trim(),
        portfolioPath: String(settingsMap.get('portfolio_path') || '').trim(),
        frontendUrl: config.frontendUrl,
        manualTriggerActive,
        defaults: {
            keywords: DEFAULT_QS_KEYWORDS,
            location: DEFAULT_SEARCH_LOCATION,
            searchSites: DEFAULT_SEARCH_SITES
        },
        note: jobsResult.status === 'rejected' ? jobsResult.reason.message : ''
    };
}

async function triggerFreelanceManualSearch() {
    const supabase = getFreelanceClient();

    if (!supabase) {
        throw new Error('Freelance agent configuration is not available.');
    }

    const { error } = await supabase
        .from('app_settings')
        .upsert({ key: 'manual_search_trigger', value: 'true' }, { onConflict: 'key' });

    if (error) {
        throw error;
    }

    return {
        accepted: true,
        message: 'Freelance scout trigger submitted.'
    };
}

async function upsertFreelanceSettings(settings) {
    const supabase = getFreelanceClient();

    if (!supabase) {
        throw new Error('Freelance agent configuration is not available.');
    }

    const payload = Object.entries(settings)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ key, value: String(value) }));

    if (!payload.length) {
        return;
    }

    const { error } = await supabase
        .from('app_settings')
        .upsert(payload, { onConflict: 'key' });

    if (error) {
        throw error;
    }
}

async function setFreelanceJobAction(jobId, action) {
    const normalizedId = Number.parseInt(jobId, 10);
    const normalizedAction = String(action || '').trim().toLowerCase();

    if (!Number.isFinite(normalizedId)) {
        throw new Error('A valid freelance job id is required.');
    }

    if (!['ignored', 'ready', 'new'].includes(normalizedAction)) {
        throw new Error('Unsupported freelance job action.');
    }

    const actions = readFreelanceJobActions();

    if (normalizedAction === 'new') {
        delete actions[normalizedId];
    } else {
        actions[normalizedId] = normalizedAction;
    }

    writeFreelanceJobActions(actions);

    return {
        jobId: normalizedId,
        action: normalizedAction
    };
}

module.exports = {
    DEFAULT_QS_KEYWORDS,
    DEFAULT_SEARCH_LOCATION,
    DEFAULT_SEARCH_SITES,
    getFreelanceDashboardData,
    setFreelanceJobAction,
    triggerFreelanceManualSearch,
    upsertFreelanceSettings
};
