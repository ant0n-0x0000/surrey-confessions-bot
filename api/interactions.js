import { createRedis, closeRedis } from '../lib/redis.js';
import { verifyKey } from 'discord-interactions';
import getRawBody from 'raw-body';
import { createHash, randomUUID } from 'node:crypto';
import { publishInstagramPosts } from '../lib/instagram.js';
import { waitUntil } from '@vercel/functions';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Instagram publishing can involve several container-status checks.
export const maxDuration = 60;

const MAX_STAGED_POSTS = 10;
const STAGED_POSTS_KEY = 'staged_posts';
const STAGED_PUBLISH_LOCK_KEY = 'staged_publish_lock';
const STAGED_PUBLISH_LOCK_TTL_SECONDS = 300;
const STAGED_LAST_PUBLISH_KEY = 'staged_last_publish';

const INSTAGRAM_REQUIRED_HASHTAGS =
  '#uniofsurrey #guildford #mysurrey #surrey #surreynotsorry';

const MAX_INSTAGRAM_CAPTION_LENGTH = 2200;
const DISCORD_CAPTION_INPUT_ID = 'instagram_caption';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');

    const signature =
      req.headers['x-signature-ed25519'];

    const timestamp =
      req.headers['x-signature-timestamp'];

    const PUBLIC_KEY =
      process.env.DISCORD_PUBLIC_KEY?.trim();

    if (!signature || !timestamp || !PUBLIC_KEY) {
      console.error(
        'Discord verification failed: missing signature, timestamp, or public key.'
      );

      return res.status(401).send(
        'Missing headers or key'
      );
    }

    const isValidRequest =
      await verifyKey(
        rawBody,
        signature,
        timestamp,
        PUBLIC_KEY
      );

    if (!isValidRequest) {
      console.error(
        'Discord verification failed: invalid signature.'
      );

      return res.status(401).send(
        'Bad request signature'
      );
    }

    const interaction =
      JSON.parse(rawBody);

    // Discord endpoint verification.
    if (interaction.type === 1) {
      return res.status(200).json({
        type: 1,
      });
    }

    // Slash commands.
    if (interaction.type === 2) {
      return await handleCommand(
        interaction,
        res
      );
    }

    // Buttons and select menus.
    if (interaction.type === 3) {
      return await handleComponent(
        interaction,
        res
      );
    }

    // Modal submissions.
    if (interaction.type === 5) {
      return await handleModalSubmit(
        interaction,
        res
      );
    }

    return res.status(400).send(
      'Unsupported interaction type'
    );
  } catch (error) {
    console.error(
      'Error processing interaction:',
      error
    );

    if (!res.headersSent) {
      return res.status(500).send(
        'Internal Server Error'
      );
    }
  }
}


/* ============================================================
   SLASH COMMANDS
   ============================================================ */

async function handleCommand(
  interaction,
  res
) {
  const commandName =
    interaction.data?.name;

  if (commandName === 'staged') {
    const redis =
      await createRedis();

    try {
      const stagedPosts =
        await getStagedPosts(redis);

      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts
        )
      );
    } finally {
      closeRedis(redis);
    }
  }

  return res.status(200).json({
    type: 4,

    data: {
      content:
        `Unknown command: ${commandName}`,

      flags: 64,
    },
  });
}


/* ============================================================
   COMPONENTS
   ============================================================ */

async function handleComponent(
  interaction,
  res
) {
  const customId =
    interaction.data?.custom_id;

  if (!customId) {
    return res.status(400).send(
      'Missing component custom_id'
    );
  }

  // Post Now opens a caption modal before publishing.
  if (customId.startsWith('post_')) {
    return showCaptionModal(
      interaction,
      res,
      'post'
    );
  }

  // Stage and Delete keep their existing immediate behaviour.
  if (
    customId.startsWith('delete_') ||
    customId.startsWith('stage_')
  ) {
    return handleModerationButton(
      interaction,
      res
    );
  }

  // Publish the complete staged queue after collecting a caption.
  if (customId === 'staged_post') {
    return showCaptionModal(
      interaction,
      res,
      'staged'
    );
  }

  // Staged-post preview controls.
  if (customId === 'staged_select') {
    return await handleStagedSelection(
      interaction,
      res
    );
  }

  if (
    customId.startsWith('staged_up_')
  ) {
    return await handleStagedMove(
      interaction,
      res,
      'up'
    );
  }

  if (
    customId.startsWith('staged_down_')
  ) {
    return await handleStagedMove(
      interaction,
      res,
      'down'
    );
  }

  if (
    customId.startsWith('staged_remove_')
  ) {
    return await handleStagedRemove(
      interaction,
      res
    );
  }

  return res.status(400).send(
    'Unknown component'
  );
}


