'use strict';

const { config } = require('./config');

class VenueApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VenueApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

function baseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function venueRequest({ apiUrl, platformApiKey, path, method = 'GET', body, authenticated = true, timeoutMs = config.venueTimeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl(apiUrl)}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(authenticated ? { 'X-Platform-Key': platformApiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 240) }; }
    }
    if (!response.ok) {
      const message = data?.error || data?.message || `Venue returned HTTP ${response.status}`;
      throw new VenueApiError(message, { status: response.status, code: 'HTTP_ERROR' });
    }
    return { data, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new VenueApiError(`Timed out after ${timeoutMs / 1000} seconds`, { code: 'TIMEOUT' });
    }
    if (error instanceof VenueApiError) throw error;
    throw new VenueApiError('Could not reach the venue API', { code: 'UNREACHABLE' });
  } finally {
    clearTimeout(timeout);
  }
}

async function snapshotVenue(venue, platformApiKey) {
  if (venue.status === 'offboarded') {
    return {
      state: 'offboarded',
      checkedAt: new Date().toISOString(),
      health: null,
      platform: null,
      error: null,
    };
  }

  const [healthResult, statusResult] = await Promise.allSettled([
    venueRequest({ apiUrl: venue.api_url, platformApiKey, path: '/health', authenticated: false }),
    venueRequest({ apiUrl: venue.api_url, platformApiKey, path: '/api/platform/status' }),
  ]);

  const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
  const platform = statusResult.status === 'fulfilled' ? statusResult.value : null;
  const platformError = statusResult.status === 'rejected' ? statusResult.reason : null;
  const healthError = healthResult.status === 'rejected' ? healthResult.reason : null;

  let state = 'online';
  if (!health && !platform) state = healthError?.code === 'UNREACHABLE' || healthError?.code === 'TIMEOUT' ? 'unreachable' : 'down';
  else if (!platform) state = 'degraded';

  return {
    state,
    checkedAt: new Date().toISOString(),
    health: health ? { latencyMs: health.latencyMs } : null,
    platform: platform ? platform.data : null,
    latencyMs: platform?.latencyMs ?? health?.latencyMs ?? null,
    error: platformError?.message || healthError?.message || null,
    errorCode: platformError?.code || healthError?.code || null,
  };
}

async function getVenueDetail(venue, platformApiKey) {
  const [status, audit] = await Promise.all([
    venueRequest({ apiUrl: venue.api_url, platformApiKey, path: '/api/platform/status' }),
    venueRequest({ apiUrl: venue.api_url, platformApiKey, path: '/api/platform/audit' }),
  ]);
  return {
    status: status.data,
    latencyMs: status.latencyMs,
    audit: Array.isArray(audit.data) ? audit.data : [],
    checkedAt: new Date().toISOString(),
  };
}

async function updateVenueFeatures(venue, platformApiKey, overrides, actor) {
  const result = await venueRequest({
    apiUrl: venue.api_url,
    platformApiKey,
    path: '/api/platform/features',
    method: 'PUT',
    body: { overrides, actor },
  });
  return result.data;
}

module.exports = { VenueApiError, venueRequest, snapshotVenue, getVenueDetail, updateVenueFeatures, baseUrl };

