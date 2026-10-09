# Cloudinary confession rendering

New confessions use `lib/cloudinary.js` to create the Cloudinary text-overlay URL. The base asset is `background_v2_box` (without a file extension), the text is Georgia regular at 45px by default, black on white, with a 15px same-colour border as padding, positioned at `(540, 604)`.

Text is wrapped server-side using Georgia width metrics (`string-pixel-width`) and the font is reduced in 1px steps when needed to keep the estimate within a 920x670 panel. If the text still cannot fit at 20px, the webhook returns a clear error rather than generating an overflowing image.

Optional Vercel overrides:
- `CLOUDINARY_CLOUD_NAME` (defaults to `hff7fini`)
- `CLOUDINARY_BACKGROUND_PUBLIC_ID` (defaults to `background_v2_box`)
