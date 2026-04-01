const REFRESH_MS=8000,fmt=new Intl.DateTimeFormat([],{dateStyle:"medium",timeStyle:"short"});let startingBlast=false;
const $=id=>document.getElementById(id);
const esc=v=>String(v||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const cls=v=>String(v||"unknown").toLowerCase().replace(/\s+/g,"_");
const when=v=>{if(!v)return"Not available";const d=new Date(v);return Number.isNaN(d.getTime())?"Not available":fmt.format(d)};
const ago=v=>{if(!v)return"Never";const d=new Date(v),diff=Math.max(0,Math.floor((Date.now()-d.getTime())/1000));if(Number.isNaN(diff))return"Unknown";for(const u of[[86400,"d"],[3600,"h"],[60,"m"],[1,"s"]])if(diff>=u[0])return Math.floor(diff/u[0])+u[1]+" ago";return"Just now"};
const uptime=s=>{const t=Number(s||0),d=Math.floor(t/86400),h=Math.floor((t%86400)/3600),m=Math.floor((t%3600)/60),sec=t%60;return d>0?`${d}d ${h}h`:h>0?`${h}h ${m}m`:m>0?`${m}m ${sec}s`:`${sec}s`};
function unskeleton(){document.querySelectorAll(".skeleton").forEach(n=>n.classList.remove("skeleton"))}
function pill(node,label,status){node.className=`pill ${cls(status)}`;node.textContent=label}
function action(message,status){pill($("hero-action"),message,status||"healthy")}
function item(source,message,time,extra=""){return `<article class="item"><div class="row"><span class="source">${esc(source)}</span><span class="time" title="${esc(when(time))}">${esc(ago(time))}</span></div><div>${esc(message)}</div>${extra}</article>`}
function logRow(log){const extra=`<div class="meta"><span>Phone: <span class="code">${esc(log.phone||"-")}</span></span><span>Sent at: ${esc(when(log.sent_at))}</span></div>`;return item(log.status||"unknown",log.message_content||"No message content stored for this row.",log.sent_at,extra)}
function issuesMarkup(issues){return issues.length?issues.map(issue=>`<div class="issue">${esc(issue)}</div>`).join(""):`<div class="empty">No active health warnings. The bot is in a clean state right now.</div>`}
function eventsMarkup(events){return events.length?events.map(event=>item(event.source,event.message,event.timestamp)).join(""):`<div class="empty">No runtime events have been captured yet.</div>`}
function logsMarkup(logs){return logs.length?logs.map(logRow).join(""):`<div class="empty">No recent message logs were returned from Supabase.</div>`}
function blastButtonState(waStatus,blastStatus){if(startingBlast)return[true,"Starting..."];if(blastStatus==="running")return[true,"Blast Running"];if(!["ready","authenticated"].includes(waStatus))return[true,"WhatsApp Not Ready"];return[false,"Run Blast Now"]}

function render(data){
    unskeleton();
    const runtime=data.runtime||{},wa=runtime.whatsapp||{},scheduler=runtime.scheduler||{},blast=runtime.blast||{},manager=runtime.manager||{},contacts=(data.stats||{}).contacts||{},logsToday=(data.stats||{}).logsToday||{},dash=data.dashboard||{},health=data.health||{},preview=data.messagePreview||{},attachments=((data.attachments||{}).stats)||{},issues=health.issues||[];
    pill($("hero-whatsapp"),wa.status||"unknown",wa.status||"unknown");
    pill($("hero-health"),health.status||"warning",health.status||"warning");
    pill($("whatsapp-pill"),wa.status||"unknown",wa.status||"unknown");
    pill($("blast-pill"),blast.status||"idle",blast.status||"idle");
    pill($("manager-pill"),manager.status||"disabled",manager.status||"disabled");
    pill($("health-pill"),health.status||"warning",health.status||"warning");
    pill($("scheduler-pill"),scheduler.cronSchedule?"Scheduled":"Not configured",scheduler.cronSchedule?"ready":"warning");
    $("hero-refresh").textContent=`Updated ${ago(data.generatedAt)}`;$("hero-url").textContent=dash.url||"Local dashboard";$("hero-app").textContent=`App: ${runtime.appStatus||"unknown"}`;
    $("whatsapp-status").textContent=(wa.status||"unknown").replace(/_/g," ");
    $("whatsapp-detail").textContent=wa.lastError?wa.lastError:wa.readyAt?`Ready since ${when(wa.readyAt)}`:wa.qrUpdatedAt?`QR refreshed ${ago(wa.qrUpdatedAt)}`:"Waiting for WhatsApp client events";
    $("whatsapp-foot").textContent=wa.lastDisconnectReason?`Last disconnect reason: ${wa.lastDisconnectReason}`:`Authenticated: ${when(wa.authenticatedAt)}`;
    $("contacts-active").textContent=String(contacts.active||0);$("contacts-foot").textContent=`${contacts.total||0} total contacts, ${contacts.inactive||0} inactive`;
    $("logs-total").textContent=String(logsToday.total||0);$("logs-foot").textContent=`${logsToday.sent||0} sent, ${logsToday.failed||0} failed, ${logsToday.other||0} other`;
    $("blast-progress").textContent=`${blast.processedContacts||0} / ${blast.targetedContacts||0}`;$("blast-detail").textContent=blast.startedAt?`Trigger: ${blast.trigger||"manual"} | Started ${when(blast.startedAt)}`:"No blast activity yet";$("blast-foot").textContent=blast.note||`Success ${blast.successCount||0}, failed ${blast.failureCount||0}, last message ${ago(blast.lastMessageAt)}`;
    $("manager-status").textContent=(manager.status||"disabled").replace(/_/g," ");$("manager-detail").textContent=manager.note||"Manager agent is idle.";$("manager-foot").textContent=`Provider: ${manager.provider||"Gemini"} | AI configured: ${manager.aiConfigured?"yes":"no"} | Attachments saved: ${attachments.total||0} | Last reply: ${ago(manager.lastReplyAt)}`;
    $("health-status").textContent=(health.status||"warning").replace(/_/g," ");$("health-detail").textContent=issues[0]||"All core services look healthy.";$("health-foot").textContent=issues.length?`${issues.length} issue(s) detected.`:"No health issues detected.";
    $("controls-state").textContent=blast.status==="running"?"Blast in progress":"Ready";
    if(!startingBlast)action(blast.status==="running"?"Blast is currently running":issues.length?"Attention needed":"System healthy",blast.status==="running"?"running":health.status||"healthy");
    $("template-source").textContent=`Sample: ${((preview.variables||{}).name)||"Contact"}`;$("template-raw").textContent=preview.template||"Template unavailable";$("template-rendered").textContent=preview.rendered||"Preview unavailable";$("template-variables").textContent=`Variables: name=${((preview.variables||{}).name)||"-"}, firstName=${((preview.variables||{}).firstName)||"-"}, phone=${((preview.variables||{}).phone)||"-"}`;
    $("scheduler-send-time").textContent=dash.sendTime||"--:--";$("scheduler-cron").textContent=scheduler.cronSchedule||"Not configured";$("scheduler-next-run").textContent=when(scheduler.nextRunAt);$("scheduler-last-run").textContent=when(scheduler.lastRunAt);
    $("config-timezone").textContent=dash.timezone||"-";$("config-range").textContent=`${dash.minMessages||0} to ${dash.maxMessages||0} contacts`;$("config-delay").textContent=`${dash.minDelaySeconds||0} to ${dash.maxDelaySeconds||0} seconds`;$("config-browser").textContent=dash.browser||"-";$("config-session").textContent=dash.sessionPath||"-";$("config-uptime").textContent=uptime(runtime.uptimeSeconds||0);$("logs-refresh").textContent=`Auto-refresh every ${Math.round(REFRESH_MS/1000)}s`;
    if(wa.qrUrl){$("qr-slot").className="qr";$("qr-slot").innerHTML=`<img src="${esc(wa.qrUrl)}" alt="WhatsApp QR code" />`;$("qr-title").textContent="Scan this QR";$("qr-detail").textContent="Open WhatsApp on your phone, then scan the code shown here.";$("qr-foot").textContent=`Generated ${when(wa.qrUpdatedAt)}`;}
    else{$("qr-slot").className="empty";$("qr-slot").textContent="If the session expires, the login QR will appear here automatically.";$("qr-title").textContent="Session connected";$("qr-detail").textContent="The dashboard will switch to scan mode whenever WhatsApp requests a new QR.";$("qr-foot").textContent=wa.readyAt?`Client ready since ${when(wa.readyAt)}`:"No QR currently required.";}
    $("issues-count").textContent=`${issues.length} issue${issues.length===1?"":"s"}`;$("issues").innerHTML=issuesMarkup(issues);$("events").innerHTML=eventsMarkup((runtime.events||[]).slice(0,10));$("recent-logs").innerHTML=logsMarkup(data.recentLogs||[]);
    const errors=data.dataErrors||[],box=$("data-errors");if(errors.length){box.hidden=false;box.innerHTML=`<strong>Partial data warning</strong><br />${errors.map(esc).join("<br />")}`}else{box.hidden=true;box.textContent=""}
    const [disabled,label]=blastButtonState(wa.status,blast.status);$("run-blast").disabled=disabled;$("run-blast").textContent=label;
}

async function refresh(){
    try{const res=await fetch("/api/status",{cache:"no-store"});if(!res.ok)throw new Error(`Request failed with status ${res.status}`);render(await res.json())}
    catch(error){unskeleton();$("hero-refresh").textContent="Refresh error";$("data-errors").hidden=false;$("data-errors").innerHTML=`<strong>Dashboard refresh failed</strong><br />${esc(error.message)}`;action("Refresh failed","error")}
}

async function triggerBlast(){
    if(startingBlast)return;startingBlast=true;action("Starting blast request","warning");$("run-blast").disabled=true;$("run-blast").textContent="Starting...";
    try{const res=await fetch("/api/blast/run",{method:"POST",headers:{"Content-Type":"application/json"}}),payload=await res.json().catch(()=>({}));if(!res.ok)throw new Error(payload.error||`Request failed with status ${res.status}`);action(payload.message||"Manual blast started","healthy")}
    catch(error){action(error.message,"error")}
    finally{startingBlast=false;await refresh()}
}

async function copyUrl(){try{await navigator.clipboard.writeText(window.location.href);action("Dashboard URL copied","healthy")}catch{action("Copy failed","error")}}

$("run-blast").addEventListener("click",triggerBlast);$("refresh-now").addEventListener("click",refresh);$("copy-url").addEventListener("click",copyUrl);refresh();setInterval(refresh,REFRESH_MS);
