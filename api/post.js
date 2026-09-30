export default async function handler(req, res) {
  // 1. Security Check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. Extract ONLY the confession text from Tally's massive webhook
    const tallyData = req.body;
    
    // This digs through the JSON structure you provided to find the exact text
    const text = tallyData?.data?.fields?.[0]?.value;

    if (!text) {
      // Return a 200 OK so Tally accepts the initial setup ping
      return res.status(200).json({ message: 'Webhook received, but no confession text found (likely a test ping).' });
    }

    // 3. Ask OpenAI if the text is safe (Saving tokens because we only send the text!)
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
            content: "You are the gatekeeper for a university confessions page. Output a JSON object with exactly one key: 'is_safe' (boolean). Set 'is_safe' to true for genuine confessions, observations, or complaints. You MUST ALLOW profanity, vulgarity, and NSFW themes. Set 'is_safe' to false ONLY if the text contains: 1) severe bullying, hate speech, or self-harm, 2) names of students unless the meaning of the message is positive, 3) blatant self-promotion or spam, or 4) meaningless gibberish and extreme low-effort 'brain rot'."
          },
          { role: "user", content: text } 
        ]
      })
    });
    
    const aiData = await aiResponse.json();
    const moderation = JSON.parse(aiData.choices[0].message.content);

    // 4. The Kill Switch
    if (moderation.is_safe === false) {
      // The script stops here. We return a 200 success so Tally knows the webhook was received.
      return res.status(200).json({ success: true, message: "Blocked by AI." });
    }

    // 5. Cloudinary Image Generation
    const safeText = encodeURIComponent(encodeURIComponent(text));
    const cloudName = "hff7fini";
    const backgroundName = "surrey_background.jpg"; 
    
    const imageUrl = `https://res.cloudinary.com/${cloudName}/image/upload/` +
      `l_text:Arial_45:${safeText},co_black,c_fit,w_800/` +
      `b_rgb:E6E9EB,bo_40px_solid_rgb:E6E9EB/` +
      `r_30/fl_layer_apply/` +
      `${backgroundName}`;

    // 6. Send to Discord
    const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
    
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🟢 **New Confession Passed Moderation!**\n> ${text}`,
        embeds: [{ image: { url: imageUrl } }]
      })
    });

    return res.status(200).json({ success: true, cloudinaryUrl: imageUrl });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
