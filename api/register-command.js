export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!appId || !botToken) {
    return res.status(500).json({
      error: 'DISCORD_APP_ID or DISCORD_BOT_TOKEN is missing',
    });
  }

  const command = {
    name: 'staged',
    description: 'Preview and manage the currently staged confessions',
  };

  try {
    const response = await fetch(
      `https://discord.com/api/v10/applications/${appId}/commands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${botToken}`,
        },
        body: JSON.stringify(command),
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `Discord API returned ${response.status}: ${responseText}`
      );

      return res.status(500).json({
        success: false,
        discordStatus: response.status,
        discordResponse: responseText,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Registered /staged successfully.',
      command: JSON.parse(responseText),
    });
  } catch (error) {
    console.error('Command registration failed:', error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
