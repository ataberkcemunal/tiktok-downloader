// ==UserScript==
// @name         TikTok Downloader
// @version      0.1
// @description  Adds a download button to TikTok videos and photo posts that saves the best quality without a watermark.
// @match        https://www.tiktok.com/*
// @grant        none
// @sandbox      raw
// @inject-into  page
// @run-at       document-start
// @noframes
// ==/UserScript==
/*
 * TikTok Downloader
 *
 * Adds a download button that saves a TikTok video in the best quality TikTok's web player
 * offers, without the watermark. Photo posts are saved as one image per photo, at full size.
 * The button goes under Share in the feed and on a video's page, beside Favourites in the
 * viewer opened from a grid, and on a small bar over every thumbnail (profile, search,
 * explore, the videos beside a video) that shows while the pointer is over it.
 *
 * Pointing at the main button opens a few more beside it: the cover (the largest of TikTok's
 * cover images, measured, since a "cover" is often bigger than the video), the first frame
 * (a PNG taken from the best video) and the sound; for a photo post, the photo that is
 * showing and the sound. Thumbnails also have a cover button, and a profile's picture gets a
 * button that saves it at its largest.
 *
 * Quality: every video comes in several versions (video.bitrateInfo). TikTok's player and its
 * own Download button use a 540p H.264 one (the Download file also has a watermark and a
 * 4-second end card); the largest is often 720p or 1080p H.265. The versions are ranked by
 * pixels, then bitrate, then codec (H.265 first), and the first one that downloads completely
 * is saved. H.264 is never above 540p, so H.264-only mode (localStorage
 * "tiktokDownloader.codec" = "h264") gives smaller, more compatible files at that size.
 *
 * Data: TikTok sends each video's details (itemStruct) in its API responses; they are caught
 * as they arrive (fetch and XMLHttpRequest are wrapped) and kept by video id. A video that was
 * loaded before that (when started as a bookmarklet) is looked up with TikTok's item detail
 * API, and if that fails, read from its page.
 *
 * As a bookmarklet, each click turns the buttons on or off. As a userscript (AUTO_START), the
 * buttons appear on their own, and the script starts before TikTok so no response is missed.
 *
 * Every comment is a block comment and every statement ends with a semicolon, so the code
 * still runs when a browser collapses the bookmarklet onto a single line.
 */
