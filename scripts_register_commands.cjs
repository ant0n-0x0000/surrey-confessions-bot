async function main() {
  const applicationId =
    process.env.DISCORD_APP_ID;

  const botToken =
    process.env.DISCORD_BOT_TOKEN;

  if (!applicationId || !botToken) {
    console.error(
      'Set DISCORD_APP_ID and DISCORD_BOT_TOKEN before running this script.'
    );

    process.exit(1);
  }

  const command = {
    name: 'staged',

    description:
      'Preview and manage the currently staged confessions',
  };

  const response = await fetch(
    `https://discord.com/api/v10/applications/` +
      `${applicationId}/commands`,

    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        Authorization:
          `Bot ${botToken}`,
      },

      body:
        JSON.stringify(command),
    }
  );

  const body =
    await response.text();

  if (!response.ok) {
    console.error(
      `Discord API returned ${response.status}:`
    );

    console.error(body);

    process.exit(1);
  }

  console.log(
    'Registered /staged successfully:'
  );

  console.log(body);
}

main().catch((error) => {
  console.error(error);

  process.exit(1);
});
