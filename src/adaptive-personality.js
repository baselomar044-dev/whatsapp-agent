/**
 * Adaptive Personality Manager - Intelligent response decision making
 * Not a chatbot. A flexible, logical agent with real personality.
 */

const Groq = require('groq-sdk');
const { appConfig } = require('./config');

class PersonalityConfig {
    constructor() {
        this.style = process.env.AGENT_PERSONALITY_STYLE || 'professional';
        this.language = process.env.AGENT_LANGUAGE || 'arabic';
        this.tone = process.env.AGENT_TONE || 'casual';
        this.rules = this.parseRules();
        this.instructions = process.env.AGENT_CUSTOM_INSTRUCTIONS || '';
    }

    parseRules() {
        // Parse rules from env or use defaults
        return {
            autoReply: this.parseBoolean(process.env.AGENT_AUTO_REPLY, false),
            silentMode: this.parseBoolean(process.env.AGENT_SILENT_MODE, false),
            intelligentIgnore: this.parseBoolean(process.env.AGENT_INTELLIGENT_IGNORE, true),
            useEmojis: this.parseBoolean(process.env.AGENT_USE_EMOJIS, true),
            maxResponseLength: parseInt(process.env.AGENT_MAX_LENGTH || '1000', 10),
            decideTone: process.env.AGENT_DECIDE_TONE || 'autonomous'
        };
    }

    parseBoolean(value, defaultVal) {
        if (value === undefined) return defaultVal;
        return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
    }
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const direct = raw.replace(/```json\n?|\n?```/g, '').trim();
    if (direct.startsWith('{') && direct.endsWith('}')) {
        return direct;
    }

    const start = direct.indexOf('{');
    const end = direct.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return direct.slice(start, end + 1);
    }

    return null;
}

function heuristicAnalysis(message) {
    const text = String(message || '').toLowerCase().trim();
    const hasQuestion = text.includes('?') || text.includes('؟');
    const isGreeting = /(hi|hello|hey|مرحبا|هلا|السلام)/i.test(text);
    const isSpam = /(http|www\.|t\.me|free\s+money|bitcoin|promo|offer)/i.test(text);
    const looksUrgent = /(urgent|asap|important|ضروري|مستعجل)/i.test(text);

    if (isSpam) {
        return {
            shouldReply: false,
            responseType: 'ignore',
            sentiment: 'spam',
            reasoning: 'Heuristic fallback detected likely spam.',
            suggestedResponse: null
        };
    }

    if (looksUrgent || hasQuestion || isGreeting) {
        return {
            shouldReply: true,
            responseType: hasQuestion ? 'normal' : 'brief',
            sentiment: looksUrgent ? 'urgent' : 'neutral',
            reasoning: 'Heuristic fallback decided this deserves a response.',
            suggestedResponse: null
        };
    }

    return {
        shouldReply: false,
        responseType: 'ignore',
        sentiment: 'neutral',
        reasoning: 'Heuristic fallback decided silence is acceptable.',
        suggestedResponse: null
    };
}

async function analyzeMessage(message, sender, previousContext = []) {
    const groqClient = appConfig.manager.groqApiKey
        ? new Groq({ apiKey: appConfig.manager.groqApiKey })
        : null;

    if (!groqClient) {
        return heuristicAnalysis(message);
    }

    const analysisPrompt = `
You are an intelligent WhatsApp agent with personality and logic. Analyze this message and decide:

SENDER: ${sender}
MESSAGE: "${message}"
PREVIOUS EXCHANGES: ${previousContext.length} messages

Your task (respond in JSON only):
{
    "shouldReply": boolean (true if message deserves a response, false to ignore silently),
    "responseType": "normal|brief|casual|ignore|ask_clarification",
    "sentiment": "positive|neutral|negative|urgent|spam",
    "reasoning": "Why this decision?",
    "suggestedResponse": "If shouldReply=true, what would you naturally say? Otherwise null"
}

LOGIC:
- Spam/bot messages? → shouldReply: false
- Normal question? → Respond naturally
- Urgent/important? → Respond with priority
- Just greeting? → Brief, casual reply
- Don't be robotic. Be real. Be helpful.
- If unsure, ask for clarification
- Silent is OK. Not every message needs a reply.

Respond ONLY with valid JSON.
`;

    try {
        const response = await groqClient.chat.completions.create({
            model: appConfig.manager.model,
            messages: [
                { role: 'system', content: 'You are a JSON-only response generator. Output ONLY valid JSON, no markdown, no explanation.' },
                { role: 'user', content: analysisPrompt }
            ],
            max_tokens: 400,
            temperature: 0.7
        });

        const content = String(response.choices?.[0]?.message?.content || '{}').trim();
        const jsonStr = extractJsonObject(content);
        if (!jsonStr) {
            return heuristicAnalysis(message);
        }

        const result = JSON.parse(jsonStr);
        if (typeof result.shouldReply !== 'boolean') {
            return heuristicAnalysis(message);
        }

        return {
            shouldReply: result.shouldReply,
            responseType: result.responseType || (result.shouldReply ? 'normal' : 'ignore'),
            sentiment: result.sentiment || 'neutral',
            reasoning: result.reasoning || 'Model decision',
            suggestedResponse: result.suggestedResponse || null
        };
    } catch (error) {
        console.error('Analysis error:', error.message);
        return heuristicAnalysis(message);
    }
}

