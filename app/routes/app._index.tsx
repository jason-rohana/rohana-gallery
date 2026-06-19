import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
} from "react-router";
import type { ComponentProps } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type AdminFormProps = ComponentProps<typeof Form>;

type FlickrAlbum = {
  id: string;
  title: string;
  url: string;
  coverUrl: string;
};

const FLICKR_ALBUMS_URL =
  process.env.FLICKR_ALBUMS_URL ||
  "https://www.flickr.com/photos/rohanawheels/albums/";
const FLICKR_ORIGIN = "https://www.flickr.com";
const SHOPIFY_CONTEXT_PARAMS = ["shop", "host", "embedded"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedGalleryId = url.searchParams.get("gallery");

  const galleries = await prisma.gallery.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      updatedAt: true,
    },
  });

  if (!galleries.length) {
    const gallery = await createDefaultGallery(session.shop);
    return redirect(getAppPath(request, gallery.id));
  }

  const selectedGalleryId = requestedGalleryId || galleries[0]?.id || "";
  const gallery =
    (await prisma.gallery.findFirst({
      where: {
        id: selectedGalleryId,
        shop: session.shop,
      },
      include: {
        tabs: {
          orderBy: { position: "asc" },
          include: {
            cards: {
              orderBy: [{ position: "asc" }, { title: "asc" }],
              include: {
                photos: {
                  orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                },
              },
            },
          },
        },
      },
    })) ||
    (await prisma.gallery.findFirst({
      where: {
        id: galleries[0].id,
        shop: session.shop,
      },
      include: {
        tabs: {
          orderBy: { position: "asc" },
          include: {
            cards: {
              orderBy: [{ position: "asc" }, { title: "asc" }],
              include: {
                photos: {
                  orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                },
              },
            },
          },
        },
      },
    }));

  if (!gallery) {
    throw new Response("Gallery not found", { status: 404 });
  }

  const cards = gallery.tabs
    .flatMap((tab) => tab.cards)
    .sort(sortAdminCards);

  const stats = {
    total: cards.length,
    active: cards.filter((card) => card.isActive).length,
    cars: cards.filter((card) => card.category !== "wheel").length,
    wheels: cards.filter((card) => card.category === "wheel").length,
  };

  return {
    galleries,
    gallery,
    cards,
    stats,
    proxyPath: "/apps/car-gallery",
    flickrAlbumsUrl: FLICKR_ALBUMS_URL,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = getString(formData, "_action");

  try {
    if (intent === "create_gallery") {
      const gallery = await prisma.gallery.create({
        data: {
          shop: session.shop,
          name: getString(formData, "name", "Rohana Flickr Gallery"),
          tabs: {
            create: {
              title: "Flickr albums",
              position: 0,
            },
          },
        },
      });

      return redirect(getAppPath(request, gallery.id));
    }

    if (intent === "update_gallery") {
      const gallery = await findGalleryForShop(
        getString(formData, "galleryId"),
        session.shop,
      );

      await prisma.gallery.update({
        where: { id: gallery.id },
        data: { name: getString(formData, "name", gallery.name) },
      });

      return redirect(getAppPath(request, gallery.id));
    }

    if (intent === "sync_flickr_albums") {
      const gallery = await findGalleryForShop(
        getString(formData, "galleryId"),
        session.shop,
      );
      const tab = await ensurePrimaryTab(gallery.id);
      const albums = await fetchFlickrAlbums();
      const existingCards = await prisma.galleryCard.findMany({
        where: {
          tab: {
            galleryId: gallery.id,
          },
        },
      });
      const existingByAlbumId = new Map(
        existingCards
          .map((card) => [card.flickrAlbumId || getFlickrAlbumId(card.flickrAlbumUrl), card])
          .filter(([albumId]) => Boolean(albumId)) as Array<
          [string, (typeof existingCards)[number]]
        >,
      );
      let createdCount = 0;

      for (const album of albums) {
        const existingCard = existingByAlbumId.get(album.id);

        if (existingCard) {
          await prisma.galleryCard.update({
            where: { id: existingCard.id },
            data: {
              flickrAlbumId: album.id,
              flickrAlbumUrl: album.url,
              flickrCoverUrl: album.coverUrl,
            },
          });
          continue;
        }

        const inferred = inferAlbumMetadata(album.title);

        await prisma.galleryCard.create({
          data: {
            tabId: tab.id,
            title: album.title,
            subtitle: inferred.wheelLabel,
            category: inferred.category,
            isActive: true,
            vehicleBrand: inferred.vehicleBrand,
            vehicleModel: inferred.vehicleModel,
            wheelType: inferred.wheelType,
            flickrAlbumId: album.id,
            flickrAlbumUrl: album.url,
            flickrCoverUrl: album.coverUrl,
            position: existingCards.length + createdCount,
          },
        });
        createdCount += 1;
      }

      return redirect(getAppPath(request, gallery.id));
    }

    if (intent === "update_album") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );

      await prisma.galleryCard.update({
        where: { id: card.id },
        data: {
          title: getString(formData, "title", card.title),
          subtitle: getString(formData, "subtitle"),
          category: normalizeCategory(getString(formData, "category")),
          isActive: formData.get("isActive") === "on",
          vehicleBrand: getString(formData, "vehicleBrand"),
          vehicleModel: getString(formData, "vehicleModel"),
          wheelType: normalizeWheelType(getString(formData, "wheelType")),
          wheelSpecification: getString(formData, "wheelSpecification"),
        },
      });

      return redirect(getAppPath(request, card.tab.galleryId));
    }

    throw new Error("Unknown action.");
  } catch (error) {
    return {
      error: getActionErrorMessage(error),
    };
  }
};

