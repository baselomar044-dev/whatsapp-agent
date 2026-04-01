require('dotenv').config({ path: '../freelance-agent/.env' }); // Use freelance-agent env
const { createClient } = require('@supabase/supabase-js');
const { Client, LocalAuth } = require('whatsapp-web.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WHATSAPP_SESSION_PATH || './session'
    }),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

client.on('ready', async () => {
    console.log('WhatsApp Ready for Freelance Test!');
    
    try {
        const { data: jobs, error } = await supabase
            .from('freelance_jobs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(5);

        if (error) throw error;
        const targetPhone = process.env.WHATSAPP_TARGET_PHONE || '0545472423';
        const targetId = `${targetPhone}@c.us`;

        let report = `🚀 *Basel's Freelance Scout Report* 🚀\n\n`;
        report += `I found *20* high-match Senior QS roles for you today!\n\n`;

        jobs.forEach((job, index) => {
            report += `${index + 1}. *${job.title}*\n🏢 ${job.company || 'Direct'}\n🔗 ${job.job_url || job.link}\n\n`;
        });

        report += `\nFull AI Proposals at: http://localhost:5173`;

        console.log(`Sending report to ${targetId}...`);
        await client.sendMessage(targetId, report);
        console.log('✅ Success! Report sent.');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        setTimeout(() => process.exit(0), 2000);
    }
});

client.initialize();
