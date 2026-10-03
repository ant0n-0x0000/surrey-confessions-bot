import Redis from 'ioredis';

const CONNECT_TIMEOUT_MS = 7000;
const MAX_CONNECTION_RETRIES = 1;

/*
 * Create a Redis client suitable for short-lived Vercel functions.
 *
 * We connect explicitly so connection failures become normal Promise
 * rejections instead of unhandled ioredis error events.
 */
export async function createRedis() {
  const redisUrl =
    process.env.REDIS_URL?.trim();

  if (!redisUrl) {
    throw new Error(
      'REDIS_URL is not configured.'
    );
  }

  const redis =
    new Redis(
      redisUrl,
      {
        lazyConnect: true,
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => {
          if (
            times > MAX_CONNECTION_RETRIES
          ) {
            return null;
          }

          return 250;
        },
      }
    );

  // ioredis emits connection errors through EventEmitter.
  // Always attach a listener so Vercel does not report an
  // "Unhandled error event".
  redis.on(
    'error',
    (error) => {
      console.error(
        '[ioredis] Redis connection error:',
        error.message
      );
    }
  );

  try {
    await redis.connect();

    return redis;
  } catch (error) {
    redis.disconnect();

    throw new Error(
      `Redis connection failed: ${error.message}`
    );
  }
}

export function closeRedis(redis) {
  if (redis) {
    redis.disconnect();
  }
}
