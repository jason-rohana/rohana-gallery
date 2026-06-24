(function () {
  const SELECTOR = "[data-car-gallery]";
  const initialized = new WeakSet();

  function normalizeGallery(gallery) {
    if (!gallery || !Array.isArray(gallery.tabs)) return { tabs: [] };

    return {
      tabs: gallery.tabs
        .map((tab, tabIndex) => ({
          id: String(tab.id || `tab-${tabIndex + 1}`),
          title: String(tab.title || `Gallery ${tabIndex + 1}`),
          cards: Array.isArray(tab.cards) ? tab.cards : [],
        }))
        .filter((tab) => tab.cards.length > 0),
    };
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function safePhotos(card) {
    if (!Array.isArray(card.photos)) return [];

    return card.photos
      .map((photo) => {
        if (typeof photo === "string") return { url: photo, alt: "" };
        return {
          url: photo && typeof photo.url === "string" ? photo.url : "",
          alt: photo && typeof photo.alt === "string" ? photo.alt : "",
        };
      })
      .filter((photo) => photo.url);
  }

  function safeWheelModel(card) {
    const wheelModel = card && card.wheelModel;

    if (!wheelModel || typeof wheelModel !== "object") {
      return { code: "", imageUrl: "", alt: "", productUrl: "" };
    }

    return {
      code: typeof wheelModel.code === "string" ? wheelModel.code : "",
      imageUrl:
        typeof wheelModel.imageUrl === "string" ? wheelModel.imageUrl : "",
      alt: typeof wheelModel.alt === "string" ? wheelModel.alt : "",
      productUrl:
        typeof wheelModel.productUrl === "string" ? wheelModel.productUrl : "",
    };
  }

  function getModelProductUrl(wheelModel) {
    if (wheelModel.productUrl) return wheelModel.productUrl;
    if (!wheelModel.code) return "";
    return `/products/${wheelModel.code.toLowerCase()}`;
  }

  function getContactUrl(root, card) {
    const productUrl = getModelProductUrl(card.wheelModel);
    if (!productUrl) return "";

    const url = new URL(productUrl, window.location.origin);
    const contactAnchor = root.dataset.contactAnchor || "contact-us";
    const reference = [
      card.referenceId ? `Reference ${card.referenceId}` : "",
      card.title,
      card.wheelModel.code,
      card.color ? `${card.color} finish` : "",
      card.description,
    ]
      .filter(Boolean)
      .join(" | ");

    url.searchParams.set("contact_source", "car_gallery_viewer");
    url.searchParams.set("gallery_reference", reference);
    if (card.referenceId) url.searchParams.set("gallery_reference_id", card.referenceId);
    url.searchParams.set("gallery_vehicle", card.title);
    url.searchParams.set("gallery_wheel_model", card.wheelModel.code);
    if (card.color) url.searchParams.set("gallery_finish", card.color);
    if (card.description) url.searchParams.set("gallery_specs", card.description);
    if (contactAnchor) url.hash = contactAnchor;

    return url.toString();
  }

  function getDemoGallery(root) {
    const demoNode = root.querySelector("[data-car-gallery-demo]");
    if (!demoNode) return { tabs: [] };

    try {
      return normalizeGallery(JSON.parse(demoNode.textContent || "{}"));
    } catch (error) {
      return { tabs: [] };
    }
  }

  async function loadGallery(root) {
    const galleryId = root.dataset.galleryId;
    const endpoint = root.dataset.galleryEndpoint;

    if (galleryId && endpoint) {
      try {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("gallery_id", galleryId);

        const response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
        });

        if (response.ok) {
          return normalizeGallery(await response.json());
        }
      } catch (error) {
        // Fall back to demo data while the app proxy is not configured.
      }
    }

    return getDemoGallery(root);
  }

  function renderGallery(root, gallery) {
    const tabsContainer = root.querySelector("[data-car-gallery-tabs]");
    const panelsContainer = root.querySelector("[data-car-gallery-panels]");
    const empty = root.querySelector("[data-car-gallery-empty]");

    if (!tabsContainer || !panelsContainer || !empty) return;

    tabsContainer.innerHTML = "";
    panelsContainer.innerHTML = "";

    if (!gallery.tabs.length) {
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    gallery.tabs.forEach((tab, tabIndex) => {
      const tabButton = createElement("button", "car-gallery__tab", tab.title);
      const panel = createElement("div", "car-gallery__panel");
      const grid = createElement("div", "car-gallery__grid");
      const isActive = tabIndex === 0;

      tabButton.type = "button";
      tabButton.setAttribute("role", "tab");
      tabButton.setAttribute("aria-selected", isActive ? "true" : "false");
      tabButton.dataset.carGalleryTab = tab.id;
      tabButton.classList.toggle("is-active", isActive);

      panel.setAttribute("role", "tabpanel");
      panel.dataset.carGalleryPanel = tab.id;
      panel.classList.toggle("is-active", isActive);

      tab.cards.forEach((card) => {
        grid.appendChild(renderCard(root, card));
      });

      panel.appendChild(grid);
      tabsContainer.appendChild(tabButton);
      panelsContainer.appendChild(panel);
    });

    tabsContainer.addEventListener("click", (event) => {
      const tabButton = event.target.closest("[data-car-gallery-tab]");
      if (!tabButton || !tabsContainer.contains(tabButton)) return;
      activateTab(root, tabButton.dataset.carGalleryTab);
    });
  }

  function activateTab(root, tabId) {
    root.querySelectorAll("[data-car-gallery-tab]").forEach((tab) => {
      const isActive = tab.dataset.carGalleryTab === tabId;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    root.querySelectorAll("[data-car-gallery-panel]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.carGalleryPanel === tabId);
    });
  }

  function renderCard(root, card) {
    const photos = safePhotos(card);
    const title = String(card.title || "Gallery item");
    const subtitle = String(card.subtitle || "");
    const description = String(card.description || "");
    const color = String(card.color || "");
    const referenceId = String(card.referenceId || "");
    const wheelModel = safeWheelModel(card);
    const button = createElement("button", "car-gallery__card");
    const photoWrap = createElement("span", "car-gallery__photo");
    const caption = createElement("span", "car-gallery__caption");

    button.type = "button";
    button.setAttribute("aria-label", `Open ${title} gallery`);

    if (photos[0]) {
      const image = document.createElement("img");
      image.src = photos[0].url;
      image.alt = photos[0].alt || title;
      image.loading = "lazy";
      photoWrap.appendChild(image);
    } else {
      photoWrap.appendChild(createElement("span", "car-gallery__placeholder", title));
    }

    caption.appendChild(createElement("span", "car-gallery__title", title));

    if (referenceId) {
      caption.appendChild(
        createElement("span", "car-gallery__reference", `Ref: ${referenceId}`),
      );
    }
    if (subtitle) caption.appendChild(createElement("span", "car-gallery__subtitle", subtitle));
    if (color) caption.appendChild(createElement("span", "car-gallery__color", color));
    if (description) caption.appendChild(createElement("span", "car-gallery__description", description));

    button.appendChild(photoWrap);
    button.appendChild(caption);
    button.addEventListener("click", () =>
      openModal(root, { title, subtitle, description, color, referenceId, wheelModel, photos }),
    );

    return button;
  }

  function ensureModal(root) {
    let modal = document.querySelector("[data-car-gallery-modal]");
    if (modal) return modal;

    modal = createElement("div", "car-gallery__modal");
    modal.dataset.carGalleryModal = "";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = [
      '<div class="car-gallery__modal-backdrop" data-car-gallery-close></div>',
      '<div class="car-gallery__modal-shell">',
      '<button type="button" class="car-gallery__modal-button car-gallery__close" data-car-gallery-close aria-label="Close gallery">x</button>',
      '<div class="car-gallery__modal-media">',
      '<button type="button" class="car-gallery__modal-button car-gallery__prev" data-car-gallery-prev aria-label="Previous photo">&lt;</button>',
      '<img class="car-gallery__modal-image" data-car-gallery-modal-image alt="">',
      '<button type="button" class="car-gallery__modal-button car-gallery__next" data-car-gallery-next aria-label="Next photo">&gt;</button>',
      '<div class="car-gallery__thumbnails" data-car-gallery-thumbnails></div>',
      "</div>",
      '<aside class="car-gallery__modal-info">',
      '<p class="car-gallery__modal-kicker" data-car-gallery-modal-subtitle></p>',
      '<h2 class="car-gallery__modal-title" data-car-gallery-modal-title></h2>',
      '<p class="car-gallery__modal-reference" data-car-gallery-modal-reference></p>',
      '<p class="car-gallery__modal-color" data-car-gallery-modal-color></p>',
      '<p class="car-gallery__modal-description" data-car-gallery-modal-description></p>',
      '<div class="car-gallery__wheel-stock" data-car-gallery-wheel-stock hidden>',
      '<img class="car-gallery__wheel-stock-image" data-car-gallery-wheel-stock-image alt="">',
      '<div class="car-gallery__wheel-stock-copy">',
      '<span>Wheel model</span>',
      '<strong data-car-gallery-wheel-stock-code></strong>',
      "</div>",
      '<div class="car-gallery__wheel-actions">',
      '<a class="car-gallery__wheel-action car-gallery__wheel-action--view" data-car-gallery-wheel-view>View wheel</a>',
      '<a class="car-gallery__wheel-action car-gallery__wheel-action--contact" data-car-gallery-wheel-contact>Contact us</a>',
      "</div>",
      "</div>",
      "</aside>",
      "</div>",
    ].join("");

    document.body.appendChild(modal);
    return modal;
  }

  function openModal(root, card) {
    const modal = ensureModal(root);
    const photos = card.photos.length
      ? card.photos
      : [{ url: "", alt: card.title, placeholder: true }];
    let currentIndex = 0;

    const image = modal.querySelector("[data-car-gallery-modal-image]");
    const title = modal.querySelector("[data-car-gallery-modal-title]");
    const subtitle = modal.querySelector("[data-car-gallery-modal-subtitle]");
    const reference = modal.querySelector("[data-car-gallery-modal-reference]");
    const color = modal.querySelector("[data-car-gallery-modal-color]");
    const description = modal.querySelector("[data-car-gallery-modal-description]");
    const wheelStock = modal.querySelector("[data-car-gallery-wheel-stock]");
    const wheelStockImage = modal.querySelector("[data-car-gallery-wheel-stock-image]");
    const wheelStockCode = modal.querySelector("[data-car-gallery-wheel-stock-code]");
    const wheelStockView = modal.querySelector("[data-car-gallery-wheel-view]");
    const wheelStockContact = modal.querySelector("[data-car-gallery-wheel-contact]");
    const thumbnails = modal.querySelector("[data-car-gallery-thumbnails]");
    const prev = modal.querySelector("[data-car-gallery-prev]");
    const next = modal.querySelector("[data-car-gallery-next]");
    const closeButtons = modal.querySelectorAll("[data-car-gallery-close]");

    title.textContent = card.title;
    subtitle.textContent = card.subtitle;
    reference.textContent = card.referenceId ? `Reference ID: ${card.referenceId}` : "";
    color.textContent = card.color ? `Color: ${card.color}` : "";
    description.textContent = card.description;
    wheelStock.hidden = !card.wheelModel.imageUrl;
    wheelStockImage.src = card.wheelModel.imageUrl || "";
    wheelStockImage.alt = card.wheelModel.alt || card.wheelModel.code || "Wheel model";
    wheelStockCode.textContent = card.wheelModel.code;
    wheelStockView.textContent = `View ${card.wheelModel.code || "wheel"}`;
    wheelStockView.href = getModelProductUrl(card.wheelModel);
    wheelStockContact.href = getContactUrl(root, card);
    thumbnails.innerHTML = "";

    photos.forEach((photo, index) => {
      const thumbnail = createElement("button", "car-gallery__thumbnail");
      thumbnail.type = "button";
      thumbnail.setAttribute("aria-label", `Show photo ${index + 1}`);

      if (photo.url) {
        const thumbnailImage = document.createElement("img");
        thumbnailImage.src = photo.url;
        thumbnailImage.alt = photo.alt || card.title;
        thumbnail.appendChild(thumbnailImage);
      }

      thumbnail.addEventListener("click", () => show(index));
      thumbnails.appendChild(thumbnail);
    });

    function show(index) {
      currentIndex = (index + photos.length) % photos.length;
      const current = photos[currentIndex];

      if (current.url) {
        image.hidden = false;
        image.src = current.url;
        image.alt = current.alt || card.title;
      } else {
        image.hidden = true;
      }

      prev.hidden = photos.length <= 1;
      next.hidden = photos.length <= 1;

      thumbnails.querySelectorAll(".car-gallery__thumbnail").forEach((thumbnail, thumbnailIndex) => {
        thumbnail.classList.toggle("is-active", thumbnailIndex === currentIndex);
      });
    }

    function close() {
      modal.classList.remove("is-open");
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKeydown);
      image.removeAttribute("src");
      wheelStockImage.removeAttribute("src");
    }

    function onKeydown(event) {
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") show(currentIndex - 1);
      if (event.key === "ArrowRight") show(currentIndex + 1);
    }

    closeButtons.forEach((button) => {
      button.onclick = close;
    });

    prev.onclick = () => show(currentIndex - 1);
    next.onclick = () => show(currentIndex + 1);

    show(0);
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeydown);
    modal.classList.add("is-open");
    modal.querySelector("[aria-label='Close gallery']").focus({ preventScroll: true });
  }

  async function init(root) {
    if (initialized.has(root)) return;
    initialized.add(root);

    const gallery = await loadGallery(root);
    renderGallery(root, gallery);
  }

  function initAll() {
    document.querySelectorAll(SELECTOR).forEach(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  document.addEventListener("shopify:section:load", initAll);
})();