/* ============================================================
   INSTAGRAM CAPTION MODALS
   ============================================================ */

function showCaptionModal(
  interaction,
  res,
  mode
) {
  const customId =
    interaction.data?.custom_id;

  let modalId;

  if (mode === 'post') {
    const uniqueId =
      customId?.slice('post_'.length);

    if (!uniqueId) {
      return res.status(400).send(
        'Invalid Post Now button.'
      );
    }

    modalId =
      `instagram_caption_post_${uniqueId}`;
  } else {
    modalId =
      'instagram_caption_staged';
  }

  return res.status(200).json({
    type: 9,

    data: {
      custom_id: modalId,

      title:
        'Instagram Caption',

      components: [
        {
          type: 1,

          components: [
            {
              type: 4,

              custom_id:
                DISCORD_CAPTION_INPUT_ID,

              label:
                'Caption (optional)',

              style: 2,

              placeholder:
                'Write a caption... hashtags are added automatically.',

              required: false,

              max_length: 2141,
            },
          ],
        },
      ],
    },
  });
}

async function handleModalSubmit(
  interaction,
  res
) {
  const modalId =
    interaction.data?.custom_id;

  if (
    !modalId?.startsWith(
      'instagram_caption_'
    )
  ) {
    return res.status(400).send(
      'Unknown modal.'
    );
  }

  const captionInput =
    getModalTextValue(
      interaction,
      DISCORD_CAPTION_INPUT_ID
    );

  const instagramCaption =
    buildInstagramCaption(
      captionInput
    );

  if (
    instagramCaption.length >
    MAX_INSTAGRAM_CAPTION_LENGTH
  ) {
    return res.status(200).json({
      type: 4,

      data: {
        content:
          `🔴 **Caption is too long.** Please keep your caption under ` +
          `${2141} characters because the required hashtags are added automatically.`,

        flags: 64,
      },
    });
  }

  if (
    modalId ===
    'instagram_caption_staged'
  ) {
    waitUntil(
      processStagedPublish(
        interaction,
        instagramCaption
      )
    );

    return res.status(200).json({
      type: 5,

      data: {
        flags: 64,
      },
    });
  }

  if (
    modalId.startsWith(
      'instagram_caption_post_'
    )
  ) {
    const uniqueId =
      modalId.slice(
        'instagram_caption_post_'.length
      );

    if (!uniqueId) {
      return res.status(400).send(
        'Invalid Post Now modal.'
      );
    }

    waitUntil(
      processPostNow(
        interaction,
        uniqueId,
        instagramCaption
      )
    );

    return res.status(200).json({
      type: 5,

      data: {
        flags: 64,
      },
    });
  }

  return res.status(400).send(
    'Unknown modal.'
  );
}

function getModalTextValue(
  interaction,
  customId
) {
  const rows =
    interaction.data?.components || [];

  for (const row of rows) {
    for (const component of row.components || []) {
      if (component.custom_id === customId) {
        return component.value || '';
      }
    }
  }

  return '';
}

function buildInstagramCaption(
  captionInput
) {
  const caption =
    typeof captionInput === 'string'
      ? captionInput.trim()
      : '';

  if (!caption) {
    return INSTAGRAM_REQUIRED_HASHTAGS;
  }

  return (
    `${caption}\n\n` +
    INSTAGRAM_REQUIRED_HASHTAGS
  );
}


/* ============================================================
   EXISTING MODERATION BUTTONS
   ============================================================ */

function handleModerationButton(
  interaction,
  res
) {
  // Explicitly keep the post-acknowledgement work alive on Vercel.
  // Without waitUntil(), work started after the Discord response can be
  // cut off when the serverless invocation finishes its HTTP response.
  waitUntil(
    processModerationButton(interaction)
  );

  res.status(200).json({
    type: 6,
  });
}

