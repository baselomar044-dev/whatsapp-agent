const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

client.on('ready', async () => {
    console.log('WhatsApp Ready for Manual Test!');
    
    try {
        const targetPhone = '0545472423';
        const targetId = `${targetPhone}@c.us`;

        let report = `🚀 *Basel's Freelance Scout: FIRST RUN* 🚀\n\n`;
        report += `I found *20* Senior Quantity Surveyor roles in Dubai today!\n\n`;
        report += `*1. Senior Quantity Surveyor - DEWA/RTA Experience Preferred*\n`;
        report += `🏢 Confidential (Dubai)\n`;
        report += `🔗 View on Dashboard: http://localhost:5173\n\n`;
        report += `Check the link for all 20 jobs and your custom AI proposals!`;

        console.log(`Sending manual report to ${targetId}...`);
        await client.sendMessage(targetId, report);
        console.log('✅ Success! Manual report sent.');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        setTimeout(() => process.exit(0), 4000);
    }
});

client.initialize();
