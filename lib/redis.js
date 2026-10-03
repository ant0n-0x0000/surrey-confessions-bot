import Redis from 'ioredis';

const CONNECT_TIMEOUT_MS = 7000;
const MAX_CONNECTION_RETRIES = 1;

let redisClient;
let redisUrlUsed;

function createRedisClient(redisUrl) {
  const redis = new Redis(
    redisUrl,
    {
      // Let ioredis manage the connection lifecycle. This is more
      // reliable in Vercel's reused serverless runtime than explicitly
      // calling connect()/disconnect() for every request.
      connectTimeout: CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_CONNECTION_RETRIES,
      retryStrategy: (times) => {
        if (times > MAX_CONNECTION_RETRIES) {
          return null;
        }

        return 250;
      },
    }
  );

  redis.on('connect', () => {
    console.log('[ioredis] Redis connection established.');
  });

  redis.on('ready', () => {
    console.log('[ioredis] Redis client ready.');
  });

  redis.on('close', () => {
    console.warn('[ioredis] Redis connection closed.');
  });

  redis.on('error', (error) => {
    console.error(
      '[ioredis] Redis connection error:',
      error.message
    );
  });

  return redis;
}

/*
 * Returns a reusable Redis client.
 *
 * We deliberately do not call redis.connect() here. ioredis starts the
 * connection itself and each Redis command waits for the connection to be
 * ready. This avoids the explicit connect/disconnect lifecycle that was
 * causing the moderation request to fail on Vercel.
 */
export async function createRedis() {
  const redisUrl =
    process.env.REDIS_URL?.trim();

  if (!redisUrl) {
    throw new Error(
      'REDIS_URL is not configured.'
    );
  }

  if (
    !redisClient ||
    redisUrlUsed !== redisUrl ||
    redisClient.status === 'end'
  ) {
    redisClient = createRedisClient(
      redisUrl
    );

    redisUrlUsed = redisUrl;
  }

  return redisClient;
}

/*
 * Kept for compatibility with the existing route files.
 *
 * Do not disconnect the shared client after each request: Vercel may reuse
 * the same function instance, and keeping the connection alive avoids a new
 * TCP/TLS connection for every Discord interaction or webhook.
 */
export function closeRedis() {
  // Intentionally left blank.
}
