import Redis from 'ioredis';
import { verifyKey } from 'discord-interactions';
import getRawBody from 'raw-body';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_STAGED_POSTS = 10;
const STAGED_POSTS_KEY = 'staged_posts';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');

    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY?.trim();

    if (!signature || !timestamp || !PUBLIC_KEY) {
      return res.status(401).send('Missing headers or key');
    }

    const isValidRequest = await verifyKey(
      rawBody,
      signature,
      timestamp,
      PUBLIC_KEY
    );

    if (!isValidRequest) {
      return res.status(401).send('Bad request signature');
    }

    const interaction = JSON.parse(rawBody);

    // Discord endpoint verification.
    if (interaction.type === 1) {
      return res.status(200).json({ type: 1 });
    }

    // Slash commands.
    if (interaction.type === 2) {
      return await handleCommand(interaction, res);
    }

    // Buttons and select menus.
    if (interaction.type === 3) {
      return await handleComponent(interaction, res);
    }

    return res.status(400).send('Unsupported interaction type');
  } catch (error) {
    console.error('Error processing interaction:', error);

    if (!res.headersSent) {
      return res.status(500).send('Internal Server Error');
    }
  }
}


/* ============================================================
   SLASH COMMANDS
   ============================================================ */

async function handleCommand(interaction, res) {
  const commandName = interaction.data?.name;

  if (commandName === 'staged') {
    const redis = new Redis(process.env.REDIS_URL);

    try {
      const stagedPosts = await getStagedPosts(redis);

      return res.status(200).json(
        createStagedPreviewResponse(stagedPosts)
      );
    } finally {
      redis.disconnect();
    }
  }

  return res.status(200).json({
    type: 4,
    data: {
      content: `Unknown command: ${commandName}`,
      flags: 64,
    },
  });
}


/* ============================================================
   COMPONENTS
   ============================================================ */

async function handleComponent(interaction, res) {
  const customId = interaction.data?.custom_id;

  if (!customId) {
    return res.status(400).send('Missing component custom_id');
  }

  // Existing moderation buttons.
  if (
    customId.startsWith('delete_') ||
    customId.startsWith('stage_') ||
    customId.startsWith('post_')
  ) {
    return await handleModerationButton(interaction, res);
  }

  // Staged-post preview controls.
  if (customId === 'staged_select') {
    return await handleStagedSelection(interaction, res);
  }

  if (customId.startsWith('staged_up_')) {
    return await handleStagedMove(interaction, res, 'up');
  }

  if (customId.startsWith('staged_down_')) {
    return await handleStagedMove(interaction, res, 'down');
  }

  if (customId.startsWith('staged_remove_')) {
    return await handleStagedRemove(interaction, res);
  }

  return res.status(400).send('Unknown component');
}


/* ============================================================
   EXISTING MODERATION BUTTONS
   ============================================================ */