async function processModerationButton(
  interaction
) {
  const customId =
    interaction.data.custom_id;

  const [action, uniqueId] =
    customId.split('_');

  console.log(
    '[Moderation] Processing button:',
    action
  );

  let redis;

  try {
    redis = await createRedis();
    /*
     * DELETE
     */
    if (action === 'delete') {
      await redis.del(
        `conf_${uniqueId}`
      );

      await editDiscordMessage(
        interaction.token,
        {
          content:
            '🔴 **Deleted and Archived.**',

          embeds: [],

          components: [],
        }
      );

      return;
    }

    /*
     * STAGE
     */
    if (action === 'stage') {
      const lockToken =
        randomUUID();

      const lockAcquired =
        await acquireStagedPublishLock(
          redis,
          lockToken
        );

      if (!lockAcquired) {
        await editDiscordMessage(
          interaction.token,
          {
            content:
              '⚠️ **Instagram publishing is currently in progress.** Please try staging this confession again in a moment.',
          }
        );

        return;
      }

      try {
        const confessionData =
          await redis.get(
            `conf_${uniqueId}`
          );

        if (!confessionData) {
          await editDiscordMessage(
            interaction.token,
            {
              content:
                '⚠️ **Error:** Confession expired or was already staged.',

              components: [],
            }
          );

          return;
        }

        /*
         * Atomically check the queue size and add the confession.
         *
         * This is deliberately done inside Redis rather than:
         *
         *   LLEN
         *   then RPUSH
         *
         * because two simultaneous requests could otherwise both see
         * 9 posts and both add one, resulting in 11.
         */
        const added =
          await redis.eval(
            `
              if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[1]) then
                return 0
              end

              redis.call('RPUSH', KEYS[1], ARGV[2])
              return 1
            `,
            1,
            STAGED_POSTS_KEY,
            MAX_STAGED_POSTS,
            confessionData
          );

        if (!added) {
          await editDiscordMessage(
            interaction.token,
            {
              content:
                `🔴 **Staging queue is full (${MAX_STAGED_POSTS}/${MAX_STAGED_POSTS}).**`,

              components: [],
            }
          );

          return;
        }

        // Only delete the temporary confession once staging succeeded.
        await redis.del(
          `conf_${uniqueId}`
        );

        const queueLength =
          await redis.llen(
            STAGED_POSTS_KEY
          );

        await editDiscordMessage(
          interaction.token,
          {
            content:
              `🟡 **Staged.** (Current Queue: ${queueLength}/${MAX_STAGED_POSTS})`,

            components: [],
          }
        );
      } finally {
        await releaseStagedPublishLock(
          redis,
          lockToken
        );
      }

      return;
    }

  } catch (error) {
    console.error(
      'Moderation button failed:',
      error
    );

    try {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            `🔴 **Action failed.**\n> ${formatInstagramError(error)}\n\nPlease try again in a moment.`,

          embeds: [],

          components: [],
        }
      );
    } catch (discordError) {
      console.error(
        'Failed to update Discord after moderation error:',
        discordError
      );
    }
  } finally {
    closeRedis(redis);
  }
}


/* ============================================================
   POST NOW
   ============================================================ */

async function processPostNow(
  interaction,
  uniqueId,
  instagramCaption
) {
  console.log(
    '[Instagram] Processing Post Now with caption.'
  );

  let redis;

  try {
    redis = await createRedis();

    const confessionData =
      await redis.get(
        `conf_${uniqueId}`
      );

    if (!confessionData) {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            '⚠️ **Error:** Confession expired or was already handled.',

          embeds: [],

          components: [],
        }
      );

      return;
    }

    let confession;

    try {
      confession =
        JSON.parse(
          confessionData
        );
    } catch (error) {
      throw new Error(
        'The stored confession data is invalid JSON.'
      );
    }

    await editDiscordMessage(
      interaction.token,
      {
        content:
          '⏳ **Publishing to Instagram...**',

        components: [],
      }
    );

    try {
      await publishInstagramPosts(
        [confession],
        instagramCaption
      );

      // Only clear the temporary confession after a confirmed publish.
      await redis.del(
        `conf_${uniqueId}`
      );

      await editDiscordMessage(
        interaction.token,
        {
          content:
            '🟢 **Posted Live to Instagram.**',

          embeds: [],

          components: [],
        }
      );

      // Also disable the buttons on the original moderation message.
      if (
        interaction.channel_id &&
        interaction.message?.id
      ) {
        try {
          await editDiscordChannelMessage(
            interaction.channel_id,
            interaction.message.id,
            {
              content:
                '🟢 **Posted Live to Instagram.**',

              embeds: [],

              components: [],
            }
          );
        } catch (discordError) {
          console.error(
            'Failed to archive the original moderation message after Instagram publish:',
            discordError
          );
        }
      }
    } catch (error) {
      console.error(
        'Instagram Post Now failed:',
        error
      );

      await editDiscordMessage(
        interaction.token,
        {
          content:
            `🔴 **Instagram publish failed.**\n> ${formatInstagramError(error)}\n\n` +
            'The confession was kept so it can be retried.',

          components: [],
        }
      );
    }
  } catch (error) {
    console.error(
      'Post Now modal failed:',
      error
    );

    try {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            `🔴 **Action failed.**\n> ${formatInstagramError(error)}\n\nPlease try again in a moment.`,

          components: [],
        }
      );
    } catch (discordError) {
      console.error(
        'Failed to update Discord after Post Now modal error:',
        discordError
      );
    }
  } finally {
    closeRedis(redis);
  }
}


