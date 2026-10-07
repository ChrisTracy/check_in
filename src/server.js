import { config } from './config.js';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Accounts } from './auth/accounts.js';
import { EntraOidc } from './auth/oidc.js';
import { loadAppSecret } from './auth/security.js';
import { buildApp } from './app.js';

const db = openDb(config.dbPath);
const store = new Store(db, {
  historyLimit: config.historyLimit,
  maxBatch: config.maxBatch,
  maxFields: config.maxFieldsPerRecord,
});
const accounts = new Accounts(db, {
  secret: loadAppSecret(config.appSecret, config.dbPath),
  sessionTtlHours: config.sessionTtlHours,
});

// First-run bootstrap from environment variables.
if (config.apiKey && !accounts.apiKeyInfo().set) accounts.setApiKey(config.apiKey, 'environment');
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
  console.log(`  History limit: ${config.historyLimit < 0 ? 'unlimited' : config.historyLimit} per record`);
  console.log(`  Users:         ${accounts.count() || 'none yet: open the dashboard to create the first admin'}`);
  console.log(`  API key:       ${accounts.apiKeyInfo().set ? 'set (required for anonymous check-ins)' : 'not set (check-ins are open)'}`);
  console.log(`  Entra SSO:     ${accounts.ssoReady() ? 'enabled' : 'off'}`);
  if (config.tlsDisable) console.log('  HTTPS:         disabled by TLS_DISABLE');
  else if (t.listening) console.log(`  HTTPS:         https://localhost:${t.listeningPort}/ (${t.mode === 'redirect' ? 'HTTP redirects to HTTPS' : 'HTTP also served'})${t.cert?.daysLeft < 30 ? `  ⚠ certificate expires in ${t.cert.daysLeft} days` : ''}`);
  else console.log(`  HTTPS:         ${t.error ? 'error: ' + t.error : 'off (turn on in Admin → HTTPS)'}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
