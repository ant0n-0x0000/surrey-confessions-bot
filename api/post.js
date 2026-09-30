export default async function handler(req, res) {
  // 1. Security check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. Grab the safe text
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'No text provided in the webhook payload' });
    }

    // 3. Double-encode for Cloudinary
    const safeText = encodeURIComponent(encodeURIComponent(text));

    // 4. Build the final Cloudinary URL
    const cloudName = "hff7fini";
    const backgroundName = "surrey_background.jpg"; 
    
    const imageUrl = `https://res.cloudinary.com/${cloudName}/image/upload/` +
      `l_text:Arial_45:${safeText},co_black,c_fit,w_800/` +
      `b_rgb:E6E9EB,bo_40px_solid_rgb:E6E9EB/` +
      `r_30/fl_layer_apply/` +
      `${backgroundName}`;

    // 5. Retrieve your Discord Webhook URL from Vercel
    const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

    if (!DISCORD_WEBHOOK_URL) {
      throw new Error('Missing DISCORD_WEBHOOK_URL in Vercel Environment Variables');
    }

    // 6. Send the text and image preview to Discord
    const discordResponse = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🟢 **New Confession Passed Moderation!**\n> ${text}`,
        embeds: [{
          image: { url: imageUrl }
        }]
      })
    });

    if (!discordResponse.ok) {
      throw new Error(`Discord API Error: ${discordResponse.statusText}`);
    }

    // 7. Tell IFTTT the process was a complete success
    return res.status(200).json({ 
      success: true, 
      cloudinaryUrl: imageUrl 
    });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