/* ============================================================
   PUBLISH STAGED POSTS
   ============================================================ */

async function processStagedPublish(
  interaction,
  instagramCaption
) {
  console.log(
    '[Instagram] Processing staged publish button.'
  );

  let redis;

  const lockToken =
    randomUUID();

  let lockAcquired = false;

  try {
    redis = await createRedis();
    lockAcquired =
      await acquireStagedPublishLock(
        redis,
        lockToken
      );

    if (!lockAcquired) {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            '⚠️ **Instagram publishing is already in progress.** Please wait for it to finish before trying again.',

          embeds: [],

          components: [],
        }
      );

      return;
    }

    const stagedPosts =
      await getStagedPosts(
        redis
      );

    if (stagedPosts.length === 0) {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            'There are currently no staged confessions to publish.',

          embeds: [],

          components: [],
        }
      );

      return;
    }

    /*
     * Create a stable fingerprint of the exact queue we are about
     * to publish. If a previous publish succeeded but Redis failed
     * before the queue was cleared, this lets a retry clean up the
     * already-published queue without publishing it twice.
     */
    const queueFingerprint =
      createStagedQueueFingerprint(
        stagedPosts,
        instagramCaption
      );

    const lastPublished =
      await redis.get(
        STAGED_LAST_PUBLISH_KEY
      );

    if (lastPublished === queueFingerprint) {
      await redis.del(
        STAGED_POSTS_KEY
      );

      await editDiscordMessage(
        interaction.token,
        {
          content:
            `🟢 **Already published.** Redis cleanup completed for ${stagedPosts.length} staged ` +
            `${stagedPosts.length === 1 ? 'post' : 'posts'}.`,

          embeds: [],

          components: [],
        }
      );

      return;
    }

    await editDiscordMessage(
      interaction.token,
      {
        content:
          `⏳ **Publishing ${stagedPosts.length} ` +
          `${stagedPosts.length === 1 ? 'staged post' : 'staged posts'} to Instagram...**`,

        embeds: [],

        components: [],
      }
    );

    const publishResult =
      await publishInstagramPosts(
        stagedPosts,
        instagramCaption
      );

    /*
     * Record the exact queue that was successfully published before
     * deleting it. If the DELETE itself fails, a retry can detect
     * the matching fingerprint and safely clear the queue without
     * publishing a duplicate.
     */
    await redis.set(
      STAGED_LAST_PUBLISH_KEY,
      queueFingerprint,
      'EX',
      86400
    );

    await redis.del(
      STAGED_POSTS_KEY
    );

    const publishSummary =
      publishResult.type === 'carousel'
        ? `🟢 **Published ${publishResult.count} staged confessions as 1 Instagram carousel.**`
        : '🟢 **Published 1 staged confession to Instagram.**';

    await editDiscordMessage(
      interaction.token,
      {
        content:
          publishSummary,

        embeds: [],

        components: [],
      }
    );
  } catch (error) {
    console.error(
      'Instagram staged publish failed:',
      error
    );

    try {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            `🔴 **Instagram publish failed.**\n> ${formatInstagramError(error)}\n\n` +
            'The staged queue has been kept intact so nothing is lost.',

          components: [],
        }
      );
    } catch (discordError) {
      console.error(
        'Failed to update Discord after Instagram publish error:',
        discordError
      );
    }
  } finally {
    if (lockAcquired) {
      try {
        await releaseStagedPublishLock(
          redis,
          lockToken
        );
      } catch (lockError) {
        console.error(
          'Failed to release staged publish lock:',
          lockError
        );
      }
    }

    closeRedis(redis);
  }
}


