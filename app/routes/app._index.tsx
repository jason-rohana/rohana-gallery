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
import { useEffect, useMemo, useState, type ComponentProps } from "react";
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

type AlbumMetadata = {
  category: string;
  vehicleBrand: string;
  vehicleModel: string;
  wheelLabel: string;
  wheelType: string;
};

type AutoRepairCard = {
  category: string;
  vehicleBrand: string;
  vehicleModel: string;
  subtitle: string;
  wheelType: string;
};

type AdminCard = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  color: string;
  category: string;
  isActive: boolean;
  vehicleBrand: string;
  vehicleModel: string;
  wheelType: string;
  wheelSpecification: string;
  flickrAlbumId: string;
  flickrAlbumUrl: string;
  flickrCoverUrl: string;
  referenceId: string;
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
    .map((card) => ({
      ...card,
      referenceId: getReferenceId(card),
    }))
    .sort(sortAdminCards);
  const brandSummaries = getBrandSummaries(cards, gallery.id);

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
    brandSummaries,
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

    if (intent === "sync_flickr_albums" || intent === "refresh_flickr_albums") {
      const gallery = await findGalleryForShop(
        getString(formData, "galleryId"),
        session.shop,
      );
      const shouldUpdateExisting = intent === "sync_flickr_albums";
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
          if (!shouldUpdateExisting) continue;

          const inferred = inferAlbumMetadata(album.title);

          await prisma.galleryCard.update({
            where: { id: existingCard.id },
            data: {
              flickrAlbumId: album.id,
              flickrAlbumUrl: album.url,
              flickrCoverUrl: album.coverUrl,
              ...getAutoRepairAlbumData(existingCard, inferred),
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

      return redirect(getActionRedirectPath(request, formData, gallery.id));
    }

    if (intent === "update_album") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );

      await prisma.galleryCard.update({
        where: { id: card.id },
        data: getAlbumUpdateData(formData, card, (field) => field),
      });

      return redirect(getActionRedirectPath(request, formData, card.tab.galleryId));
    }

    if (intent === "bulk_update_albums") {
      const gallery = await findGalleryForShop(
        getString(formData, "galleryId"),
        session.shop,
      );
      const deleteCardId = getString(formData, "deleteCardId");

      if (deleteCardId) {
        const card = await findCardForShop(deleteCardId, session.shop);

        await prisma.galleryCard.delete({ where: { id: card.id } });
        return redirect(getActionRedirectPath(request, formData, card.tab.galleryId));
      }

      const cardIds = formData
        .getAll("cardId")
        .map((value) => (typeof value === "string" ? value : ""))
        .filter(Boolean);

      if (!cardIds.length) {
        throw new Error("No albums were submitted.");
      }

      const cards = await prisma.galleryCard.findMany({
        where: {
          id: { in: cardIds },
          tab: {
            gallery: {
              id: gallery.id,
              shop: session.shop,
            },
          },
        },
        include: {
          tab: true,
        },
      });
      const cardsById = new Map(cards.map((card) => [card.id, card]));

      if (cards.length !== cardIds.length) {
        throw new Error("One or more albums could not be found.");
      }

      await prisma.$transaction(
        cardIds.map((cardId) => {
          const card = cardsById.get(cardId);

          if (!card) {
            throw new Error("Album not found.");
          }

          return prisma.galleryCard.update({
            where: { id: card.id },
            data: getAlbumUpdateData(formData, card, (field) =>
              getFieldName(cardId, field),
            ),
          });
        }),
      );

      return redirect(getActionRedirectPath(request, formData, gallery.id));
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
    brandSummaries,
    stats,
    proxyPath,
    flickrAlbumsUrl,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const [filters, setFilters] = useState(() => getAdminFilters(location.search));
  const brandSlugKey = brandSummaries.map((brand) => brand.slug).join("|");
  const availableBrandSlugs = useMemo(
    () => new Set(brandSummaries.map((brand) => brand.slug)),
    [brandSlugKey, brandSummaries],
  );
  const filteredCards = useMemo(
    () => filterAdminCards(cards, filters),
    [cards, filters],
  );
  const filterReturnSearch = getSearchWithFilters(
    location.search,
    gallery.id,
    filters,
  );
  const wheelsThemeGalleryId = `${gallery.id}::wheels`;
  const selectedBrandSummary = brandSummaries.find(
    (brand) => brand.slug === filters.brand,
  );
  const currentThemeBlock =
    filters.category === "wheel"
      ? {
          label: "Wheels",
          galleryId: wheelsThemeGalleryId,
        }
      : selectedBrandSummary
        ? {
            label: selectedBrandSummary.name,
            galleryId: selectedBrandSummary.themeGalleryId,
          }
        : {
            label: "All makes",
            galleryId: gallery.id,
          };

  useEffect(() => {
    setFilters(getAdminFilters(location.search));
  }, [location.search]);

  useEffect(() => {
    setFilters((current) => {
      if (!current.brand || availableBrandSlugs.has(current.brand)) {
        return current;
      }

      return { ...current, brand: "" };
    });
  }, [availableBrandSlugs]);

  return (
    <s-page heading="Car Gallery">
      <style>{styles}</style>
      <div className="cg-shell">

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
              <span>All makes gallery ID</span>
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
              Adds public albums from <a href={flickrAlbumsUrl}>{flickrAlbumsUrl}</a>.
              Existing edited album settings are preserved.
            </p>
            <div className="cg-stats">
              <span>{stats.total} albums</span>
              <span>{stats.active} active</span>
              <span>{stats.cars} cars</span>
              <span>{stats.wheels} wheels</span>
            </div>
          </div>

          <div className="cg-import-actions">
            <AdminForm method="post">
              <input type="hidden" name="_action" value="refresh_flickr_albums" />
              <input type="hidden" name="galleryId" value={gallery.id} />
              <input type="hidden" name="returnSearch" value={filterReturnSearch} />
              <button type="submit">Add new Flickr albums</button>
            </AdminForm>
            <AdminForm method="post">
              <input type="hidden" name="_action" value="sync_flickr_albums" />
              <input type="hidden" name="galleryId" value={gallery.id} />
              <input type="hidden" name="returnSearch" value={filterReturnSearch} />
              <button className="cg-secondary" type="submit">Sync and repair</button>
            </AdminForm>
          </div>
        </div>
      </s-section>

      <s-section heading="Album curation">
        {cards.length ? (
          <>
          <div className="cg-filter-panel">
            <div className="cg-form cg-filter-form">
              <label>
                <span>Search albums</span>
                <input
                  value={filters.q}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      q: event.currentTarget.value,
                    }))
                  }
                  placeholder="BMW, RFX11, reference ID..."
                />
              </label>

              <label>
                <span>Category</span>
                <select
                  value={filters.category}
                  onChange={(event) => {
                    const category = normalizeFilterCategory(event.currentTarget.value);
                    setFilters((current) => ({
                      ...current,
                      category,
                      brand: category === "wheel" ? "" : current.brand,
                    }));
                  }}
                >
                  <option value="all">All</option>
                  <option value="car">Cars</option>
                  <option value="wheel">Wheels</option>
                </select>
              </label>

              <label>
                <span>Vehicle make</span>
                <select
                  value={filters.brand}
                  onChange={(event) => {
                    const brand = event.currentTarget.value;
                    setFilters((current) => ({
                      ...current,
                      brand,
                      category: brand ? "car" : current.category,
                      q: "",
                    }));
                  }}
                >
                  <option value="">All makes</option>
                  {brandSummaries.map((brand) => (
                    <option key={brand.slug} value={brand.slug}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                onClick={() => setFilters({ brand: "", category: "all", q: "" })}
              >
                Reset
              </button>
            </div>

            <div className="cg-brand-filter-list" aria-label="Filter by make">
              <button
                className={`cg-pill cg-pill-button ${!filters.brand && filters.category !== "wheel" ? "is-active" : ""}`}
                onClick={() => setFilters({ brand: "", category: "car", q: "" })}
                type="button"
              >
                All car makes
              </button>
              {brandSummaries.map((brand) => (
                <button
                  className={`cg-pill cg-pill-button ${filters.brand === brand.slug ? "is-active" : ""}`}
                  onClick={() =>
                    setFilters({ brand: brand.slug, category: "car", q: "" })
                  }
                  key={brand.slug}
                  type="button"
                >
                  {brand.name} ({brand.totalCount})
                </button>
              ))}
              <button
                className={`cg-pill cg-pill-button ${filters.category === "wheel" ? "is-active" : ""}`}
                onClick={() => setFilters({ brand: "", category: "wheel", q: "" })}
                type="button"
              >
                Wheels ({stats.wheels})
              </button>
            </div>

            <div className="cg-current-theme-block">
              <div>
                <h3>Theme block for {currentThemeBlock.label}</h3>
                <p className="cg-muted">
                  Select a make or Wheels above to see only that gallery ID.
                </p>
              </div>
              <label>
                <span>Gallery ID</span>
                <input readOnly value={currentThemeBlock.galleryId} />
              </label>
              <label>
                <span>Theme endpoint</span>
                <input readOnly value={proxyPath} />
              </label>
            </div>

            <p className="cg-muted">
              Showing {filteredCards.length} of {cards.length} albums.
            </p>
          </div>

          <AdminForm method="post" className="cg-form cg-bulk-form">
            <input type="hidden" name="_action" value="bulk_update_albums" />
            <input type="hidden" name="galleryId" value={gallery.id} />
            <input type="hidden" name="returnSearch" value={filterReturnSearch} />

            <div className="cg-bulk-header">
              <p className="cg-muted">
                Edit the visible albums, then save them together. Existing details
                stay intact when you refresh Flickr for new albums.
              </p>
              <button type="submit">Save visible changes</button>
            </div>

            <div className="cg-albums">
              {filteredCards.map((card) => (
                <article
                  className={`cg-album ${card.isActive ? "" : "is-inactive"}`}
                  key={card.id}
                >
                  <input type="hidden" name="cardId" value={card.id} />

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

                  <div className="cg-album-fields">
                    <div className="cg-album-meta">
                      <span>Reference ID: {card.referenceId}</span>
                      <a href={card.flickrAlbumUrl} target="_blank" rel="noreferrer">
                        Open Flickr album
                      </a>
                    </div>

                    <div className="cg-album-primary">
                      <label className="cg-title-field">
                        <span>Album title</span>
                        <input
                          name={getFieldName(card.id, "title")}
                          defaultValue={card.title}
                        />
                      </label>

                      <label>
                        <span>Wheel model / finish</span>
                        <input
                          name={getFieldName(card.id, "subtitle")}
                          defaultValue={card.subtitle}
                          placeholder="RFX11 Brushed Titanium"
                        />
                      </label>
                    </div>

                    <div className="cg-album-grid">
                      <label className="cg-check">
                        <input
                          type="checkbox"
                          name={getFieldName(card.id, "isActive")}
                          defaultChecked={card.isActive}
                        />
                        <span>Active</span>
                      </label>

                      <label>
                        <span>Category</span>
                        <select
                          name={getFieldName(card.id, "category")}
                          defaultValue={card.category || "car"}
                        >
                          <option value="car">Car</option>
                          <option value="wheel">Wheel</option>
                        </select>
                      </label>

                      <label>
                        <span>Vehicle brand</span>
                        <input
                          name={getFieldName(card.id, "vehicleBrand")}
                          defaultValue={card.vehicleBrand}
                        />
                      </label>

                      <label>
                        <span>Vehicle model</span>
                        <input
                          name={getFieldName(card.id, "vehicleModel")}
                          defaultValue={card.vehicleModel}
                        />
                      </label>

                      <label>
                        <span>Wheel type</span>
                        <select
                          name={getFieldName(card.id, "wheelType")}
                          defaultValue={card.wheelType}
                        >
                          <option value="">Not set</option>
                          <option value="cross-forged">Cross-forged</option>
                          <option value="forged">Forged</option>
                        </select>
                      </label>

                      <label className="cg-spec-field">
                        <span>Wheel specification</span>
                        <textarea
                          name={getFieldName(card.id, "wheelSpecification")}
                          defaultValue={card.wheelSpecification}
                          rows={2}
                          placeholder="Front: 22x10.5 Rear: 22x11.5"
                        />
                      </label>
                    </div>

                    <div className="cg-row-actions">
                      <button type="submit">Save visible changes</button>
                      <button
                        className="cg-danger"
                        name="deleteCardId"
                        onClick={(event) => {
                          if (
                            !window.confirm(
                              `Delete ${card.title} from this app? This will not delete the Flickr album.`,
                            )
                          ) {
                            event.preventDefault();
                          }
                        }}
                        type="submit"
                        value={card.id}
                      >
                        Delete from app
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <div className="cg-bulk-footer">
              <button type="submit">Save visible changes</button>
            </div>
          </AdminForm>
          </>
        ) : (
          <p className="cg-muted">Sync Flickr albums to start curating.</p>
        )}
      </s-section>
      </div>
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

function getBrandSummaries(cards: AdminCard[], galleryId: string) {
  const summaries = new Map<
    string,
    {
      name: string;
      slug: string;
      themeGalleryId: string;
      activeCount: number;
      totalCount: number;
    }
  >();

  cards
    .filter((card) => card.category !== "wheel")
    .forEach((card) => {
      const name = getCardBrand(card);
      const slug = slugify(name);
      const current =
        summaries.get(slug) || {
          name,
          slug,
          themeGalleryId: `${galleryId}::${slug}`,
          activeCount: 0,
          totalCount: 0,
        };

      current.totalCount += 1;
      if (card.isActive) current.activeCount += 1;
      summaries.set(slug, current);
    });

  return Array.from(summaries.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function getAdminFilters(search: string) {
  const params = new URLSearchParams(search);

  return {
    brand: (params.get("brand") || "").trim().toLowerCase(),
    category: normalizeFilterCategory(params.get("category") || "all"),
    q: (params.get("q") || "").trim(),
  };
}

function filterAdminCards(
  cards: AdminCard[],
  filters: { brand: string; category: string; q: string },
) {
  const query = filters.q.toLowerCase();

  return cards.filter((card) => {
    if (filters.category === "car" && card.category === "wheel") return false;
    if (filters.category === "wheel" && card.category !== "wheel") return false;
    if (filters.brand && slugify(getCardBrand(card)) !== filters.brand) return false;

    if (!query) return true;

    return [
      card.referenceId,
      card.title,
      card.subtitle,
      card.description,
      card.color,
      card.vehicleBrand,
      card.vehicleModel,
      card.wheelType,
      card.wheelSpecification,
      card.flickrAlbumId,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function normalizeFilterCategory(value: string) {
  return value === "car" || value === "wheel" ? value : "all";
}

function getCardBrand(card: { vehicleBrand: string }) {
  return card.vehicleBrand.trim() || "Other";
}

function getSearchWithFilters(
  search: string,
  galleryId: string,
  filters: { brand: string; category: string; q: string },
) {
  const currentParams = new URLSearchParams(search);
  const nextParams = new URLSearchParams();

  SHOPIFY_CONTEXT_PARAMS.forEach((key) => {
    const value = currentParams.get(key);
    if (value) nextParams.set(key, value);
  });

  nextParams.set("gallery", galleryId);
  if (filters.brand) nextParams.set("brand", filters.brand);
  if (filters.category && filters.category !== "all") {
    nextParams.set("category", filters.category);
  }
  if (filters.q.trim()) nextParams.set("q", filters.q.trim());

  const query = nextParams.toString();
  return query ? `?${query}` : "";
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

function inferAlbumMetadata(title: string): AlbumMetadata {
  const [vehiclePart, ...wheelParts] = title.split(/\s+-\s+/);
  const vehicleLabel = vehiclePart.trim();
  const wheelLabel = wheelParts.join(" - ").trim();
  const startsWithWheel = Boolean(findWheelModelCode(vehicleLabel));
  const category = startsWithWheel ? "wheel" : "car";
  const vehicleDetails =
    category === "car"
      ? detectVehicleDetails(vehicleLabel)
      : { brand: "", model: "" };

  return {
    category,
    vehicleBrand: vehicleDetails.brand,
    vehicleModel: vehicleDetails.model,
    wheelLabel,
    wheelType: inferWheelType(wheelLabel || title),
  };
}

function detectVehicleDetails(vehicleLabel: string) {
  const withoutYear = stripLeadingVehicleYear(vehicleLabel);
  const normalized = withoutYear.trim();
  const brands = [
    ["Mercedes-Benz", "Mercedes-Benz"],
    ["Mercedes Benz", "Mercedes-Benz"],
    ["Mercedes", "Mercedes-Benz"],
    ["Land Rover", "Land Rover"],
    ["Range Rover", "Land Rover"],
    ["Rolls Royce", "Rolls-Royce"],
    ["Rolls-Royce", "Rolls-Royce"],
    ["Aston Martin", "Aston Martin"],
    ["Alfa Romeo", "Alfa Romeo"],
    ["Chevrolet", "Chevrolet"],
    ["Lamborghini", "Lamborghini"],
    ["Volkswagen", "Volkswagen"],
    ["McLaren", "McLaren"],
    ["Porsche", "Porsche"],
    ["Ferrari", "Ferrari"],
    ["Genesis", "Genesis"],
    ["Cadillac", "Cadillac"],
    ["Infiniti", "Infiniti"],
    ["Maserati", "Maserati"],
    ["Bentley", "Bentley"],
    ["Toyota", "Toyota"],
    ["Nissan", "Nissan"],
    ["Lexus", "Lexus"],
    ["Honda", "Honda"],
    ["Dodge", "Dodge"],
    ["Acura", "Acura"],
    ["Audi", "Audi"],
    ["Ford", "Ford"],
    ["Jeep", "Jeep"],
    ["Subaru", "Subaru"],
    ["Tesla", "Tesla"],
    ["Volvo", "Volvo"],
    ["BMW", "BMW"],
    ["Kia", "Kia"],
  ]
    .map(([label, brand]) => ({ label, brand }))
    .sort((a, b) => b.label.length - a.label.length);
  const match = brands.find((brandEntry) =>
    normalized.toLowerCase().startsWith(brandEntry.label.toLowerCase()),
  );

  if (match) {
    return {
      brand: match.brand,
      model: normalized.slice(match.label.length).trim() || normalized,
    };
  }

  return {
    brand: normalized.split(/\s+/)[0] || "",
    model: normalized.split(/\s+/).slice(1).join(" ").trim() || normalized,
  };
}

function stripLeadingVehicleYear(value: string) {
  return value.replace(/^(?:19|20)\d{2}\s+/, "").trim();
}

function getAutoRepairAlbumData(
  card: AutoRepairCard,
  inferred: AlbumMetadata,
) {
  const data: Partial<AutoRepairCard> = {};

  if (shouldRepairCategory(card.category)) {
    data.category = inferred.category;
  }

  if (shouldRepairVehicleBrand(card.vehicleBrand)) {
    data.vehicleBrand = inferred.vehicleBrand;
    data.vehicleModel = inferred.vehicleModel;
  } else if (shouldRepairVehicleModel(card.vehicleBrand, card.vehicleModel)) {
    data.vehicleModel = inferred.vehicleModel;
  }

  if (!card.subtitle.trim() && inferred.wheelLabel) {
    data.subtitle = inferred.wheelLabel;
  }

  if (!card.wheelType.trim() && inferred.wheelType) {
    data.wheelType = inferred.wheelType;
  }

  return data;
}

function shouldRepairCategory(category: string) {
  return !category.trim();
}

function shouldRepairVehicleBrand(vehicleBrand: string) {
  return !vehicleBrand.trim() || /^(?:19|20)\d{2}$/.test(vehicleBrand.trim());
}

function shouldRepairVehicleModel(vehicleBrand: string, vehicleModel: string) {
  const normalizedBrand = vehicleBrand.trim().toLowerCase();
  const normalizedModel = vehicleModel.trim().toLowerCase();

  if (!normalizedBrand || !normalizedModel) return false;

  return (
    normalizedModel.startsWith(`${normalizedBrand} `) ||
    /^(?:19|20)\d{2}\s+/.test(normalizedModel)
  );
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

function getAlbumUpdateData(
  formData: FormData,
  card: {
    title: string;
    subtitle: string;
    category: string;
    vehicleBrand: string;
    vehicleModel: string;
    wheelType: string;
    wheelSpecification: string;
  },
  getName: (field: string) => string,
) {
  const title = getString(formData, getName("title"), card.title);
  const subtitle = getString(formData, getName("subtitle"));
  const category = normalizeCategory(getString(formData, getName("category")));
  const submittedBrand = getString(formData, getName("vehicleBrand"));
  const submittedModel = getString(formData, getName("vehicleModel"));
  let wheelType = normalizeWheelType(getString(formData, getName("wheelType")));
  let vehicleBrand = submittedBrand;
  let vehicleModel = submittedModel;

  if (
    hasMeaningfullyChanged(title, card.title) &&
    category !== "wheel" &&
    !hasMeaningfullyChanged(submittedBrand, card.vehicleBrand) &&
    !hasMeaningfullyChanged(submittedModel, card.vehicleModel)
  ) {
    const inferred = inferAlbumMetadata(title);

    if (inferred.category !== "wheel" && inferred.vehicleBrand) {
      vehicleBrand = inferred.vehicleBrand;
      vehicleModel = inferred.vehicleModel;
      if (!wheelType && inferred.wheelType) {
        wheelType = inferred.wheelType;
      }
    }
  }

  return {
    title,
    subtitle,
    category,
    isActive: formData.get(getName("isActive")) === "on",
    vehicleBrand,
    vehicleModel,
    wheelType,
    wheelSpecification: getString(formData, getName("wheelSpecification")),
  };
}

function hasMeaningfullyChanged(nextValue: string, currentValue: string) {
  return nextValue.trim() !== currentValue.trim();
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "gallery"
  );
}

function getReferenceId(card: { flickrAlbumId: string; id: string }) {
  const source = card.flickrAlbumId || card.id;
  const compactSource = source.replace(/[^a-z0-9]/gi, "").toUpperCase();

  return `RW-${compactSource.slice(-6) || "BUILD"}`;
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

function getFieldName(cardId: string, field: string) {
  return `album:${cardId}:${field}`;
}

function getActionErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function getActionRedirectPath(
  request: Request,
  formData: FormData,
  galleryId: string,
) {
  const returnSearch = getString(formData, "returnSearch");

  if (returnSearch) {
    return getAppPathFromSearch(returnSearch, galleryId, true);
  }

  return getAppPath(request, galleryId);
}

function getAppPath(request: Request, galleryId?: string) {
  return getAppPathFromSearch(new URL(request.url).search, galleryId);
}

function getAppPathFromSearch(
  search: string,
  galleryId?: string,
  preserveFilters = false,
) {
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

  if (preserveFilters) {
    const brand = currentParams.get("brand");
    const category = currentParams.get("category");
    const q = currentParams.get("q");

    if (brand) appParams.set("brand", brand);
    if (category && category !== "all") appParams.set("category", category);
    if (q) appParams.set("q", q);
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
  .cg-shell {
    width: min(1760px, calc(100vw - 40px));
    max-width: 100%;
    margin: 0 auto;
    display: grid;
    gap: 16px;
  }

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
  .cg-stats,
  .cg-brand-filter-list {
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

  .cg-pill-button {
    appearance: none;
    background: #fff;
    cursor: pointer;
    font: inherit;
  }

  .cg-form label,
  .cg-copy-grid label,
  .cg-current-theme-block label {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .cg-form span,
  .cg-copy-grid span,
  .cg-current-theme-block span {
    color: #616161;
    font-size: 12px;
    font-weight: 700;
  }

  .cg-form input,
  .cg-form select,
  .cg-form textarea,
  .cg-copy-grid input,
  .cg-current-theme-block input {
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
  .cg-import button,
  .cg-reset-link {
    border: 1px solid #1f1f1f;
    border-radius: 6px;
    background: #1f1f1f;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    min-height: 38px;
    padding: 8px 12px;
    text-align: center;
    text-decoration: none;
  }

  .cg-form button:hover,
  .cg-import button:hover,
  .cg-reset-link:hover {
    background: #000;
  }

  .cg-secondary,
  .cg-reset-link {
    background: #fff !important;
    border-color: #8a8a8a !important;
    color: #202020 !important;
  }

  .cg-danger {
    background: #fff !important;
    border-color: #c0392b !important;
    color: #b42318 !important;
  }

  .cg-import {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }

  .cg-import-actions {
    display: grid;
    gap: 8px;
  }

  .cg-muted {
    color: #616161;
    line-height: 1.5;
  }

  .cg-muted a {
    color: inherit;
  }

  .cg-filter-panel {
    display: grid;
    gap: 14px;
    border: 1px solid #dedede;
    border-radius: 8px;
    background: #fff;
    padding: 14px;
  }

  .cg-filter-panel p {
    margin: 0;
  }

  .cg-current-theme-block {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) minmax(260px, 1fr) minmax(180px, 0.7fr);
    align-items: end;
    gap: 12px;
    border-top: 1px solid #dedede;
    padding-top: 14px;
  }

  .cg-current-theme-block h3 {
    margin: 0 0 4px;
    font-size: 14px;
  }

  .cg-filter-form {
    display: grid;
    grid-template-columns: minmax(240px, 1.2fr) minmax(140px, 0.55fr) minmax(180px, 0.7fr) auto auto;
    align-items: end;
    gap: 12px;
  }

  .cg-bulk-form {
    display: grid;
    gap: 16px;
  }

  .cg-bulk-header,
  .cg-bulk-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    border: 1px solid #dedede;
    border-radius: 8px;
    background: #fff;
    padding: 14px;
  }

  .cg-bulk-header {
    position: sticky;
    top: 0;
    z-index: 2;
  }

  .cg-bulk-header p {
    margin: 0;
  }

  .cg-albums {
    grid-template-columns: 1fr;
    gap: 14px;
  }

  .cg-album {
    display: grid;
    grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
    gap: 18px;
    align-items: stretch;
    border: 1px solid #dedede;
    border-radius: 8px;
    background: #fff;
    padding: 16px;
  }

  .cg-album.is-inactive {
    opacity: 0.62;
  }

  .cg-cover {
    min-height: 240px;
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

  .cg-album-fields {
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .cg-album-meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    color: #616161;
    font-size: 12px;
    font-weight: 800;
    line-height: 1.3;
    text-transform: uppercase;
  }

  .cg-album-meta a {
    color: inherit;
  }

  .cg-album-primary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
    gap: 12px;
    min-width: 0;
  }

  .cg-album-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr));
    gap: 12px;
    align-items: end;
    min-width: 0;
  }

  .cg-check {
    align-items: center;
    grid-template-columns: auto auto;
    justify-content: start;
    padding-bottom: 10px;
  }

  .cg-check input {
    width: auto;
  }

  .cg-spec-field textarea {
    min-height: 38px;
  }

  .cg-row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .cg-title-field,
  .cg-spec-field {
    grid-column: 1 / -1;
  }

  @media (min-width: 1280px) {
    .cg-title-field {
      grid-column: span 2;
    }

    .cg-spec-field {
      grid-column: span 2;
    }
  }

  @media (max-width: 900px) {
    .cg-shell {
      width: min(100%, calc(100vw - 24px));
    }

    .cg-inline-form,
    .cg-copy-grid,
    .cg-import,
    .cg-filter-form,
    .cg-current-theme-block,
    .cg-bulk-header,
    .cg-bulk-footer,
    .cg-albums,
    .cg-album,
    .cg-album-primary,
    .cg-album-grid {
      grid-template-columns: 1fr;
    }

    .cg-cover {
      min-height: 220px;
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
