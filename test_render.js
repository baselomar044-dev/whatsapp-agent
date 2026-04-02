const { execSync } = require('node:child_process');

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function resolveRepoUrl() {
  const configured = String(process.env.REPO_URL || '').trim();

  if (configured) {
    return configured.replace(/\.git$/, '');
  }

  const origin = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();

  if (origin.startsWith('git@github.com:')) {
    return `https://github.com/${origin.slice('git@github.com:'.length).replace(/\.git$/, '')}`;
  }

  return origin.replace(/\.git$/, '');
}

async function test() {
  const payload = {
    type: 'web_service',
    name: process.env.RENDER_SERVICE_NAME || 'whatsapp-agent',
    ownerId: requiredEnv('RENDER_OWNER_ID'),
    repo: resolveRepoUrl(),
    branch: process.env.RENDER_BRANCH || 'master',
    autoDeploy: 'yes',
    rootDir: '',
    serviceDetails: {
      env: 'docker',
      dockerfilePath: './Dockerfile',
      dockerContext: '.',
      plan: process.env.RENDER_PLAN || 'starter',
      region: process.env.RENDER_REGION || 'oregon',
      disk: {
        name: 'session-disk',
        mountPath: '/app/data',
        sizeGB: 1
      }
    },
    envVars: [
      { key: 'PORT', value: '3000' },
      { key: 'DASHBOARD_HOST', value: '0.0.0.0' },
      { key: 'DASHBOARD_PORT', value: '3000' },
      { key: 'WHATSAPP_SESSION_PATH', value: '/app/data/session' },
      { key: 'MANAGER_STORAGE_PATH', value: '/app/data/storage' },
      { key: 'SUPABASE_URL', value: requiredEnv('SUPABASE_URL') },
      { key: 'SUPABASE_KEY', value: requiredEnv('SUPABASE_KEY') },
      { key: 'GEMINI_API_KEY', value: requiredEnv('GEMINI_API_KEY') },
      { key: 'DASHBOARD_PASSWORD', value: requiredEnv('DASHBOARD_PASSWORD') },
      { key: 'SEND_TIME', value: process.env.SEND_TIME || '09:00' },
      { key: 'MIN_MESSAGES', value: process.env.MIN_MESSAGES || '30' },
      { key: 'MAX_MESSAGES', value: process.env.MAX_MESSAGES || '40' }
    ]
  };

  const res = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requiredEnv('RENDER_API_KEY')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  console.log(JSON.stringify(await res.json(), null, 2));
}

test().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