/* ============================================================
   STAGED POST SELECTION
   ============================================================ */

async function handleStagedSelection(
  interaction,
  res
) {
  const selectedValue =
    interaction.data?.values?.[0];

  const selectedIndex =
    Number.parseInt(
      selectedValue,
      10
    );

  if (
    !Number.isInteger(
      selectedIndex
    )
  ) {
    return res
      .status(400)
      .send(
        'Invalid staged post selection'
      );
  }

  const redis =
    await createRedis();

  try {
    const stagedPosts =
      await getStagedPosts(
        redis
      );

    if (!stagedPosts[selectedIndex]) {
      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts
        )
      );
    }

    return res.status(200).json(
      createStagedPreviewResponse(
        stagedPosts,
        selectedIndex
      )
    );
  } finally {
    closeRedis(redis);
  }
}


/* ============================================================
   MOVE STAGED POST
   ============================================================ */

async function handleStagedMove(
  interaction,
  res,
  direction
) {
  const index =
    getIndexFromCustomId(
      interaction.data.custom_id
    );

  if (index === null) {
    return res
      .status(400)
      .send(
        'Invalid staged post index'
      );
  }

  const redis =
    await createRedis();

  const lockToken =
    randomUUID();

  let lockAcquired = false;

  try {
    lockAcquired =
      await acquireStagedPublishLock(
        redis,
        lockToken
      );

    if (!lockAcquired) {
      return res.status(200).json({
        type: 4,

        data: {
          content:
            '⚠️ **Instagram publishing is currently in progress.** Please wait for it to finish before changing the staged queue.',

          flags: 64,
        },
      });
    }

    const stagedPosts =
      await getStagedPosts(
        redis
      );

    if (!stagedPosts[index]) {
      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts
        )
      );
    }

    const targetIndex =
      direction === 'up'
        ? index - 1
        : index + 1;

    // Already at the relevant end of the queue.
    if (
      targetIndex < 0 ||
      targetIndex >=
        stagedPosts.length
    ) {
      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts,
          index
        )
      );
    }

    await swapStagedPosts(
      redis,
      index,
      targetIndex
    );

    const updatedPosts =
      await getStagedPosts(
        redis
      );

    return res.status(200).json(
      createStagedPreviewResponse(
        updatedPosts,
        targetIndex
      )
    );
  } finally {
    if (lockAcquired) {
      await releaseStagedPublishLock(
        redis,
        lockToken
      );
    }

    closeRedis(redis);
  }
}


/* ============================================================
   UNSTAGE
   ============================================================ */

async function handleStagedRemove(
  interaction,
  res
) {
  const index =
    getIndexFromCustomId(
      interaction.data.custom_id
    );

  if (index === null) {
    return res
      .status(400)
      .send(
        'Invalid staged post index'
      );
  }

  const redis =
    await createRedis();

  const lockToken =
    randomUUID();

  let lockAcquired = false;

  try {
    lockAcquired =
      await acquireStagedPublishLock(
        redis,
        lockToken
      );

    if (!lockAcquired) {
      return res.status(200).json({
        type: 4,

        data: {
          content:
            '⚠️ **Instagram publishing is currently in progress.** Please wait for it to finish before changing the staged queue.',

          flags: 64,
        },
      });
    }

    const stagedPosts =
      await getStagedPosts(
        redis
      );

    if (!stagedPosts[index]) {
      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts
        )
      );
    }

    await removeStagedPost(
      redis,
      index
    );

    const updatedPosts =
      await getStagedPosts(
        redis
      );

    /*
     * Keep the selection around the same position
     * after removing a post.
     */
    let selectedIndex = null;

    if (updatedPosts.length > 0) {
      selectedIndex =
        Math.min(
          index,
          updatedPosts.length - 1
        );
    }

    return res.status(200).json(
      createStagedPreviewResponse(
        updatedPosts,
        selectedIndex
      )
    );
  } finally {
    if (lockAcquired) {
      await releaseStagedPublishLock(
        redis,
        lockToken
      );
    }

    closeRedis(redis);
  }
}


