import { config } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Accounts } from './auth/accounts.js';
import { EntraOidc } from './auth/oidc.js';
import { loadAppSecret } from './auth/security.js';
import { buildApp } from './app.js';

const db = openDb(config.dbPath);
const accounts = new Accounts(db, {
  secret: loadAppSecret(config.appSecret, config.dbPath),
  sessionTtlHours: config.sessionTtlHours,
});
// A history limit saved in Settings wins over the HISTORY_LIMIT variable.
const savedHistoryLimit = accounts.historyLimit;
const historyLimit = savedHistoryLimit ?? config.historyLimit;
const store = new Store(db, {
  historyLimit,
  maxBatch: config.maxBatch,
  maxFields: config.maxFieldsPerRecord,
});

// First-run bootstrap from environment variables.
for (const note of accounts.bootstrapApiKey({ envKey: config.apiKey, hasRecords: store.summary().records > 0 })) console.log(`API key: ${note}`);
if (config.adminUsername && config.adminPassword && accounts.count() === 0) {
  await accounts.create({ username: config.adminUsername, password: config.adminPassword, name: 'Administrator', role: 'admin' });
  console.log(`Created admin user "${config.adminUsername}" from ADMIN_USERNAME / ADMIN_PASSWORD`);
}

const oidc = new EntraOidc(accounts, { issuerOverride: config.oidcIssuerOverride, allowInsecure: config.oidcAllowInsecure });
const app = buildApp({ config, store, accounts, oidc });

const shutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down…`);
  try {
    store.flush();
    await app.close();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  const t = await app.tls.apply();
  const s = store.summary();
  console.log(`Check-in API listening on http://localhost:${config.port}`);
  console.log(`  Dashboard:     http://localhost:${config.port}/`);
  console.log(`  Database:      ${config.dbPath} (${s.records} records, ${s.history} history rows)`);
  console.log(`  History limit: ${historyLimit < 0 ? 'unlimited' : historyLimit} per record (${savedHistoryLimit === null ? 'HISTORY_LIMIT' : 'set in Settings'})`);
  console.log(`  Users:         ${accounts.count() || 'none yet: open the dashboard to create the first admin'}`);
  console.log(`  API key:       ${accounts.apiKeyRequired ? 'required for check-ins (see Add Device)' : 'not required (check-ins are open to anyone who can reach the server)'}`);
  console.log(`  Entra SSO:     ${accounts.ssoReady() ? 'enabled' : 'off'}`);
  if (config.tlsDisable) console.log('  HTTPS:         disabled by TLS_DISABLE');
  else if (t.listening) console.log(`  HTTPS:         https://localhost:${t.listeningPort}/ (${t.mode === 'redirect' ? 'HTTP redirects to HTTPS' : 'HTTP also served'})${t.cert?.daysLeft < 30 ? `  ⚠ certificate expires in ${t.cert.daysLeft} days` : ''}`);
  else console.log(`  HTTPS:         ${t.error ? 'error: ' + t.error : 'off (turn on in Admin → HTTPS)'}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
