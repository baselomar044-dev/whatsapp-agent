const cron = require('node-cron');
const { appConfig } = require('./config');
const { getActiveContacts, getMessageTemplate, getAppSetting, upsertAppSetting } = require('./database');
const { renderMessageTemplate } = require('./message-template');
const { sendMessage } = require('./whatsapp');
const {
    finishBlast,
    markSchedulerTrigger,
    pushEvent,
    recordRuntimeError,
    setSchedulerState,
    startBlast
} = require('./runtime-state');

let scheduledTask = null;
let manualTriggerInterval = null;
let activeBlastPromise = null;

async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay(minSeconds, maxSeconds) {
    return Math.floor(Math.random() * (maxSeconds - minSeconds + 1) + minSeconds) * 1000;
}

function shuffle(items) {
    const list = [...items];

    for (let index = list.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
    }

    return list;
}

function sortByLeastRecentlyMessaged(contacts) {
    return [...contacts].sort((left, right) => {
        if (!left.last_sent_at && right.last_sent_at) {
            return -1;
        }

        if (left.last_sent_at && !right.last_sent_at) {
            return 1;
        }

        const leftTime = left.last_sent_at ? new Date(left.last_sent_at).getTime() : 0;
        const rightTime = right.last_sent_at ? new Date(right.last_sent_at).getTime() : 0;
        return leftTime - rightTime;
    });
}

function calculateCountToSend(totalContacts) {
    if (totalContacts <= 0) {
        return 0;
    }

    const target = Math.floor(
        Math.random() * (appConfig.maxMessages - appConfig.minMessages + 1)
    ) + appConfig.minMessages;

    return Math.min(totalContacts, target);
}

function selectContactsForBlast(contacts, countToSend) {
    const prioritizedContacts = sortByLeastRecentlyMessaged(contacts);
    const shortlistSize = Math.min(prioritizedContacts.length, Math.max(countToSend, countToSend * 2));
    return shuffle(prioritizedContacts.slice(0, shortlistSize)).slice(0, countToSend);
}

function createBlastInProgressError() {
    const error = new Error('A blast is already running. Wait for it to finish before starting another one.');
    error.code = 'BLAST_ALREADY_RUNNING';
    return error;
}

async function runBlast(trigger = 'manual') {
    let countToSend = 0;
    let successCount = 0;
    let blastStarted = false;

    console.log(`Starting ${trigger} message blast...`);
    markSchedulerTrigger(trigger);

    try {
        const contacts = await getActiveContacts();
        countToSend = calculateCountToSend(contacts.length);

        startBlast(countToSend, trigger);
        blastStarted = true;

        if (countToSend === 0) {
            const note = 'Blast skipped because there are no active contacts to message.';
            console.log(note);
            finishBlast({
                targetedContacts: 0,
                successCount: 0,
                failureCount: 0,
                note
            });

            return {
                targetedContacts: 0,
                successCount: 0,
                failureCount: 0,
                note
            };
        }

        const baseMessage = await getMessageTemplate();
        const contactsToSend = selectContactsForBlast(contacts, countToSend);

        console.log(`Sending messages to ${contactsToSend.length} contacts today.`);

        for (let index = 0; index < contactsToSend.length; index += 1) {
            const contact = contactsToSend[index];
            const message = renderMessageTemplate(baseMessage, contact);
            const success = await sendMessage(contact.phone, message);

            if (success) {
                successCount += 1;
            }

            if (index < contactsToSend.length - 1 && appConfig.maxDelaySeconds > 0) {
                const delay = getRandomDelay(appConfig.minDelaySeconds, appConfig.maxDelaySeconds);
                console.log(`Waiting ${delay / 1000} seconds before next message...`);
                await wait(delay);
            }
        }

        const failureCount = Math.max(countToSend - successCount, 0);
        const note = `Blast completed with ${successCount} sent and ${failureCount} failed.`;

        console.log(`Blast completed. Successfully sent ${successCount}/${countToSend} messages.`);
        finishBlast({
            targetedContacts: countToSend,
            successCount,
            failureCount,
            note
        });

        return {
            targetedContacts: countToSend,
            successCount,
            failureCount,
            note
        };
    } catch (error) {
        if (blastStarted) {
            const failureCount = Math.max(countToSend - successCount, 0);
            finishBlast({
                targetedContacts: countToSend,
                successCount,
                failureCount,
                note: `Blast aborted: ${error.message}`
            });
        }

        throw error;
    }
}

async function runDailyBlast(trigger = 'manual') {
    if (activeBlastPromise) {
        throw createBlastInProgressError();
    }

    activeBlastPromise = runBlast(trigger);

    try {
        return await activeBlastPromise;
    } finally {
        activeBlastPromise = null;
    }
}

function isBlastRunning() {
    return Boolean(activeBlastPromise);
}

async function pollManualBlastTrigger() {
    try {
        const triggerValue = await getAppSetting('manual_blast_trigger', 'false');

        if (String(triggerValue).toLowerCase() !== 'true') {
            return;
        }

        if (isBlastRunning()) {
            await upsertAppSetting('manual_blast_trigger', 'false');
            pushEvent('scheduler', 'Manual blast trigger ignored because another blast is still running.', 'warn');
            return;
        }

        console.log('Manual blast trigger detected.');
        pushEvent('scheduler', 'Manual blast trigger detected.');
        await upsertAppSetting('manual_blast_trigger', 'false');
        await runDailyBlast('manual');
    } catch (error) {
        recordRuntimeError('scheduler', error);
    }
}

function setupScheduler() {
    if (scheduledTask || manualTriggerInterval) {
        return;
    }

    const [hour, minute] = appConfig.sendTime.split(':');
    const cronSchedule = `${minute} ${hour} * * *`;

    console.log(`Scheduler set for ${appConfig.sendTime} daily (Cron: ${cronSchedule})`);
    setSchedulerState(appConfig.sendTime, cronSchedule);

    scheduledTask = cron.schedule(cronSchedule, () => {
        runDailyBlast('scheduled').catch((error) => {
            if (error.code === 'BLAST_ALREADY_RUNNING') {
                pushEvent('scheduler', 'Scheduled blast skipped because another blast is already running.', 'warn');
                return;
            }

            recordRuntimeError('blast', error);
            console.error('Error in daily blast:', error);
        });
    });

    manualTriggerInterval = setInterval(pollManualBlastTrigger, appConfig.manualTriggerPollMs);
}

function stopScheduler() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
    }

    if (manualTriggerInterval) {
        clearInterval(manualTriggerInterval);
        manualTriggerInterval = null;
    }
}

module.exports = {
    isBlastRunning,
    runDailyBlast,
    setupScheduler,
    stopScheduler
};
