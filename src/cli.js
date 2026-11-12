import { OAuthTokenManager, requiredEnv } from './auth.js';
import { SheerIDClient } from './client.js';

function makeClient() {
  if (process.env.SHEERFLOW_MODE === 'demo') throw new Error('CLI diagnostic commands require SHEERFLOW_MODE=live. Use the dashboard for local demo mode.');
  const programId = requiredEnv(process.env, 'SHEERID_PROGRAM_ID');
  const tokenManager = new OAuthTokenManager({
    clientId: requiredEnv(process.env, 'SHEERID_CLIENT_ID'),
    clientSecret: requiredEnv(process.env, 'SHEERID_CLIENT_SECRET'),
  });
  return { client:new SheerIDClient({ tokenManager }), programId };
}

async function main(argv) {
  const [command, ...args] = argv;
  const { client, programId } = makeClient();
  if (command === 'doctor') {
    const theme = await client.getProgramTheme(programId);
    const organizationSearch = typeof theme?.config?.orgSearchUrl === 'string';
    process.stdout.write(JSON.stringify({
      status:'ok', oauth:'authenticated', programId:`${programId.slice(0,4)}…${programId.slice(-4)}`,
      programTheme:'available', organizationSearch:organizationSearch ? 'available' : 'not-configured',
    }, null, 2) + '\n');
    return;
  }
  if (command === 'status') {
    const id = args[0];
    if (!/^[a-f\d]{24}$/i.test(id || '')) throw new Error('Usage: npm run status -- <24-character-verification-id>');
    const result = await client.getStatus(id);
    process.stdout.write(JSON.stringify({ verificationId:result.verificationId, currentStep:result.currentStep, errorIds:result.errorIds || [] }, null, 2) + '\n');
    return;
  }
  if (command === 'organizations') {
    const query = args.join(' ').trim();
    if (query.length < 2) throw new Error('Usage: npm run organizations -- "organization name"');
    const results = await client.searchOrganizations(programId, query);
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }
  throw new Error('Commands: doctor, status <verification-id>, organizations <query>');
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code || 'CLI_ERROR'}: ${error.message}\n`);
  process.exitCode = 1;
});
