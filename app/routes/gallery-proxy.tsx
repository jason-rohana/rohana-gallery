import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

  return jsonResponse({
    id: gallery.id,
    name: gallery.name,
    tabs: await Promise.all(
      gallery.tabs.map(async (tab) => ({
        id: tab.id,
        title: tab.title,
        cards: await Promise.all(
          tab.cards.map(async (card) => {
            const wheelModelCode = findWheelModelCode(
              card.subtitle,
              card.title,
              card.description,
            );
            const wheelModelImage = wheelModelCode
              ? wheelModelImageByCode.get(wheelModelCode)
              : null;
            const productImageUrl =
              wheelModelCode && !wheelModelImage?.imageUrl
                ? await getProductFirstImageUrl(wheelModelCode)
                : "";

            return {
              id: card.id,
              title: card.title,
              subtitle: card.subtitle,
              description: card.description,
              color: card.color,
              wheelModel: wheelModelCode
                ? {
                    code: wheelModelCode,
                    imageUrl: wheelModelImage?.imageUrl || productImageUrl,
                    alt: wheelModelImage?.alt || wheelModelCode,
                    productUrl: getProductUrl(wheelModelCode),
                  }
                : null,
              photos: card.photos.map((photo) => ({
                id: photo.id,
                url: photo.url,
                alt: photo.alt,
              })),
            };
          }),
        ),
      })),
    ),
  });
};

const SUPPORTED_WHEEL_PREFIXES = ["RFX", "RFC", "RFG", "RLB", "RPM", "RFL", "RC"];

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
