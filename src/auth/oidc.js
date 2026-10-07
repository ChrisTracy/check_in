import * as oidc from 'openid-client';
import { sha256 } from './security.js';

/**
 * Microsoft Entra ID (OIDC) sign-in using the authorization code flow with PKCE.
 * Discovery results are cached until the SSO settings change.
 */
export class EntraOidc {
  constructor(accounts, { issuerOverride = '', allowInsecure = false } = {}) {
    this.accounts = accounts;
    this.issuerOverride = issuerOverride;
    this.allowInsecure = allowInsecure;
    this.cache = null; // { key, config, at }
  }

  issuer(tenantId) {
    return this.issuerOverride || `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0`;
  }

  async config() {
    const s = this.accounts.sso();
    const secret = this.accounts.ssoSecret();
    const key = sha256([s.tenantId, s.clientId, secret, this.issuerOverride].join('|'));
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < 6 * 3600_000) return this.cache.config;
    const opts = this.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined;
    const config = await oidc.discovery(new URL(this.issuer(s.tenantId)), s.clientId, undefined, oidc.ClientSecretPost(secret), opts);
    this.cache = { key, config, at: Date.now() };
    return config;
  }

  async authorizationUrl(redirectUri) {
    const config = await this.config();
    const tx = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
    };
    const params = {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      response_mode: 'query',
      code_challenge: await oidc.calculatePKCECodeChallenge(tx.verifier),
      code_challenge_method: 'S256',
      state: tx.state,
      nonce: tx.nonce,
    };
    // Let people pick which Microsoft account to use (Entra only).
    if (!this.issuerOverride) params.prompt = 'select_account';
    const url = oidc.buildAuthorizationUrl(config, params);
    return { url: url.href, tx };
  }

  /** Exchange the code from the callback URL; returns the ID token claims. */
  async callback(currentUrl, tx) {
    const config = await this.config();
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: tx.verifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    return tokens.claims();
  }

  async test() {
    this.cache = null;
    const config = await this.config();
    const m = config.serverMetadata();
    return { issuer: m.issuer, authorizationEndpoint: m.authorization_endpoint, tokenEndpoint: m.token_endpoint };
  }
}
