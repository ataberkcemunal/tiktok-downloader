// ==UserScript==
// @name         TikTok Downloader
// @version      0.2.16
// @description  Adds a download button to TikTok videos and photo posts that saves the best quality without a watermark.
// @match        https://www.tiktok.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        unsafeWindow
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
 * explore, the videos beside a video) that shows while the pointer is over it, and beside
 * Share under a story.
 *
 * For a photo post, the button saves the photo that is showing (its label says which, "3/7"),
 * and a second one under it saves every photo (thumbnails save every photo). A profile's picture gets a button that saves it at its largest.
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
  /* Set by build.js to the userscript's version. */
  const VERSION = "0.2.16";
  const HOST_TAG = "tiktok-downloader";
  const LOG = "[TikTok Downloader]";
  const CODEC_SETTING = "tiktokDownloader.codec";
  const DONE_SETTING = "tiktokDownloader.downloaded";

  /* ---------- General helpers ---------- */

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* Text made safe for a file name: no characters file systems refuse, at most `max` characters. */
  const cleanName = (text, max = 60) =>
    (text || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/#\S+/g, "").replace(/\s+/g, " ").trim().slice(0, max).trim();

  const extensionOf = type =>
    ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "video/mp4": "mp4" })[type] || "";

  /* The browser's own fetch, taken before TikTok wraps it. Files from TikTok's servers are fetched
     with it; TikTok's API is called through window.fetch, which TikTok signs. */
  /* The page's own window. With Tampermonkey's GM_* functions granted, the script's "window"
     can be Tampermonkey's wrapper around it, and the page's is unsafeWindow; the fetch and
     XMLHttpRequest of the page must be the ones wrapped. */
  const page = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;
  const shared = page.__tiktokDownloaderShared || (page.__tiktokDownloaderShared = {
    items: new Map(),
    nativeFetch: page.fetch.bind(page),
    listening: false,
  });
  const items = shared.items;

  /* ---------- Catching TikTok's data ---------- */

  const isItem = value => value && typeof value === "object" && typeof value.id === "string" && /^\d+$/.test(value.id) &&
    value.author && (value.video || value.imagePost);

  /* Keeps every video found in a response, however deep it is (itemList, itemInfo.itemStruct,
     data[].item …). A newer copy replaces an older one: its addresses are fresher. */
  /* TikTok's own copy of a post in the page (its React state) names the author by username
     only, with the display name beside it; made to look like the API's, where the author is an
     object. */
  function normalizeItem(item) {
    if (typeof item.author !== "string") return item;
    return {
      ...item,
      author: { uniqueId: item.author, nickname: item.nickname || "", id: item.authorId, secUid: item.authorSecId },
    };
  }

  function collectItems(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 7) return;
    if (isItem(value)) {
      items.set(value.id, normalizeItem(value));
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

    const pageFetch = page.fetch;
    page.fetch = function (input) {
      const result = pageFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (isApiUrl(url)) {
        result.then(response => response.clone().text()).then(collectText).catch(() => {});
      }
      return result;
    };

    const open = page.XMLHttpRequest.prototype.open;
    page.XMLHttpRequest.prototype.open = function (method, url) {
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

  /* A post's details from the page itself: TikTok's buttons and entries keep the post they
     show in their React props (the Share button's, a few levels up, as "item"). Only a full copy
     counts: one with every version of the video, or the photos. Nothing is downloaded, so this
     works even when TikTok answers requests with a check page instead. */
  const ITEM_HOLDERS = '[data-e2e="share-icon"], [data-e2e="browse-favorite-icon"], [data-e2e="share-btn"], ' +
    '[data-more-menu-item-id], article, [data-e2e="user-post-item"]';
  function itemFromPage(id) {
    for (const element of document.querySelectorAll(ITEM_HOLDERS)) {
      const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
      let fiber = key && element[key];
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (!props || typeof props !== "object") continue;
        for (const name in props) {
          const value = props[name];
          if (isItem(value) && value.id === id && (value.video?.bitrateInfo?.length || value.imagePost?.images?.length)) {
            return normalizeItem(value);
          }
        }
      }
    }
    return null;
  }

  /* A post's details: kept ones, the page's own copy, TikTok's item detail API, then the post's
     own page. fresh (the addresses may have expired) asks TikTok first and uses the page's copy
     only if that fails. */
  async function itemFor(id, { fresh = false } = {}) {
    if (!fresh && items.has(id)) return items.get(id);
    const fromPage = () => {
      const item = itemFromPage(id);
      if (item) items.set(id, item);
      return item;
    };
    if (!fresh && fromPage()) return items.get(id);
    try {
      const response = await page.fetch("/api/item/detail/?aid=1988&itemId=" + id, { credentials: "include" });
      const data = await response.json();
      const item = data?.itemInfo?.itemStruct;
      if (isItem(item) && item.id === id) {
        items.set(id, normalizeItem(item));
        return items.get(id);
      }
    } catch (error) {
      console.warn(LOG, "item detail failed", error);
    }
    const kept = items.get(id);
    try {
      const response = await shared.nativeFetch("/@i/video/" + id, { credentials: "include" });
      collectPageData(new DOMParser().parseFromString(await response.text(), "text/html"));
    } catch (error) {
      console.warn(LOG, "post page failed", error);
    }
    /* A new copy from the post's page; otherwise the page's own copy, or a kept one. */
    if (items.get(id) && items.get(id) !== kept) return items.get(id);
    if (fromPage() || items.has(id)) return items.get(id);
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

  /* ---------- What was downloaded ---------- */

  /* Downloads are remembered in this browser, so their buttons turn pink: "v:<id>" a
     video, "p:<id>:<n>" one photo of a post (counted from 0), "a:<id>" all of a post's photos,
     "u:<username>" a profile picture. A story is remembered for a day (it is gone after that),
     anything else for good. Each key maps to the time it is forgotten, or null for never. */
  const DAY = 24 * 60 * 60 * 1000;
  const STORE = "downloaded";
  const downloaded = new Map();
  const isDownloaded = key => {
    if (!key || !downloaded.has(key)) return false;
    const until = downloaded.get(key);
    return until === null || until > Date.now();
  };

  /* Buttons that show a check mark, painted again once the saved downloads have been read. */
  const paintable = new Set();
  const repaintAll = () => {
    for (const button of paintable) {
      if (button.isConnected === false && button.painted) paintable.delete(button);
      else button.repaint?.();
    }
  };

  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  /* Where downloads are kept: Tampermonkey's own storage when it is granted (it survives
     clearing TikTok's site data), one value per download, "d:<key>"; otherwise IndexedDB. */
  const gm = typeof GM_getValue === "function" && typeof GM_setValue === "function" &&
    typeof GM_listValues === "function" && typeof GM_deleteValue === "function";

  /* Reads every saved download into the map, dropping those whose time is up, and moves over
     older lists: the localStorage one of the first versions (a story's, due within a day,
     keeps its time; any other is kept for good) and, with Tampermonkey's storage, the
     IndexedDB one, which is then deleted. */
  const database = (async () => {
    const now = Date.now();
    const moved = [];
    const keep = (key, until) => {
      if (until !== null && until <= now) return false;
      if (!downloaded.has(key)) downloaded.set(key, until);
      return true;
    };
    let db = null;
    try {
      if (gm) {
        for (const name of GM_listValues()) {
          if (name.startsWith("d:") && !keep(name.slice(2), GM_getValue(name, null))) GM_deleteValue(name);
        }
      }
      const open = indexedDB.open("tiktokDownloader", 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      db = await request(open);
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const keys = await request(store.getAllKeys());
      const values = await request(store.getAll());
      keys.forEach((key, index) => {
        if (!keep(key, values[index])) store.delete(key);
        else if (gm) moved.push(key);
      });
      try {
        const old = JSON.parse(localStorage.getItem(DONE_SETTING) || "null");
        if (old) {
          for (const [key, until] of Object.entries(old)) {
            if (until <= now || downloaded.has(key)) continue;
            keep(key, until <= now + DAY ? until : null);
            if (gm) moved.push(key);
            else store.put(downloaded.get(key), key);
          }
          localStorage.removeItem(DONE_SETTING);
        }
      } catch (error) {
        console.warn(LOG, "couldn't move the old downloads", error);
      }
      if (gm) {
        for (const key of moved) GM_setValue("d:" + key, downloaded.get(key));
        db.close();
        indexedDB.deleteDatabase("tiktokDownloader");
        db = null;
      }
    } catch (error) {
      console.warn(LOG, "couldn't read the list of downloads", error);
    } finally {
      repaintAll();
    }
    return db;
  })();

  function markDownloaded(key) {
    if (!key) return;
    const id = key.split(":")[1];
    const until = items.get(id)?.story ? Date.now() + DAY : null;
    downloaded.set(key, until);
    if (gm) {
      GM_setValue("d:" + key, until);
      return;
    }
    database.then(db => {
      if (db) db.transaction(STORE, "readwrite").objectStore(STORE).put(until, key);
    }).catch(error => console.warn(LOG, "couldn't remember the download", error));
  }

  /* ---------- Downloading ---------- */

  /* Downloads a file, reporting progress (0–1) when its size is known, and checks what came back:
     the right status, a video that starts as an MP4 file, an image of the right type,
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
    if (kind !== "video" && !type.startsWith(kind + "/")) throw new Error("Unexpected file type " + type);
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
    const blob = new Blob(chunks, { type: kind === "video" ? "video/mp4" : type });
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
  /* "username (Display Name)", as in Instagram Downloader; just the username when the display
     name is missing or the same. */
  function ownerName(uniqueId, nickname) {
    const name = cleanName(nickname, 60);
    return name && name.toLowerCase() !== (uniqueId || "").toLowerCase() ? uniqueId + " (" + name + ")" : uniqueId;
  }

  /* A file's name: "username (Display Name) - caption - id". */
  function fileBase(item) {
    const parts = [ownerName(item.author?.uniqueId || "tiktok", item.author?.nickname)];
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

  async function downloadItem(id, onProgress) {
    const item = await itemFor(id);
    if (isPhotoPost(item)) return downloadPhotos(item, onProgress);
    const { blob, variant, best } = await downloadBestVideo(item, onProgress);
    saveBlob(blob, fileBase(item) + ".mp4");
    if (best && variant.width * variant.height < best.width * best.height) {
      toast("Saved " + qualityLabel(variant) + ": the " + qualityLabel(best) + " version couldn't be downloaded.");
    }
  }

  /* ---------- One photo, profile picture ---------- */

  /* The largest of several images: each candidate (an address or a list of addresses for the
     same image) is downloaded and measured, since the addresses don't say how big they are. */
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

  /* The addresses of a profile's picture (avatarLarger, 1080 at most): from a video of theirs
     that is already known, the page's own data, and the picture shown on the page (which TikTok
     asks for at 1080 too). */
  function profilePictureUrls(uniqueId, avatar, doc = document) {
    const urls = [];
    for (const item of items.values()) {
      if (item.author?.uniqueId === uniqueId && item.author.avatarLarger) {
        urls.push(item.author.avatarLarger);
        break;
      }
    }
    try {
      const data = JSON.parse(doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "{}");
      const user = data.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
      if (user?.uniqueId === uniqueId) urls.push(user.avatarLarger);
    } catch (ignored) {}
    const shown = avatar?.querySelector("img");
    if (shown) urls.push(shown.currentSrc || shown.src);
    return [...new Set(urls.filter(url => /^https?:/.test(url || "")))];
  }

  /* The profile's display name: from a video of theirs that is already known, the page's own
     data, or the name shown under the username on the profile. */
  function profileNickname(uniqueId) {
    for (const item of items.values()) {
      if (item.author?.uniqueId === uniqueId && item.author.nickname) return item.author.nickname;
    }
    try {
      const data = JSON.parse(document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || "{}");
      const user = data.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
      if (user?.uniqueId === uniqueId && user.nickname) return user.nickname;
    } catch (ignored) {}
    return document.querySelector('[data-e2e="user-subtitle"]')?.textContent || "";
  }

  const profilePictureName = uniqueId => ownerName(uniqueId, profileNickname(uniqueId)) + " - profile picture";

  /* Saves the largest of them; the profile page is fetched only if none of them works (TikTok
     sometimes answers that with a check page instead). */
  async function downloadProfilePicture(uniqueId, avatar) {
    let blob = null;
    try {
      blob = await largestImage(profilePictureUrls(uniqueId, avatar));
    } catch (error) {
      const response = await shared.nativeFetch("/@" + encodeURIComponent(uniqueId), { credentials: "include" });
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      const url = profilePictureUrls(uniqueId, null, doc)[0];
      if (!url) throw new Error("Couldn't find this profile's picture.");
      blob = await fetchChecked(url, { kind: "image" });
    }
    saveBlob(blob, profilePictureName(uniqueId, avatar) + "." + (extensionOf(blob.type) || "jpg"));
  }

  /* Opens the profile's picture in a new tab of ours, as Instagram Downloader does, rather than
     at its own address: the picture is the same file at the same size (the largest of the
     addresses), but saving it from here gives it a readable name ("username (Display Name) -
     profile picture.jpg") instead of the server's. The tab is opened at once (inside the click,
     so pop-up blockers allow it) and filled in once the picture has been downloaded. */
  function openProfilePicture(uniqueId, avatar) {
    const tab = openLoadingTab();
    if (!tab) return;
    const name = profilePictureName(uniqueId);
    const urls = profilePictureUrls(uniqueId, avatar);
    largestImage(urls)
      .then(blob => showImage(tab, { blob }, name))
      .catch(() => {
        if (urls[0]) showImage(tab, { url: urls[0] }, name);
        else if (!tab.closed) tab.document.body.textContent = "Couldn't find this profile's picture.";
      });
  }

  /* ---------- Opening in a tab ---------- */

  function openLoadingTab() {
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      alert("Allow pop-ups for tiktok.com to open pictures in a new tab.");
      return null;
    }
    tab.document.title = "Loading…";
    tab.document.body.style.cssText =
      "margin:0;min-height:100vh;background:#111;color:#888;font:14px -apple-system,sans-serif;" +
      "display:flex;align-items:center;justify-content:center";
    tab.document.body.textContent = "Loading…";
    return tab;
  }

  /* Shows a picture in the tab, from a downloaded file or, when it couldn't be downloaded, from
     its address. Clicking zooms to full size (twice the size for small pictures) keeping the
     clicked point under the pointer; clicking again fits it. Only a downloaded file gets a
     Download button (and the S key): a picture shown from its address couldn't be downloaded. */
  function showImage(tab, { blob, url }, namePrefix) {
    if (tab.closed) return;
    const doc = tab.document;
    const name = namePrefix + "." + (blob ? extensionOf(blob.type) || "jpg" : "jpg");
    doc.title = name;
    doc.body.textContent = "";
    doc.body.style.cssText =
      "margin:0;min-height:100vh;box-sizing:border-box;padding-bottom:" + (blob ? 80 : 0) + "px;background:#111;" +
      "color:#ccc;font:14px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center";
    const image = doc.createElement("img");
    image.src = blob ? tab.URL.createObjectURL(blob) : url;
    const fitStyle = "max-width:100vw;max-height:calc(100vh - " + (blob ? 80 : 0) + "px);object-fit:contain;cursor:zoom-in";
    image.style.cssText = fitStyle;
    doc.body.append(image);

    let zoomed = false;
    image.addEventListener("click", event => {
      const rect = image.getBoundingClientRect();
      const ratioX = (event.clientX - rect.left) / rect.width;
      const ratioY = (event.clientY - rect.top) / rect.height;
      zoomed = !zoomed;
      if (!zoomed) {
        doc.body.style.alignItems = doc.body.style.justifyContent = "center";
        image.style.cssText = fitStyle;
        return;
      }
      const width = Math.max(image.naturalWidth, rect.width * 2);
      doc.body.style.alignItems = doc.body.style.justifyContent = "flex-start";
      image.style.cssText = "flex:none;margin:auto;max-width:none;max-height:none;cursor:zoom-out;width:" + width + "px";
      const zoomedRect = image.getBoundingClientRect();
      doc.scrollingElement.scrollLeft = ratioX * zoomedRect.width - event.clientX;
      doc.scrollingElement.scrollTop = ratioY * zoomedRect.height - event.clientY;
    });

    if (blob) {
      /* The Download button, fixed at the bottom centre so it stays in reach while zoomed. */
      const host = doc.createElement(HOST_TAG);
      host.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:1";
      const root = host.attachShadow({ mode: "open" });
      const style = doc.createElement("style");
      style.textContent = PILL_CSS + "button.busy svg{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}";
      const bar = doc.createElement("div");
      bar.className = "pill";
      const button = makeSmallButton("download", "Download (S)", () => saveBlob(blob, name));
      bar.append(button);
      root.append(style, bar);
      doc.body.append(host);
      doc.addEventListener("keydown", event => {
        if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          button.click();
        }
      });
    }
    tab.focus();
  }

  /* ---------- Buttons ---------- */

  const ICONS = {
    download: ["M12 3.5v11", "m7.5 10.5 4.5 4.5 4.5-4.5", "M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2"],
    /* An arrow out of a box: open in a new tab. */
    open: ["M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13", "M14.5 3.5h6v6", "m20.5 3.5-9 9"],
    /* Two photos, one behind the other: every photo of a post. */
    stack: ["M8.5 7.5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M3.5 15.5v-10a2 2 0 0 1 2-2h10", "m6.5 17.5 3.8-3.8a1.5 1.5 0 0 1 2.1 0l4 4"],
    /* A picture: the photo that is showing. */
    frame: ["M5 3.5h14A1.5 1.5 0 0 1 20.5 5v14a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z", "M9 7.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z", "m20.5 15.5-4.8-4.8a1.5 1.5 0 0 0-2.1 0L4 20.3"],
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["m5 12.5 4.5 4.5L19 7"],
    /* A thick check mark, among the filled icons. */
    doneSolid: { solid: ["M9.5 18.75a1.75 1.75 0 0 1-1.24-.51l-4.5-4.5a1.75 1.75 0 1 1 2.48-2.48l3.26 3.27 8.26-8.27a1.75 1.75 0 1 1 2.48 2.48l-9.5 9.5a1.75 1.75 0 0 1-1.24.51z"] },
    /* Filled versions, for the buttons among TikTok's own filled icons (like, comment,
       favourite, share). An arrow over a tray: */
    downloadSolid: { solid: [
      "M12 2a1.75 1.75 0 0 1 1.75 1.75v7.6l2.51-2.5a1.75 1.75 0 1 1 2.48 2.47l-5.5 5.5a1.75 1.75 0 0 1-2.48 0l-5.5-5.5a1.75 1.75 0 1 1 2.48-2.47l2.51 2.5v-7.6A1.75 1.75 0 0 1 12 2z",
      "M3.75 15a1.75 1.75 0 0 1 1.75 1.75v1.25c0 .28.22.5.5.5h12a.5.5 0 0 0 .5-.5v-1.25a1.75 1.75 0 1 1 3.5 0V18a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4v-1.25A1.75 1.75 0 0 1 3.75 15z",
    ] },
    /* A photo in front of another, with a mountain and a sun cut out of it: */
    stackSolid: { solid: [
      "M5 2.5h10.5a1.5 1.5 0 0 1 0 3h-10v10a1.5 1.5 0 0 1-3 0V5A2.5 2.5 0 0 1 5 2.5z",
      "M9.5 7.5h10A2.5 2.5 0 0 1 22 10v9a2.5 2.5 0 0 1-2.5 2.5h-10A2.5 2.5 0 0 1 7 19v-9a2.5 2.5 0 0 1 2.5-2.5zM12 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM10 19h9.5l-3.2-4.2-2.1 2.6-1.4-1.6z",
    ] },
  };

  /* The frosted pill that holds small buttons: the extra buttons beside the main one, and the
     bars over thumbnails and the profile picture. */
  /* TikTok's own pink-red (a liked heart), for buttons whose file has been downloaded. */
  const DONE_COLOUR = "#fe2c55";

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
    ".pill button.downloaded{color:" + DONE_COLOUR + "}",
  ].join("");

  function icon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    /* An icon is a list of outline paths, or { solid: [...] } for a filled one. (Not "fill":
       every list already has a fill method.) */
    const shape = ICONS[name];
    const solid = !Array.isArray(shape);
    if (solid) svg.classList.add("solid");
    for (const data of solid ? shape.solid : shape) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", data);
      if (solid) path.setAttribute("fill-rule", "evenodd");
      svg.append(path);
    }
    return svg;
  }

  /* Looks like TikTok's own buttons in the column: a 48 px circle with a small bold label under
     it. Colours are copied from the Share button, so light and dark themes both match. A photo
     post has a second one under it, for every photo. */
  const ACTION_CSS = [
    ":host{all:initial;display:flex;flex-direction:column;align-items:center;margin-top:var(--gap,0px)}",
    /* Sizes and spaces are copied from the Share button (set by makeActionHost): the space above
       its circle, the circle and icon sizes, and the space between the circle and its label. */
    ".unit{display:flex;flex-direction:column;align-items:center;padding-top:var(--pad,0px)}",
    ".unit[hidden]{display:none}",
    ".unit + .unit{margin-top:var(--unit-gap,0px)}",
    "button{all:unset;box-sizing:border-box;width:var(--size,48px);height:var(--size,48px);border-radius:999px;display:grid;place-items:center;",
    "cursor:pointer;background:var(--circle,rgba(22,24,35,.06));color:var(--fg,currentColor);transition:transform .1s,opacity .15s}",
    "button:hover{opacity:.75}",
    "button:active{transform:scale(.9)}",
    "button:focus-visible{outline:2px solid currentColor;outline-offset:2px}",
    "svg{width:var(--icon,24px);height:var(--icon,24px);fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}",
    "svg.solid{fill:currentColor;stroke:none}",
    "button.downloaded{color:" + DONE_COLOUR + "}",
    "button.busy svg{animation:spin .8s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    ".percent{font:700 12px/1 var(--font,-apple-system,sans-serif)}",
    ".label{margin-top:var(--label-gap,0px);font:700 12px/16px var(--font,-apple-system,sans-serif);color:var(--label,currentColor);text-align:center;white-space:nowrap}",
    /* In the viewer opened from a grid, the buttons sit in a row: a 32 px circle with its label
       beside it. */
    ":host([data-row]){flex-direction:row;gap:20px;margin:0}",
    ":host([data-row]) .unit{flex-direction:row;gap:6px;padding:0}",
    ":host([data-row]) .label{margin:0}",
    ":host([data-row]) .unit + .unit{margin:0}",
    ":host([data-row]) button{width:32px;height:32px}",
    ":host([data-row]) svg{width:18px;height:18px}",
    /* Moved under the row when it doesn't fit in it. */
    ":host([data-below]){margin-top:12px;align-self:flex-start}",
    /* Under a story, among its round buttons: side by side, no background and no label. */
    ":host([data-story]){flex-direction:row;gap:4px;margin:0}",
    ":host([data-story]) .unit{padding:0}",
    ":host([data-story]) .unit + .unit{margin:0}",
    ":host([data-story]) button{background:transparent}",
    ":host([data-story]) .label{display:none}",
  ].join("");

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
    const labelStyle = label && getComputedStyle(label);
    /* The layout: Share's icon box (its circle, or a bare icon in the For You feed) and label,
       measured from the box Share sits in. */
    const box = share.parentElement?.getBoundingClientRect();
    const iconBox = share.firstElementChild?.getBoundingClientRect();
    const labelBox = label?.getBoundingClientRect();
    const svgBox = svg?.getBoundingClientRect();
    const px = value => Math.max(0, Math.round(value)) + "px";
    const measured = box && iconBox && iconBox.width >= 16 && iconBox.height >= 16;
    return {
      circle: circle ? getComputedStyle(circle).backgroundColor : "",
      fg: svg ? getComputedStyle(svg).color : "",
      label: labelStyle ? labelStyle.color : "",
      font: labelStyle ? labelStyle.fontFamily : "",
      size: measured ? px(Math.max(iconBox.width, iconBox.height)) : "",
      icon: svgBox && svgBox.width >= 12 ? px(Math.min(svgBox.width, 28)) : "",
      pad: measured ? px(iconBox.top - box.top) : "",
      labelGap: measured && labelBox ? px(labelBox.top - iconBox.bottom) : "",
    };
  }

  /* The buttons for one post. The first saves the video, or for a photo post the photo that is
     showing; its label shows the quality that will be saved, or which photo ("3/7"), once the
     post's details are known (hovering looks them up if they aren't yet). A photo post with
     more than one photo also gets a second button, under the first, that saves them all. */
  function makeActionHost(id, share, { row = false, story = false, scope = () => null } = {}) {
    const host = document.createElement(HOST_TAG);
    host.dataset.id = id;
    if (row) host.dataset.row = "";
    if (story) host.dataset.story = "";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ACTION_CSS;
    const colours = shareStyle(share);
    /* No round background behind Share (the For You feed shows bare icons): none here either. */
    host.style.setProperty("--circle", colours.circle || "transparent");
    if (colours.fg) host.style.setProperty("--fg", colours.fg);
    if (colours.label) host.style.setProperty("--label", colours.label);
    if (colours.font) host.style.setProperty("--font", colours.font);
    if (!row && !story) {
      for (const [name, value] of [["--size", colours.size], ["--icon", colours.icon], ["--pad", colours.pad], ["--label-gap", colours.labelGap]]) {
        if (value) host.style.setProperty(name, value);
      }
    }
    if (story) host.style.setProperty("--fg", getComputedStyle(share).color);
    /* The space TikTok leaves between its own buttons: a margin under each, or the column's gap. */
    const shareGap = !row && !story && share.parentElement?.nextElementSibling ? getComputedStyle(share.parentElement).marginBottom : "";
    if (shareGap && shareGap !== "0px") host.style.setProperty("--gap", shareGap);
    const columnGap = share.parentElement?.parentElement ? getComputedStyle(share.parentElement.parentElement).rowGap : "";
    const unitGap = shareGap && shareGap !== "0px" ? shareGap : /px$/.test(columnGap) && columnGap !== "0px" ? columnGap : "";
    if (unitGap) host.style.setProperty("--unit-gap", unitGap);

    const makeUnit = iconName => {
      const unit = document.createElement("div");
      unit.className = "unit";
      const button = document.createElement("button");
      button.type = "button";
      button.append(icon(iconName));
      const label = document.createElement("span");
      label.className = "label";
      unit.append(button, label);
      return { unit, button, label };
    };
    /* Filled icons, like TikTok's own, except under a story, whose icons are outlines. */
    const mainIcon = story ? "download" : "downloadSolid";
    const allIcon = story ? "stack" : "stackSolid";
    const main = makeUnit(mainIcon);
    main.label.textContent = "Save";
    const all = makeUnit(allIcon);
    all.unit.hidden = true;
    root.append(style, main.unit, all.unit);

    /* Which photo is showing, kept up to date while the post's photos slide by. */
    let watching = 0;
    let added = false;
    const showIndex = item => {
      const count = item.imagePost.images.length;
      const index = shownPhotoIndex(item, scope());
      main.label.textContent = index >= 0 ? index + 1 + "/" + count : "Photo";
      main.button.repaint?.();
    };
    const watch = item => {
      if (watching) return;
      watching = setInterval(() => {
        if (host.isConnected) added = true;
        else if (added) {
          clearInterval(watching);
          return;
        }
        showIndex(item);
      }, 400);
    };

    const describe = item => {
      if (isPhotoPost(item)) {
        const count = item.imagePost.images.length;
        showIndex(item);
        watch(item);
        main.button.title = count > 1 ? "Download the photo that is showing" : "Download the photo";
        all.unit.hidden = count < 2;
        all.label.textContent = "All " + count;
        all.button.title = "Download all " + count + " photos";
        all.button.setAttribute("aria-label", all.button.title);
      } else {
        const best = rankVariants(item)[0];
        main.label.textContent = qualityLabel(best) || "Save";
        main.button.title = "Download video · " + qualityTitle(best);
        all.unit.hidden = true;
      }
      main.button.setAttribute("aria-label", main.button.title);
      main.button.repaint?.();
      all.button.repaint?.();
    };
    host.refresh = () => {
      if (items.has(id)) describe(items.get(id));
    };
    host.refresh();
    host.addEventListener("pointerenter", () => {
      if (!items.has(id)) itemFor(id).then(describe).catch(() => {});
    });

    const after = () => {
      if (items.has(id)) describe(items.get(id));
    };
    /* What the main button saves: the video, or the photo showing. */
    const mainKey = () => {
      const item = items.get(id);
      if (!item) return null;
      if (!isPhotoPost(item)) return "v:" + id;
      const index = shownPhotoIndex(item, scope());
      return index >= 0 ? "p:" + id + ":" + index : null;
    };
    wireButton(main.button, mainIcon, async onProgress => {
      const item = await itemFor(id);
      return isPhotoPost(item) ? downloadShownPhoto(id, scope()) : downloadItem(id, onProgress);
    }, after, mainKey);
    wireButton(all.button, allIcon, onProgress => downloadItem(id, onProgress), after, () => "a:" + id);
    main.button.repaint();
    all.button.repaint();
    isolateEvents(host);
    return host;
  }

  /* Clicking a button runs its action. While a download runs: a spinner, then the percentage
     (when the action reports it), then a check mark; an error is shown. An action that returns
     nothing (opening a tab) runs inside the click, so pop-up blockers allow it. A button with a
     key (doneKey, a function, since a photo post's key changes with the photo showing) turns
     pink once that has been downloaded, and still downloads it again when clicked.
     button.repaint() shows the right icon and title for its key. */
  function wireButton(button, iconName, action, after, doneKey) {
    const setIcon = name => button.replaceChildren(icon(name));
    if (doneKey) paintable.add(button);
    button.repaint = () => {
      button.painted = true;
      if (button.classList.contains("busy") || button.querySelector(".percent")) return;
      const title = (button.title || "").replace(/ · Downloaded.*$/, "");
      /* Downloaded: the same icon in TikTok's pink, as a liked heart turns red. */
      const done = isDownloaded(doneKey?.());
      setIcon(iconName);
      button.classList.toggle("downloaded", done);
      button.title = done ? title + " · Downloaded, click to download again" : title;
      button.setAttribute("aria-label", button.title);
    };
    button.addEventListener("click", () => {
      if (button.classList.contains("busy")) return;
      const key = doneKey?.();
      const onProgress = fraction => {
        const text = document.createElement("span");
        text.className = "percent";
        text.textContent = Math.round(fraction * 100) + "%";
        button.classList.remove("busy");
        button.replaceChildren(text);
      };
      let result;
      try {
        result = action(onProgress);
      } catch (error) {
        console.error(LOG, error);
        alert(error?.message || "Something went wrong.");
        return;
      }
      if (!(result instanceof Promise)) return;
      button.classList.add("busy");
      setIcon("busy");
      result.then(
        () => {
          markDownloaded(key);
          button.classList.remove("busy");
          setIcon(Array.isArray(ICONS[iconName]) ? "done" : "doneSolid");
          after?.();
          setTimeout(() => {
            button.replaceChildren();
            button.repaint();
          }, 1500);
        },
        error => {
          button.classList.remove("busy");
          button.replaceChildren();
          button.repaint();
          console.error(LOG, error);
          alert(error?.message || "Download failed.");
        });
    });
  }

  /* The main button downloads the video, or every photo of a photo post. */
  function wireDownload(button, id, describe) {
    wireButton(button, "download", onProgress => downloadItem(id, onProgress), () => {
      if (items.has(id)) describe(items.get(id));
    }, () => (isPhotoPost(items.get(id)) ? "a:" : "v:") + id);
    button.repaint();
  }

  function makeSmallButton(iconName, label, action, doneKey) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(iconName));
    wireButton(button, iconName, action, null, doneKey);
    if (doneKey) button.repaint();
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
    /* A button keeps focus after a click, so only keyboard focus keeps a bar showing. */
    ":host([data-hover]) .bar,.bar:has(:focus-visible){opacity:1;pointer-events:auto}",
    /* Over the profile picture, as in Instagram Downloader: open at the bottom left, download at
       the bottom right. */
    ".bar.avatar-left{left:0;top:auto;bottom:0}",
    ".bar.avatar-right{left:auto;right:0;top:auto;bottom:0}",
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
    bar.append(button);
    root.append(style, bar);
    const describe = item => {
      const best = isPhotoPost(item) ? null : rankVariants(item)[0];
      button.title = isPhotoPost(item)
        ? "Download " + item.imagePost.images.length + " photos at full size"
        : "Download video · " + qualityTitle(best);
      button.setAttribute("aria-label", button.title);
      button.repaint?.();
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
    const open = document.createElement("div");
    open.className = "pill bar avatar-left";
    open.append(makeSmallButton("open", "Open profile picture in a new tab", () => openProfilePicture(uniqueId, avatar)));
    const save = document.createElement("div");
    save.className = "pill bar avatar-right";
    save.append(makeSmallButton("download", "Download profile picture", () => downloadProfilePicture(uniqueId, avatar), () => "u:" + uniqueId));
    root.append(style, open, save);
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
        /* Inside an entry the id comes from the entry. The row beside the For You feed belongs
           to the entry on screen; its own "more" menu names that post, which also works for
           photo posts (they have no player to read the id from). */
        const inside = share.closest(ENTRY);
        const chrome = inside ? null : share.closest('[data-e2e="anchoring-chrome-host"]');
        const fromMenu = chrome?.querySelector("[data-more-menu-item-id]")?.dataset.moreMenuItemId;
        const entry = inside || entryOnScreen();
        const column = share.parentElement?.parentElement;
        if (!column || !entry && !fromMenu) continue;
        const id = /^\d{8,}$/.test(fromMenu || "") ? fromMenu : idOfEntry(entry);
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
      /* The row is the left half of a line whose right half holds the share icons. */
      const line = row?.parentElement?.parentElement;
      if (line?.parentElement) {
        const id = location.pathname.match(/\/(?:video|photo)\/(\d{8,})/)?.[1] || null;
        const existing = row.parentElement.querySelector(":scope > " + HOST_TAG) ||
          line.parentElement.querySelector(":scope > " + HOST_TAG + "[data-below]");
        let host = existing && existing.dataset.id === id ? existing : null;
        if (!host) {
          existing?.remove();
          if (id) {
            host = makeActionHost(id, favorite, { row: true });
            row.after(host);
            hosts.add(host);
          }
        }
        /* Squeezed against the share icons (the halves shrink rather than overlap), it goes on a
           line of its own under the row instead, labels and all. Checked again on every scan,
           since the labels only appear once the post's details are known. */
        const group = line.querySelector('[data-e2e="browse-share-group"]');
        if (host && !("below" in host.dataset) && group &&
          host.getBoundingClientRect().right > group.getBoundingClientRect().left - 16) {
          host.dataset.below = "";
          line.after(host);
        }
      }
      /* A story (opened from a profile picture): its round buttons under it, like and share,
         each in a box of its own; the address names the story that is showing. */
      const storyShare = document.querySelector('[class*="StoriesSocialBarContainer"] [data-e2e="share-btn"]');
      const storyBox = storyShare?.parentElement;
      if (storyBox?.parentElement) {
        const id = location.pathname.match(/\/(?:video|photo)\/(\d{8,})/)?.[1] || null;
        const existing = storyBox.parentElement.querySelector(":scope > " + HOST_TAG);
        if (!(existing && existing.dataset.id === id)) {
          existing?.remove();
          if (id) {
            const host = makeActionHost(id, storyShare, { story: true });
            storyBox.after(host);
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
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "href", "data-more-menu-item-id"] });
    /* Scrolling the feed changes which entry the buttons beside it belong to. */
    document.addEventListener("scroll", queueScan, { capture: true, passive: true });
    /* Leaving the page (opening a picture in a new tab, switching windows) hides the bars over
       thumbnails: the pointer may be elsewhere when the user comes back. */
    const onLeave = () => {
      for (const host of document.querySelectorAll(HOST_TAG + "[data-hover]")) host.removeAttribute("data-hover");
    };
    addEventListener("blur", onLeave);
    queueScan();

    return {
      stop() {
        observer.disconnect();
        document.removeEventListener("scroll", queueScan, { capture: true });
        removeEventListener("blur", onLeave);
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
    console.info(LOG, "version " + VERSION);
    if (page.__tiktokDownloader) {
      page.__tiktokDownloader.stop();
      page.__tiktokDownloader = null;
      toast("TikTok Downloader is off.");
      return;
    }
    const begin = () => {
      collectPageData();
      page.__tiktokDownloader = startButtons();
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