async function generateResponse(message, sender, personality, previousContext = []) {
    const groqClient = appConfig.manager.groqApiKey
        ? new Groq({ apiKey: appConfig.manager.groqApiKey })
        : null;

    if (!groqClient) {
        return 'Unable to generate response';
    }

    const responsePrompt = `
You are ${personality.style} WhatsApp agent. NOT A CHATBOT. Real person, real logic.

PERSONALITY:
- Style: ${personality.style}
- Tone: ${personality.tone}
- Language: ${personality.language}
- Use emojis: ${personality.rules.useEmojis ? 'yes, naturally' : 'no'}
- Custom rules: ${personality.instructions}

MESSAGE FROM ${sender}:
"${message}"

RESPOND NATURALLY - not robotic, not chatbot-like:
- Short, casual, real
- Maximum ${personality.rules.maxResponseLength} chars
- Match their energy
- Be helpful without being fake
- Use language they use (if Arabic, respond Arabic; if English, English)
- No "Hello! Thanks for messaging..." bullshit

Just respond directly, naturally.
`;

    try {
        const response = await groqClient.chat.completions.create({
            model: appConfig.manager.model,
            messages: [
                { role: 'system', content: 'You are a natural, conversational WhatsApp agent. Respond like a real person, not a bot.' },
                { role: 'user', content: responsePrompt }
            ],
            max_tokens: 300,
            temperature: 0.8
        });

        return String(response.choices?.[0]?.message?.content || 'Got it').trim();
    } catch (error) {
        console.error('Response generation error:', error.message);
        return null;
    }
}

async function processIncomingMessage(message, sender) {
    const personality = new PersonalityConfig();

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📨 INTELLIGENT ANALYSIS - From ${sender}`);
    console.log(`${'═'.repeat(70)}`);
    console.log(`Message: ${message.slice(0, 100)}`);

    // Step 1: Analyze if we should reply
    const analysis = await analyzeMessage(message, sender, []);

    console.log(`\n📊 Analysis Result:`);
    console.log(`   Should Reply: ${analysis.shouldReply ? '✅ YES' : '❌ NO'}`);
    console.log(`   Type: ${analysis.responseType}`);
    console.log(`   Sentiment: ${analysis.sentiment}`);
    console.log(`   Reasoning: ${analysis.reasoning}`);

    // Step 2: If we should reply, generate natural response
    if (analysis.shouldReply) {
        console.log(`\n💭 Generating response...`);
        const response = analysis.suggestedResponse
            ? String(analysis.suggestedResponse).trim()
            : await generateResponse(message, sender, personality, []);

        if (response) {
            console.log(`\n✉️  Response:`);
            console.log(`   "${response}"`);

            return {
                shouldReply: true,
                response,
                analysis
            };
        }
    } else {
        console.log(`\n🤐 Staying silent on this one.`);
        return {
            shouldReply: false,
            reason: analysis.reasoning,
            analysis
        };
    }

    console.log(`${'═'.repeat(70)}\n`);

    return {
        shouldReply: false
    };
}

module.exports = {
    PersonalityConfig,
    analyzeMessage,
    generateResponse,
    processIncomingMessage
};
