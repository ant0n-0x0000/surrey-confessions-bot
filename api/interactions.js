import { kv } from '@vercel/kv';
import { verifyKey } from 'discord-interactions';

// CRITICAL FIX: Tell Vercel NOT to parse the JSON body automatically.
// We need the raw text stream to mathematically verify Discord's signature.
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

    // 3. Now that it's verified, we can safely parse the JSON
    const interaction = JSON.parse(rawBody);

    // 4. Handle Discord's initial PING request (required for setup)
    if (interaction.type === 1) {
      return res.status(200).json({ type: 1 }); // Respond with PONG (Type 1)
    }

    // 5. Handle Button Clicks (Type 3)
    if (interaction.type === 3) {
      const customId = interaction.data.custom_id;
      const [action, uniqueId] = customId.split('_'); 
      
      // Tell Discord we received the click and are processing it
      res.status(200).json({ type: 6 }); 

      if (action === 'delete') {
        await kv.del(`conf_${uniqueId}`);
        await editDiscordMessage(interaction.token, {
          content: '🔴 **Deleted and Archived.**',
          embeds: [], 
          components: [] 
        });

      } else if (action === 'stage') {
        const confessionData = await kv.get(`conf_${uniqueId}`);
        if (confessionData) {
          // Note: kv.get automatically parses JSON in ioredis/vercel-kv, so we stringify it again for the list
          await kv.rpush('staged_posts', typeof confessionData === 'string' ? confessionData : JSON.stringify(confessionData));
          await kv.del(`conf_${uniqueId}`); 
          
          const queueLength = await kv.llen('staged_posts');

          await editDiscordMessage(interaction.token, {
            content: `🟡 **Staged.** (Current Queue: ${queueLength}/10)`,
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
    // If we haven't already sent a response, send a 500
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
