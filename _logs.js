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
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  // Get latest deploy ID
  const deps = await gql(`{ deployments(input: { serviceId: "${SERVICE_ID}" }, first: 1) { edges { node { id status } } } }`);
  const deployId = deps.data.deployments.edges[0].node.id;
  console.log('Deploy:', deployId, deps.data.deployments.edges[0].node.status);
  
  // Get last 50 deploy logs
  const logs = await gql(`{ deploymentLogs(deploymentId: "${deployId}", limit: 50) { message severity timestamp } }`);
  if (logs.data && logs.data.deploymentLogs) {
    logs.data.deploymentLogs.forEach(l => console.log(`[${l.severity || 'info'}] ${l.message}`));
  } else {
    console.log(JSON.stringify(logs, null, 2));
  }
})();
