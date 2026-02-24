/*
████████╗██╗██╗     ███████╗███████╗
╚══██╔══╝██║██║     ██╔════╝██╔════╝
   ██║   ██║██║     █████╗  ███████╗
   ██║   ██║██║     ██╔══╝  ╚════██║
   ██║   ██║███████╗███████╗███████║
   ╚═╝   ╚═╝╚══════╝╚══════╝╚══════╝
      •--~~~## MOTHERSHIP ##~~~--•

The tile-loading architecture has three levels that all communicate together:

- At the top, the MOTHERSHIP. This has access to things in the real world like
  fetching from the internet or reading from the file system. It's the interface
  to tile loading, it gets configured in ways that are appropriate for its
  context. This is the entry point: you give it a URL and it'll instantiate that
  tile. To the extent possible, this should contain all the intelligence and all
  the configurability so that the other components can be deployed in entirely
  generic ways.
- The mothership instantiates tiles by creating insulated contexts (a sandboxed
  iframe, an incognito window…) and loading a SHUTTLE in it. The role of the
  shuttle is to set up a service worker and an iframe to load the root of the
  tile into. It only exists because you need something to carry a service worker
  in. The only other thing that it does is (*drumroll*) shuttle messages back
  and forth between the worker and the mothership.
- The WORKER is dispatched on a shuttle to handle resource loading for a tile.
  Apart from allow-listing some paths for itself and the shuttle, it passes all
  requests up, which the shuttle then hands over to the mothership.
*/

import { el } from './lib/el.js';
import { ReactiveElement } from '@lit/reactive-element';
const TILES_PFX = 'tiles-';
const SHUTTLE_PFX = 'tiles-shuttle-';
const SND_SHUTTLE_LOAD = `${SHUTTLE_PFX}load`; // tell worker to roll
const RCV_SHUTTLE_READY = `${SHUTTLE_PFX}ready`; // worker ready
const SND_SET_TITLE = `${SHUTTLE_PFX}set-title`; // set the title
const SND_SET_ICON = `${SHUTTLE_PFX}set-icon`; // set the icon
const WORKER_PFX = 'tiles-worker-';
const SND_WORKER_LOAD = `${WORKER_PFX}load`; // tell worker to roll
const RCV_WORKER_READY = `${WORKER_PFX}ready`; // worker ready
const RCV_WORKER_REQUEST = `${WORKER_PFX}request`; // worker requested something
const SND_WORKER_RESPONSE = `${WORKER_PFX}response`; // respond to a worker
const TILES_WARNING = `${TILES_PFX}warn`; // worker warnings
const TILES_ERROR = `${TILES_PFX}error`; // shuttle errors

export class TileLoadEvent extends Event {
  constructor() {
    super('tile-load');
  }
}

export class TileTitleChangeEvent extends Event {
  #title;

  get title() {
    return this.#title;
  }

  constructor(title) {
    super('tile-title-change');
    this.#title = title;
  }
}

export class TileFrame extends ReactiveElement {
  static tagName = 'tile-frame';

  static properties = {
    src: { type: String, reflect: true },
  };

  static loadDomain = 'load.webtil.es';

  static define() {
    if (customElements.get(this.tagName)) return;

    customElements.define(this.tagName, this);
  }

  static #loaders = [];

  static addLoader(loader) {
    this.loaders.push(loader);
  }

  static removeLoader(loader) {
    this.loaders = this.loaders.filter((ldr) => ldr !== loader);
  }

  static async loadTile(src) {
    for (const ldr of this.#loaders) {
      const tileData = await ldr.load(src);
      if (tileData !== undefined) return tileData;
    }
    return {};
  }

