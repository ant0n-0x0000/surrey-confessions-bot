import Redis from 'ioredis';
import { verifyKey } from 'discord-interactions';
import getRawBody from 'raw-body';

export const config = {
  api: { bodyParser: false },
};

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

    const isValidRequest = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);

    if (!isValidRequest) {
      return res.status(401).send('Bad request signature');
    }

    const interaction = JSON.parse(rawBody);

    if (interaction.type === 1) {
      // Send native JSON to guarantee strict formatting for Discord
      return res.status(200).json({ type: 1 });
    }

    if (interaction.type === 3) {
      res.status(200).json({ type: 6 }); 

      const customId = interaction.data.custom_id;
      const [action, uniqueId] = customId.split('_'); 
      const redis = new Redis(process.env.REDIS_URL);
      
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
          await redis.rpush('staged_posts', confessionData);
          await redis.del(`conf_${uniqueId}`); 
          
          const queueLength = await redis.llen('staged_posts');

          await editDiscordMessage(interaction.token, {
            content: `🟡 **Staged.** (Current Queue: ${queueLength}/10)`,
            components: [] 
          });
        } else {
            await editDiscordMessage(interaction.token, {
                content: `⚠️ **Error:** Confession expired or was already staged.`,
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
      res.status(500).send('Internal Server Error');
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
