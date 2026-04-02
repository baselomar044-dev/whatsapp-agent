const https = require('https');
const TOKEN = 'cb1fab3f-27ba-47fc-9383-d22f80cd8b68';
const PROJECT_ID = 'e625767b-5b69-4590-a696-017e322405d0';
const SERVICE_ID = '154a3f20-b014-47cc-a478-0a61aea16dc1';
const ENV_ID = 'b7c29e2a-87b4-40c8-892e-79b93e2f8192';

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
  // Create persistent volume at /app/data
  console.log('Creating volume...');
  const vol = await gql(`mutation {
    volumeCreate(input: {
      projectId: "${PROJECT_ID}",
      serviceId: "${SERVICE_ID}",
      environmentId: "${ENV_ID}",
      mountPath: "/app/data"
    }) {
      id
      name
      createdAt
    }
  }`);
  console.log(JSON.stringify(vol, null, 2));

  if (vol.data && vol.data.volumeCreate) {
    console.log('Volume created! ID:', vol.data.volumeCreate.id);
    
    // Trigger redeploy to mount the volume
    console.log('Triggering redeploy...');
    const rd = await gql(`mutation { serviceInstanceRedeploy(environmentId: "${ENV_ID}", serviceId: "${SERVICE_ID}") }`);
    console.log('Redeploy:', JSON.stringify(rd));
  }
})();
