# TikTok Downloader

A userscript that adds download buttons to TikTok and saves videos in the best quality TikTok's web player offers, without the watermark.

- **Videos:** every version TikTok sends is ranked by size, then bitrate, then codec. The best one that downloads completely is saved (often 1080p H.265).
- **Photo posts:** one button saves the photo that is showing, another saves every photo at full size.
- **Where the buttons are:** under Share in the feed and on a video's page, in the viewer opened from a grid, under stories, and on a bar over every thumbnail (profile, search, explore).
- **Profile picture:** open it in a new tab or download it at its largest.
- **All posts:** "All posts" at the end of a profile's row of tabs opens a tab with every post as a card, with download buttons.
- **Download history:** downloaded items turn pink. Downloads are remembered in Tampermonkey's storage; stories are forgotten after a day.

Files are named `username (Display Name) - caption - id`.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `tiktok-downloader.user.js` in this repository, click **Raw**, and let Tampermonkey install it.

### For development

`tiktok-downloader-loader.user.js` loads the built file from disk with `@require file:///…`, so changes show after a page reload.

1. Change the path in it to your own checkout.
2. Allow Tampermonkey to access file URLs in your browser's extension settings.

Then:

```bash
node build.js                         # tiktok-downloader.js → tiktok-downloader.user.js
node smoke-test.js tiktok-downloader.js
```

## Notes

- TikTok limits how fast a profile's list of posts can be loaded. After about ten pages in a few minutes it shows a puzzle on its page. Solve it there, and the "All posts" tab carries on by itself.
- For personal archiving of content you have the right to keep. Re-uploading other people's content may break TikTok's terms and copyright law.
