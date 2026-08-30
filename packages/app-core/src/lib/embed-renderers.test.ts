// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  escapeEmbedFrame,
  parseEmbed,
  renderEmbedElement,
  renderEmbeds,
} from "./embed-renderers";

// The bridge is typed as always present; the tests stand in a partial one.
const zenWindow = window as unknown as { zen?: unknown };

describe("parseEmbed", () => {
  it("maps a YouTube watch URL to the nocookie player, its poster, and an autoplay play URL", () => {
    const parsed = parseEmbed(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s",
    );
    expect(parsed).toMatchObject({
      provider: "youtube",
      title: "YouTube video",
      aspectRatio: 16 / 9,
    });
    expect(parsed?.src).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90",
    );
    expect(parsed?.playSrc).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90&autoplay=1",
    );
    expect(parsed?.poster).toBe(
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    );
  });

  it("maps a Vimeo URL with no static poster", () => {
    expect(parseEmbed("https://vimeo.com/76979871")).toMatchObject({
      provider: "vimeo",
      src: "https://player.vimeo.com/video/76979871",
      playSrc: "https://player.vimeo.com/video/76979871?autoplay=1",
      poster: null,
    });
  });

  it("rejects unsupported providers and non-https URLs", () => {
    expect(parseEmbed("https://example.com/video.mp4")).toBeNull();
    expect(parseEmbed("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("renderEmbedElement", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete zenWindow.zen;
  });

  it("renders a click-to-play poster and mounts no iframe until play is clicked", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const onActivate = vi.fn();
    renderEmbedElement(el, "https://youtu.be/dQw4w9WgXcQ", { onActivate });

    const surface = el.querySelector<HTMLElement>(".zen-embed-frame");
    expect(surface).not.toBeNull();
    expect(surface?.querySelector("iframe")).toBeNull();
    const poster = surface?.querySelector<HTMLButtonElement>(
      "button.zen-embed-poster",
    );
    expect(
      poster?.querySelector<HTMLImageElement>("img.zen-embed-poster-image")
        ?.src,
    ).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(poster?.querySelector(".zen-embed-provider")?.textContent).toBe(
      "YouTube",
    );
    expect(onActivate).not.toHaveBeenCalled();

    // The mousedown is swallowed so focus never leaves the note.
    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    poster?.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // The click mounts the player and does not bubble as a "reveal source" click.
    const bubbled = vi.fn();
    document.body.addEventListener("click", bubbled);
    poster?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(bubbled).not.toHaveBeenCalled();
    const iframe = surface?.querySelector("iframe");
    expect(iframe?.src).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
    );
    expect(iframe?.getAttribute("allow")).toContain("autoplay");
    expect(surface?.querySelector(".zen-embed-poster")).toBeNull();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("fills a Vimeo poster from link metadata when the bridge provides it", async () => {
    zenWindow.zen = {
      fetchLinkMetadata: async (url: string) => ({
        url,
        ok: true,
        image: "https://i.vimeocdn.com/video/1.jpg",
      }),
    };
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderEmbedElement(el, "https://vimeo.com/76979871");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".zen-embed-provider")?.textContent).toBe("Vimeo");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      el.querySelector<HTMLImageElement>("img.zen-embed-poster-image")?.src,
    ).toBe("https://i.vimeocdn.com/video/1.jpg");
  });

  it("keeps an unsupported URL as a plain link", () => {
    const el = document.createElement("div");
    renderEmbedElement(el, "https://example.com/clip.mp4");
    expect(el.querySelector("iframe")).toBeNull();
    expect(el.querySelector(".zen-embed-poster")).toBeNull();
    expect(
      el.querySelector<HTMLAnchorElement>(".zen-embed-unsupported a")?.href,
    ).toBe("https://example.com/clip.mp4");
  });

  it("renderEmbeds leaves a rendered block alone, so a started player survives a re-run", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="zen-embed" data-embed-url="https://youtu.be/dQw4w9WgXcQ"></div>';
    document.body.appendChild(root);
    renderEmbeds(root);
    root.querySelector<HTMLButtonElement>(".zen-embed-poster")?.click();
    const iframe = root.querySelector("iframe");
    expect(iframe).not.toBeNull();
    renderEmbeds(root);
    expect(root.querySelector("iframe")).toBe(iframe);
  });
});

describe("escapeEmbedFrame", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does nothing when no embed player owns focus", () => {
    expect(escapeEmbedFrame()).toBe(false);
  });

  it("hands focus back to the editor hosting the player, caret untouched", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "alpha\nbeta",
        selection: { anchor: 7 },
      }),
    });
    // The widget lives in the editor root; kept out of the observed content
    // element so the DOM observer does not read it back as an edit.
    const block = document.createElement("div");
    block.className = "cm-embed-block";
    block.innerHTML =
      '<div class="zen-embed-frame"><iframe title="YouTube video"></iframe></div>';
    view.dom.appendChild(block);
    const iframe = block.querySelector("iframe");
    iframe?.focus();
    expect(document.activeElement).toBe(iframe);

    expect(escapeEmbedFrame()).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.selection.main.head).toBe(7);
    view.destroy();
  });

  it("blurs a reading-view player and focuses the scroll container", () => {
    const host = document.createElement("div");
    host.tabIndex = 0;
    host.innerHTML =
      '<div class="zen-embed"><div class="zen-embed-frame"><iframe title="YouTube video"></iframe></div></div>';
    document.body.appendChild(host);
    const iframe = host.querySelector("iframe");
    iframe?.focus();
    expect(document.activeElement).toBe(iframe);

    expect(escapeEmbedFrame()).toBe(true);
    expect(document.activeElement).toBe(host);
  });
});
