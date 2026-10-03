import Redis from 'ioredis';
import { verifyKey } from 'discord-interactions';

// Tell Vercel NOT to parse the JSON body automatically so we can verify the signature.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Manually read the raw stream into a string
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // 2. Verify the request is actually from Discord
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp || !PUBLIC_KEY) {
      return res.status(401).json({ error: 'Missing signature headers or public key' });
    }

    const isValidRequest = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);

    if (!isValidRequest) {
      return res.status(401).json({ error: 'Bad request signature' });
    }

    // 3. Setup Redis connection
    const redis = new Redis(process.env.REDIS_URL);

    // 4. Safely parse the JSON
    const interaction = JSON.parse(rawBody);

    // 5. Handle Discord's PING
    if (interaction.type === 1) {
      return res.status(200).json({ type: 1 });
    }

    // 6. Handle Button Clicks
    if (interaction.type === 3) {
      const customId = interaction.data.custom_id;
      const [action, uniqueId] = customId.split('_'); 
      
      // Tell Discord we are processing the click
      res.status(200).json({ type: 6 }); 

      if (action === 'delete') {
        await redis.del(`conf_${uniqueId}`);
        await editDiscordMessage(interaction.token, {
          content: '🔴 **Deleted and Archived.**',
          embeds: [], 
          components: [] 
        });

      } else if (action === 'stage') {
        const confessionData = await redis.get(`conf_${uniqueId}`);
        if (confessionData) {
          // Push to the staging list and clean up the temporary record
          await redis.rpush('staged_posts', confessionData);
          await redis.del(`conf_${uniqueId}`); 
          
          const queueLength = await redis.llen('staged_posts');

          await editDiscordMessage(interaction.token, {
            content: `🟡 **Staged.** (Current Queue: ${queueLength}/10)`,
            components: [] 
          });
        } else {
            // Handle edge case where data expired or was already staged
            await editDiscordMessage(interaction.token, {
                content: `⚠️ **Error:** Confession data no longer exists in database.`,
                components: [] 
              });
        }
      } else if (action === 'post') {
         await editDiscordMessage(interaction.token, {
            content: `🟢 **Posted Live.**`,
            components: [] 
          });
      }
    }
  } catch (error) {
    console.error("Error processing interaction:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}

async function editDiscordMessage(interactionToken, data) {
  const appId = process.env.DISCORD_APP_ID;
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}
