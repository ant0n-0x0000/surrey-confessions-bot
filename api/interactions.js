import Redis from 'ioredis';
import { verifyKey } from 'discord-interactions';

// Tell Vercel NOT to parse the body automatically
export const config = {
  api: {
    bodyParser: false,
  },
};

// A rock-solid helper to manually read the raw stream for signature verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // 1. Get raw body
    const rawBody = await getRawBody(req);
    
    // 2. Fetch headers & key (adding .trim() just in case Vercel added a hidden space)
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY?.trim();

    if (!signature || !timestamp || !PUBLIC_KEY) {
      return res.status(401).send('Missing headers or key');
    }

    // 3. Verify
    const isValidRequest = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);

    if (!isValidRequest) {
      return res.status(401).send('Bad request signature');
    }

    const interaction = JSON.parse(rawBody);

    // 4. Handle PING (Type 1) - The exact format Discord demands
    if (interaction.type === 1) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(JSON.stringify({ type: 1 }));
    }

    // 5. Handle Buttons (Type 3)
    if (interaction.type === 3) {
      // Instantly tell Discord we are processing it so it doesn't time out
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(JSON.stringify({ type: 6 })); 

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
          // Push to the staging queue
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
