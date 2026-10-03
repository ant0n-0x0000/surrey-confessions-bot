import Redis from 'ioredis';
import { verifyKey } from 'discord-interactions';
import getRawBody from 'raw-body';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // Discord signatures must be verified against the exact raw request body.
    const rawBodyBuffer = await getRawBody(req);
    const rawBody = rawBodyBuffer.toString('utf8');

    // Read Discord's signature headers and application public key.
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY?.trim();

    // Safe debugging information.
    // Do NOT log the actual signature, public key, bot token, etc.
    console.log('Discord interaction received:', {
      method: req.method,
      bodyLength: rawBody.length,
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
      hasPublicKey: !!PUBLIC_KEY,
    });

    if (!signature || !timestamp || !PUBLIC_KEY) {
      console.error('Missing Discord signature headers or public key.');
      return res.status(401).send('Missing headers or key');
    }

    // IMPORTANT:
    // verifyKey() is asynchronous in discord-interactions.
    // We must await it.
    const isValidRequest = await verifyKey(
      rawBody,
      signature,
      timestamp,
      PUBLIC_KEY
    );

    console.log('Discord signature valid:', isValidRequest);

    if (!isValidRequest) {
      return res.status(401).send('Bad request signature');
    }

    // Now that the request has been verified, parse the JSON.
    const interaction = JSON.parse(rawBody);

    console.log('Discord interaction type:', interaction.type);

    // ---------------------------------------------------------
    // PING
    // Discord sends this when validating the interactions URL.
    // We must respond with { "type": 1 }.
    // ---------------------------------------------------------
    if (interaction.type === 1) {
      res.setHeader('Content-Type', 'application/json');

      return res.status(200).json({
        type: 1,
      });
    }

    // ---------------------------------------------------------
    // MESSAGE COMPONENT / BUTTON
    // ---------------------------------------------------------
    if (interaction.type === 3) {
      res.setHeader('Content-Type', 'application/json');

      // Immediately acknowledge the button interaction.
      // Type 6 = DEFERRED_UPDATE_MESSAGE.
      res.status(200).json({
        type: 6,
      });

      const customId = interaction.data?.custom_id;

      if (!customId) {
        console.error('Button interaction had no custom_id.');
        return;
      }

      const [action, uniqueId] = customId.split('_');

      if (!action || !uniqueId) {
        console.error('Invalid custom_id:', customId);
        return;
      }

      const redis = new Redis(process.env.REDIS_URL);

      try {
        // -------------------------------------------------------
        // DELETE
        // -------------------------------------------------------
        if (action === 'delete') {
          await redis.del(`conf_${uniqueId}`);

          await editDiscordMessage(interaction.token, {
            content: '🔴 **Deleted and Archived.**',
            embeds: [],
            components: [],
          });
        }

        // -------------------------------------------------------
        // STAGE
        // -------------------------------------------------------
        else if (action === 'stage') {
          const confessionData = await redis.get(`conf_${uniqueId}`);

          if (confessionData) {
            await redis.rpush('staged_posts', confessionData);
            await redis.del(`conf_${uniqueId}`);

            const queueLength = await redis.llen('staged_posts');

            await editDiscordMessage(interaction.token, {
              content: `🟡 **Staged.** (Current Queue: ${queueLength}/10)`,
              components: [],
            });
          } else {
            await editDiscordMessage(interaction.token, {
              content:
                '⚠️ **Error:** Confession expired or was already staged.',
              components: [],
            });
          }
        }

        // -------------------------------------------------------
        // POST NOW
        // -------------------------------------------------------
        else if (action === 'post') {
          await editDiscordMessage(interaction.token, {
            content: '🟢 **Posted Live.**',
            components: [],
          });
        }

        else {
          console.error('Unknown interaction action:', action);
        }
      } finally {
        // Close this Redis connection after the operation completes.
        redis.disconnect();
      }

      return;
    }

    // Unknown interaction type.
    console.log('Unhandled Discord interaction type:', interaction.type);

    return res.status(400).send('Unsupported interaction type');
  } catch (error) {
    console.error('Error processing interaction:', error);

    if (!res.headersSent) {
      return res.status(500).send('Internal Server Error');
    }
  }
}

async function editDiscordMessage(interactionToken, data) {
  const appId = process.env.DISCORD_APP_ID;

  if (!appId) {
    throw new Error('DISCORD_APP_ID is not configured');
  }

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    }
  );

  if (!response.ok) {
    const responseText = await response.text();

    throw new Error(
      `Discord message edit failed (${response.status}): ${responseText}`
    );
  }
}
