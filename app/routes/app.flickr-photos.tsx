import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

type FlickrPhoto = {
  id: string;
  url: string;
  alt: string;
};

const FLICKR_DEFAULT_USER_NSID =
  process.env.FLICKR_USER_NSID || "59355137@N05";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const albumUrl = url.searchParams.get("albumUrl") || "";

  if (!albumUrl.trim()) {
    return jsonResponse({ photos: [] }, 400);
  }

  return jsonResponse({
    photos: await getFlickrAlbumPhotos(albumUrl),
  });
};

async function getFlickrAlbumPhotos(albumUrl: string) {
  const albumParts = getFlickrAlbumParts(albumUrl);

  if (!albumParts) {
    return [];
  }

  const feedUrl = new URL("https://www.flickr.com/services/feeds/photoset.gne");
  feedUrl.searchParams.set("set", albumParts.albumId);
  feedUrl.searchParams.set("nsid", albumParts.nsid);
  feedUrl.searchParams.set("lang", "en-us");
  feedUrl.searchParams.set("format", "json");
  feedUrl.searchParams.set("nojsoncallback", "1");

  const response = await fetch(feedUrl);

  if (!response.ok) {
    throw new Error("Flickr album feed failed.");
  }

  const feed = (await response.json()) as {
    items?: Array<{
      title?: string;
      link?: string;
      media?: { m?: string };
    }>;
  };

  return (
    feed.items
      ?.map((item, index) => {
        const imageUrl = item.media?.m ? getLargeFlickrImageUrl(item.media.m) : "";

        if (!imageUrl) return null;

        return {
          id:
            getFlickrPhotoId(item.link || "") ||
            `flickr-${albumParts.albumId}-${index + 1}`,
          url: imageUrl,
          alt: item.title || "Flickr gallery image",
        };
      })
      .filter((photo): photo is FlickrPhoto => Boolean(photo)) || []
  );
}

function getFlickrAlbumParts(value: string) {
  const trimmedValue = value.trim();
  const albumId =
    trimmedValue.match(/\/(?:albums|sets)\/(\d+)/i)?.[1] ||
    trimmedValue.match(/\b(\d{10,})\b/)?.[1] ||
    "";

  if (!albumId) return null;

  const ownerPathValue = trimmedValue.match(/\/photos\/([^/?#]+)\//i)?.[1] || "";
  const nsidQueryValue = trimmedValue.match(/[?&]nsid=([^&#]+)/i)?.[1] || "";
  const decodedNsid = decodeURIComponent(nsidQueryValue || ownerPathValue);
  const nsid = decodedNsid.includes("@") ? decodedNsid : FLICKR_DEFAULT_USER_NSID;

  return { albumId, nsid };
}

function getLargeFlickrImageUrl(url: string) {
  return url.replace(/_[a-z](\.[a-z0-9]+)$/i, "_b$1");
}

function getFlickrPhotoId(url: string) {
  return url.match(/\/photos\/[^/]+\/(\d+)/i)?.[1] || "";
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
}
