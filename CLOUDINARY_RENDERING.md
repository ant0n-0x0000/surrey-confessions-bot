# Cloudinary confession rendering

New confessions use `lib/cloudinary.js` to create the Cloudinary text-overlay URL. The default background asset is `background_v3` (without a file extension). Text uses Arial regular at 45px by default, black on white, with a 15px same-colour border as padding, positioned at the centre of the 1080x1080 canvas (`540, 540`).

Text is wrapped server-side using Arial width metrics from `string-pixel-width`. The font is reduced in 1px steps when needed to keep the estimated text panel within 920x670. If the text still cannot fit at 20px, the webhook returns a clear error rather than generating an overflowing image.

Optional Vercel overrides:

- `CLOUDINARY_CLOUD_NAME` (defaults to `hff7fini`)
- `CLOUDINARY_BACKGROUND_PUBLIC_ID` (defaults to `background_v3`)
