import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const tallyData = req.body;
    const text = tallyData?.data?.fields?.[0]?.value;

    if (!text) {
      return res.status(200).json({ message: 'Webhook received, but no confession text found (likely a test ping).' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are the strict gatekeeper for a university confessions page. Output a JSON object with exactly one key: 'is_safe' (boolean).

ALLOW: General complaints, profanity, vulgarity, and NSFW themes. 

BLOCK (Set is_safe to false) if the text violates ANY of these strict rules:
1. FULL NAMES: Any use of a full name (first and last name together) is strictly forbidden, regardless of context (even positive ones).
2. TARGETED HARASSMENT: Any negative, insulting, or bullying statement directed at a specific person. (e.g., "[Name] is a shithead" MUST be blocked). While general profanity is allowed, targeted profanity using a name is bullying.
3. NEGATIVE USE OF FIRST NAMES: First names or initials are ONLY allowed in strictly positive, harmless, or romantic contexts (e.g., a crush). If a first name is tied to a complaint or insult, block it immediately.
4. HARM & HATE: Hate speech (racism, homophobia, etc.) or self-harm.
5. LOW QUALITY: Blatant self-promotion, spam, or meaningless 'brain rot' gibberish.`
          },
          { role: "user", content: text } 
        ]
      })
    });
    
    const aiData = await aiResponse.json();
    const moderation = JSON.parse(aiData.choices[0].message.content);

    if (moderation.is_safe === false) {
      return res.status(200).json({ success: true, message: "Blocked by AI." });
    }

    const safeText = encodeURIComponent(encodeURIComponent(text));
    const cloudName = "hff7fini";
    const backgroundName = "surrey_background.jpg"; 
    
    const imageUrl = `https://res.cloudinary.com/${cloudName}/image/upload/` +
      `l_text:Arial_45:${safeText},co_black,c_fit,w_800/` +
      `b_rgb:E6E9EB,bo_40px_solid_rgb:E6E9EB/` +
      `r_30/fl_layer_apply/` +
      `${backgroundName}`;

    // 1. Generate a unique ID for this specific confession
    const uniqueId = crypto.randomUUID();

    // 2. Save the data to Vercel KV so the next script can retrieve it. 
    // { ex: 86400 } automatically deletes the record after 24 hours to keep your DB clean.
    await kv.set(`conf_${uniqueId}`, { text, imageUrl }, { ex: 86400 });

    const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
    
    // 3. Send Interactive Message to Discord using the Bot API
    const discordResponse = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`
      },
      body: JSON.stringify({
        content: `🟢 **New Confession Passed Moderation!**\n> ${text}`,
        embeds: [{ image: { url: imageUrl } }],
        components: [
          {
            type: 1, // Action Row
            components: [
              { type: 2, style: 1, label: "Stage", custom_id: `stage_${uniqueId}` },
              { type: 2, style: 3, label: "Post Now", custom_id: `post_${uniqueId}` },
              { type: 2, style: 4, label: "Delete", custom_id: `delete_${uniqueId}` }
            ]
          }
        ]
      })
    });

    if (!discordResponse.ok) {
       const err = await discordResponse.json();
       throw new Error(`Discord API Error: ${JSON.stringify(err)}`);
    }

    return res.status(200).json({ success: true, id: uniqueId });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
