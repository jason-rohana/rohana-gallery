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

type AdminContext = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type UploadedPhoto = {
  shopifyFileId: string;
  url: string;
  alt: string;
};

type ShopifyImageFile = {
  id: string;
  url: string;
  alt: string;
  filename: string;
  width?: number;
  height?: number;
};

type ShopifyFilesResult = {
  files: ShopifyImageFile[];
  error: string;
};

type GalleryPhotoItem = {
  id: string;
  url: string;
  alt: string;
};

type WheelModelImageItem = {
  id: string;
  modelCode: string;
  imageUrl: string;
  alt: string;
};

type AdminFormProps = ComponentProps<typeof Form>;

type ShopifyUserError = {
  field?: string[] | null;
  message: string;
};

type StagedUploadTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{
    name: string;
    value: string;
  }>;
};

type CreatedShopifyFile = {
  id: string;
  alt?: string | null;
  fileStatus?: string | null;
  image?: {
    url?: string | null;
  } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedGalleryId = url.searchParams.get("gallery");
  const shopifyFilesResult = await listShopifyImageFiles(admin as AdminContext);

  const galleries = await prisma.gallery.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      updatedAt: true,
    },
  });

  const selectedGalleryId = requestedGalleryId || galleries[0]?.id || "";
  const gallery = selectedGalleryId
    ? await prisma.gallery.findFirst({
        where: {
          id: selectedGalleryId,
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
                    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                  },
                },
              },
            },
          },
        },
      })
    : null;
  const wheelModelImages = await prisma.wheelModelImage.findMany({
    where: { shop: session.shop },
    orderBy: { modelCode: "asc" },
  });

  return {
    galleries,
    gallery,
    proxyPath: "/apps/car-gallery",
    shopifyFiles: shopifyFilesResult.files,
    shopifyFilesError: shopifyFilesResult.error,
    wheelModelImages,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = getString(formData, "_action");

  try {
    if (intent === "create_gallery") {
      const gallery = await prisma.gallery.create({
        data: {
          shop: session.shop,
          name: getString(formData, "name", "Wheel Gallery"),
          tabs: {
            create: {
              title: "Featured",
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

    if (intent === "add_tab") {
      const gallery = await findGalleryForShop(
        getString(formData, "galleryId"),
        session.shop,
      );
      const position = await prisma.galleryTab.count({
        where: { galleryId: gallery.id },
      });

      await prisma.galleryTab.create({
        data: {
          galleryId: gallery.id,
          title: getString(formData, "title", "New group"),
          position,
        },
      });

      return redirect(getAppPath(request, gallery.id));
    }

    if (intent === "delete_tab") {
      const tab = await findTabForShop(getString(formData, "tabId"), session.shop);

      await prisma.galleryTab.delete({ where: { id: tab.id } });
      return redirect(getAppPath(request, tab.galleryId));
    }

    if (intent === "update_tab") {
      const tab = await findTabForShop(getString(formData, "tabId"), session.shop);

      await prisma.galleryTab.update({
        where: { id: tab.id },
        data: { title: getString(formData, "title", tab.title) },
      });

      return redirect(getAppPath(request, tab.galleryId));
    }

    if (intent === "add_card") {
      const tab = await findTabForShop(getString(formData, "tabId"), session.shop);
      const position = await prisma.galleryCard.count({
        where: { tabId: tab.id },
      });

      await prisma.galleryCard.create({
        data: {
          tabId: tab.id,
          title: getString(formData, "title", "Untitled build"),
          subtitle: getString(formData, "subtitle"),
          description: getString(formData, "description"),
          color: getString(formData, "color"),
          flickrAlbumUrl: getString(formData, "flickrAlbumUrl"),
          position,
        },
      });

      return redirect(getAppPath(request, tab.galleryId));
    }

    if (intent === "update_card") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );

      await prisma.galleryCard.update({
        where: { id: card.id },
        data: {
          title: getString(formData, "title", card.title),
          subtitle: getString(formData, "subtitle"),
          description: getString(formData, "description"),
          color: getString(formData, "color"),
          flickrAlbumUrl: getString(formData, "flickrAlbumUrl"),
        },
      });

      return redirect(getAppPath(request, card.tab.galleryId));
    }

    if (intent === "delete_card") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );

      await prisma.galleryCard.delete({ where: { id: card.id } });
      return redirect(getAppPath(request, card.tab.galleryId));
    }

    if (intent === "attach_existing_photos") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );
      const selectedPhotos = formData
        .getAll("selectedPhotos")
        .map((value) => parseSelectedPhoto(value))
        .filter((photo): photo is UploadedPhoto => Boolean(photo));

      if (!selectedPhotos.length) {
        throw new Error("Choose at least one Shopify Files image first.");
      }

      const currentPhotoCount = await prisma.galleryPhoto.count({
        where: { cardId: card.id },
      });

      await prisma.galleryPhoto.createMany({
        data: selectedPhotos.map((photo, index) => ({
          cardId: card.id,
          shopifyFileId: photo.shopifyFileId,
          url: photo.url,
          alt: photo.alt,
          position: currentPhotoCount + index,
        })),
      });

      return redirect(getAppPath(request, card.tab.galleryId));
    }

    if (intent === "upload_local_photos") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );
      const localPhotos = getLocalImageFiles(formData, "localPhotos");

      if (!localPhotos.length) {
        throw new Error("Choose at least one local image first.");
      }

      const uploadedPhotos = await uploadLocalImageFilesToShopify(
        admin as AdminContext,
        localPhotos,
      );
      const currentPhotoCount = await prisma.galleryPhoto.count({
        where: { cardId: card.id },
      });

      await prisma.galleryPhoto.createMany({
        data: uploadedPhotos.map((photo, index) => ({
          cardId: card.id,
          shopifyFileId: photo.shopifyFileId,
          url: photo.url,
          alt: photo.alt,
          position: currentPhotoCount + index,
        })),
      });

      return redirect(getAppPath(request, card.tab.galleryId));
    }

    if (intent === "delete_photo") {
      const photo = await prisma.galleryPhoto.findFirst({
        where: {
          id: getString(formData, "photoId"),
          card: {
            tab: {
              gallery: {
                shop: session.shop,
              },
            },
          },
        },
        include: {
          card: {
            include: {
              tab: true,
            },
          },
        },
      });

      if (!photo) {
        throw new Error("Photo not found.");
      }

      await prisma.galleryPhoto.delete({ where: { id: photo.id } });
      return redirect(getAppPath(request, photo.card.tab.galleryId));
    }

    if (intent === "reorder_photos") {
      const card = await findCardForShop(
        getString(formData, "cardId"),
        session.shop,
      );

      await reorderCardPhotosByIds(
        card.id,
        parseOrderedPhotoIds(getString(formData, "orderedPhotoIds")),
      );

      return redirect(getAppPath(request, card.tab.galleryId));
    }

    if (intent === "save_wheel_model_image") {
      const modelCode = normalizeWheelModelCode(getString(formData, "modelCode"));
      const selectedPhoto = parseSelectedPhoto(
        getString(formData, "selectedPhoto"),
      );

      if (!isSupportedWheelModelCode(modelCode)) {
        throw new Error(
          "Use a supported wheel model code like RFX11, RFC3, RC10, RFG, RLB, RPM, or RFL.",
        );
      }

      if (!selectedPhoto) {
        throw new Error("Choose a Shopify Files image for this wheel model.");
      }

      await prisma.wheelModelImage.upsert({
        where: {
          shop_modelCode: {
            shop: session.shop,
            modelCode,
          },
        },
        update: {
          shopifyFileId: selectedPhoto.shopifyFileId,
          imageUrl: selectedPhoto.url,
          alt: selectedPhoto.alt || modelCode,
        },
        create: {
          shop: session.shop,
          modelCode,
          shopifyFileId: selectedPhoto.shopifyFileId,
          imageUrl: selectedPhoto.url,
          alt: selectedPhoto.alt || modelCode,
        },
      });

      return redirect(getGalleryRedirectPath(request, formData));
    }

    if (intent === "delete_wheel_model_image") {
      await prisma.wheelModelImage.deleteMany({
        where: {
          id: getString(formData, "wheelModelImageId"),
          shop: session.shop,
        },
      });

      return redirect(getGalleryRedirectPath(request, formData));
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
    proxyPath,
    shopifyFiles,
    shopifyFilesError,
    wheelModelImages,
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
              <input name="name" placeholder="Wheel builds" />
            </label>
            <button type="submit">Create gallery</button>
          </AdminForm>

          {galleries.length ? (
            <div className="cg-gallery-list" aria-label="Saved galleries">
              {galleries.map((item) => (
                <a
                  className={`cg-pill ${gallery?.id === item.id ? "is-active" : ""}`}
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

      {gallery ? (
        <>
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

          <s-section heading="Wheel stock images">
            <div className="cg-wheel-library">
              <p className="cg-muted">
                Add one stock wheel image per model code. Gallery cards will match
                text like Rohana Cross-Forged RFX11, RFC3, RC10, RFG, RLB, RPM,
                or RFL automatically.
              </p>

              <WheelStockImageForm
                currentGalleryId={gallery.id}
                files={shopifyFiles}
                filesError={shopifyFilesError}
              />

              {wheelModelImages.length ? (
                <div className="cg-wheel-model-grid">
                  {wheelModelImages.map((wheelModel) => (
                    <article className="cg-wheel-model" key={wheelModel.id}>
                      <img
                        src={wheelModel.imageUrl}
                        alt={wheelModel.alt || wheelModel.modelCode}
                      />
                      <div>
                        <strong>{wheelModel.modelCode}</strong>
                        <AdminForm method="post">
                          <input
                            type="hidden"
                            name="_action"
                            value="delete_wheel_model_image"
                          />
                          <input
                            type="hidden"
                            name="wheelModelImageId"
                            value={wheelModel.id}
                          />
                          <input
                            type="hidden"
                            name="galleryId"
                            value={gallery.id}
                          />
                          <button className="cg-danger" type="submit">
                            Delete
                          </button>
                        </AdminForm>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </s-section>

          <s-section heading="Tabs and cards">
            <AdminForm method="post" className="cg-form cg-inline-form cg-add-tab">
              <input type="hidden" name="_action" value="add_tab" />
              <input type="hidden" name="galleryId" value={gallery.id} />
              <label>
                <span>New tab</span>
                <input name="title" placeholder="Featured" />
              </label>
              <button type="submit">Add tab</button>
            </AdminForm>

            <div className="cg-tabs">
              {gallery.tabs.map((tab) => (
                <section className="cg-tab" key={tab.id}>
                  <div className="cg-tab-header">
                    <AdminForm method="post" className="cg-form cg-tab-title-form">
                      <input type="hidden" name="_action" value="update_tab" />
                      <input type="hidden" name="tabId" value={tab.id} />
                      <label>
                        <span>Tab name</span>
                        <input name="title" defaultValue={tab.title} />
                      </label>
                      <button type="submit">Save tab</button>
                    </AdminForm>

                    <AdminForm method="post">
                      <input type="hidden" name="_action" value="delete_tab" />
                      <input type="hidden" name="tabId" value={tab.id} />
                      <button
                        className="cg-danger"
                        type="submit"
                        disabled={gallery.tabs.length === 1}
                      >
                        Delete tab
                      </button>
                    </AdminForm>
                  </div>

                  <div className="cg-cards">
                    {tab.cards.map((card) => (
                      <article className="cg-card" key={card.id}>
                        <div className="cg-card-preview">
                          {card.photos[0] ? (
                            <img src={card.photos[0].url} alt={card.photos[0].alt} />
                          ) : card.flickrAlbumUrl ? (
                            <div className="cg-card-placeholder">
                              Flickr album linked
                            </div>
                          ) : (
                            <div className="cg-card-placeholder">{card.title}</div>
                          )}
                        </div>

                        <AdminForm method="post" className="cg-form cg-card-form">
                          <input type="hidden" name="_action" value="update_card" />
                          <input type="hidden" name="cardId" value={card.id} />
                          <label>
                            <span>Title</span>
                            <input name="title" defaultValue={card.title} />
                          </label>
                          <label>
                            <span>Subtitle</span>
                            <input name="subtitle" defaultValue={card.subtitle} />
                          </label>
                          <label>
                            <span>Description</span>
                            <input
                              name="description"
                              defaultValue={card.description}
                            />
                          </label>
                          <label>
                            <span>Color</span>
                            <input name="color" defaultValue={card.color} />
                          </label>
                          <label>
                            <span>Flickr album URL</span>
                            <input
                              name="flickrAlbumUrl"
                              defaultValue={card.flickrAlbumUrl}
                              placeholder="https://www.flickr.com/photos/rohanawheels/albums/72177720332457517/"
                            />
                          </label>
                          <p className="cg-upload-help">
                            Public Flickr album photos will display before saved
                            Shopify photos.
                          </p>
                          <button type="submit">Save card</button>
                        </AdminForm>

                        <ShopifyFilesPicker
                          cardId={card.id}
                          files={shopifyFiles}
                          filesError={shopifyFilesError}
                        />

                        <LocalPhotoUploadForm cardId={card.id} />

                        {card.photos.length ? (
                          <CardPhotoStrip cardId={card.id} photos={card.photos} />
                        ) : null}

                        <AdminForm method="post">
                          <input type="hidden" name="_action" value="delete_card" />
                          <input type="hidden" name="cardId" value={card.id} />
                          <button className="cg-danger" type="submit">
                            Delete card
                          </button>
                        </AdminForm>
                      </article>
                    ))}
                  </div>

                  <AdminForm method="post" className="cg-form cg-add-card">
                    <input type="hidden" name="_action" value="add_card" />
                    <input type="hidden" name="tabId" value={tab.id} />
                    <label>
                      <span>Title</span>
                      <input
                        name="title"
                        defaultValue={gallery.name ? `${gallery.name} ` : ""}
                        placeholder="Porsche 992"
                      />
                    </label>
                    <label>
                      <span>Subtitle</span>
                      <input name="subtitle" placeholder="Forged: Series 21" />
                    </label>
                    <label>
                      <span>Description</span>
                      <input name="description" placeholder="S21-01" />
                    </label>
                    <label>
                      <span>Color</span>
                      <input name="color" placeholder="Gloss Black" />
                    </label>
                    <label className="cg-wide-field">
                      <span>Flickr album URL</span>
                      <input
                        name="flickrAlbumUrl"
                        placeholder="https://www.flickr.com/photos/rohanawheels/albums/72177720332457517/"
                      />
                    </label>
                    <button type="submit">Add card</button>
                  </AdminForm>
                </section>
              ))}
            </div>
          </s-section>
        </>
      ) : (
        <s-section heading="Create your first gallery">
          <p className="cg-muted">
            Make one gallery, add tabs like Featured or SUVs, then add cards for
            each vehicle build.
          </p>
        </s-section>
      )}
    </s-page>
  );
}

function WheelStockImageForm({
  currentGalleryId,
  files,
  filesError,
}: {
  currentGalleryId: string;
  files: ShopifyImageFile[];
  filesError: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedFile, setSelectedFile] = useState<ShopifyImageFile | null>(null);
  const filteredFiles = useFilteredShopifyFiles(files, searchTerm);

  return (
    <AdminForm method="post" className="cg-form cg-wheel-stock-form">
      <input type="hidden" name="_action" value="save_wheel_model_image" />
      <input type="hidden" name="galleryId" value={currentGalleryId} />
      <input
        type="hidden"
        name="selectedPhoto"
        value={selectedFile ? serializeSelectedPhoto(selectedFile) : ""}
      />

      <label>
        <span>Wheel model code</span>
        <input name="modelCode" placeholder="RFX11" />
      </label>

      <div className="cg-wheel-stock-pick">
        <span>Stock wheel image</span>
        {selectedFile ? (
          <div className="cg-wheel-stock-preview">
            <img src={selectedFile.url} alt={selectedFile.alt} />
            <span>{selectedFile.filename || selectedFile.alt}</span>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          disabled={!files.length}
        >
          Choose from Shopify Files
        </button>
        {!files.length ? (
          filesError ? (
            <p className="cg-upload-warning">{filesError}</p>
          ) : (
            <p className="cg-upload-help">
              No ready images found. Add stock wheel images in Shopify admin under
              Content &gt; Files, then refresh this app.
            </p>
          )
        ) : null}
      </div>

      <button type="submit" disabled={!selectedFile}>
        Save wheel image
      </button>

      {isOpen ? (
        <ShopifyFilesModal
          files={filteredFiles}
          searchTerm={searchTerm}
          title="Choose stock wheel image"
          onClose={() => setIsOpen(false)}
          onSearchChange={setSearchTerm}
          onSelect={(file) => {
            setSelectedFile(file);
            setIsOpen(false);
          }}
        />
      ) : null}
    </AdminForm>
  );
}

function ShopifyFilesModal({
  files,
  searchTerm,
  title,
  onClose,
  onSearchChange,
  onSelect,
}: {
  files: ShopifyImageFile[];
  searchTerm: string;
  title: string;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (file: ShopifyImageFile) => void;
}) {
  return (
    <div className="cg-picker-backdrop" role="presentation">
      <div
        aria-label={title}
        aria-modal="true"
        className="cg-picker-modal"
        role="dialog"
      >
        <div className="cg-picker-header">
          <div>
            <h3>{title}</h3>
            <p>Search images uploaded in Shopify admin under Content &gt; Files.</p>
          </div>
          <button
            aria-label="Close Shopify Files picker"
            className="cg-picker-close"
            type="button"
            onClick={onClose}
          >
            x
          </button>
        </div>

        <label className="cg-picker-search">
          <span>Search photos</span>
          <input
            autoFocus
            placeholder="Search filename, alt text, or URL"
            type="search"
            value={searchTerm}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
          />
        </label>

        {files.length ? (
          <div className="cg-file-picker">
            {files.map((file) => (
              <button
                className="cg-file-option cg-file-option-button"
                key={file.id}
                type="button"
                onClick={() => onSelect(file)}
              >
                <img src={file.url} alt={file.alt} />
                <span>{file.filename || file.alt}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="cg-upload-help">No matching Shopify Files images.</p>
        )}
      </div>
    </div>
  );
}

function CardPhotoStrip({
  cardId,
  photos,
}: {
  cardId: string;
  photos: GalleryPhotoItem[];
}) {
  const [orderedPhotos, setOrderedPhotos] = useState(photos);
  const [draggedPhotoId, setDraggedPhotoId] = useState("");

  useEffect(() => {
    setOrderedPhotos(photos);
  }, [photos]);

  const orderedPhotoIds = orderedPhotos.map((photo) => photo.id);
  const hasOrderChanges =
    orderedPhotoIds.join(",") !== photos.map((photo) => photo.id).join(",");

  const moveDraggedPhoto = (targetPhotoId: string) => {
    if (!draggedPhotoId || draggedPhotoId === targetPhotoId) return;

    setOrderedPhotos((currentPhotos) => {
      const draggedPhoto = currentPhotos.find(
        (photo) => photo.id === draggedPhotoId,
      );
      const draggedIndex = currentPhotos.findIndex(
        (photo) => photo.id === draggedPhotoId,
      );
      const targetIndex = currentPhotos.findIndex(
        (photo) => photo.id === targetPhotoId,
      );

      if (!draggedPhoto || draggedIndex === -1 || targetIndex === -1) {
        return currentPhotos;
      }

      const nextPhotos = currentPhotos.filter(
        (photo) => photo.id !== draggedPhotoId,
      );
      const targetIndexAfterRemoval = nextPhotos.findIndex(
        (photo) => photo.id === targetPhotoId,
      );
      const insertIndex =
        draggedIndex < targetIndex
          ? targetIndexAfterRemoval + 1
          : targetIndexAfterRemoval;

      nextPhotos.splice(insertIndex, 0, draggedPhoto);
      return nextPhotos;
    });
  };

  return (
    <div className="cg-photo-order">
      <p className="cg-photo-order-help">
        Drag photos to rearrange. The first photo is the cover.
      </p>
      <div className="cg-photo-strip" aria-label="Drag photos to reorder">
        {orderedPhotos.map((photo, photoIndex) => (
          <div
            className={`cg-photo ${
              draggedPhotoId === photo.id ? "is-dragging" : ""
            }`}
            draggable
            key={photo.id}
            onDragEnd={() => setDraggedPhotoId("")}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={(event) => {
              setDraggedPhotoId(photo.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              moveDraggedPhoto(photo.id);
            }}
          >
            <div className="cg-photo-frame">
              <img src={photo.url} alt={photo.alt} draggable={false} />
              {photoIndex === 0 ? (
                <span className="cg-cover-badge">Cover</span>
              ) : null}
              <AdminForm method="post">
                <input type="hidden" name="_action" value="delete_photo" />
                <input type="hidden" name="photoId" value={photo.id} />
                <button type="submit" aria-label="Delete photo">
                  x
                </button>
              </AdminForm>
            </div>
          </div>
        ))}
      </div>

      <AdminForm method="post" className="cg-photo-order-form">
        <input type="hidden" name="_action" value="reorder_photos" />
        <input type="hidden" name="cardId" value={cardId} />
        <input
          type="hidden"
          name="orderedPhotoIds"
          value={JSON.stringify(orderedPhotoIds)}
        />
        <button type="submit" disabled={!hasOrderChanges}>
          Save photo order
        </button>
      </AdminForm>
    </div>
  );
}

function ShopifyFilesPicker({
  cardId,
  files,
  filesError,
}: {
  cardId: string;
  files: ShopifyImageFile[];
  filesError: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const filteredFiles = useFilteredShopifyFiles(files, searchTerm);

  return (
    <div className="cg-file-picker-form">
      <button type="button" onClick={() => setIsOpen(true)} disabled={!files.length}>
        Choose from Shopify Files
      </button>
      {!files.length ? (
        filesError ? (
          <p className="cg-upload-warning">{filesError}</p>
        ) : (
          <p className="cg-upload-help">
            No ready images found. Add images in Shopify admin under Content &gt;
            Files, then refresh this app.
          </p>
        )
      ) : null}

      {isOpen ? (
        <div className="cg-picker-backdrop" role="presentation">
          <div
            aria-label="Choose Shopify Files photos"
            aria-modal="true"
            className="cg-picker-modal"
            role="dialog"
          >
            <div className="cg-picker-header">
              <div>
                <h3>Choose Shopify Files photos</h3>
                <p>Search images uploaded in Shopify admin under Content &gt; Files.</p>
              </div>
              <button
                aria-label="Close Shopify Files picker"
                className="cg-picker-close"
                type="button"
                onClick={() => setIsOpen(false)}
              >
                x
              </button>
            </div>

            <label className="cg-picker-search">
              <span>Search photos</span>
              <input
                autoFocus
                placeholder="Search filename, alt text, or URL"
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.currentTarget.value)}
              />
            </label>

            <AdminForm method="post" className="cg-form cg-picker-form">
              <input type="hidden" name="_action" value="attach_existing_photos" />
              <input type="hidden" name="cardId" value={cardId} />

              {filteredFiles.length ? (
                <div className="cg-file-picker">
                  {filteredFiles.map((file) => (
                    <label className="cg-file-option" key={file.id}>
                      <input
                        type="checkbox"
                        name="selectedPhotos"
                        value={serializeSelectedPhoto(file)}
                      />
                      <img src={file.url} alt={file.alt} />
                      <span>{file.filename || file.alt}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="cg-upload-help">No matching Shopify Files images.</p>
              )}

              <div className="cg-picker-actions">
                <button
                  className="cg-secondary"
                  type="button"
                  onClick={() => setIsOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" disabled={!filteredFiles.length}>
                  Add selected photos
                </button>
              </div>
            </AdminForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LocalPhotoUploadForm({ cardId }: { cardId: string }) {
  const [fileCount, setFileCount] = useState(0);
  const uploadButtonText = fileCount
    ? `Upload ${fileCount} ${fileCount === 1 ? "photo" : "photos"}`
    : "Upload photos";

  return (
    <AdminForm
      method="post"
      encType="multipart/form-data"
      className="cg-form cg-local-upload-form"
    >
      <input type="hidden" name="_action" value="upload_local_photos" />
      <input type="hidden" name="cardId" value={cardId} />

      <label>
        <span>Upload multiple photos from device</span>
        <input
          type="file"
          name="localPhotos"
          accept="image/*"
          multiple
          onChange={(event) => setFileCount(event.currentTarget.files?.length || 0)}
        />
      </label>

      <button type="submit" disabled={!fileCount}>
        {uploadButtonText}
      </button>
    </AdminForm>
  );
}

function useFilteredShopifyFiles(files: ShopifyImageFile[], searchTerm: string) {
  return useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    if (!normalizedSearch) return files;

    return files.filter((file) => {
      return [file.alt, file.filename, file.url]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [files, searchTerm]);
}

function getString(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  const stringValue = typeof value === "string" ? value.trim() : "";
  return stringValue || fallback;
}

function getActionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong.";

  if (
    message.includes("stagedUploadsCreate") ||
    message.toLowerCase().includes("access denied")
  ) {
    return "Shopify has not granted this app local upload access yet. Stop dev mode, run `shopify app dev --reset`, and approve the updated Files permissions. Local uploads need write_files.";
  }

  return message;
}

async function findGalleryForShop(id: string, shop: string) {
  const gallery = await prisma.gallery.findFirst({
    where: { id, shop },
  });

  if (!gallery) throw new Error("Gallery not found.");
  return gallery;
}

async function findTabForShop(id: string, shop: string) {
  const tab = await prisma.galleryTab.findFirst({
    where: {
      id,
      gallery: { shop },
    },
  });

  if (!tab) throw new Error("Tab not found.");
  return tab;
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

  if (!card) throw new Error("Card not found.");
  return card;
}

async function reorderCardPhotosByIds(cardId: string, orderedPhotoIds: string[]) {
  const photos = await prisma.galleryPhoto.findMany({
    where: { cardId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  const uniquePhotoIds = [...new Set(orderedPhotoIds)];

  if (!uniquePhotoIds.length) throw new Error("No photo order was provided.");

  if (uniquePhotoIds.some((photoId) => !photoMap.has(photoId))) {
    throw new Error("Photo order includes an invalid photo.");
  }

  const orderedPhotos = uniquePhotoIds.map((photoId) => photoMap.get(photoId)!);
  const remainingPhotos = photos.filter((photo) => !uniquePhotoIds.includes(photo.id));
  const finalPhotos = [...orderedPhotos, ...remainingPhotos];

  await prisma.$transaction(
    finalPhotos.map((photo, index) =>
      prisma.galleryPhoto.update({
        where: { id: photo.id },
        data: { position: index },
      }),
    ),
  );
}

function getLocalImageFiles(formData: FormData, key: string) {
  const files = formData
    .getAll(key)
    .filter((value): value is File => isLocalImageFile(value));

  if (files.length > 20) {
    throw new Error("Upload 20 images or fewer at a time.");
  }

  return files;
}

function isLocalImageFile(value: FormDataEntryValue): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value &&
    "type" in value &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    value.size > 0 &&
    typeof value.type === "string" &&
    value.type.startsWith("image/")
  );
}

async function uploadLocalImageFilesToShopify(
  admin: AdminContext,
  files: File[],
): Promise<UploadedPhoto[]> {
  const stagedTargets = await createStagedUploadTargets(admin, files);

  await Promise.all(
    files.map(async (file, index) => {
      const target = stagedTargets[index];
      const uploadFormData = new FormData();

      target.parameters.forEach((parameter) => {
        uploadFormData.append(parameter.name, parameter.value);
      });

      uploadFormData.append("file", file, sanitizeFilename(file.name, index));

      const response = await fetch(target.url, {
        method: "POST",
        body: uploadFormData,
      });

      if (!response.ok) {
        throw new Error(`Shopify upload failed for ${file.name || "an image"}.`);
      }
    }),
  );

  const createdFiles = await createShopifyFiles(admin, stagedTargets, files);
  const readyFiles = await waitForShopifyImageFiles(
    admin,
    createdFiles.map((file) => file.id),
  );

  return readyFiles.map((file, index) => {
    const imageUrl = file.image?.url;

    if (!imageUrl) {
      throw new Error("Shopify is still processing one of the uploaded images.");
    }

    return {
      shopifyFileId: file.id,
      url: imageUrl,
      alt: file.alt || files[index]?.name || "Gallery image",
    };
  });
}

async function createStagedUploadTargets(
  admin: AdminContext,
  files: File[],
): Promise<StagedUploadTarget[]> {
  const response = await admin.graphql(
    `#graphql
      mutation galleryStagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: files.map((file, index) => ({
          filename: sanitizeFilename(file.name, index),
          fileSize: String(file.size),
          httpMethod: "POST",
          mimeType: file.type || "image/jpeg",
          resource: "FILE",
        })),
      },
    },
  );
  const json = await response.json();
  const stagedUploadsCreate = json.data?.stagedUploadsCreate;

  throwIfGraphQlErrors(json.errors);
  throwIfUserErrors(stagedUploadsCreate?.userErrors);

  const targets = (stagedUploadsCreate?.stagedTargets || []) as StagedUploadTarget[];

  if (targets.length !== files.length) {
    throw new Error("Shopify did not create upload targets for every image.");
  }

  return targets;
}

async function createShopifyFiles(
  admin: AdminContext,
  stagedTargets: StagedUploadTarget[],
  files: File[],
): Promise<CreatedShopifyFile[]> {
  const response = await admin.graphql(
    `#graphql
      mutation galleryFileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            alt
            fileStatus
            ... on MediaImage {
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        files: stagedTargets.map((target, index) => ({
          alt: files[index]?.name || "Gallery image",
          contentType: "IMAGE",
          originalSource: target.resourceUrl,
        })),
      },
    },
  );
  const json = await response.json();
  const fileCreate = json.data?.fileCreate;

  throwIfGraphQlErrors(json.errors);
  throwIfUserErrors(fileCreate?.userErrors);

  const createdFiles = (fileCreate?.files || []) as CreatedShopifyFile[];

  if (createdFiles.length !== files.length || createdFiles.some((file) => !file.id)) {
    throw new Error("Shopify did not finish creating every uploaded image.");
  }

  return createdFiles;
}

async function waitForShopifyImageFiles(
  admin: AdminContext,
  fileIds: string[],
): Promise<CreatedShopifyFile[]> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const files = await getShopifyImageFilesByIds(admin, fileIds);
    const failedFile = files.find((file) => file.fileStatus === "FAILED");

    if (failedFile) {
      throw new Error("Shopify failed to process one of the uploaded images.");
    }

    if (
      files.length === fileIds.length &&
      files.every((file) => file.image?.url)
    ) {
      return files;
    }

    await sleep(850);
  }

  throw new Error("Shopify is still processing the uploaded images. Try again in a moment.");
}

async function getShopifyImageFilesByIds(
  admin: AdminContext,
  fileIds: string[],
): Promise<CreatedShopifyFile[]> {
  const response = await admin.graphql(
    `#graphql
      query galleryFilesById($ids: [ID!]!) {
        nodes(ids: $ids) {
          id
          ... on MediaImage {
            alt
            fileStatus
            image {
              url
            }
          }
        }
      }`,
    { variables: { ids: fileIds } },
  );
  const json = await response.json();

  throwIfGraphQlErrors(json.errors);

  return (json.data?.nodes || []).filter(Boolean) as CreatedShopifyFile[];
}

function throwIfGraphQlErrors(errors: unknown) {
  if (Array.isArray(errors) && errors.length) {
    const message =
      errors
        .map((error) =>
          typeof error === "object" && error && "message" in error
            ? String(error.message)
            : "",
        )
        .filter(Boolean)
        .join(" ") || "Shopify returned an upload error.";

    throw new Error(message);
  }
}

function throwIfUserErrors(errors: ShopifyUserError[] | undefined) {
  if (Array.isArray(errors) && errors.length) {
    throw new Error(errors.map((error) => error.message).join(" "));
  }
}

function sanitizeFilename(filename: string, index: number) {
  const fallback = `gallery-image-${Date.now()}-${index + 1}.jpg`;
  const cleanFilename = filename
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleanFilename || fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listShopifyImageFiles(
  admin: AdminContext,
): Promise<ShopifyFilesResult> {
  try {
    const response = await admin.graphql(
      `#graphql
        query galleryImageFiles {
          files(first: 250, query: "media_type:IMAGE", sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                alt
                fileStatus
                ... on MediaImage {
                  image {
                    url
                    width
                    height
                  }
                }
              }
            }
          }
        }`,
    );

    const json = await response.json();
    const graphQLErrors = json.errors;

    if (Array.isArray(graphQLErrors) && graphQLErrors.length) {
      return {
        files: [],
        error: getShopifyFilesAccessMessage(),
      };
    }

    const files = (json.data?.files?.edges || [])
      .map(
        ({
          node,
        }: {
          node: {
            id: string;
            alt?: string;
            fileStatus?: string;
            image?: { url?: string; width?: number; height?: number };
          };
        }) => ({
          id: node.id,
          url: node.image?.url || "",
          alt: node.alt || "Shopify file image",
          filename: getFilenameFromUrl(node.image?.url || ""),
          width: node.image?.width,
          height: node.image?.height,
          fileStatus: node.fileStatus,
        }),
      )
      .filter((file: ShopifyImageFile & { fileStatus?: string }) => {
        return Boolean(file.url) && (!file.fileStatus || file.fileStatus === "READY");
      });

    return { files, error: "" };
  } catch (error) {
    return {
      files: [],
      error: getShopifyFilesAccessMessage(),
    };
  }
}

function getShopifyFilesAccessMessage() {
  return "Shopify has not granted this app Files access yet. Restart dev mode with `shopify app dev --reset`, approve the updated permissions, or reinstall the app on this store.";
}

function serializeSelectedPhoto(file: ShopifyImageFile) {
  return JSON.stringify({
    id: file.id,
    url: file.url,
    alt: file.alt,
  });
}

function getFilenameFromUrl(url: string) {
  try {
    const parsedUrl = new URL(url);
    const filename = parsedUrl.pathname.split("/").filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : "";
  } catch (error) {
    return "";
  }
}

function parseSelectedPhoto(value: FormDataEntryValue): UploadedPhoto | null {
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value);

    if (
      typeof parsed.id === "string" &&
      typeof parsed.url === "string" &&
      parsed.url
    ) {
      return {
        shopifyFileId: parsed.id,
        url: parsed.url,
        alt: typeof parsed.alt === "string" ? parsed.alt : "",
      };
    }
  } catch (error) {
    return null;
  }

  return null;
}

function parseOrderedPhotoIds(value: string) {
  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.filter((photoId): photoId is string => typeof photoId === "string");
    }
  } catch (error) {
    return [];
  }

  return [];
}

const SUPPORTED_WHEEL_PREFIXES = ["RFX", "RFC", "RFG", "RLB", "RPM", "RFL", "RC"];

function normalizeWheelModelCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isSupportedWheelModelCode(modelCode: string) {
  return SUPPORTED_WHEEL_PREFIXES.some((prefix) => {
    return modelCode.startsWith(prefix) && modelCode.length > prefix.length;
  });
}

const SHOPIFY_CONTEXT_PARAMS = ["shop", "host", "embedded"] as const;

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

function getGalleryRedirectPath(request: Request, formData: FormData) {
  const galleryId = getString(formData, "galleryId");
  return getAppPath(request, galleryId || undefined);
}

const styles = `
  .cg-toolbar,
  .cg-setup,
  .cg-tab,
  .cg-card {
    display: grid;
    gap: 16px;
  }

  .cg-inline-form,
  .cg-copy-grid,
  .cg-add-card {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr)) auto;
    align-items: end;
    gap: 12px;
  }

  .cg-add-card .cg-wide-field {
    grid-column: span 2;
  }

  .cg-add-tab {
    margin-bottom: 20px;
  }

  .cg-gallery-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .cg-pill {
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
  .cg-copy-grid input {
    width: 100%;
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    font: inherit;
    padding: 9px 10px;
  }

  .cg-form button,
  .cg-tab-header button,
  .cg-card button {
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
  .cg-tab-header button:hover,
  .cg-card button:hover {
    background: #000;
  }

  .cg-form button:disabled,
  .cg-tab-header button:disabled,
  .cg-card button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .cg-danger {
    background: #fff !important;
    border-color: #c0392b !important;
    color: #b42318 !important;
  }

  .cg-tabs {
    display: grid;
    gap: 20px;
  }

  .cg-wheel-library {
    display: grid;
    gap: 16px;
  }

  .cg-wheel-stock-form {
    display: grid;
    grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) auto;
    gap: 12px;
    align-items: end;
  }

  .cg-wheel-stock-pick {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .cg-wheel-stock-pick > span {
    color: #616161;
    font-size: 12px;
    font-weight: 700;
  }

  .cg-wheel-stock-preview {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 1px solid #dedede;
    border-radius: 6px;
    padding: 8px;
  }

  .cg-wheel-stock-preview img {
    width: 64px;
    aspect-ratio: 1 / 1;
    display: block;
    object-fit: contain;
    background: #f4f4f4;
    border-radius: 4px;
  }

  .cg-wheel-stock-preview span {
    overflow: hidden;
    color: #303030;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cg-wheel-model-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }

  .cg-wheel-model {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border: 1px solid #dedede;
    border-radius: 8px;
    padding: 10px;
  }

  .cg-wheel-model img {
    width: 72px;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    background: #f4f4f4;
    border-radius: 6px;
  }

  .cg-wheel-model div {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .cg-tab {
    border: 1px solid #dedede;
    border-radius: 8px;
    padding: 18px;
  }

  .cg-tab-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
  }

  .cg-tab-title-form {
    display: grid;
    grid-template-columns: minmax(0, 340px) auto;
    align-items: end;
    gap: 10px;
  }

  .cg-cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .cg-card {
    border: 1px solid #dedede;
    border-radius: 8px;
    padding: 14px;
  }

  .cg-card-preview {
    aspect-ratio: 16 / 9;
    border-radius: 6px;
    overflow: hidden;
    background: linear-gradient(135deg, #111, #555);
  }

  .cg-card-preview img,
  .cg-photo-frame img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
  }

  .cg-card-placeholder {
    height: 100%;
    display: grid;
    place-items: center;
    color: #fff;
    font-size: 22px;
    font-weight: 800;
    text-align: center;
    padding: 16px;
  }

  .cg-card-form,
  .cg-file-picker-form,
  .cg-local-upload-form,
  .cg-picker-form {
    display: grid;
    gap: 10px;
  }

  .cg-local-upload-form {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
  }

  .cg-upload-help,
  .cg-upload-warning,
  .cg-upload-status {
    margin: 0;
    color: #616161;
    font-size: 12px;
    line-height: 1.4;
  }

  .cg-upload-warning {
    border: 1px solid #f1c6c1;
    border-radius: 6px;
    background: #fff4f4;
    color: #8e1f0b;
    padding: 10px;
  }

  .cg-picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 999;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.42);
    padding: 24px;
  }

  .cg-picker-modal {
    width: min(980px, 100%);
    max-height: min(760px, calc(100vh - 48px));
    overflow: hidden;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    gap: 16px;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 20px 80px rgba(0, 0, 0, 0.22);
    padding: 20px;
  }

  .cg-picker-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .cg-picker-header h3,
  .cg-picker-header p {
    margin: 0;
  }

  .cg-picker-header h3 {
    font-size: 20px;
    line-height: 1.2;
  }

  .cg-picker-header p {
    color: #616161;
    font-size: 13px;
    margin-top: 6px;
  }

  .cg-picker-close {
    width: 36px;
    min-height: 36px !important;
    padding: 0 !important;
  }

  .cg-picker-search {
    display: grid;
    gap: 6px;
  }

  .cg-picker-search span {
    color: #616161;
    font-size: 12px;
    font-weight: 700;
  }

  .cg-picker-search input {
    border: 1px solid #c9c9c9;
    border-radius: 6px;
    font: inherit;
    padding: 10px 12px;
    width: 100%;
  }

  .cg-file-picker {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 10px;
    max-height: 430px;
    overflow: auto;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    padding: 10px;
  }

  .cg-file-option {
    position: relative;
    display: grid;
    grid-template-rows: 112px auto;
    gap: 6px;
    overflow: hidden;
    border: 2px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    background: #f7f7f7;
    padding: 6px;
  }

  .cg-file-option-button {
    border: 2px solid transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .cg-file-option-button:hover {
    border-color: #0b5cab;
  }

  .cg-file-option input {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 1;
    width: auto;
  }

  .cg-file-option:has(input:checked) {
    border-color: #0b5cab;
    box-shadow: 0 0 0 2px rgba(11, 92, 171, 0.16);
  }

  .cg-file-option img {
    width: 100%;
    height: 112px;
    display: block;
    object-fit: cover;
    border-radius: 4px;
  }

  .cg-file-option span {
    overflow: hidden;
    color: #303030;
    font-size: 11px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cg-picker-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .cg-secondary {
    background: #fff !important;
    border-color: #8a8a8a !important;
    color: #202020 !important;
  }

  .cg-photo-strip {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .cg-photo-order {
    display: grid;
    gap: 8px;
  }

  .cg-photo-order-help {
    margin: 0;
    color: #616161;
    font-size: 12px;
    line-height: 1.4;
  }

  .cg-photo-order-form {
    display: grid;
  }

  .cg-photo {
    display: grid;
    min-width: 0;
    cursor: grab;
    transition:
      opacity 0.18s ease,
      transform 0.18s ease;
  }

  .cg-photo.is-dragging {
    cursor: grabbing;
    opacity: 0.45;
    transform: scale(0.98);
  }

  .cg-photo-frame {
    position: relative;
    aspect-ratio: 1 / 1;
    border-radius: 6px;
    overflow: hidden;
    background: #f0f0f0;
  }

  .cg-cover-badge {
    position: absolute;
    left: 6px;
    top: 6px;
    border-radius: 999px;
    background: #111;
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    padding: 3px 7px;
  }

  .cg-photo-frame button {
    position: absolute;
    top: 6px;
    right: 6px;
    min-height: 0;
    padding: 2px 7px;
  }

  .cg-muted {
    color: #616161;
  }

  @media (max-width: 900px) {
    .cg-inline-form,
    .cg-copy-grid,
    .cg-add-card,
    .cg-wheel-stock-form,
    .cg-tab-title-form,
    .cg-cards {
      grid-template-columns: 1fr;
    }
  }
`;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
