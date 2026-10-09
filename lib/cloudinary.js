import pixelWidth from 'string-pixel-width';

const CLOUDINARY_CLOUD_NAME =
  process.env.CLOUDINARY_CLOUD_NAME || 'hff7fini';

const CLOUDINARY_BACKGROUND_PUBLIC_ID =
  process.env.CLOUDINARY_BACKGROUND_PUBLIC_ID || 'background_v2_box';

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1080;
const TEXT_CENTER_X = 540;
const TEXT_CENTER_Y = 604;

const MAX_BOX_WIDTH = 920;
const MAX_BOX_HEIGHT = 670;

const DEFAULT_FONT_FAMILY = 'Georgia';
const DEFAULT_FONT_SIZE = 45;
const MIN_FONT_SIZE = 20;
const BOX_BACKGROUND = 'FFFFFF';
const TEXT_COLOUR = '000000';
const BOX_PADDING = 15;

/*
 * The Cloudinary text background adds its own internal breathing room.
 * Reserve that space, the 15px border padding on both sides, and a small
 * safety allowance so the real outer text panel stays inside 920x670.
 */
const CLOUDINARY_BACKGROUND_GUTTER = 10;
const SAFETY_GUTTER = 8;
const MAX_LINE_WIDTH =
  MAX_BOX_WIDTH -
  (BOX_PADDING * 2) -
  (CLOUDINARY_BACKGROUND_GUTTER * 2) -
  SAFETY_GUTTER;

const MAX_TEXT_HEIGHT =
  MAX_BOX_HEIGHT -
  (BOX_PADDING * 2) -
  (CLOUDINARY_BACKGROUND_GUTTER * 2) -
  SAFETY_GUTTER;

const APPROXIMATE_LINE_HEIGHT_FACTOR = 1.22;

/**
 * Wrap one paragraph to the measured width of the Georgia font that
 * Cloudinary will render. Empty paragraphs are preserved so submitters'
 * intentional paragraph breaks remain visible.
 */
function wrapParagraph(paragraph, fontSize, maxWidth) {
  if (paragraph.trim() === '') {
    return [''];
  }

  const words = paragraph.trim().split(/\s+/);
  const lines = [];
  let currentLine = '';

  const widthOf = (value) =>
    pixelWidth(value, {
      font: DEFAULT_FONT_FAMILY,
      size: fontSize,
    });

  for (const word of words) {
    const candidate = currentLine
      ? `${currentLine} ${word}`
      : word;

    if (widthOf(candidate) <= maxWidth) {
      currentLine = candidate;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    // Split unusually long unbroken strings so they can't exceed the safe width.
    if (widthOf(word) > maxWidth) {
      let chunk = '';

      for (const character of Array.from(word)) {
        const nextChunk = chunk + character;

        if (widthOf(nextChunk) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk = nextChunk;
        }
      }

      currentLine = chunk;
    } else {
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function wrapText(text, fontSize) {
  const normalized = String(text)
    .replace(/\r\n?/g, '\n')
    .trim();

  const paragraphs = normalized.split('\n');
  const lines = [];

  for (const paragraph of paragraphs) {
    lines.push(
      ...wrapParagraph(
        paragraph,
        fontSize,
        MAX_LINE_WIDTH
      )
    );
  }

  return lines;
}

function estimateTextHeight(lineCount, fontSize) {
  return lineCount * fontSize * APPROXIMATE_LINE_HEIGHT_FACTOR;
}

function createTextLayout(text) {
  let fontSize = DEFAULT_FONT_SIZE;
  let lines = wrapText(text, fontSize);
  let estimatedTextHeight = estimateTextHeight(lines.length, fontSize);

  while (
    fontSize > MIN_FONT_SIZE &&
    estimatedTextHeight > MAX_TEXT_HEIGHT
  ) {
    fontSize -= 1;
    lines = wrapText(text, fontSize);
    estimatedTextHeight = estimateTextHeight(lines.length, fontSize);
  }

  const estimatedOuterWidth =
    Math.min(
      MAX_LINE_WIDTH,
      Math.max(...lines.map(line =>
        pixelWidth(line, {
          font: DEFAULT_FONT_FAMILY,
          size: fontSize,
        })
      ), 0)
    ) +
    (BOX_PADDING * 2) +
    (CLOUDINARY_BACKGROUND_GUTTER * 2);

  const estimatedOuterHeight =
    estimatedTextHeight +
    (BOX_PADDING * 2) +
    (CLOUDINARY_BACKGROUND_GUTTER * 2);

  if (estimatedOuterHeight > MAX_BOX_HEIGHT) {
    throw new Error(
      `This confession is too long to fit the post template at the minimum ` +
      `${MIN_FONT_SIZE}px font size. Shorten the confession and submit it again.`
    );
  }

  if (estimatedOuterWidth > MAX_BOX_WIDTH) {
    throw new Error(
      'The confession text could not be laid out inside the maximum box width.'
    );
  }

  return {
    fontSize,
    lines,
    wrappedText: lines.join('\n'),
    estimatedOuterWidth,
    estimatedOuterHeight,
  };
}

function doubleEncodeText(text) {
  /*
   * Cloudinary requires double-encoding for reserved characters such as
   * commas, slashes, percent signs, hash symbols and line breaks in l_text.
   */
  return encodeURIComponent(encodeURIComponent(text));
}

/**
 * Create the production Cloudinary URL using the approved Background v2 box.
 * No file extension is appended to the public ID.
 */
export function createConfessionImageUrl(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Cannot render an empty confession.');
  }

  const layout = createTextLayout(text);
  const encodedText = doubleEncodeText(layout.wrappedText);

  const transformation =
    `l_text:${DEFAULT_FONT_FAMILY}_${layout.fontSize}:${encodedText}` +
    `,co_rgb:${TEXT_COLOUR}` +
    `,b_rgb:${BOX_BACKGROUND}` +
    `,bo_${BOX_PADDING}px_solid_rgb:${BOX_BACKGROUND}` +
    `/fl_layer_apply,g_xy_center,x_${TEXT_CENTER_X},y_${TEXT_CENTER_Y}`;

  const publicId =
    CLOUDINARY_BACKGROUND_PUBLIC_ID.replace(/\.(jpg|jpeg|png|webp)$/i, '');

  const imageUrl =
    `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/` +
    `${transformation}/${publicId}`;

  return {
    imageUrl,
    layout,
  };
}

// Exported for focused tests and to keep the layout rules explicit.
export const confessionLayoutConfig = {
  canvasWidth: CANVAS_WIDTH,
  canvasHeight: CANVAS_HEIGHT,
  centerX: TEXT_CENTER_X,
  centerY: TEXT_CENTER_Y,
  maxWidth: MAX_BOX_WIDTH,
  maxHeight: MAX_BOX_HEIGHT,
  defaultFontFamily: DEFAULT_FONT_FAMILY,
  defaultFontSize: DEFAULT_FONT_SIZE,
  minFontSize: MIN_FONT_SIZE,
  padding: BOX_PADDING,
  maxLineWidth: MAX_LINE_WIDTH,
};