  #iframe = el('iframe', {
    style: {
      display: 'block',
      width: '100%',
      border: 'none',
    },
  });

  #manifest;
  #pathLoader;
  #uuid = crypto.randomUUID();

  get loadSource() {
    return `https://${TileFrame.loadDomain}/.well-known/web-tiles/`;
  }

  constructor() {
    super();

    this.src = '';
  }

  createRenderRoot() {
    const root = super.createRenderRoot();

    return root;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#iframe.addEventListener('load', this.#onIframeLoad);
    window.addEventListener('message', this.#onMessage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#iframe.removeEventListener('load', this.#onIframeLoad);
    window.removeEventListener('message', this.#onMessage);
  }

  update(changedProperties) {
    super.update(changedProperties);

    if (changedProperties.has('src')) {
      const tile = TileFrame.loadTile(this.src);

      if (tile !== undefined) {
        this.#manifest = tile.manifest;
        this.#pathLoader = tile.pathLoader;
        this.#iframe.src = this.loadSource;
      }
    }
  }

  resolvePath(path) {
    if (this.#pathLoader === undefined) throw new Error('Tile not loaded');

    const u = new URL(`fake:${path}`);
    return this.#pathLoader.resolvePath(u.pathname);
  }

  #onIframeLoad = () => {
    this.sendToShuttle(SND_SHUTTLE_LOAD, { id: this.#uuid });
  };

  #onMessage = async (ev) => {
    const { action, msg, id } = ev.data || {};

    // TODO: check that iframe is the same as well?
    if (id !== this.#uuid) return;

    if (action === TILES_WARNING) {
      console.warn(`[W:${id}]`, ...msg);
    }
    if (action === TILES_ERROR) {
      console.error(`[S:${id}]`, ...msg);
    } else if (action === RCV_SHUTTLE_READY) {
      this.#sendToShuttle(SND_WORKER_LOAD, { id });
    } else if (action === RCV_WORKER_READY) {
      this.dispatchEvent(new TileLoadEvent());

      if (this.#manifest?.name) {
        const title = this.#manifest?.name;
        this.#sendToShuttle(SND_SET_TITLE, { title });
        this.dispatchEvent(new TileTitleChangeEvent(title));
      }
      const icon = this.#manifest?.icons?.[0]?.src;
      if (icon) {
        this.#sendToShuttle(SND_SET_ICON, { path: icon });
      }
    } else if (action === RCV_WORKER_REQUEST) {
      const { type, payload } = ev.data;

      if (type === 'resolve-path') {
        const { path, requestId } = payload;
        const { status, headers, body } = await this.resolvePath(path);
        this.#sendToShuttle(SND_WORKER_RESPONSE, { requestId, response: { status, headers, body } });
      }
    }
  };

  #sendToShuttle(action, payload) {
    // TODO: double check we can hardcode #uuid
    this.#iframe.contentWindow.postMessage({ id: this.#uuid, action, payload }, '*');
  }
}

// TODO: add logic to render a tile's card
/* async renderCard(options) {
    const card = el('div', {
      style: {
        border: '1px solid lightgrey',
        'border-radius': '3px',
        cursor: 'pointer',
      },
    });
    card.addEventListener('click', async () => {
      const tileRenderer = await this.renderContent(
        options?.contentHeight || this.#manifest?.sizing?.height || Math.max(card.offsetHeight, 300),
      );
      card.replaceWith(tileRenderer);
    });
    // XXX we always take the first, we could be smarter with sizes
    if (this.#manifest?.screenshots?.[0]?.src) {
      const res = await this.resolvePath(this.#manifest.screenshots[0].src);
      if (res.ok) {
        const blob = new Blob([res.body], { type: res.headers?.['content-type'] });
        const url = URL.createObjectURL(blob);
        el(
          'div',
          {
            style: {
              'background-image': `url(${url})`,
              'background-size': 'cover',
              'background-position': '50%',
              'aspect-ratio': '16/9',
            },
          },
          [],
          card,
        );
      }
    }
    const title = el(
      'div',
      {
        style: {
          padding: '0.5rem 1rem',
          display: 'flex',
          'align-items': 'center',
        },
      },
      [],
      card,
    );
    // XXX we always take the first, we could be smarter with sizes
    if (this.#manifest?.icons?.[0]?.src) {
      const res = await this.resolvePath(this.#manifest.icons[0].src);
      if (res.ok) {
        const blob = new Blob([res.body], { type: res.headers?.['content-type'] });
        const url = URL.createObjectURL(blob);
        el('img', { src: url, width: '48', height: '48', alt: 'icon', style: { 'padding-right': '0.5rem' } }, [], title);
      }
    }
    el('span', { style: { 'font-weight': 'bold' } }, [this.#manifest.name || 'Untitled Tile'], title);
    if (this.#manifest.description) {
      el('p', { style: { margin: '0.5rem 1rem 1rem 1rem' } }, [this.#manifest.description], card);
    }
    return card;
  } */
