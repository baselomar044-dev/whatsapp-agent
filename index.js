require('dotenv').config();
const { client, sendManagedMessage, sendManagedMedia } = require('./src/whatsapp');
const { startDashboardServer } = require('./src/dashboard');
const { pushEvent, recordRuntimeError, setAppStatus } = require('./src/runtime-state');
const { setupScheduler, runDailyBlast, stopScheduler } = require('./src/scheduler');
const { createManagerAgent } = require('./src/manager-agent');

console.log('WhatsApp Sender Agent starting...');
setAppStatus('starting', 'Application booting.');

const dashboardServer = startDashboardServer({
    client,
    sendManagedMessage,
    sendManagedMedia
});
let schedulerStarted = false;
let isShuttingDown = false;

createManagerAgent({
    client,
    sendManagedMessage,
    sendManagedMedia
});

const isPreview = process.argv.includes('--preview');

if (isPreview) {
    console.log('--- PREVIEW MODE ACTIVE ---');
    console.log('WhatsApp connection and blast schedulers are strictly DISABLED.');
    setAppStatus('running', 'Application online in PREVIEW MODE (no WhatsApp connected).');
} else {
    Promise.resolve(client.initialize()).catch((error) => {
        recordRuntimeError('whatsapp', error);
        setAppStatus('error', `WhatsApp initialization failed: ${error.message}`);
        console.error('WhatsApp initialization failed:', error);
    });

    client.on('ready', () => {
        setAppStatus('running', 'Application is online.');

        if (!schedulerStarted) {
            setupScheduler();
            schedulerStarted = true;
        }
        
        // Optional: Run immediately for testing if a command line argument is passed
        if (process.argv.includes('--now')) {
            pushEvent('app', 'Immediate blast requested with --now.');
            runDailyBlast('immediate').catch((error) => {
                setAppStatus('error', `Immediate blast failed: ${error.message}`);
                console.error('Immediate blast failed:', error);
            });
        }
    });
}

async function shutdown() {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log('Shutting down...');
    setAppStatus('stopping', 'Shutdown requested.');
    stopScheduler();

    try {
        await new Promise((resolve) => dashboardServer.close(resolve));
    } catch (error) {
        recordRuntimeError('dashboard', error);
    }

    try {
        await client.destroy();
    } catch (error) {
        recordRuntimeError('whatsapp', error);
    }

    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    recordRuntimeError('process', error);
    setAppStatus('error', `Unhandled rejection: ${error.message}`);
    console.error('Unhandled rejection:', error);
});
