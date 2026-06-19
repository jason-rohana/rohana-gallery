import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type GalleryPhotoResponse = {
  id: string;
  url: string;
  alt: string;
};

type StoredGalleryPhoto = {
  id: string;
  url: string;
  alt: string;
};

type GalleryCardForResponse = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  color: string;
  category: string;
  vehicleBrand: string;
  vehicleModel: string;
  wheelType: string;
  wheelSpecification: string;
  flickrAlbumUrl: string;
  flickrCoverUrl: string;
  photos: StoredGalleryPhoto[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return jsonResponse({ tabs: [] }, 401);
  }

  const url = new URL(request.url);
  const galleryId = url.searchParams.get("gallery_id");

  if (!galleryId) {
    return jsonResponse({ tabs: [] });
  }

  const gallery = await prisma.gallery.findFirst({
    where: {
      id: galleryId,
      shop: session.shop,
    },
    include: {
      tabs: {
        orderBy: { position: "asc" },
        include: {
          cards: {
            orderBy: { position: "asc" },
            include: {
              photos: {
                orderBy: { position: "asc" },
              },
            },
          },
        },
      },
    },
  });

  if (!gallery) {
    return jsonResponse({ tabs: [] }, 404);
  }

  const wheelModelImages = await prisma.wheelModelImage.findMany({
    where: { shop: session.shop },
  });
  const wheelModelImageByCode = new Map(
    wheelModelImages.map((wheelModelImage) => [
      wheelModelImage.modelCode,
      wheelModelImage,
    ]),
  );

  const cards = gallery.tabs
    .flatMap((tab) => tab.cards)
    .filter((card) => card.isActive);
  const preparedCards = await Promise.all(
    cards.map((card) => buildCardResponse(card, wheelModelImageByCode)),
  );
  const tabs = buildStorefrontTabs(preparedCards);

  return jsonResponse({
    id: gallery.id,
    name: gallery.name,
    tabs,
  });
};

const SUPPORTED_WHEEL_PREFIXES = ["RFX", "RFC", "RFG", "RLB", "RPM", "RFL", "RC"];

const FLICKR_DEFAULT_USER_NSID =
  process.env.FLICKR_USER_NSID || "59355137@N05";
const FLICKR_CACHE_MS = 10 * 60 * 1000;
const flickrAlbumCache = new Map<
  string,
  { expiresAt: number; photos: GalleryPhotoResponse[] }
>();

function findWheelModelCode(...values: string[]) {
  const text = values.join(" ").toUpperCase();

  for (const prefix of SUPPORTED_WHEEL_PREFIXES) {
    const match = text.match(new RegExp(`\\b${prefix}[\\s-]*([A-Z0-9]+)\\b`));

    if (match?.[1]) {
      return `${prefix}${match[1].replace(/[^A-Z0-9]/g, "")}`;
    }
  }

  return "";
}

async function buildCardResponse(
  card: GalleryCardForResponse,
  wheelModelImageByCode: Map<string, { imageUrl: string; alt: string }>,
) {
  const wheelModelCode = findWheelModelCode(
    card.subtitle,
    card.title,
    card.description,
    card.wheelSpecification,
  );
  const wheelModelImage = wheelModelCode
    ? wheelModelImageByCode.get(wheelModelCode)
    : null;
  const productImageUrl =
    wheelModelCode && !wheelModelImage?.imageUrl
      ? await getProductFirstImageUrl(wheelModelCode)
      : "";
  const photos = await getCardPhotos(
    card.flickrAlbumUrl,
    card.flickrCoverUrl,
    card.photos,
  );

  return {
    id: card.id,
    title: getDisplayTitle(card),
    subtitle: getDisplaySubtitle(card),
    description: card.wheelSpecification || card.description,
    color: card.color,
    category: card.category,
    vehicleBrand: card.vehicleBrand,
    vehicleModel: card.vehicleModel,
    wheelType: card.wheelType,
    wheelModel: wheelModelCode
      ? {
          code: wheelModelCode,
          imageUrl: wheelModelImage?.imageUrl || productImageUrl,
          alt: wheelModelImage?.alt || wheelModelCode,
          productUrl: getProductUrl(wheelModelCode),
        }
      : null,
    photos,
  };
}

type PreparedGalleryCard = Awaited<ReturnType<typeof buildCardResponse>>;

function buildStorefrontTabs(cards: PreparedGalleryCard[]) {
  const carCards = cards.filter((card) => card.category !== "wheel");
  const wheelCards = cards.filter((card) => card.category === "wheel");
  const brandNames = Array.from(
    new Set(carCards.map((card) => card.vehicleBrand.trim() || "Other")),
  ).sort((a, b) => a.localeCompare(b));
  const brandTabs = brandNames.map((brandName, index) => ({
    id: `brand-${index}-${slugify(brandName)}`,
    title: brandName,
    cards: carCards
      .filter((card) => (card.vehicleBrand.trim() || "Other") === brandName)
      .sort(sortPreparedCards),
  }));

  if (!wheelCards.length) {
    return brandTabs;
  }

  return [
    ...brandTabs,
    {
      id: "wheel-albums",
      title: "Wheels",
      cards: wheelCards.sort(sortPreparedCards),
    },
  ];
}

