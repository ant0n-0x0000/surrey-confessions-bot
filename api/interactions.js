import { createRedis, closeRedis } from '../lib/redis.js';
import { verifyKey } from 'discord-interactions';
import getRawBody from 'raw-body';
import { createHash, randomUUID } from 'node:crypto';
import { publishInstagramPosts } from '../lib/instagram.js';
import { createConfessionImageUrl } from '../lib/cloudinary.js';
import { waitUntil } from '@vercel/functions';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Instagram publishing can involve several container-status checks.
export const maxDuration = 60;

const MAX_STAGED_POSTS = 10;
const CONFESSION_TTL_SECONDS = 86400;
const MODERATOR_USER_ID = '145224646868860928';
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

  // Restore an expired submission from its Discord moderation message before
  // opening the caption modal. The Redis record still gets a short TTL.
  if (customId.startsWith('post_')) {
    const uniqueId =
      customId.slice('post_'.length);

    let redis;

    try {
      redis = await createRedis();

      const confession =
        await getOrRestoreConfession(
          redis,
          uniqueId,
          interaction
        );

      if (!confession) {
        return res.status(200).json({
          type: 4,
          data: {
            content:
              '⚠️ **This confession could not be recovered.** Its original text is no longer available in the moderation message. Please resubmit it through Tally.',
            flags: 64,
          },
        });
      }
    } catch (error) {
      console.error(
        'Failed to restore confession before Post Now:',
        error
      );

      return res.status(200).json({
        type: 4,
        data: {
          content:
            '⚠️ **Could not load this confession.** Please try again in a moment.',
          flags: 64,
        },
      });
    } finally {
      closeRedis(redis);
    }

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
        await sendInteractionFollowup(
          interaction,
          '⚠️ **Instagram publishing is currently in progress.** Please try staging this confession again in a moment.'
        );

        return;
      }

      try {
        const confession =
          await getOrRestoreConfession(
            redis,
            uniqueId,
            interaction
          );

        if (!confession) {
          await sendInteractionFollowup(
            interaction,
            '⚠️ **This confession could not be recovered.** Its original text is no longer available in the moderation message. Please resubmit it through Tally.'
          );

          return;
        }

        // Keep the source Discord identifiers with the staged item so an
        // unstage can restore its buttons and a successful publish can remove
        // its now-obsolete moderation message.
        const stagedConfession = {
          ...confession,
          uniqueId,
          discordChannelId:
            interaction.channel_id || null,
          discordMessageId:
            interaction.message?.id || null,
        };

        /*
         * Atomically check the queue size, prevent duplicates, and add the
         * confession. All three operations happen inside Redis to avoid race
         * conditions when button clicks overlap.
         * Return values: 1 = added, 0 = full, -1 = already staged.
         */
        const added =
          await redis.eval(
            `
              local existingPosts =
                redis.call('LRANGE', KEYS[1], 0, -1)

              for _, existingJson in ipairs(existingPosts) do
                local ok, existing = pcall(cjson.decode, existingJson)
                if ok and existing and existing.uniqueId == ARGV[2] then
                  return -1
                end
              end

              if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[1]) then
                return 0
              end

              redis.call('RPUSH', KEYS[1], ARGV[3])
              return 1
            `,
            1,
            STAGED_POSTS_KEY,
            MAX_STAGED_POSTS,
            uniqueId,
            JSON.stringify(stagedConfession)
          );

        if (added === 0) {
          // Leave the original confession and its buttons untouched. It can
          // be staged later when a slot becomes available.
          await sendInteractionFollowup(
            interaction,
            `🔴 **Staging queue is full (${MAX_STAGED_POSTS}/${MAX_STAGED_POSTS}).** This confession has not been staged; its buttons are still available.`
          );

          return;
        }

        if (added === -1) {
          // A rapid double-click can arrive with an old interaction payload.
          // Do not overwrite the already-staged message or add a duplicate.
          await redis.del(`conf_${uniqueId}`);
          await sendInteractionFollowup(
            interaction,
            'ℹ️ **This confession is already in the staged queue.**'
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
      // Do not replace the source message on a transient error: its content
      // is the recovery copy if the Redis record has expired.
      await sendInteractionFollowup(
        interaction,
        `🔴 **Action failed.**\n> ${formatInstagramError(error)}\n\nPlease try again in a moment.`
      );
    } catch (discordError) {
      console.error(
        'Failed to send moderation error follow-up:',
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

    let confession =
      await getOrRestoreConfession(
        redis,
        uniqueId,
        interaction
      );

    if (!confession) {
      await editDiscordMessage(
        interaction.token,
        {
          content:
            '⚠️ **Error:** This confession expired and could not be recovered from the original Discord message.',

          embeds: [],

          components: [],
        }
      );

      return;
    }

    // Regenerate the preview URL so pending submissions created before this
    // deployment also use the current Background v2 design when published.
    confession.imageUrl =
      createConfessionImageUrl(confession.text).imageUrl;

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

      await deletePublishedSourceMessages(
        stagedPosts
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

    // Rebuild image URLs from the stored confession text. This upgrades any
    // posts that were staged before the new design was deployed, without
    // needing a Redis migration or changing their order.
    const postsWithCurrentDesign =
      stagedPosts.map((post) => {
        if (typeof post.text !== 'string' || !post.text.trim()) {
          throw new Error(
            'A staged confession is missing its text and cannot be rendered with the current design.'
          );
        }

        return {
          ...post,
          imageUrl:
            createConfessionImageUrl(post.text).imageUrl,
        };
      });

    const publishResult =
      await publishInstagramPosts(
        postsWithCurrentDesign,
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

    // These source messages no longer represent pending submissions. Remove
    // them after a confirmed publish so the moderation channel stays focused
    // on confessions that still need action.
    await deletePublishedSourceMessages(
      stagedPosts
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

    const postToUnstage =
      stagedPosts[index];

    await removeStagedPost(
      redis,
      index
    );

    let sourceMessageRestored = false;

    try {
      sourceMessageRestored =
        await restoreModerationPostAfterUnstage(
          redis,
          postToUnstage
        );
    } catch (error) {
      console.error(
        '[Moderation] Unstaged post, but failed to restore its source message:',
        error
      );
    }

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

    const previewResponse =
      createStagedPreviewResponse(
        updatedPosts,
        selectedIndex
      );

    if (!sourceMessageRestored) {
      previewResponse.data.content +=
        '\n\n⚠️ This post was removed from the queue, but its original Discord message could not be restored automatically. This can happen with posts staged before the latest update or if the original message was deleted.';
    }

    return res.status(200).json(
      previewResponse
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
   CONFESSION RECOVERY / MODERATION MESSAGE HELPERS
   ============================================================ */

async function getOrRestoreConfession(
  redis,
  uniqueId,
  interaction
) {
  const stored =
    await redis.get(`conf_${uniqueId}`);

  if (stored) {
    try {
      const confession = JSON.parse(stored);
      if (typeof confession.text === 'string' && confession.text.trim()) {
        return {
          ...confession,
          uniqueId,
        };
      }
    } catch (error) {
      console.warn(
        '[Redis] Stored confession was invalid; attempting Discord recovery.',
        error.message
      );
    }
  }

  const recovered =
    recoverConfessionFromDiscordMessage(
      interaction?.message
    );

  if (!recovered) {
    return null;
  }

  let imageUrl = recovered.imageUrl;

  try {
    imageUrl =
      createConfessionImageUrl(
        recovered.text
      ).imageUrl || imageUrl;
  } catch (error) {
    console.warn(
      '[Cloudinary] Could not regenerate recovered confession image; retaining the existing embed URL:',
      error.message
    );
  }

  const confession = {
    text: recovered.text,
    imageUrl,
    uniqueId,
  };

  await redis.set(
    `conf_${uniqueId}`,
    JSON.stringify(confession),
    'EX',
    CONFESSION_TTL_SECONDS
  );

  console.log(
    '[Moderation] Recovered expired confession from its Discord message.',
    { uniqueId }
  );

  return confession;
}

function recoverConfessionFromDiscordMessage(
  message
) {
  const content = message?.content;

  if (typeof content !== 'string') {
    return null;
  }

  const headerEnd = content.indexOf('\n');
  if (headerEnd === -1) {
    return null;
  }

  const header = content.slice(0, headerEnd);
  if (!header.startsWith('🟡 **New Confession**')) {
    return null;
  }

  let text = content.slice(headerEnd + 1);
  if (!text.startsWith('>')) {
    return null;
  }

  // The original webhook adds one quote marker and one separator space.
  // Remove only those characters, preserving the sender's actual text.
  text = text.startsWith('> ')
    ? text.slice(2)
    : text.slice(1);

  if (!text.trim()) {
    return null;
  }

  const imageUrl =
    message.embeds?.find(
      (embed) => embed.image?.url
    )?.image?.url || null;

  return { text, imageUrl };
}

function createModerationMessagePayload(
  uniqueId,
  confession
) {
  let imageUrl = confession.imageUrl;

  try {
    imageUrl =
      createConfessionImageUrl(
        confession.text
      ).imageUrl || imageUrl;
  } catch (error) {
    console.warn(
      '[Cloudinary] Could not regenerate image while restoring moderation message:',
      error.message
    );
  }

  return {
    content:
      `🟡 **New Confession** <@${MODERATOR_USER_ID}>\n> ${confession.text}`,

    embeds: imageUrl
      ? [{ image: { url: imageUrl } }]
      : [],

    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Stage',
            custom_id: `stage_${uniqueId}`,
          },
          {
            type: 2,
            style: 3,
            label: 'Post Now',
            custom_id: `post_${uniqueId}`,
          },
          {
            type: 2,
            style: 4,
            label: 'Delete',
            custom_id: `delete_${uniqueId}`,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

async function restoreModerationPostAfterUnstage(
  redis,
  stagedPost
) {
  const channelId = stagedPost.discordChannelId;
  const messageId = stagedPost.discordMessageId;

  // Queue entries created before this update have no source-message metadata.
  // Leave those entries unstaged but do not invent an inaccessible control ID.
  if (!channelId || !messageId) {
    console.warn(
      '[Moderation] Cannot restore original message for a legacy staged item without Discord message metadata.'
    );
    return false;
  }

  const uniqueId =
    typeof stagedPost.uniqueId === 'string' && stagedPost.uniqueId
      ? stagedPost.uniqueId
      : randomUUID();

  const confession = {
    text: stagedPost.text,
    imageUrl: stagedPost.imageUrl || null,
    uniqueId,
  };

  // Recreate a short-lived cache entry. If it expires again, the Discord
  // moderation message remains the durable recovery copy.
  try {
    confession.imageUrl =
      createConfessionImageUrl(
        confession.text
      ).imageUrl || confession.imageUrl;
  } catch (error) {
    console.warn(
      '[Cloudinary] Could not regenerate image while unstaging:',
      error.message
    );
  }

  await redis.set(
    `conf_${uniqueId}`,
    JSON.stringify(confession),
    'EX',
    CONFESSION_TTL_SECONDS
  );

  try {
    await editDiscordChannelMessage(
      channelId,
      messageId,
      createModerationMessagePayload(
        uniqueId,
        confession
      )
    );
  } catch (error) {
    console.error(
      '[Moderation] Failed to restore the original message after unstage:',
      error
    );
    throw error;
  }

  return true;
}

async function deletePublishedSourceMessages(
  stagedPosts
) {
  for (const post of stagedPosts) {
    if (!post.discordChannelId || !post.discordMessageId) {
      continue;
    }

    try {
      await deleteDiscordChannelMessage(
        post.discordChannelId,
        post.discordMessageId
      );
    } catch (error) {
      // Publishing already succeeded and the queue has been cleared. A source
      // message cleanup failure must not make the post appear un-published.
      console.warn(
        '[Moderation] Could not remove a published source message:',
        error.message
      );
    }
  }
}

async function sendInteractionFollowup(
  interaction,
  content
) {
  const appId =
    process.env.DISCORD_APP_ID;

  if (!appId || !interaction?.token) {
    throw new Error(
      'DISCORD_APP_ID or interaction token is missing.'
    );
  }

  const response =
    await fetch(
      `https://discord.com/api/v10/webhooks/${appId}/${interaction.token}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          flags: 64,
          allowed_mentions: { parse: [] },
        }),
      }
    );

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Discord interaction follow-up failed (${response.status}): ${responseText}`
    );
  }
}

async function deleteDiscordChannelMessage(
  channelId,
  messageId
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
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      }
    );

  if (!response.ok && response.status !== 404) {
    const responseText = await response.text();
    throw new Error(
      `Discord channel message delete failed (${response.status}): ${responseText}`
    );
  }
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
      (post, index) => {
        let previewImageUrl = post.imageUrl;

        // Prefer the current design for old staged items, while keeping the
        // preview usable if a legacy confession cannot be rendered.
        if (typeof post.text === 'string' && post.text.trim()) {
          try {
            previewImageUrl =
              createConfessionImageUrl(post.text).imageUrl;
          } catch (error) {
            console.warn(
              '[Cloudinary] Could not regenerate staged preview image:',
              error.message
            );
          }
        }

        return {
          title:
            `#${index + 1}`,

          description:
            post.text ||
            'No confession text available.',

          image: previewImageUrl
            ? {
                url: previewImageUrl,
              }
            : undefined,

          footer: {
            text:
              `Post ${index + 1} of ` +
              `${stagedPosts.length}`,
          },
        };
      }
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