/* ============================================================
   STAGED QUEUE LOCK / PUBLISH HELPERS
   ============================================================ */

async function acquireStagedPublishLock(
  redis,
  lockToken
) {
  const result =
    await redis.set(
      STAGED_PUBLISH_LOCK_KEY,
      lockToken,
      'NX',
      'EX',
      STAGED_PUBLISH_LOCK_TTL_SECONDS
    );

  return result === 'OK';
}

async function releaseStagedPublishLock(
  redis,
  lockToken
) {
  await redis.eval(
    `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end

      return 0
    `,
    1,
    STAGED_PUBLISH_LOCK_KEY,
    lockToken
  );
}

function createStagedQueueFingerprint(
  stagedPosts,
  instagramCaption
) {
  return createHash(
    'sha256'
  )
    .update(
      JSON.stringify({
        stagedPosts,
        instagramCaption,
      })
    )
    .digest('hex');
}

function formatInstagramError(
  error
) {
  if (!error) {
    return 'Unknown Instagram error.';
  }

  return (
    error.message ||
    'Unknown Instagram error.'
  );
}


/* ============================================================
   REDIS HELPERS
   ============================================================ */

async function getStagedPosts(redis) {
  const values =
    await redis.lrange(
      STAGED_POSTS_KEY,
      0,
      -1
    );

  return values
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch (error) {
        console.error(
          'Invalid staged post JSON:',
          error
        );

        return null;
      }
    })
    .filter(Boolean)
    .slice(
      0,
      MAX_STAGED_POSTS
    );
}


/*
 * Swap two positions in the Redis list.
 */
async function swapStagedPosts(
  redis,
  firstIndex,
  secondIndex
) {
  await redis.eval(
    `
      local first =
        redis.call(
          'LINDEX',
          KEYS[1],
          ARGV[1]
        )

      local second =
        redis.call(
          'LINDEX',
          KEYS[1],
          ARGV[2]
        )

      if not first or not second then
        return 0
      end

      redis.call(
        'LSET',
        KEYS[1],
        ARGV[1],
        second
      )

      redis.call(
        'LSET',
        KEYS[1],
        ARGV[2],
        first
      )

      return 1
    `,
    1,
    STAGED_POSTS_KEY,
    firstIndex,
    secondIndex
  );
}


/*
 * Remove a specific position from the Redis list.
 *
 * Redis lists don't have a native "remove item at index"
 * command, so we rebuild the list atomically in Lua.
 */
async function removeStagedPost(
  redis,
  index
) {
  await redis.eval(
    `
      local length =
        redis.call(
          'LLEN',
          KEYS[1]
        )

      if tonumber(ARGV[1]) < 0
        or tonumber(ARGV[1]) >= length then
        return 0
      end

      local values =
        redis.call(
          'LRANGE',
          KEYS[1],
          0,
          -1
        )

      redis.call(
        'DEL',
        KEYS[1]
      )

      for i = 1, #values do
        if i - 1 ~= tonumber(ARGV[1]) then
          redis.call(
            'RPUSH',
            KEYS[1],
            values[i]
          )
        end
      end

      return 1
    `,
    1,
    STAGED_POSTS_KEY,
    index
  );
}


/*
 * Extract the numeric index from:
 *
 * staged_up_4
 * staged_down_4
 * staged_remove_4
 */
function getIndexFromCustomId(
  customId
) {
  const parts =
    customId.split('_');

  const value =
    parts[parts.length - 1];

  const index =
    Number.parseInt(
      value,
      10
    );

  if (
    !Number.isInteger(index) ||
    index < 0
  ) {
    return null;
  }

  return index;
}


/* ============================================================
   STAGED PREVIEW
   ============================================================ */

