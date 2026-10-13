const LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const RESPONSE_LIMIT = 1024 * 1024;
const SCOPES = Object.freeze(['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'openid', 'profile', 'offline_access']);
const MESSAGE_FIELDS = 'id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments';
const IMMUTABLE = 'IdType="ImmutableId"';

export class MicrosoftMailError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'MicrosoftMailError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => { throw new MicrosoftMailError(code, message, status); };
const opaque = (value, max = 16384) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\x00-\x1f\x7f]/.test(value);
const safeText = value => typeof value === 'string' ? value : '';
const address = value => ({ emailAddress: { name: safeText(value?.emailAddress?.name), address: safeText(value?.emailAddress?.address) } });

/** Delegated, read-only Microsoft 365 mail. Token exchanges are the only POSTs.
 * Requests never follow redirects, retry automatically, or expose provider errors.
 * Contracts: Microsoft identity v2 authorization-code flow and Graph v1.0 mail.
 */
export function createMicrosoftMailClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  function configuration() {
    const missing = ['MICROSOFT_MAIL_CLIENT_ID', 'MICROSOFT_MAIL_CLIENT_SECRET']
      .filter(key => typeof env[key] !== 'string' || !env[key].trim());
    const issues = [];
    const tenant = env.MICROSOFT_MAIL_TENANT_ID || 'organizations';
    if (typeof tenant !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(tenant) || tenant.includes('..'))
      issues.push('Microsofts organisation måste vara ett tenant-ID eller domännamn.');
    const redirectUri = env.MAIL_REDIRECT_URI || (typeof env.RENDER_EXTERNAL_URL === 'string' && env.RENDER_EXTERNAL_URL
      ? `${env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/integrations/microsoft-mail/callback` : null);
    if (!redirectUri) missing.push('MAIL_REDIRECT_URI');
    else {
      try {
        const url = new URL(redirectUri);
        const local = env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
        if (typeof redirectUri !== 'string' || redirectUri.length > 2048 || (!local && url.protocol !== 'https:') || url.username || url.password || url.hash)
          throw new Error();
      } catch { issues.push('Microsofts returadress måste vara en registrerad HTTPS-adress.'); }
    }
    return { ready: !missing.length && !issues.length, missing, issues, redirectUri, scopes: [...SCOPES] };
  }
  function configured() {
    const config = configuration();
    if (!config.ready) fail('microsoft_mail_not_configured', 'Microsofts e-postkoppling saknar giltiga inställningar.', 409);
    return config;
  }
  const identityPath = endpoint => `${LOGIN_ORIGIN}/${encodeURIComponent(env.MICROSOFT_MAIL_TENANT_ID || 'organizations')}/oauth2/v2.0/${endpoint}`;

  async function transport(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(20000, timeoutMs)));
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      if (response.redirected) fail('microsoft_mail_redirect_forbidden', 'Microsofts svar innehöll en oväntad omdirigering.');
      if (!response.ok) {
        await response.body?.cancel?.();
        if (response.status === 401) fail('microsoft_mail_access_denied', 'Microsofts e-postkoppling behöver godkännas igen.', 401);
        if (response.status === 403) fail('microsoft_mail_access_denied', 'Microsoft gav inte behörighet att läsa denna brevlåda.', 403);
        if (response.status === 404) fail('microsoft_mail_not_found', 'Brevlådan eller meddelandet kunde inte hittas hos Microsoft.', 404);
        if (response.status === 429) fail('microsoft_mail_rate_limited', 'Microsoft begränsar hämtningen. Försök igen senare.', 503);
        fail('microsoft_mail_request_rejected', 'Microsoft kunde inte godkänna e-postanropet.', 502);
      }
      const declaredSize = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > RESPONSE_LIMIT) {
        await response.body?.cancel?.();
        fail('microsoft_mail_response_too_large', 'Microsofts e-postsvar var för stort.');
      }
      let content = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > RESPONSE_LIMIT) {
              await reader.cancel();
              fail('microsoft_mail_response_too_large', 'Microsofts e-postsvar var för stort.');
            }
            content += decoder.decode(part.value, { stream: true });
          }
          content += decoder.decode();
        } finally { reader.releaseLock(); }
      } else {
        content = await response.text();
        if (Buffer.byteLength(content) > RESPONSE_LIMIT) fail('microsoft_mail_response_too_large', 'Microsofts e-postsvar var för stort.');
      }
      let data;
      try { data = JSON.parse(content); } catch { fail('microsoft_mail_response_invalid', 'Microsofts e-postsvar kunde inte verifieras.'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('microsoft_mail_response_invalid', 'Microsofts e-postsvar kunde inte verifieras.');
      return data;
    } catch (error) {
      if (error instanceof MicrosoftMailError) throw error;
      if (controller.signal.aborted) fail('microsoft_mail_timeout', 'Microsofts e-postanrop tog för lång tid.', 504);
      fail('microsoft_mail_unavailable', 'Microsofts e-posttjänst kunde inte nås.', 502);
    } finally { clearTimeout(timer); }
  }
  async function tokens(body, originalRefreshToken) {
    const data = await transport(identityPath('token'), { method: 'POST', headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'
    }, body });
    const refreshToken = data.refresh_token ?? originalRefreshToken;
    const lifetime = Number(data.expires_in);
    if (!opaque(data.access_token) || !opaque(refreshToken) || String(data.token_type).toLowerCase() !== 'bearer'
      || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86400)
      fail('microsoft_mail_token_invalid', 'Microsoft lämnade inga verifierade inloggningsuppgifter.');
    // Microsoft may return this benign OpenID profile claim along with the
    // requested read scopes. It is accepted in responses only, never requested.
    const knownScopes = new Map([...SCOPES,'email'].map(scope => [scope.toLowerCase(), scope]));
    const hasScope=Object.hasOwn(data,'scope');
    if(hasScope&&typeof data.scope!=='string')fail('microsoft_mail_scope_invalid','Microsoft lämnade oväntade e-postbehörigheter.');
    const granted = hasScope ? data.scope.trim().split(/\s+/).filter(Boolean) : [];
    const scopes = [...new Set(granted.map(scope => {
      try { scope = decodeURIComponent(scope); } catch { return undefined; }
      return knownScopes.get(scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase());
    }))];
    if (hasScope&&!scopes.length || scopes.includes(undefined)) fail('microsoft_mail_scope_invalid', 'Microsoft lämnade oväntade e-postbehörigheter.');
    return { accessToken: data.access_token, refreshToken, expiresAt: Number(now()) + lifetime * 1000, scopes };
  }
  function mailboxPath(mailbox = 'me', inbox = false) {
    const collection = inbox ? '/mailFolders/inbox/messages' : '/messages';
    if (mailbox === 'me') return `/v1.0/me${collection}`;
    if (typeof mailbox !== 'string' || mailbox.length > 254 || !/^[^\s@/\\?#%]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(mailbox))
      fail('microsoft_mail_mailbox_invalid', 'Ange en giltig Microsoft-brevlåda.', 422);
    return `/v1.0/users/${encodeURIComponent(mailbox)}${collection}`;
  }
  function graphHeaders(accessToken, textBody = false) {
    if (!opaque(accessToken)) fail('microsoft_mail_token_missing', 'Microsofts e-postkoppling behöver godkännas igen.', 401);
    return { Accept: 'application/json', Authorization: `Bearer ${accessToken}`,
      Prefer: textBody ? `${IMMUTABLE}, outlook.body-content-type="text"` : IMMUTABLE };
  }
  function pagingUrl(link, path) {
    let url;
    try { url = new URL(link); } catch { fail('microsoft_mail_paging_invalid', 'Microsofts fortsättningslänk kunde inte verifieras.'); }
    if (typeof link !== 'string' || link.length > 16384 || url.origin !== GRAPH_ORIGIN || url.pathname !== path || url.username || url.password || url.hash)
      fail('microsoft_mail_paging_invalid', 'Microsofts fortsättningslänk kunde inte verifieras.');
    return url.toString();
  }
  const messageSummary = item => {
    if (!item || !opaque(item.id, 4096)) fail('microsoft_mail_response_invalid', 'Microsofts meddelande kunde inte verifieras.');
    return { id: item.id, subject: safeText(item.subject), from: address(item.from), receivedDateTime: safeText(item.receivedDateTime),
      isRead: item.isRead === true, bodyPreview: safeText(item.bodyPreview), hasAttachments: item.hasAttachments === true };
  };

  return {
    configuration,
    authorisationUrl({ state, challenge, loginHint } = {}) {
      const config = configured();
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(state ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? '')
        || loginHint !== undefined && (typeof loginHint !== 'string' || loginHint.length > 254 || /[\r\n\x00]/.test(loginHint)))
        fail('microsoft_mail_authorisation_invalid', 'Microsofts inloggningssession kunde inte verifieras.', 422);
      const url = new URL(identityPath('authorize'));
      for (const [key, value] of Object.entries({ client_id: env.MICROSOFT_MAIL_CLIENT_ID, response_type: 'code', response_mode: 'query',
        redirect_uri: config.redirectUri, scope: config.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
        ...(loginHint ? { login_hint: loginHint } : {}) })) url.searchParams.set(key, value);
      return url.toString();
    },
    async exchangeCode({ code, verifier } = {}) {
      const config = configured();
      if (!opaque(code, 8192) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier ?? ''))
        fail('microsoft_mail_authorisation_invalid', 'Microsofts returuppgifter kunde inte verifieras.', 422);
      return tokens(new URLSearchParams({ client_id: env.MICROSOFT_MAIL_CLIENT_ID, client_secret: env.MICROSOFT_MAIL_CLIENT_SECRET,
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri, scope: config.scopes.join(' ') }));
    },
    async refreshToken({ refreshToken } = {}) {
      const config = configured();
      if (!opaque(refreshToken)) fail('microsoft_mail_token_missing', 'Microsofts e-postkoppling behöver godkännas igen.', 401);
      return tokens(new URLSearchParams({ client_id: env.MICROSOFT_MAIL_CLIENT_ID, client_secret: env.MICROSOFT_MAIL_CLIENT_SECRET,
        grant_type: 'refresh_token', refresh_token: refreshToken, scope: config.scopes.join(' ') }), refreshToken);
    },
    async me(accessToken) {
      const url = new URL('/v1.0/me', GRAPH_ORIGIN);
      url.searchParams.set('$select', 'id,displayName,mail,userPrincipalName');
      const data = await transport(url.toString(), { method: 'GET', headers: graphHeaders(accessToken) });
      if (!opaque(data.id, 4096)) fail('microsoft_mail_response_invalid', 'Microsofts användare kunde inte verifieras.');
      return { id: data.id, displayName: safeText(data.displayName), mail: typeof data.mail === 'string' ? data.mail : null,
        userPrincipalName: safeText(data.userPrincipalName) };
    },
    async listMessages({ accessToken, mailbox = 'me', maxCount = 50 } = {}) {
      if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 50) fail('microsoft_mail_count_invalid', 'Hämta mellan 1 och 50 meddelanden.', 422);
      const path = mailboxPath(mailbox, true), headers = graphHeaders(accessToken), first = new URL(path, GRAPH_ORIGIN);
      first.searchParams.set('$top', String(maxCount));
      first.searchParams.set('$select', MESSAGE_FIELDS);
      first.searchParams.set('$orderby', 'receivedDateTime desc');
      let next = first.toString(), hasMore = false;
      const messages = [], visited = new Set();
      for (let page = 0; page < 3 && next && messages.length < maxCount; page++) {
        if (visited.has(next)) fail('microsoft_mail_paging_invalid', 'Microsofts fortsättningslänk kunde inte verifieras.');
        visited.add(next);
        const data = await transport(next, { method: 'GET', headers });
        if (!Array.isArray(data.value)) fail('microsoft_mail_response_invalid', 'Microsofts meddelandelista kunde inte verifieras.');
        const remaining = maxCount - messages.length;
        messages.push(...data.value.slice(0, remaining).map(messageSummary));
        next = data['@odata.nextLink'] === undefined || data['@odata.nextLink'] === null ? null : pagingUrl(data['@odata.nextLink'], path);
        if (next && visited.has(next)) fail('microsoft_mail_paging_invalid', 'Microsofts fortsättningslänk kunde inte verifieras.');
        hasMore = Boolean(next) || data.value.length > remaining;
      }
      return { messages, hasMore };
    },
    async getMessage({ accessToken, mailbox = 'me', messageId } = {}) {
      const path = mailboxPath(mailbox);
      if (!opaque(messageId, 4096) || ['.', '..'].includes(messageId)) fail('microsoft_mail_message_invalid', 'Meddelandets ID är ogiltigt.', 422);
      const url = new URL(`${path}/${encodeURIComponent(messageId)}`, GRAPH_ORIGIN);
      url.searchParams.set('$select', `${MESSAGE_FIELDS},body,toRecipients,ccRecipients,webLink`);
      const data = await transport(url.toString(), { method: 'GET', headers: graphHeaders(accessToken, true) });
      const summary = messageSummary(data);
      if (summary.id !== messageId) fail('microsoft_mail_response_invalid', 'Microsofts meddelande matchade inte det begärda ID:t.');
      if (typeof data.body?.content !== 'string' || String(data.body.contentType).toLowerCase() !== 'text')
        fail('microsoft_mail_body_invalid', 'Microsofts meddelande kunde inte hämtas som vanlig text.');
      const attachmentUrl = new URL(`${path}/${encodeURIComponent(messageId)}/attachments`, GRAPH_ORIGIN);
      attachmentUrl.searchParams.set('$select', 'id,name,size,contentType');
      const metadata = await transport(attachmentUrl.toString(), { method: 'GET', headers: graphHeaders(accessToken) });
      if (!Array.isArray(metadata.value)) fail('microsoft_mail_response_invalid', 'Microsofts bilageinformation kunde inte verifieras.');
      // Metadata pagination is not followed during opening. No content bytes
      // are selected, returned, or fetched through attachment download paths.
      const moreAttachments = metadata['@odata.nextLink'] === undefined || metadata['@odata.nextLink'] === null
        ? null : pagingUrl(metadata['@odata.nextLink'], attachmentUrl.pathname);
      return { ...summary, body: { contentType: 'text', content: data.body.content },
        toRecipients: Array.isArray(data.toRecipients) ? data.toRecipients.map(address) : [],
        ccRecipients: Array.isArray(data.ccRecipients) ? data.ccRecipients.map(address) : [], webLink: safeText(data.webLink),
        attachments: metadata.value.slice(0,50).map(item => ({ id: safeText(item.id), name: safeText(item.name),
          size: Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : 0, contentType: safeText(item.contentType) })),
        attachmentsHasMore: Boolean(moreAttachments) || metadata.value.length > 50 };
    }
  };
}
