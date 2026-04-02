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
  // Check volume-related mutations
  const intro = await gql(`{
    __schema {
      mutationType {
        fields {
          name
          args { name type { name kind ofType { name } } }
        }
      }
    }
  }`);
  const muts = intro.data.__schema.mutationType.fields;
  const volMuts = muts.filter(f => f.name.toLowerCase().includes('volume'));
  console.log('Volume mutations:');
  volMuts.forEach(f => {
    console.log(`  ${f.name}(${f.args.map(a => a.name + ':' + (a.type.name || a.type.ofType?.name || a.type.kind)).join(', ')})`);
  });

  // Check VolumeCreateInput
  const volInput = await gql(`{ __type(name: "VolumeCreateInput") { inputFields { name type { name kind ofType { name } } } } }`);
  console.log('\nVolumeCreateInput:', JSON.stringify(volInput.data, null, 2));
})();
