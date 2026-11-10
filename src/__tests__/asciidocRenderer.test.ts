import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RenderContext } from "../types";
import { readFixture } from "./fixtureLoader";
import { getRepoFileContent } from "../services/gitService";

vi.mock("../services/gitService", () => ({
  getRepoFileContent: vi.fn(async (_context: RenderContext, path: string) => readFixture(path))
}));

const { renderAsciidoc } = await import("../renderer/asciidocRenderer");

function contextFor(filePath: string): RenderContext {
  return { projectId: "proj", repositoryId: "repo", version: "main", filePath };
}

function mustReadFixture(path: string): string {
  const content = readFixture(path);
  if (content === null) {
    throw new Error(`Missing test fixture: ${path}`);
  }
  return content;
}

describe("renderAsciidoc", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getRepoFileContent).mockImplementation(async (_context, path) => readFixture(path));
  });

  it("applies ancestor configs in order before document attributes and preserves the header", async () => {
    const files: Record<string, string> = {
      "/.asciidoctorconfig": ":product: Root\n:root-only: inherited\n",
      "/docs/.asciidoctorconfig": ":product: Docs\n:folder-only: inherited-folder\n",
      "/docs/chapters/.asciidoctorconfig": ":product: Chapter\n:toc:\n:sectnums:\n"
    };
    vi.mocked(getRepoFileContent).mockImplementation(async (_context, path) => files[path] ?? null);

    const html = await renderAsciidoc(
      "= {product} Guide\n:product: Document\n\n== Overview\n\n{product} {root-only} {folder-only}\n",
      contextFor("/docs/chapters/main.adoc")
    );

    expect(html).toContain("Document inherited inherited-folder");
    expect(html).toContain('id="toc"');
    expect(html).toMatch(/<h2[^>]*>1\. Overview<\/h2>/);
    expect(html).not.toContain("<h1");
    expect(getRepoFileContent).toHaveBeenCalledTimes(3);
  });

  it("uses the nearest config and resolves its includes relative to its folder", async () => {
    const files: Record<string, string> = {
      "/.asciidoctorconfig": ":product: Root\n",
      "/docs/.asciidoctorconfig": "include::shared/attributes.adoc[]\n",
      "/docs/shared/attributes.adoc": ":product: Shared\n",
      "/docs/chapters/.asciidoctorconfig": ":product: Chapter\n"
    };
    vi.mocked(getRepoFileContent).mockImplementation(async (_context, path) => files[path] ?? null);

    const html = await renderAsciidoc("= Guide\n\n{product}\n", contextFor("/docs/chapters/main.adoc"));

    expect(html).toContain("<p>Chapter</p>");
    expect(getRepoFileContent).toHaveBeenCalledWith(
      contextFor("/docs/chapters/main.adoc"),
      "/docs/shared/attributes.adoc"
    );
  });

  it("ignores missing configs and does not search outside the document's ancestors", async () => {
    const context = contextFor("/docs/main.adoc");
    const html = await renderAsciidoc("= Guide\n\nUnchanged content.\n", context);

    expect(html).toContain("Unchanged content.");
    expect(html).not.toContain("Could not resolve");
    expect(vi.mocked(getRepoFileContent).mock.calls).toEqual([
      [context, "/.asciidoctorconfig"],
      [context, "/docs/.asciidoctorconfig"]
    ]);
  });

  it("processes conditional config content and keeps document includes relative to the document", async () => {
    const files: Record<string, string> = {
      "/.asciidoctorconfig": ":shared-enabled:\n",
      "/docs/.asciidoctorconfig": "ifdef::shared-enabled[]\n:product: Enabled\nendif::[]\n\n",
      "/docs/chapters/.asciidoctorconfig": "",
      "/docs/chapters/body.adoc": "{product} content\n"
    };
    vi.mocked(getRepoFileContent).mockImplementation(async (_context, path) => files[path] ?? null);

    const html = await renderAsciidoc("= Guide\n\ninclude::body.adoc[]\n", contextFor("/docs/chapters/main.adoc"));

    expect(html).toContain("Enabled content");
    expect(html).not.toContain("Could not resolve");
  });

  it("loads configs from the selected repository version without leaking between renders", async () => {
    vi.mocked(getRepoFileContent).mockImplementation(async (context, path) =>
      path === "/.asciidoctorconfig" ? `:product: ${context.repositoryId}-${context.version}\n` : null
    );
    const source = "= Guide\n\n{product}\n";
    const first = await renderAsciidoc(source, contextFor("/main.adoc"));
    const second = await renderAsciidoc(source, {
      ...contextFor("/main.adoc"),
      repositoryId: "other-repo",
      version: "feature"
    });

    expect(first).toContain("<p>repo-main</p>");
    expect(second).toContain("<p>other-repo-feature</p>");
    expect(getRepoFileContent).toHaveBeenCalledTimes(2);
  });

  it("resolves nested local includes and keeps section structure", async () => {
    const source = mustReadFixture("/docs/main.adoc");
    const html = await renderAsciidoc(source, contextFor("/docs/main.adoc"));

    expect(html).toContain("Chapter 1");
    expect(html).toContain("nested include content");
    expect(html).toContain("Chapter 2 (offset)");
    expect(html).toContain("Some text.");
  });

  it("applies leveloffset attribute from the include directive", async () => {
    const source = mustReadFixture("/docs/main.adoc");
    const html = await renderAsciidoc(source, contextFor("/docs/main.adoc"));

    // ch2.adoc is a level-0 (`=`) document; leveloffset=+1 should demote it to <h2>.
    expect(html).toMatch(/<h2[^>]*>Chapter 2 \(offset\)<\/h2>/);
  });

  it("replaces circular includes with a warning instead of looping forever", async () => {
    const source = mustReadFixture("/docs/cyclic-a.adoc");
    const html = await renderAsciidoc(source, contextFor("/docs/cyclic-a.adoc"));

    expect(html.toLowerCase()).toContain("circular include detected");
  });

  it("replaces unresolvable includes with a warning placeholder", async () => {
    const source = "= Main\n\ninclude::does-not-exist.adoc[]\n";
    const html = await renderAsciidoc(source, contextFor("/docs/main.adoc"));

    expect(html.toLowerCase()).toContain("could not resolve local include");
  });

  it("does not attempt to resolve absolute-URL includes locally", async () => {
    const source = "= Main\n\ninclude::https://example.com/remote.adoc[]\n";
    const html = await renderAsciidoc(source, contextFor("/docs/main.adoc"));

    expect(html.toLowerCase()).toContain("could not resolve local include");
  });

  it("renders inline and block latexmath formulas with KaTeX", async () => {
    const source = `:stem: latexmath

Inline latexmath:[x^2 + y^2].

[latexmath]
++++
\\frac{a}{b} = c
++++`;
    const html = await renderAsciidoc(source, contextFor("/docs/main.adoc"));

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\(x^2 + y^2\\)");
  });
});