async function handleModerationButton(interaction, res) {
  // Acknowledge the button immediately.
  res.status(200).json({ type: 6 });

  const customId = interaction.data.custom_id;
  const [action, uniqueId] = customId.split('_');

  const redis = new Redis(process.env.REDIS_URL);

  try {
    /*
     * DELETE
     */
    if (action === 'delete') {
      await redis.del(`conf_${uniqueId}`);

      await editDiscordMessage(interaction.token, {
        content: '🔴 **Deleted and Archived.**',
        embeds: [],
        components: [],
      });

      return;
    }

    /*
     * STAGE
     */
    if (action === 'stage') {
      const confessionData = await redis.get(`conf_${uniqueId}`);

      if (!confessionData) {
        await editDiscordMessage(interaction.token, {
          content:
            '⚠️ **Error:** Confession expired or was already staged.',
          components: [],
        });

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
      const added = await redis.eval(
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
        await editDiscordMessage(interaction.token, {
          content:
            `🔴 **Staging queue is full (${MAX_STAGED_POSTS}/${MAX_STAGED_POSTS}).**`,
          components: [],
        });

        return;
      }

      // Only delete the temporary confession once staging succeeded.
      await redis.del(`conf_${uniqueId}`);

      const queueLength = await redis.llen(
        STAGED_POSTS_KEY
      );

      await editDiscordMessage(interaction.token, {
        content:
          `🟡 **Staged.** (Current Queue: ${queueLength}/${MAX_STAGED_POSTS})`,
        components: [],
      });

      return;
    }

    /*
     * POST NOW
     *
     * This currently only changes the Discord moderation message.
     * We'll replace this with the Graph API posting logic later.
     */
    if (action === 'post') {
      await editDiscordMessage(interaction.token, {
        content: '🟢 **Posted Live.**',
        components: [],
      });
    }
  } finally {
    redis.disconnect();
  }
}


/* ============================================================
   STAGED POST SELECTION
   ============================================================ */

async function handleStagedSelection(interaction, res) {
  const selectedValue = interaction.data?.values?.[0];

  const selectedIndex = Number.parseInt(
    selectedValue,
    10
  );

  if (!Number.isInteger(selectedIndex)) {
    return res
      .status(400)
      .send('Invalid staged post selection');
  }

  const redis = new Redis(process.env.REDIS_URL);

  try {
    const stagedPosts = await getStagedPosts(redis);

    if (!stagedPosts[selectedIndex]) {
      return res.status(200).json(
        createStagedPreviewResponse(stagedPosts)
      );
    }

    return res.status(200).json(
      createStagedPreviewResponse(
        stagedPosts,
        selectedIndex
      )
    );
  } finally {
    redis.disconnect();
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
  const index = getIndexFromCustomId(
    interaction.data.custom_id
  );

  if (index === null) {
    return res
      .status(400)
      .send('Invalid staged post index');
  }

  const redis = new Redis(process.env.REDIS_URL);

  try {
    const stagedPosts = await getStagedPosts(redis);

    if (!stagedPosts[index]) {
      return res.status(200).json(
        createStagedPreviewResponse(stagedPosts)
      );
    }

    const targetIndex =
      direction === 'up'
        ? index - 1
        : index + 1;

    // Already at the relevant end of the queue.
    if (
      targetIndex < 0 ||
      targetIndex >= stagedPosts.length
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
      await getStagedPosts(redis);

    return res.status(200).json(
      createStagedPreviewResponse(
        updatedPosts,
        targetIndex
      )
    );
  } finally {
    redis.disconnect();
  }
}


/* ============================================================
   UNSTAGE
   ============================================================ */

async function handleStagedRemove(
  interaction,
  res
) {
  const index = getIndexFromCustomId(
    interaction.data.custom_id
  );

  if (index === null) {
    return res
      .status(400)
      .send('Invalid staged post index');
  }

  const redis = new Redis(process.env.REDIS_URL);

  try {
    const stagedPosts =
      await getStagedPosts(redis);

    if (!stagedPosts[index]) {
      return res.status(200).json(
        createStagedPreviewResponse(
          stagedPosts
        )
      );
    }

    await removeStagedPost(redis, index);

    const updatedPosts =
      await getStagedPosts(redis);

    /*
     * Keep the selection around the same position
     * after removing a post.
     */
    let selectedIndex = null;

    if (updatedPosts.length > 0) {
      selectedIndex = Math.min(
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
    redis.disconnect();
  }
}


/* ============================================================
   REDIS HELPERS
   ============================================================ */

async function getStagedPosts(redis) {
  const values = await redis.lrange(
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
    .slice(0, MAX_STAGED_POSTS);
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
function getIndexFromCustomId(customId) {
  const parts = customId.split('_');

  const value =
    parts[parts.length - 1];

  const index =
    Number.parseInt(value, 10);

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
    stagedPosts.map((post, index) => ({
      title: `#${index + 1}`,

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
    }));


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
                  selectedIndex === index,
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
    text.slice(0, maxLength - 1) +
    '…'
  );
}


/* ============================================================
   DISCORD API
   ============================================================ */

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

  const response = await fetch(
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
