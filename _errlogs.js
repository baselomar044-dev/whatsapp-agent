const https = require('https');
const TOKEN = 'cb1fab3f-27ba-47fc-9383-d22f80cd8b68';
const SERVICE_ID = '154a3f20-b014-47cc-a478-0a61aea16dc1';

function gql(query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });
    const req = https.request({
      hostname: 'backboard.railway.app',
      path: '/graphql/v2',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(body = b))); });
    req.on('error', reject); let body;
    req.end(data);
  });
}

(async () => {
  const deps = await gql(`{ deployments(input: { serviceId: "${SERVICE_ID}" }, first: 1) { edges { node { id } } } }`);
  const deployId = deps.data.deployments.edges[0].node.id;
  
  // Get ALL logs - errors especially
  const logs = await gql(`{ deploymentLogs(deploymentId: "${deployId}", limit: 200) { message severity timestamp } }`);
  if (logs.data && logs.data.deploymentLogs) {
    const errorLogs = logs.data.deploymentLogs.filter(l => l.severity === 'error' || l.message.toLowerCase().includes('error') || l.message.toLowerCase().includes('fail') || l.message.toLowerCase().includes('crash'));
    console.log(`Total logs: ${logs.data.deploymentLogs.length}, Error-related: ${errorLogs.length}`);
    errorLogs.forEach(l => console.log(`[${l.severity}] ${l.message}`));
    
    // Also show the last 20 chronological
    console.log('\n--- LAST 20 LOGS ---');
    logs.data.deploymentLogs.slice(-20).forEach(l => console.log(`[${l.severity || 'info'}] ${l.message}`));
  }
})();
