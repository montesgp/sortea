# ADR 0008: CMS with explicit publishing, revisions and a public media bucket

Status: accepted, 2026-10-15

## Context

FR-CMS-04 asks for a CMS for images, video URLs, banners, copy, SEO/OpenGraph, FAQs and legal texts (winners and delivery evidence are already handled by the award console, AC-06). Before this change the site content lived in `cms_blocks` rows written by the seed, the legal pages were placeholder text in code, and nothing could be edited from the panel. Three constraints shape the design: brand experiences are content switches, not code (ADR 0005); browsers never call the API or Supabase directly (ADR 0005); and buyers accept a specific version of the terms and privacy policy, recorded with each consent.

## Decision

- **Fixed block shapes.** The editable blocks are `brand`, `home`, `seo`, `announcement`, `gallery` (a photo page; `showOnHome` and `showInMenu`, off by default, add the home teaser and the menu link; photos by others carry author, license and an https source shown next to them), `legal.terms` and `legal.privacy`. Their shapes live in `packages/domain` (`cmsBlockSchemas`); the API rejects anything else. Links stay on the site or use https (`//host` is refused), and videos must be YouTube links over https.
- **Drafts and explicit publishing.** `cms_blocks.draft` holds the work in progress; `content` is what the site shows. Publishing re-validates the draft, copies it to `content`, bumps `version` and appends a row to `cms_block_revisions`, which is append-only like the audit log. Restoring an earlier version copies it into the draft; publishing it again is a separate step. Publishing, discarding, media and FAQ changes are audited. Permission `cms.manage` (owner and admin).
- **Legal versions.** Publishing a legal text sets `settings.legal.termsVersion` or `privacyVersion` to the text's version and refuses a version already in force or one published before with different text (bringing back an earlier version with exactly its own text is allowed), so a version label always means one text. Checkout and the public site read that version from the database instead of the 30-second tenant cache, so neither another API instance's consent nor the legal page label can lag behind a publish. The platform never writes legal text: the pages keep their draft notice until the organization publishes its own.
- **Public media bucket.** Images go to a public Supabase bucket (`MEDIA_BUCKET`, default `site-media`), separate from the private bucket for product files. Only the API writes to it. An image is accepted when its bytes are JPEG, PNG or WebP (the declared type is ignored; SVG is refused because it can carry scripts), up to 2 MB. It is stored as `<organization>/<sha256>.<ext>`, so identical uploads are deduplicated and objects can be cached forever. Blocks reference images as `media:<path>`; the API checks that every reference belongs to the organization and resolves them to public URLs for the site. An image used by a published block or a draft cannot be deleted.
- **Upload path.** The browser posts the file to the BFF, which sends the raw bytes to the API with the internal token. No browser credential for Storage exists.
- **Caching.** The web tier caches site data per hostname for 30 seconds. Publishing clears the cache of the instance that handled the request; other instances show the change within 30 seconds.

## Consequences

- Production needs the bucket created once, public, limited to `image/jpeg`, `image/png` and `image/webp` and 2 MB. The seed does this locally.
- The web service must accept request bodies above adapter-node's 512 KB default for image uploads: set `BODY_SIZE_LIMIT=3M`.
- Public image URLs point to the Supabase project. The CSP already allows https images; local Supabase (http on loopback) is added in development only.
- Images in the bucket are public by URL. The library warns editors not to upload documents or photos with personal data.
- Image URLs in content may also be same-site paths or https URLs (the shared `imageUrlSchema` used by products and prizes).
- Saving or publishing a block share-locks the images it points to, and deleting one takes the row lock first, so a draft never keeps an image deleted at the same instant: one of the two is refused (`unknown_media` or `media_in_use`). The bucket object is still removed before the row deletion commits; a failed commit leaves a row without its object, rare and visible in the library.
- Revisions keep old `media:` references. Deleting an image that only an old revision uses is allowed, so restoring that revision shows no image until a new one is chosen.
