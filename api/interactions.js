import { kv } from '@vercel/kv';
import { verifyKey } from 'discord-interactions';

export default async function handler(req, res) {
  // 1. Security Check: Discord strictly requires POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Verify the request is actually from Discord
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = JSON.stringify(req.body); // We need the raw string for verification

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).json({ error: 'Bad request signature' });
  }

  const interaction = req.body;

  // 3. Handle Discord's initial PING request (required for setup)
  if (interaction.type === 1) { // Type 1 is a PING
    return res.status(200).json({ type: 1 }); // Respond with PONG (Type 1)
  }

  // 4. Handle Button Clicks (Type 3 is a Message Component interaction)
  if (interaction.type === 3) {
    const customId = interaction.data.custom_id;
    const [action, uniqueId] = customId.split('_'); // e.g., 'stage', '12345'
    
    // We immediately tell Discord "Message Received, I'm thinking..." 
    // to stop the "Interaction Failed" error, as Discord only gives us 3 seconds.
    // Type 6 (DEFERRED_UPDATE_MESSAGE) tells Discord we will edit the message shortly.
    res.status(200).json({ type: 6 }); 

    try {
      if (action === 'delete') {
        // Remove from database
        await kv.del(`conf_${uniqueId}`);

        // Update the Discord message to show it was deleted
        await editDiscordMessage(interaction.token, {
          content: '🔴 **Deleted and Archived.**',
          embeds: [], // Remove the image
          components: [] // Remove the buttons
        });

      } else if (action === 'stage') {
        // Move from temporary storage to the 'staged_posts' list
        const confessionData = await kv.get(`conf_${uniqueId}`);
        if (confessionData) {
          await kv.rpush('staged_posts', JSON.stringify(confessionData));
          await kv.del(`conf_${uniqueId}`); // Clean up the temp record
          
          // Get current queue length
          const queueLength = await kv.llen('staged_posts');

          await editDiscordMessage(interaction.token, {
            content: `🟡 **Staged.** (Current Queue: ${queueLength}/10)`,
            components: [] // Remove buttons so it can't be clicked again
          });
        }
      } else if (action === 'post') {
         // Post Immediately (You will need to re-add your Meta Graph API code here)
         // For now, we'll just update the message.
         await editDiscordMessage(interaction.token, {
            content: `🟢 **Posted Live.**`,
            components: [] 
          });
      }
    } catch (error) {
      console.error("Error processing interaction:", error);
    }
  }
}

// Helper function to edit the Discord message after we've processed the button click
async function editDiscordMessage(interactionToken, data) {
  const appId = process.env.DISCORD_APP_ID;
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}
