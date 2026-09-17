import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordRateLimitError, rateLimitErrorFromResponse } from '../extension/discord/auth.js';

test('uses Discord retry_after values for rate-limit errors', () => {
  const error = rateLimitErrorFromResponse(
    { headers: new Headers({ 'retry-after': '0.25' }) },
    { retry_after: 2.4 },
  );

  assert.ok(error instanceof DiscordRateLimitError);
  assert.equal(error.retryAfterMs, 2_400);
});

test('uses a safe minimum retry delay when Discord omits retry_after', () => {
  const error = rateLimitErrorFromResponse({ headers: new Headers() });
  assert.equal(error.retryAfterMs, 5_000);
});
