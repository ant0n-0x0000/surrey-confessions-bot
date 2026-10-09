import { createRedis, closeRedis } from '../lib/redis.js';
import { createConfessionImageUrl } from '../lib/cloudinary.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed',
    });
  }

  let redis;

  try {
    const tallyData = req.body;
    const text = tallyData?.data?.fields?.[0]?.value;

    if (!text) {
      return res.status(200).json({
        message:
          'Webhook received, but no confession text found (likely a test ping).',
      });
    }

    redis = await createRedis();

    const { imageUrl, layout } =
      createConfessionImageUrl(text);

    console.log(
      '[Cloudinary] Created confession image URL:',
      {
        fontSize: layout.fontSize,
        lineCount: layout.lines.length,
        estimatedBoxWidth: Math.round(layout.estimatedOuterWidth),
        estimatedBoxHeight: Math.round(layout.estimatedOuterHeight),
      }
    );

    // Generate a unique ID for this confession.
    const uniqueId = crypto.randomUUID();

    // Store confession data in Redis for 24 hours.
    await redis.set(
      `conf_${uniqueId}`,
      JSON.stringify({
        text,
        imageUrl,
      }),
      'EX',
      86400
    );

    const DISCORD_BOT_TOKEN =
      process.env.DISCORD_BOT_TOKEN;

    const DISCORD_CHANNEL_ID =
      process.env.DISCORD_CHANNEL_ID;

    // Send the confession to Discord for manual moderation.
    const discordResponse = await fetch(
      `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bot ${DISCORD_BOT_TOKEN}`,
        },

        body: JSON.stringify({
          content:
            `🟡 **New Confession** <@145224646868860928>\n> ${text}`,

          embeds: [
            {
              image: {
                url: imageUrl,
              },
            },
          ],

          components: [
            {
              type: 1,

              components: [
                {
                  type: 2,
                  style: 1,
                  label: 'Stage',
                  custom_id:
                    `stage_${uniqueId}`,
                },

                {
                  type: 2,
                  style: 3,
                  label: 'Post Now',
                  custom_id:
                    `post_${uniqueId}`,
                },

                {
                  type: 2,
                  style: 4,
                  label: 'Delete',
                  custom_id:
                    `delete_${uniqueId}`,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!discordResponse.ok) {
      const err =
        await discordResponse.json();

      throw new Error(
        `Discord API Error: ${JSON.stringify(err)}`
      );
    }

    return res.status(200).json({
      success: true,
      id: uniqueId,
    });
  } catch (error) {
    console.error(
      'Error processing confession:',
      error
    );

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    closeRedis(redis);
  }
}
