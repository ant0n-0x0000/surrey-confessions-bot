export const CONFESSION_STATUS = Object.freeze({
  new: Object.freeze({
    title: 'New Confession',
    color: 0xF1C40F,
  }),
  staged: Object.freeze({
    title: 'Staged',
    color: 0x3498DB,
  }),
  published: Object.freeze({
    title: 'Posted to Instagram',
    color: 0x2ECC71,
  }),
  archivePending: Object.freeze({
    title: 'Posted to Instagram · Archive Pending',
    color: 0x2ECC71,
  }),
  deleted: Object.freeze({
    title: 'Deleted',
    color: 0xE74C3C,
  }),
});

export function createConfessionEmbed(confession, status) {
  if (
    typeof confession?.text !== 'string' ||
    !confession.text.trim()
  ) {
    throw new Error('Cannot create a Discord embed without confession text.');
  }

  const embed = {
    title: status.title,
    description: confession.text,
    color: status.color,
  };

  if (
    typeof confession.imageUrl === 'string' &&
    confession.imageUrl.trim()
  ) {
    embed.image = {
      url: confession.imageUrl,
    };
  }

  return embed;
}