function createStagedPreviewResponse(
  stagedPosts,
  selectedIndex = null
) {
  /*
   * Empty queue.
   */
  if (stagedPosts.length === 0) {
    return {
      type: 4,

      data: {
        content:
          'There are currently no staged confessions.',

        components: [],

        // Ephemeral.
        flags: 64,
      },
    };
  }

  /*
   * One Discord embed per confession.
   *
   * Discord allows a maximum of 10 embeds per
   * message, which conveniently matches the
   * Graph API carousel limit.
   */
  const embeds =
    stagedPosts.map(
      (post, index) => ({
        title:
          `#${index + 1}`,

        description:
          post.text ||
          'No confession text available.',

        image: post.imageUrl
          ? {
              url: post.imageUrl,
            }
          : undefined,

        footer: {
          text:
            `Post ${index + 1} of ` +
            `${stagedPosts.length}`,
        },
      })
    );


  /*
   * First row:
   *
   * Dropdown containing all staged posts.
   */
  const components = [
    {
      type: 1,

      components: [
        {
          type: 3,

          custom_id:
            'staged_select',

          placeholder:
            selectedIndex === null
              ? 'Select a staged confession to manage it'
              : `Selected: Post ${selectedIndex + 1}`,

          options:
            stagedPosts.map(
              (post, index) => ({
                label:
                  `Post ${index + 1}`,

                description:
                  truncateText(
                    post.text ||
                      'No text',
                    100
                  ),

                value:
                  String(index),

                default:
                  selectedIndex ===
                  index,
              })
            ),
        },
      ],
    },

    /*
     * Second row:
     *
     * Move Up
     * Move Down
     * Unstage
     */
    {
      type: 1,

      components: [
        {
          type: 2,

          style: 1,

          label:
            'Move Up',

          custom_id:
            `staged_up_${selectedIndex ?? 0}`,

          disabled:
            selectedIndex === null ||
            selectedIndex === 0,
        },

        {
          type: 2,

          style: 1,

          label:
            'Move Down',

          custom_id:
            `staged_down_${selectedIndex ?? 0}`,

          disabled:
            selectedIndex === null ||
            selectedIndex ===
              stagedPosts.length - 1,
        },

        {
          type: 2,

          style: 4,

          label:
            'Unstage',

          custom_id:
            `staged_remove_${selectedIndex ?? 0}`,

          disabled:
            selectedIndex === null,
        },
      ],
    },

    /*
     * Third row:
     *
     * Publish the complete queue to Instagram.
     * One staged post becomes a single image post.
     * Two to ten staged posts become a carousel.
     */
    {
      type: 1,

      components: [
        {
          type: 2,

          style: 3,

          label:
            '📸 Post Staged to Instagram',

          custom_id:
            'staged_post',
        },
      ],
    },
  ];


  return {
    type: 4,

    data: {
      content:
        `## Staged Posts — ` +
        `${stagedPosts.length}/${MAX_STAGED_POSTS}\n` +
        'Posts are shown in the exact order ' +
        'they will be sent to Graph API.',

      embeds,

      components,

      // Make /staged private to the moderator.
      flags: 64,
    },
  };
}


function truncateText(
  text,
  maxLength
) {
  if (text.length <= maxLength) {
    return text;
  }

  return (
    text.slice(
      0,
      maxLength - 1
    ) +
    '…'
  );
}


/* ============================================================
   DISCORD API
   ============================================================ */


async function editDiscordChannelMessage(
  channelId,
  messageId,
  data
) {
  const botToken =
    process.env.DISCORD_BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      'DISCORD_BOT_TOKEN is not configured.'
    );
  }

  const response =
    await fetch(
      `https://discord.com/api/v10/channels/` +
        `${channelId}/messages/${messageId}`,
      {
        method: 'PATCH',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bot ${botToken}`,
        },

        body: JSON.stringify(data),
      }
    );

  if (!response.ok) {
    const responseText =
      await response.text();

    throw new Error(
      `Discord channel message edit failed ` +
        `(${response.status}): ` +
        responseText
    );
  }
}

async function editDiscordMessage(
  interactionToken,
  data
) {
  const appId =
    process.env.DISCORD_APP_ID;

  if (!appId) {
    throw new Error(
      'DISCORD_APP_ID is not configured'
    );
  }

  const response =
    await fetch(
      `https://discord.com/api/v10/webhooks/` +
        `${appId}/${interactionToken}/messages/@original`,

      {
        method: 'PATCH',

        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify(data),
      }
    );

  if (!response.ok) {
    const responseText =
      await response.text();

    throw new Error(
      `Discord message edit failed ` +
      `(${response.status}): ` +
      responseText
    );
  }
}