(() => {
  "use strict";

  const AUTO_START = true;
  const HOST_TAG = "tiktok-downloader";
  const LOG = "[TikTok Downloader]";
  const CODEC_SETTING = "tiktokDownloader.codec";

  /* ---------- General helpers ---------- */

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* Text made safe for a file name: no characters file systems refuse, at most `max` characters. */
  const cleanName = (text, max = 60) =>
    (text || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();

  const extensionOf = type =>
    ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "audio/mp4": "m4a", "audio/mpeg": "mp3", "video/mp4": "mp4" })[type] || "";

  /* The browser's own fetch, taken before TikTok wraps it. Files from TikTok's servers are fetched
     with it; TikTok's API is called through window.fetch, which TikTok signs. */
  const shared = window.__tiktokDownloaderShared || (window.__tiktokDownloaderShared = {
    items: new Map(),
    nativeFetch: window.fetch.bind(window),
    listening: false,
  });
  const items = shared.items;

  /* ---------- Catching TikTok's data ---------- */

  const isItem = value => value && typeof value === "object" && typeof value.id === "string" && /^\d+$/.test(value.id) &&
    value.author && (value.video || value.imagePost);

  /* Keeps every video found in a response, however deep it is (itemList, itemInfo.itemStruct,
     data[].item …). A newer copy replaces an older one: its addresses are fresher. */
  function collectItems(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (isItem(value)) {
      items.set(value.id, value);
      return;
    }
    for (const key in value) collectItems(value[key], depth + 1);
  }

  function collectText(text) {
    if (!text || text[0] !== "{" && text[0] !== "[") return;
    try {
      collectItems(JSON.parse(text));
    } catch (ignored) {}
  }

  const isApiUrl = url => /\/api\//.test(String(url || ""));

  /* Wraps fetch and XMLHttpRequest once to read TikTok's API responses. The responses themselves
     are left untouched. */
  function startListening() {
    if (shared.listening) return;
    shared.listening = true;

    const pageFetch = window.fetch;
    window.fetch = function (input) {
      const result = pageFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (isApiUrl(url)) {
        result.then(response => response.clone().text()).then(collectText).catch(() => {});
      }
      return result;
    };

    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isApiUrl(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") collectText(this.responseText);
            else if (this.responseType === "json") collectItems(this.response);
          } catch (ignored) {}
        });
      }
      return open.apply(this, arguments);
    };
  }

  /* The details TikTok put in the page when it was first loaded (an opened video). */
  function collectPageData(doc = document) {
    const script = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (script) collectText(script.textContent);
  }

  /* A video's details: kept ones, then TikTok's item detail API, then the video's own page.
     fresh skips the kept copy (its addresses may have expired). */
  async function itemFor(id, { fresh = false } = {}) {
    if (!fresh && items.has(id)) return items.get(id);
    try {
      const response = await window.fetch("/api/item/detail/?aid=1988&itemId=" + id, { credentials: "include" });
      const data = await response.json();
      const item = data?.itemInfo?.itemStruct;
      if (isItem(item) && item.id === id) {
        items.set(id, item);
        return item;
      }
    } catch (error) {
      console.warn(LOG, "item detail failed", error);
    }
    const response = await shared.nativeFetch("/@i/video/" + id, { credentials: "include" });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    collectPageData(doc);
    if (items.has(id)) return items.get(id);
    throw new Error("Couldn't find this video's details. Reload the page and try again.");
  }

  /* ---------- Choosing the best version ---------- */

  const codecOf = name => /265|hvc|hev|bytevc1/i.test(name || "") ? "h265" : "h264";

  /* Every version of a video, best first: most pixels, then highest bitrate, then H.265. The
     player's own address comes last, for when no version works. */
  function rankVariants(item) {
    const video = item.video || {};
    const h264Only = localStorage.getItem(CODEC_SETTING) === "h264";
    const variants = (video.bitrateInfo || [])
      .map(info => ({
        name: info.GearName,
        width: info.PlayAddr?.Width || 0,
        height: info.PlayAddr?.Height || 0,
        bitrate: info.Bitrate || 0,
        codec: codecOf(info.CodecType),
        size: Number(info.PlayAddr?.DataSize) || 0,
        urls: [...new Set(info.PlayAddr?.UrlList || [])],
      }))
      .filter(variant => variant.urls.length && (!h264Only || variant.codec === "h264"))
      .sort((a, b) =>
        b.width * b.height - a.width * a.height ||
        b.bitrate - a.bitrate ||
        (a.codec === "h265" ? 0 : 1) - (b.codec === "h265" ? 0 : 1));
    if (video.playAddr) {
      variants.push({ name: "playAddr", width: video.width || 0, height: video.height || 0, bitrate: video.bitrate || 0,
        codec: codecOf(video.codecType), size: 0, urls: [video.playAddr] });
    }
    return variants;
  }

  /* "1080p H.265", from a version's size and codec. */
  const qualityLabel = variant => variant ? Math.min(variant.width, variant.height) + "p" : "";
  const qualityTitle = variant => variant
    ? variant.width + "×" + variant.height + " · " + (variant.codec === "h265" ? "H.265" : "H.264") +
      (variant.bitrate ? " · " + (variant.bitrate / 1e6).toFixed(1) + " Mbps" : "")
    : "";

  const isPhotoPost = item => !!item?.imagePost?.images?.length;

  /* ---------- Downloading ---------- */

  /* Downloads a file, reporting progress (0–1) when its size is known, and checks what came back:
     the right status, a video that starts as an MP4 file, an image or audio of the right type,
     and the expected size. Anything else throws, so the next address can be tried. */
  async function fetchChecked(url, { kind, size = 0, onProgress } = {}) {
    /* Asked for as a range from the start, as TikTok's player does (the answer is the whole file,
       status 206), and never from the browser's cache: a range cached earlier by the player could
       come back cut short. TikTok's own servers (video files) refuse a request without the
       session's cookies (403), while the image servers refuse one with them (CORS), so cookies are
       sent only to tiktok.com, and left out once more if the browser blocks the request. */
    const options = credentials => ({
      credentials,
      cache: "no-store",
      headers: kind === "video" ? { Range: "bytes=0-" } : {},
    });
    const ownServer = /(^|\.)tiktok\.com$/.test(new URL(url, location.href).hostname);
    let response;
    try {
      response = await shared.nativeFetch(url, options(ownServer ? "include" : "omit"));
    } catch (error) {
      if (!ownServer) throw error;
      response = await shared.nativeFetch(url, options("omit"));
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const range = response.headers.get("content-range");
    if (response.status === 206 && range && !/^bytes 0-/.test(range)) throw new Error("Unexpected range " + range);
    const type = (response.headers.get("content-type") || "").split(";")[0].trim();
    /* TikTok serves sounds as video/mp4, though they hold only audio. */
    const typeOk = type.startsWith(kind + "/") || kind === "audio" && type === "video/mp4";
    if (kind !== "video" && !typeOk) throw new Error("Unexpected file type " + type);
    const total = size || Number(response.headers.get("content-length")) || 0;
    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total && onProgress) onProgress(Math.min(received / total, 1));
    }
    const blob = new Blob(chunks, { type: kind === "video" ? "video/mp4" : kind === "audio" && type === "video/mp4" ? "audio/mp4" : type });
    if (kind === "video") {
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (String.fromCharCode(...head.slice(4, 8)) !== "ftyp") throw new Error("Not an MP4 file");
    }
    if (size && blob.size !== size) throw new Error("Incomplete file (" + blob.size + " of " + size + " bytes)");
    return blob;
  }

  /* Waits before each new try of the best size. TikTok's servers sometimes refuse (403) for a
     short while, at every address and even with fresh ones, and then serve the same file again. */
  const RETRY_DELAYS = [0, 1500, 4000];

  /* The best version that downloads completely, with the best one there was. The best size is
     tried several times, with the details fetched again before each new try (the addresses
     expire); a lower size is saved only after that. */
  async function downloadBestVideo(item, onProgress) {
    const failures = [];
    const pixels = variant => variant.width * variant.height;
    const attempt = async list => {
      for (const variant of list) {
        for (const url of variant.urls) {
          try {
            const blob = await fetchChecked(url, { kind: "video", size: variant.size, onProgress });
            console.info(LOG, "saved " + variant.name + " (" + qualityTitle(variant) + ") from " + new URL(url).host);
            return { blob, variant };
          } catch (error) {
            failures.push(variant.name + " @ " + new URL(url).host + ": " + error.message);
          }
        }
      }
      return null;
    };

    let variants = rankVariants(item);
    const best = variants[0];
    if (!best) throw new Error("This video has no downloadable file.");
    const isBestSize = variant => pixels(variant) === pixels(best);
    for (let round = 0; round < RETRY_DELAYS.length; round++) {
      if (round) {
        await wait(RETRY_DELAYS[round]);
        try {
          variants = rankVariants(await itemFor(item.id, { fresh: true }));
        } catch (error) {
          failures.push("refresh: " + error.message);
        }
      }
      const result = await attempt(variants.filter(isBestSize));
      if (result) return { ...result, best };
    }
    const result = await attempt(variants.filter(variant => !isBestSize(variant)));
    if (result) return { ...result, best };
    console.warn(LOG, "every version failed", failures);
    throw new Error("Couldn't download this video.");
  }

  /* "@account - first words of the caption - 7704344985625169172". */
  function fileBase(item) {
    const parts = ["@" + (item.author?.uniqueId || "tiktok")];
    const caption = cleanName(item.desc, 60);
    if (caption) parts.push(caption);
    parts.push(item.id);
    return parts.join(" - ");
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* Each photo of a photo post as its own file, at the size TikTok stores it. The addresses are
     signed, so they are used as they are. */
  async function downloadPhotos(item, onProgress) {
    const images = item.imagePost.images;
    const base = fileBase(item);
    const width = String(images.length).length < 2 ? 2 : String(images.length).length;
    for (let index = 0; index < images.length; index++) {
      let blob = null;
      for (const url of images[index].imageURL?.urlList || []) {
        try {
          blob = await fetchChecked(url, { kind: "image" });
          break;
        } catch (error) {
          console.warn(LOG, "photo " + (index + 1) + " failed at " + new URL(url).host, error);
        }
      }
      if (!blob) throw new Error("Couldn't download photo " + (index + 1) + " of " + images.length + ".");
      saveBlob(blob, base + " - " + String(index + 1).padStart(width, "0") + "." + (extensionOf(blob.type) || "jpg"));
      onProgress?.((index + 1) / images.length);
      /* Browsers drop downloads started too close together. */
      if (index < images.length - 1) await wait(250);
    }
  }

  /* The last video downloaded, so its first frame can be taken without downloading it again. */
  let lastVideo = null;
  async function bestVideoOf(item, onProgress) {
    if (lastVideo?.id === item.id) return lastVideo;
    const result = await downloadBestVideo(item, onProgress);
    lastVideo = { id: item.id, ...result };
    return lastVideo;
  }

  async function downloadItem(id, onProgress) {
    const item = await itemFor(id);
    if (isPhotoPost(item)) return downloadPhotos(item, onProgress);
    const { blob, variant, best } = await bestVideoOf(item, onProgress);
    saveBlob(blob, fileBase(item) + ".mp4");
    if (best && variant.width * variant.height < best.width * best.height) {
      toast("Saved " + qualityLabel(variant) + ": the " + qualityLabel(best) + " version couldn't be downloaded.");
    }
  }

  /* ---------- Cover, first frame, sound, one photo, profile picture ---------- */

  /* The largest of several images: each candidate (an address or a list of addresses for the
     same image) is downloaded and measured, since TikTok's names don't say which is largest
     (a video's "cover" is often bigger than its "originCover", and bigger than the video). */
  async function largestImage(candidates) {
    let best = null;
    for (const candidate of candidates) {
      for (const url of [].concat(candidate)) {
        try {
          const blob = await fetchChecked(url, { kind: "image" });
          const bitmap = await createImageBitmap(blob);
          const pixels = bitmap.width * bitmap.height;
          bitmap.close();
          if (!best || pixels > best.pixels) best = { blob, pixels };
          break;
        } catch (error) {
          console.warn(LOG, "image failed at " + new URL(url).host, error);
        }
      }
    }
    if (!best) throw new Error("Couldn't download the image.");
    return best.blob;
  }

  async function downloadCover(id) {
    const item = await itemFor(id);
    const video = item.video || {};
    const candidates = [...new Set([video.cover, video.originCover, video.dynamicCover].filter(Boolean))];
    if (!candidates.length) throw new Error("This video has no cover.");
    const blob = await largestImage(candidates);
    saveBlob(blob, fileBase(item) + " - cover." + (extensionOf(blob.type) || "jpg"));
  }

  /* The first frame of a downloaded video, as a PNG the size of the video. A frame that comes
     out empty (transparent) counts as failed. */
  function firstFrameOf(blob) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(blob);
      let drawn = false;
      const finish = (error, result) => {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        video.removeAttribute("src");
        video.load();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("The video couldn't be read.")), 15000);
      const draw = () => {
        if (drawn) return;
        drawn = true;
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const context = canvas.getContext("2d");
          context.drawImage(video, 0, 0);
          if (!context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3]) throw new Error("The frame came out empty.");
          canvas.toBlob(image => finish(image ? null : new Error("Couldn't create the image."), image), "image/png");
        } catch (error) {
          finish(error);
        }
      };
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.addEventListener("error", () => finish(new Error("This browser can't play the video, so its first frame can't be taken.")));
      /* Seeking to 0 makes the browser prepare the first frame; it is drawn once ready, or after
         300 ms at the latest. */
      video.addEventListener("loadeddata", () => {
        video.addEventListener("seeked", draw, { once: true });
        video.currentTime = 0;
        setTimeout(draw, 300);
      }, { once: true });
      video.src = url;
    });
  }

  async function downloadFirstFrame(id, onProgress) {
    const item = await itemFor(id);
    const { blob } = await bestVideoOf(item, onProgress);
    saveBlob(await firstFrameOf(blob), fileBase(item) + " - first frame.png");
  }

  async function downloadSound(id, onProgress) {
    const item = await itemFor(id);
    const url = item.music?.playUrl;
    if (!url) throw new Error("This post's sound isn't available.");
    const blob = await fetchChecked(url, { kind: "audio", onProgress });
    saveBlob(blob, fileBase(item) + " - sound." + (extensionOf(blob.type) || "m4a"));
  }

  /* The photo of a photo post that is showing: the largest visible picture on screen whose
     address names one of the post's photos (addresses differ in size and signature, but share
     the photo's key, the last part of the path before "~"). */
  const photoKey = url => {
    try {
      return new URL(url, location.href).pathname.split("/").pop().split("~")[0];
    } catch (error) {
      return "";
    }
  };
  function shownPhotoIndex(item, scope) {
    const keys = item.imagePost.images.map(image => new Set((image.imageURL?.urlList || []).map(photoKey)));
    const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let best = null;
    for (const image of (scope || document).querySelectorAll("img")) {
      const key = photoKey(image.currentSrc || image.src);
      const index = keys.findIndex(set => set.has(key));
      if (index < 0) continue;
      const box = image.getBoundingClientRect();
      const width = Math.min(box.right, view.right) - Math.max(box.left, view.left);
      const height = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
      const area = width > 0 && height > 0 ? width * height : 0;
      if (area && (!best || area > best.area)) best = { index, area };
    }
    return best ? best.index : -1;
  }

  async function downloadShownPhoto(id, scope) {
    const item = await itemFor(id);
    const images = item.imagePost?.images || [];
    const index = shownPhotoIndex(item, scope);
    if (index < 0) throw new Error("Couldn't tell which photo is showing.");
    let blob = null;
    for (const url of images[index].imageURL?.urlList || []) {
      try {
        blob = await fetchChecked(url, { kind: "image" });
        break;
      } catch (error) {
        console.warn(LOG, "photo failed at " + new URL(url).host, error);
      }
    }
    if (!blob) throw new Error("Couldn't download this photo.");
    const width = Math.max(2, String(images.length).length);
    saveBlob(blob, fileBase(item) + " - " + String(index + 1).padStart(width, "0") + "." + (extensionOf(blob.type) || "jpg"));
  }

  /* A profile's picture at its largest (avatarLarger, 1080 at most): from a video of theirs that
     is already known, the page's own data and the picture shown on the page (which TikTok asks
     for at 1080 too), the largest of them; their profile page only if none of these works. */
  async function downloadProfilePicture(uniqueId, avatar) {
    const candidates = [];
    for (const item of items.values()) {
      if (item.author?.uniqueId === uniqueId && item.author.avatarLarger) {
        candidates.push(item.author.avatarLarger);
        break;
      }
    }
    const fromPage = doc => {
      try {
        const data = JSON.parse(doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "{}");
        const user = data.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
        return user?.uniqueId === uniqueId ? user.avatarLarger : null;
      } catch (error) {
        return null;
      }
    };
    candidates.push(fromPage(document));
    const shown = avatar?.querySelector("img");
    candidates.push(shown && (shown.currentSrc || shown.src));
    let blob = null;
    try {
      blob = await largestImage([...new Set(candidates.filter(url => /^https?:/.test(url || "")))]);
    } catch (error) {
      const response = await shared.nativeFetch("/@" + encodeURIComponent(uniqueId), { credentials: "include" });
      const url = fromPage(new DOMParser().parseFromString(await response.text(), "text/html"));
      if (!url) throw new Error("Couldn't find this profile's picture.");
      blob = await fetchChecked(url, { kind: "image" });
    }
    saveBlob(blob, "@" + uniqueId + " - profile picture." + (extensionOf(blob.type) || "jpg"));
  }

  /* ---------- Buttons ---------- */

  const ICONS = {
    download: ["M12 3.5v11", "m7.5 10.5 4.5 4.5 4.5-4.5", "M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2"],
    /* A play triangle in a frame: the cover. */
    cover: ["M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z", "M10 8.6v6.8l5.4-3.4z"],
    /* A picture: the first frame, or the photo that is showing. */
    frame: ["M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z", "M9 7.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z", "m20.5 15.5-4.8-4.8a1.5 1.5 0 0 0-2.1 0L4 20.3"],
    /* Two notes: the sound. */
    sound: ["M9 18V5.5l11-2V16", "M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z", "M20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"],
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["m5 12.5 4.5 4.5L19 7"],
  };

  /* The frosted pill that holds small buttons: the extra buttons beside the main one, and the
     bars over thumbnails and the profile picture. */
  const PILL_CSS = [
    ".pill{display:flex;gap:2px;padding:3px;border-radius:999px;color:#fff;",
    "background:rgba(22,22,22,.55);-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);",
    "box-shadow:0 2px 12px rgba(0,0,0,.22),inset 0 0 0 .5px rgba(255,255,255,.18)}",
    ".pill button{all:unset;box-sizing:border-box;width:34px;height:34px;border-radius:999px;display:grid;place-items:center;",
    "cursor:pointer;color:inherit;background:transparent;transition:background .15s,transform .1s}",
    ".pill button:hover{background:rgba(255,255,255,.16);opacity:1}",
    ".pill button:active{transform:scale(.88)}",
    ".pill button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
    ".pill svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}",
    ".pill .percent{font:700 10px/1 -apple-system,sans-serif}",
  ].join("");

  function icon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const data of ICONS[name]) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", data);
      svg.append(path);
    }
    return svg;
  }

  /* Looks like TikTok's own buttons in the column: a 48 px circle with a small bold label under
     it. Colours are copied from the Share button, so light and dark themes both match. */
  const ACTION_CSS = [
    ":host{all:initial;display:flex;flex-direction:column;align-items:center;margin-top:var(--gap,0px)}",
    "button{all:unset;box-sizing:border-box;width:48px;height:48px;border-radius:999px;display:grid;place-items:center;",
    "cursor:pointer;background:var(--circle,rgba(22,24,35,.06));color:var(--fg,currentColor);transition:transform .1s,opacity .15s}",
    "button:hover{opacity:.75}",
    "button:active{transform:scale(.9)}",
    "button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
    "svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}",
    "button.busy svg{animation:spin .8s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    ".percent{font:700 12px/1 -apple-system,sans-serif}",
    ".label{font:700 12px/16px -apple-system,sans-serif;color:var(--label,currentColor);text-align:center;white-space:nowrap}",
    /* In the viewer opened from a grid, the buttons sit in a row: a 32 px circle with its label
       beside it. */
    ":host([data-row]){flex-direction:row;gap:6px;margin:0}",
    ":host([data-row]) button{width:32px;height:32px}",
    ":host([data-row]) svg{width:18px;height:18px}",
    /* The extra buttons open beside the main one while the pointer is over it: to its left in
       the column, above it in a row. An invisible strip bridges the gap so they stay open on
       the way over. */
    ":host{position:relative}",
    ".more{position:absolute;right:calc(100% + 8px);top:24px;transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .15s}",
    ".more:empty{display:none}",
    ".more::after{content:'';position:absolute;left:100%;top:0;bottom:0;width:10px}",
    ":host(:hover) .more,.more:focus-within{opacity:1;pointer-events:auto}",
    ":host([data-row]) .more{right:auto;left:0;top:auto;bottom:calc(100% + 8px);transform:none}",
    ":host([data-row]) .more::after{left:0;right:0;top:100%;bottom:auto;width:auto;height:10px}",
  ].join("") + PILL_CSS;

  /* The circle element and the label of TikTok's Share button, to copy colours from: the first
     element with a background that is round. */
  function shareStyle(share) {
    const circle = [...share.querySelectorAll("*")].find(element => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const round = style.borderRadius.endsWith("%") || parseFloat(style.borderRadius) >= Math.min(box.width, box.height) / 2 - 1;
      return round && box.width >= 24 && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(style.backgroundColor);
    });
    const label = share.querySelector("strong");
    const svg = share.querySelector("svg");
    return {
      circle: circle ? getComputedStyle(circle).backgroundColor : "",
      fg: svg ? getComputedStyle(svg).color : "",
      label: label ? getComputedStyle(label).color : "",
    };
  }

  /* The button for one video. Its label shows the quality that will be saved (or the number of
     photos) once the video's details are known; hovering looks them up if they aren't yet. */
  function makeActionHost(id, share, { row = false, scope = () => null } = {}) {
    const host = document.createElement(HOST_TAG);
    host.dataset.id = id;
    if (row) host.dataset.row = "";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ACTION_CSS;
    const colours = shareStyle(share);
    if (colours.circle) host.style.setProperty("--circle", colours.circle);
    if (colours.fg) host.style.setProperty("--fg", colours.fg);
    if (colours.label) host.style.setProperty("--label", colours.label);
    const shareGap = !row && share.parentElement?.nextElementSibling ? getComputedStyle(share.parentElement).marginBottom : "";
    if (shareGap && shareGap !== "0px") host.style.setProperty("--gap", shareGap);

    const button = document.createElement("button");
    button.type = "button";
    button.append(icon("download"));
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Save";
    const more = document.createElement("div");
    more.className = "pill more";
    root.append(style, button, label, more);

    /* The extra buttons, once it is known whether this is a video or a photo post. */
    let extrasFor = "";
    const setExtras = item => {
      const kind = isPhotoPost(item) ? "photo" : "video";
      if (extrasFor === kind) return;
      extrasFor = kind;
      more.replaceChildren(...(kind === "photo"
        ? [
          makeSmallButton("frame", "Download the photo that is showing", () => downloadShownPhoto(id, scope())),
          makeSmallButton("sound", "Download sound", onProgress => downloadSound(id, onProgress)),
        ]
        : [
          makeSmallButton("cover", "Download cover", () => downloadCover(id)),
          makeSmallButton("frame", "Download first frame", onProgress => downloadFirstFrame(id, onProgress)),
          makeSmallButton("sound", "Download sound", onProgress => downloadSound(id, onProgress)),
        ]));
    };

    const describe = item => {
      setExtras(item);
      if (isPhotoPost(item)) {
        const count = item.imagePost.images.length;
        label.textContent = count + (count === 1 ? " photo" : " photos");
        button.title = "Download " + label.textContent + " at full size";
      } else {
        const best = rankVariants(item)[0];
        label.textContent = qualityLabel(best) || "Save";
        button.title = "Download video · " + qualityTitle(best);
      }
      button.setAttribute("aria-label", button.title);
    };
    host.refresh = () => {
      if (items.has(id)) describe(items.get(id));
    };
    host.refresh();
    host.addEventListener("pointerenter", () => {
      if (!items.has(id)) itemFor(id).then(describe).catch(() => {});
    });

    wireDownload(button, id, describe);
    isolateEvents(host);
    return host;
  }

  /* Clicking a button runs its action: a spinner, then the percentage (when the action reports
     it), then a check mark; an error is shown. */
  function wireButton(button, iconName, action, after) {
    const setIcon = name => button.replaceChildren(icon(name));
    button.addEventListener("click", () => {
      if (button.classList.contains("busy")) return;
      button.classList.add("busy");
      setIcon("busy");
      const onProgress = fraction => {
        const text = document.createElement("span");
        text.className = "percent";
        text.textContent = Math.round(fraction * 100) + "%";
        button.classList.remove("busy");
        button.replaceChildren(text);
      };
      let result;
      try {
        result = Promise.resolve(action(onProgress));
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(
        () => {
          button.classList.remove("busy");
          setIcon("done");
          after?.();
          setTimeout(() => setIcon(iconName), 1500);
        },
        error => {
          button.classList.remove("busy");
          setIcon(iconName);
          console.error(LOG, error);
          alert(error?.message || "Download failed.");
        });
    });
  }

  /* The main button downloads the video, or every photo of a photo post. */
  function wireDownload(button, id, describe) {
    wireButton(button, "download", onProgress => downloadItem(id, onProgress), () => {
      if (items.has(id)) describe(items.get(id));
    });
  }

  function makeSmallButton(iconName, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(iconName));
    wireButton(button, iconName, action);
    return button;
  }

  /* Taps on our buttons don't reach TikTok, which would pause the video, open it or follow a
     tile's link. */
  function isolateEvents(host) {
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "dblclick", "contextmenu", "keydown"]) {
      host.addEventListener(type, event => {
        event.stopPropagation();
        if (type === "click" || type === "dblclick") event.preventDefault();
      });
    }
  }

  /* A small frosted bar over a thumbnail (profile, search, explore, the videos beside a video):
     it shows while the pointer is over the thumbnail, or a button has keyboard focus. */
  const TILE_CSS = PILL_CSS + [
    ":host{all:initial;position:absolute;inset:0;pointer-events:none;z-index:2}",
    ".bar{position:absolute;left:8px;top:8px;opacity:0;pointer-events:none;transition:opacity .15s}",
    ":host([data-hover]) .bar,.bar:focus-within{opacity:1;pointer-events:auto}",
    /* Over the round profile picture, the bar sits at the bottom in the middle. */
    ":host([data-avatar]) .bar{left:50%;top:auto;bottom:8px;transform:translateX(-50%)}",
    "button.busy svg{animation:spin .8s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
  ].join("");

  /* The bar for one thumbnail. Its details aren't looked up on hover (a grid has dozens of them),
     only when the button is clicked; the title shows the quality when they are already known. */
  function makeTileHost(id) {
    const host = document.createElement(HOST_TAG);
    host.dataset.id = id;
    host.dataset.tile = "";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = TILE_CSS;
    const bar = document.createElement("div");
    bar.className = "pill bar";
    const button = document.createElement("button");
    button.type = "button";
    button.append(icon("download"));
    bar.append(button, makeSmallButton("cover", "Download cover", () => downloadCover(id)));
    root.append(style, bar);
    const describe = item => {
      const best = isPhotoPost(item) ? null : rankVariants(item)[0];
      button.title = isPhotoPost(item)
        ? "Download " + item.imagePost.images.length + " photos at full size"
        : "Download video · " + qualityTitle(best);
      button.setAttribute("aria-label", button.title);
    };
    button.title = "Download";
    button.setAttribute("aria-label", "Download");
    host.refresh = () => {
      if (items.has(id)) describe(items.get(id));
    };
    host.refresh();
    wireDownload(button, id, describe);
    isolateEvents(host);
    return host;
  }

  /* The bar over a profile's picture, with one button that saves it at its largest. */
  function makeAvatarHost(uniqueId, avatar) {
    const host = document.createElement(HOST_TAG);
    host.dataset.id = "@" + uniqueId;
    host.dataset.tile = "";
    host.dataset.avatar = "";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = TILE_CSS;
    const bar = document.createElement("div");
    bar.className = "pill bar";
    bar.append(makeSmallButton("download", "Download profile picture", () => downloadProfilePicture(uniqueId, avatar)));
    root.append(style, bar);
    host.refresh = () => {};
    isolateEvents(host);
    return host;
  }

  /* A thumbnail's link, and the box its bar goes in: the link itself or the nearest ancestor of
     the same size that is positioned (so the bar can sit over it). */
  const TILE_LINK = 'a[href*="/video/"], a[href*="/photo/"]';
  const tileBoxes = new WeakMap();
  function tileBoxOf(link) {
    const known = tileBoxes.get(link);
    if (known?.contains(link)) return known;
    const size = link.getBoundingClientRect();
    if (size.width < 80 || size.height < 80) return null;
    if (!link.querySelector("img, picture, canvas, video")) return null;
    let box = link;
    for (let depth = 0; depth < 4 && box; depth++, box = box.parentElement) {
      const rect = box.getBoundingClientRect();
      if (Math.abs(rect.width - size.width) > 2 || Math.abs(rect.height - size.height) > 2) break;
      if (getComputedStyle(box).position !== "static") {
        tileBoxes.set(link, box);
        return box;
      }
    }
    return null;
  }

  /* Shows the bar of a thumbnail's box while the pointer is over it. Set up once per box, since
     TikTok reuses boxes for other videos. */
  const hoverBoxes = new WeakSet();
  function trackHover(box) {
    if (hoverBoxes.has(box)) return;
    hoverBoxes.add(box);
    const set = on => box.querySelector(":scope > " + HOST_TAG + "[data-tile]")?.toggleAttribute("data-hover", on);
    box.addEventListener("pointerenter", () => set(true));
    box.addEventListener("pointerleave", () => set(false));
  }

  /* The id of the video in one feed entry: from its "more" menu button (photo posts have no
     player), its player (xgwrapper-0-<id>), a link to it, or,
     for the first entry of a video's own page, the page address. */
  function idOfEntry(entry) {
    const menu = entry.querySelector("[data-more-menu-item-id]")?.dataset.moreMenuItemId;
    if (/^\d{8,}$/.test(menu || "")) return menu;
    const player = entry.querySelector('[id^="xgwrapper-"]');
    const fromPlayer = player?.id.match(/(\d{8,})$/)?.[1];
    if (fromPlayer) return fromPlayer;
    const link = entry.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    const fromLink = link?.getAttribute("href").match(/\/(?:video|photo)\/(\d+)/)?.[1];
    if (fromLink) return fromLink;
    if (/-0$/.test(entry.id)) return location.pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1] || null;
    return null;
  }

  const ENTRY = '[data-e2e="recommend-list-item-container"], article';

  /* The feed entry in the middle of the screen, which is the one playing. Since late 2026 the
     For You feed shows a single row of buttons beside the feed, outside every entry, and that
     row belongs to this entry. */
  function entryOnScreen() {
    const middle = innerHeight / 2;
    for (const entry of document.querySelectorAll(ENTRY)) {
      const box = entry.getBoundingClientRect();
      if (box.top <= middle && box.bottom > middle) return entry;
    }
    return null;
  }

  /* Adds a button under Share in every feed entry (For You, Following, a video's page and the
     videos after it), and keeps it there as TikTok reuses entries for other videos, or as the
     feed scrolls when the buttons sit beside it. */
  function startButtons() {
    const hosts = new Set();

    const scan = () => {
      for (const share of document.querySelectorAll('[data-e2e="share-icon"]')) {
        const entry = share.closest(ENTRY) || entryOnScreen();
        const column = share.parentElement?.parentElement;
        if (!entry || !column) continue;
        const id = idOfEntry(entry);
        const existing = column.querySelector(":scope > " + HOST_TAG);
        if (existing && existing.dataset.id === id) continue;
        existing?.remove();
        if (!id) continue;
        const host = makeActionHost(id, share, { scope: () => share.closest(ENTRY) || entryOnScreen() });
        share.parentElement.after(host);
        hosts.add(host);
      }
      /* The viewer opened from a grid (profile, search, explore): its buttons are in a row, and
         the address shows which video it is. */
      const favorite = document.querySelector('[data-e2e="browse-favorite-icon"]')?.closest("button");
      const row = favorite?.parentElement;
      if (row?.parentElement) {
        const id = location.pathname.match(/\/(?:video|photo)\/(\d{8,})/)?.[1] || null;
        const existing = row.parentElement.querySelector(":scope > " + HOST_TAG);
        if (!(existing && existing.dataset.id === id)) {
          existing?.remove();
          if (id) {
            const host = makeActionHost(id, favorite, { row: true });
            row.after(host);
            hosts.add(host);
          }
        }
      }
      /* The profile picture on a profile page. */
      const avatar = document.querySelector('[data-e2e="user-avatar"]');
      const uniqueId = decodeURIComponent(location.pathname.match(/^\/@([^/?#]+)\/?$/)?.[1] || "");
      if (avatar && uniqueId && getComputedStyle(avatar).position !== "static") {
        const existing = avatar.querySelector(":scope > " + HOST_TAG + "[data-avatar]");
        if (existing?.dataset.id !== "@" + uniqueId) {
          existing?.remove();
          avatar.append(makeAvatarHost(uniqueId, avatar));
          trackHover(avatar);
        }
      }
      /* Thumbnails outside the feed: profile, search, explore, the videos beside a video. */
      for (const link of document.querySelectorAll(TILE_LINK)) {
        if (link.closest(ENTRY + ", " + HOST_TAG)) continue;
        const id = link.getAttribute("href").match(/\/(?:video|photo)\/(\d{8,})/)?.[1];
        const box = id && tileBoxOf(link);
        if (!box) continue;
        const existing = box.querySelector(":scope > " + HOST_TAG + "[data-tile]");
        if (existing && existing.dataset.id === id) continue;
        existing?.remove();
        const host = makeTileHost(id);
        box.append(host);
        trackHover(box);
        if (box.matches(":hover")) host.toggleAttribute("data-hover", true);
        hosts.add(host);
      }
      for (const host of hosts) {
        if (!host.isConnected) hosts.delete(host);
        else host.refresh();
      }
    };

    let queued = false;
    const queueScan = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        try {
          scan();
        } catch (error) {
          console.error(LOG, error);
        }
      });
    };
    const observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "href"] });
    /* Scrolling the feed changes which entry the buttons beside it belong to. */
    document.addEventListener("scroll", queueScan, { capture: true, passive: true });
    queueScan();

    return {
      stop() {
        observer.disconnect();
        document.removeEventListener("scroll", queueScan, { capture: true });
        for (const host of document.querySelectorAll(HOST_TAG)) host.remove();
      },
    };
  }

  function toast(message) {
    const note = document.createElement("div");
    note.textContent = message;
    note.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;" +
      "border-radius:999px;background:rgba(22,22,22,.85);color:#fff;font:14px -apple-system,sans-serif;pointer-events:none";
    document.documentElement.append(note);
    setTimeout(() => note.remove(), 2500);
  }

  /* ---------- Start ---------- */

  /* The listener starts at once (as a userscript, before TikTok's own code); the buttons once
     the page has a body. Each bookmarklet click turns the buttons on or off. */
  function start() {
    if (!/(^|\.)tiktok\.com$/.test(location.hostname)) {
      alert("TikTok Downloader only works on tiktok.com.");
      return;
    }
    startListening();
    if (window.__tiktokDownloader) {
      window.__tiktokDownloader.stop();
      window.__tiktokDownloader = null;
      toast("TikTok Downloader is off.");
      return;
    }
    const begin = () => {
      collectPageData();
      window.__tiktokDownloader = startButtons();
      if (!AUTO_START) toast("TikTok Downloader is on. Click the bookmarklet again to turn it off.");
    };
    if (document.body) begin();
    else document.addEventListener("DOMContentLoaded", begin, { once: true });
  }

  try {
    start();
  } catch (error) {
    console.error(LOG, error);
    alert("Something went wrong: " + error.message);
  }
})();