function AdminForm({ action, ...props }: AdminFormProps) {
  const location = useLocation();

  return <Form {...props} action={action ?? getAppIndexActionPath(location.search)} />;
}

export default function Index() {
  const {
    galleries,
    gallery,
    cards,
    stats,
    proxyPath,
    flickrAlbumsUrl,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();

  return (
    <s-page heading="Car Gallery">
      <style>{styles}</style>

      {actionData && "error" in actionData && actionData.error ? (
        <s-banner tone="critical">{actionData.error}</s-banner>
      ) : null}

      <s-section heading="Gallery library">
        <div className="cg-toolbar">
          <AdminForm method="post" className="cg-form cg-inline-form">
            <input type="hidden" name="_action" value="create_gallery" />
            <label>
              <span>New gallery name</span>
              <input name="name" placeholder="Rohana Flickr Gallery" />
            </label>
            <button type="submit">Create gallery</button>
          </AdminForm>

          {galleries.length ? (
            <div className="cg-gallery-list" aria-label="Saved galleries">
              {galleries.map((item) => (
                <a
                  className={`cg-pill ${gallery.id === item.id ? "is-active" : ""}`}
                  href={getAppPathFromSearch(location.search, item.id)}
                  key={item.id}
                >
                  {item.name}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </s-section>

      <s-section heading="Theme block setup">
        <div className="cg-setup">
          <AdminForm method="post" className="cg-form cg-inline-form">
            <input type="hidden" name="_action" value="update_gallery" />
            <input type="hidden" name="galleryId" value={gallery.id} />
            <label>
              <span>Gallery name</span>
              <input name="name" defaultValue={gallery.name} />
            </label>
            <button type="submit">Save name</button>
          </AdminForm>

          <div className="cg-copy-grid">
            <label>
              <span>Gallery ID for the theme block</span>
              <input readOnly value={gallery.id} />
            </label>
            <label>
              <span>Theme endpoint</span>
              <input readOnly value={proxyPath} />
            </label>
          </div>
        </div>
      </s-section>

      <s-section heading="Flickr import">
        <div className="cg-import">
          <div>
            <p className="cg-muted">
              Syncs public albums from <a href={flickrAlbumsUrl}>{flickrAlbumsUrl}</a>.
              Existing album settings stay intact; new albums are added as active.
            </p>
            <div className="cg-stats">
              <span>{stats.total} albums</span>
              <span>{stats.active} active</span>
              <span>{stats.cars} cars</span>
              <span>{stats.wheels} wheels</span>
            </div>
          </div>

          <AdminForm method="post">
            <input type="hidden" name="_action" value="sync_flickr_albums" />
            <input type="hidden" name="galleryId" value={gallery.id} />
            <button type="submit">Sync Flickr albums</button>
          </AdminForm>
        </div>
      </s-section>

      <s-section heading="Album curation">
        {cards.length ? (
          <div className="cg-albums">
            {cards.map((card) => (
              <article
                className={`cg-album ${card.isActive ? "" : "is-inactive"}`}
                key={card.id}
              >
                <a
                  className="cg-cover"
                  href={card.flickrAlbumUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {card.flickrCoverUrl ? (
                    <img src={card.flickrCoverUrl} alt={card.title} />
                  ) : (
                    <span>{card.title}</span>
                  )}
                </a>

                <AdminForm method="post" className="cg-form cg-album-form">
                  <input type="hidden" name="_action" value="update_album" />
                  <input type="hidden" name="cardId" value={card.id} />

                  <div className="cg-album-topline">
                    <label className="cg-check">
                      <input
                        type="checkbox"
                        name="isActive"
                        defaultChecked={card.isActive}
                      />
                      <span>Active</span>
                    </label>

                    <label>
                      <span>Category</span>
                      <select name="category" defaultValue={card.category || "car"}>
                        <option value="car">Car</option>
                        <option value="wheel">Wheel</option>
                      </select>
                    </label>

                    <label>
                      <span>Wheel type</span>
                      <select name="wheelType" defaultValue={card.wheelType}>
                        <option value="">Not set</option>
                        <option value="cross-forged">Cross-forged</option>
                        <option value="forged">Forged</option>
                      </select>
                    </label>
                  </div>

                  <label>
                    <span>Album title</span>
                    <input name="title" defaultValue={card.title} />
                  </label>

                  <div className="cg-two-fields">
                    <label>
                      <span>Vehicle brand</span>
                      <input name="vehicleBrand" defaultValue={card.vehicleBrand} />
                    </label>
                    <label>
                      <span>Vehicle model</span>
                      <input name="vehicleModel" defaultValue={card.vehicleModel} />
                    </label>
                  </div>

                  <label>
                    <span>Wheel model / finish</span>
                    <input
                      name="subtitle"
                      defaultValue={card.subtitle}
                      placeholder="RFX11 Brushed Titanium"
                    />
                  </label>

                  <label>
                    <span>Wheel specification</span>
                    <textarea
                      name="wheelSpecification"
                      defaultValue={card.wheelSpecification}
                      rows={2}
                      placeholder="Front: 22x10.5 Rear: 22x11.5"
                    />
                  </label>

                  <button type="submit">Save album</button>
                </AdminForm>
              </article>
            ))}
          </div>
        ) : (
          <p className="cg-muted">Sync Flickr albums to start curating.</p>
        )}
      </s-section>
    </s-page>
  );
}

function sortAdminCards(
  a: { category: string; vehicleBrand: string; vehicleModel: string; title: string },
  b: { category: string; vehicleBrand: string; vehicleModel: string; title: string },
) {
  return [
    a.category.localeCompare(b.category),
    a.vehicleBrand.localeCompare(b.vehicleBrand),
    a.vehicleModel.localeCompare(b.vehicleModel),
    a.title.localeCompare(b.title),
  ].find((result) => result !== 0) || 0;
}

async function createDefaultGallery(shop: string) {
  return prisma.gallery.create({
    data: {
      shop,
      name: "Rohana Flickr Gallery",
      tabs: {
        create: {
          title: "Flickr albums",
          position: 0,
        },
      },
    },
  });
}

async function findGalleryForShop(id: string, shop: string) {
  const gallery = await prisma.gallery.findFirst({
    where: { id, shop },
  });

  if (!gallery) throw new Error("Gallery not found.");
  return gallery;
}

async function ensurePrimaryTab(galleryId: string) {
  const tab = await prisma.galleryTab.findFirst({
    where: { galleryId },
    orderBy: { position: "asc" },
  });

  if (tab) return tab;

  return prisma.galleryTab.create({
    data: {
      galleryId,
      title: "Flickr albums",
      position: 0,
    },
  });
}

async function findCardForShop(id: string, shop: string) {
  const card = await prisma.galleryCard.findFirst({
    where: {
      id,
      tab: {
        gallery: { shop },
      },
    },
    include: {
      tab: true,
    },
  });

  if (!card) throw new Error("Album not found.");
  return card;
}

async function fetchFlickrAlbums() {
  const albums: FlickrAlbum[] = [];
  const seenAlbumIds = new Set<string>();

  for (let page = 1; page <= 50; page += 1) {
    const pageUrl =
      page === 1
        ? FLICKR_ALBUMS_URL
        : new URL(`page${page}/`, FLICKR_ALBUMS_URL).toString();
    const response = await fetch(pageUrl);

    if (!response.ok) {
      if (page === 1) throw new Error("Could not load the Flickr albums page.");
      break;
    }

    const html = await response.text();
    const pageAlbums = parseFlickrAlbumsPage(html);
    const newAlbums = pageAlbums.filter((album) => !seenAlbumIds.has(album.id));

    if (!newAlbums.length) break;

    newAlbums.forEach((album) => {
      seenAlbumIds.add(album.id);
      albums.push(album);
    });

    if (pageAlbums.length < 24) break;
  }

  return albums;
}

function parseFlickrAlbumsPage(html: string) {
  const albums: FlickrAlbum[] = [];
  const pattern =
    /<div\s+class="view photo-list-album-view[^>]*background-image:\s*url\((?<cover>[^)]+)\)[\s\S]*?<a[^>]+href="(?<href>\/photos\/[^/]+\/albums\/(?<id>\d+))"\s+title="(?<title>[^"]+)"/g;

  for (const match of html.matchAll(pattern)) {
    const id = match.groups?.id || "";
    const href = match.groups?.href || "";
    const title = decodeHtml(match.groups?.title || "");
    const coverUrl = normalizeUrl(match.groups?.cover || "");

    if (!id || !href || !title) continue;

    albums.push({
      id,
      title,
      url: new URL(href, FLICKR_ORIGIN).toString(),
      coverUrl,
    });
  }

  return albums;
}

function inferAlbumMetadata(title: string) {
  const [vehiclePart, ...wheelParts] = title.split(/\s+-\s+/);
  const vehicleLabel = vehiclePart.trim();
  const wheelLabel = wheelParts.join(" - ").trim();
  const startsWithWheel = Boolean(findWheelModelCode(vehicleLabel));
  const category = startsWithWheel ? "wheel" : "car";
  const vehicleBrand = category === "car" ? detectVehicleBrand(vehicleLabel) : "";
  const vehicleModel =
    category === "car"
      ? vehicleLabel.slice(vehicleBrand.length).trim() || vehicleLabel
      : "";

  return {
    category,
    vehicleBrand,
    vehicleModel,
    wheelLabel,
    wheelType: inferWheelType(wheelLabel || title),
  };
}

function detectVehicleBrand(vehicleLabel: string) {
  const normalized = vehicleLabel.trim();
  const brands = [
    "Mercedes-Benz",
    "Mercedes Benz",
    "Land Rover",
    "Rolls Royce",
    "Rolls-Royce",
    "Aston Martin",
    "Alfa Romeo",
    "Chevrolet",
    "Lamborghini",
    "Volkswagen",
    "McLaren",
    "Porsche",
    "Ferrari",
    "Genesis",
    "Cadillac",
    "Infiniti",
    "Maserati",
    "Bentley",
    "Toyota",
    "Nissan",
    "Lexus",
    "Honda",
    "Dodge",
    "Acura",
    "Audi",
    "Ford",
    "Jeep",
    "Subaru",
    "Tesla",
    "Volvo",
    "BMW",
    "Kia",
  ].sort((a, b) => b.length - a.length);
  const match = brands.find((brand) =>
    normalized.toLowerCase().startsWith(brand.toLowerCase()),
  );

  if (match) return match === "Mercedes Benz" ? "Mercedes-Benz" : match;

  return normalized.split(/\s+/)[0] || "";
}

const WHEEL_PREFIXES = ["RFX", "RFC", "RFG", "RLB", "RPM", "RFL", "RC"];

function findWheelModelCode(value: string) {
  const text = value.toUpperCase();

  for (const prefix of WHEEL_PREFIXES) {
    const match = text.match(new RegExp(`\\b${prefix}[\\s-]*([A-Z0-9]+)\\b`));
    if (match?.[1]) return `${prefix}${match[1].replace(/[^A-Z0-9]/g, "")}`;
  }

  return "";
}

function inferWheelType(value: string) {
  const wheelCode = findWheelModelCode(value);

  if (/^(RFG|RLB|RPM|RFL)/.test(wheelCode)) return "forged";
  if (/^(RFX|RFC|RC)/.test(wheelCode)) return "cross-forged";
  if (/forged/i.test(value)) return "forged";
  return "";
}

function normalizeCategory(value: string) {
  return value === "wheel" ? "wheel" : "car";
}

function normalizeWheelType(value: string) {
  return value === "cross-forged" || value === "forged" ? value : "";
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return new URL(trimmed, FLICKR_ORIGIN).toString();
  return trimmed;
}

function getFlickrAlbumId(value: string) {
  return value.match(/\/(?:albums|sets)\/(\d+)/i)?.[1] || "";
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);

  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  return trimmed || fallback;
}

function getActionErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function getAppPath(request: Request, galleryId?: string) {
  return getAppPathFromSearch(new URL(request.url).search, galleryId);
}

function getAppPathFromSearch(search: string, galleryId?: string) {
  const currentParams = new URLSearchParams(search);
  const appParams = new URLSearchParams();

  SHOPIFY_CONTEXT_PARAMS.forEach((key) => {
    const value = currentParams.get(key);

    if (value) {
      appParams.set(key, value);
    }
  });

  if (galleryId) {
    appParams.set("gallery", galleryId);
  }

  const query = appParams.toString();
  return `/app${query ? `?${query}` : ""}`;
}

function getAppIndexActionPath(search: string) {
  const currentParams = new URLSearchParams(search);
  const actionParams = new URLSearchParams();

  actionParams.set("index", "");

  SHOPIFY_CONTEXT_PARAMS.forEach((key) => {
    const value = currentParams.get(key);

    if (value) {
      actionParams.set(key, value);
    }
  });

  const galleryId = currentParams.get("gallery");

  if (galleryId) {
    actionParams.set("gallery", galleryId);
  }

  return `/app?${actionParams.toString()}`;
}

const styles = `
  .cg-toolbar,
  .cg-setup,
  .cg-import,
  .cg-albums {
    display: grid;
    gap: 16px;
  }

  .cg-inline-form,
  .cg-copy-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 12px;
  }

  .cg-gallery-list,
  .cg-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .cg-pill,
  .cg-stats span {
    border: 1px solid #d0d0d0;
    border-radius: 999px;
    color: #303030;
    padding: 8px 12px;
    text-decoration: none;
  }

  .cg-pill.is-active {
    background: #111;
    border-color: #111;
    color: #fff;
  }

  .cg-form label,
  .cg-copy-grid label {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .cg-form span,
  .cg-copy-grid span {
    color: #616161;
    font-size: 12px;
    font-weight: 700;
  }

  .cg-form input,
  .cg-form select,
  .cg-form textarea,
  .cg-copy-grid input {
    width: 100%;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    font: inherit;
    padding: 9px 10px;
  }

  .cg-form textarea {
    resize: vertical;
  }

  .cg-form button,
  .cg-import button {
    border: 1px solid #1f1f1f;
    border-radius: 6px;
    background: #1f1f1f;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    min-height: 38px;
    padding: 8px 12px;
  }

  .cg-form button:hover,
  .cg-import button:hover {
    background: #000;
  }

  .cg-import {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }

  .cg-muted {
    color: #616161;
    line-height: 1.5;
  }

  .cg-muted a {
    color: inherit;
  }

  .cg-albums {
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  }

  .cg-album {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    gap: 14px;
    border: 1px solid #dedede;
    border-radius: 8px;
    background: #fff;
    padding: 14px;
  }

  .cg-album.is-inactive {
    opacity: 0.62;
  }

  .cg-cover {
    min-height: 150px;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 6px;
    background: linear-gradient(135deg, #111, #555);
    color: #fff;
    font-weight: 800;
    text-align: center;
    text-decoration: none;
  }

  .cg-cover img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .cg-album-form {
    display: grid;
    gap: 10px;
  }

  .cg-album-topline,
  .cg-two-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .cg-album-topline {
    grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
    align-items: end;
  }

  .cg-check {
    align-items: center;
    grid-template-columns: auto auto;
    justify-content: start;
    padding-bottom: 9px;
  }

  .cg-check input {
    width: auto;
  }

  @media (max-width: 900px) {
    .cg-inline-form,
    .cg-copy-grid,
    .cg-import,
    .cg-albums,
    .cg-album,
    .cg-album-topline,
    .cg-two-fields {
      grid-template-columns: 1fr;
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