function sortPreparedCards(a: PreparedGalleryCard, b: PreparedGalleryCard) {
  return getCardSortKey(a).localeCompare(getCardSortKey(b));
}

function getCardSortKey(card: PreparedGalleryCard) {
  return (card.vehicleModel || card.title).toLowerCase();
}

function getDisplayTitle(card: GalleryCardForResponse) {
  if (card.category !== "wheel") {
    const vehicleTitle = [card.vehicleBrand, card.vehicleModel]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");

    if (vehicleTitle) return vehicleTitle;
  }

  return card.title;
}

function getDisplaySubtitle(card: GalleryCardForResponse) {
  return [getWheelTypeLabel(card.wheelType), card.subtitle]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" | ");
}

function getWheelTypeLabel(wheelType: string) {
  if (wheelType === "cross-forged") return "Cross-forged";
  if (wheelType === "forged") return "Forged";
  return "";
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tab"
  );
}

async function getCardPhotos(
  flickrAlbumUrl: string,
  flickrCoverUrl: string,
  storedPhotos: StoredGalleryPhoto[],
) {
  const savedPhotos = storedPhotos.map((photo) => ({
    id: photo.id,
    url: photo.url,
    alt: photo.alt,
  }));
  const coverPhoto = flickrCoverUrl
    ? [
        {
          id: `flickr-cover-${getFlickrAlbumParts(flickrAlbumUrl)?.albumId || "album"}`,
          url: flickrCoverUrl,
          alt: "Flickr gallery cover image",
        },
      ]
    : [];
  const fallbackPhotos = savedPhotos.length ? savedPhotos : coverPhoto;

  if (!flickrAlbumUrl.trim()) {
    return fallbackPhotos;
  }

  try {
    const flickrPhotos = await getFlickrAlbumPhotos(flickrAlbumUrl);
    return flickrPhotos.length ? flickrPhotos : fallbackPhotos;
  } catch (error) {
    return fallbackPhotos;
  }
}

async function getFlickrAlbumPhotos(albumUrl: string) {
  const albumParts = getFlickrAlbumParts(albumUrl);

  if (!albumParts) {
    return [];
  }

  const cacheKey = `${albumParts.nsid}:${albumParts.albumId}`;
  const cached = flickrAlbumCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.photos;
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

  const photos =
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
      .filter((photo): photo is GalleryPhotoResponse => Boolean(photo)) || [];

  flickrAlbumCache.set(cacheKey, {
    expiresAt: Date.now() + FLICKR_CACHE_MS,
    photos,
  });

  return photos;
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

const PRODUCT_IMAGE_SOURCE_ORIGIN =
  process.env.PRODUCT_IMAGE_SOURCE_ORIGIN || "https://www.rohanawheels.com";
const productFirstImageCache = new Map<string, string>();

function getProductUrl(modelCode: string) {
  return new URL(
    `/products/${modelCode.toLowerCase()}`,
    PRODUCT_IMAGE_SOURCE_ORIGIN,
  ).toString();
}

async function getProductFirstImageUrl(modelCode: string) {
  if (productFirstImageCache.has(modelCode)) {
    return productFirstImageCache.get(modelCode) || "";
  }

  try {
    const productUrl = new URL(
      `/products/${modelCode.toLowerCase()}.js`,
      PRODUCT_IMAGE_SOURCE_ORIGIN,
    );
    const response = await fetch(productUrl);

    if (!response.ok) {
      productFirstImageCache.set(modelCode, "");
      return "";
    }

    const product = await response.json();
    const imageUrl = getFirstProductImageUrl(product);
    productFirstImageCache.set(modelCode, imageUrl);
    return imageUrl;
  } catch (error) {
    productFirstImageCache.set(modelCode, "");
    return "";
  }
}

function getFirstProductImageUrl(product: unknown) {
  if (!product || typeof product !== "object") return "";

  const productData = product as {
    featured_image?: string | { src?: string };
    images?: Array<string | { src?: string }>;
  };
  const firstImage = productData.images?.[0] || productData.featured_image || "";
  const imageUrl =
    typeof firstImage === "string" ? firstImage : firstImage?.src || "";

  if (!imageUrl) return "";
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  if (imageUrl.startsWith("/")) {
    return new URL(imageUrl, PRODUCT_IMAGE_SOURCE_ORIGIN).toString();
  }

  return imageUrl;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
